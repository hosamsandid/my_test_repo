import test from 'node:test';
import assert from 'node:assert/strict';
import { toolchainOptions, toolchainEmptyState, toolchainChangeWarning, availableToolchains, versionSourceLine } from './toolchain-select-view.js';

const JVM = { id: 'jvm-21', name: 'JVM 21', image: 'localhost/as-agent-jvm:latest', platforms: ['podman'], description: 'JDK 21 + Maven', baseline: 'java temurin-21, maven 3.9' };
const GO = { id: 'go-1-23', name: 'Go 1.23', image: 'ar/as-agent-go:v1', platforms: ['podman', 'kubernetes'] };

test('toolchainOptions marks a runtime-mismatched toolchain unavailable but still lists it', () => {
  const onK8s = toolchainOptions([JVM, GO], 'kubernetes');
  assert.deepEqual(onK8s.map(o => o.id), ['jvm-21', 'go-1-23'], 'nothing is hidden');
  assert.equal(onK8s[0].available, false);
  assert.match(onK8s[0].hint, /not available on kubernetes/);
  assert.match(onK8s[0].hint, /built for podman/);
  assert.equal(onK8s[1].available, true);
});

test('toolchainOptions surfaces the description as the hint when the toolchain is usable', () => {
  const [jvm] = toolchainOptions([JVM], 'podman');
  assert.equal(jvm.available, true);
  assert.equal(jvm.hint, 'JDK 21 + Maven');
  assert.equal(jvm.label, 'JVM 21');
  assert.equal(jvm.image, 'localhost/as-agent-jvm:latest');
});

test('toolchainOptions carries platforms/baseline for the tile grid badges (#2279)', () => {
  const [jvm] = toolchainOptions([JVM], 'podman');
  assert.deepEqual(jvm.platforms, ['podman']);
  assert.equal(jvm.baseline, 'java temurin-21, maven 3.9');
  // GO declares no baseline in the fixture — the badge row must not invent one.
  const [, go] = toolchainOptions([JVM, GO], 'podman');
  assert.equal(go.baseline, '');
  assert.deepEqual(go.platforms, ['podman', 'kubernetes']);
});

test('toolchainOptions treats a platform-less entry as available everywhere and tolerates junk', () => {
  const [any] = toolchainOptions([{ id: 'x', image: 'y:1' }], 'kubernetes');
  assert.equal(any.available, true);
  assert.equal(any.label, 'x', 'falls back to the id when no name is set');
  assert.deepEqual(any.platforms, ['podman', 'kubernetes'], 'defaults to everywhere when the manifest names none');
  assert.equal(any.baseline, '');
  assert.deepEqual(toolchainOptions(null, 'podman'), []);
  assert.deepEqual(toolchainOptions([null, {}], 'podman'), [], 'entries with no id are dropped');
});

test('toolchainEmptyState explains the empty registry differently per role', () => {
  const admin = toolchainEmptyState([], { canManage: true, defaultImage: 'as-agent:latest' });
  assert.match(admin, /as-agent:latest/);
  assert.match(admin, /Register one/);
  const member = toolchainEmptyState([], { canManage: false, defaultImage: 'as-agent:latest' });
  assert.match(member, /A System Admin adds them/);
  assert.equal(toolchainEmptyState([JVM], { canManage: true }), null, 'no notice once something is registered');
});

test('AC5: changing the toolchain warns that running agents are interrupted', () => {
  const w = toolchainChangeWarning({ isEdit: true, initialToolchainId: null, toolchainId: 'jvm-21', agentCount: 3 });
  assert.match(w, /toolchain 'jvm-21'/);
  assert.match(w, /restart 3 agents/);
  assert.match(w, /interrupted/);
  assert.match(w, /quiet moment/);
});

test('the warning is singular for one agent and names a switch between two toolchains', () => {
  const one = toolchainChangeWarning({ isEdit: true, initialToolchainId: 'go-1-23', toolchainId: 'jvm-21', agentCount: 1 });
  assert.match(one, /restart 1 agent in this environment/);
  assert.match(one, /switch the toolchain to 'jvm-21'/);
});

test('clearing the toolchain warns about returning to the default image', () => {
  const w = toolchainChangeWarning({ isEdit: true, initialToolchainId: 'jvm-21', toolchainId: null, agentCount: 2 });
  assert.match(w, /default agent image/);
  assert.match(w, /restart 2 agents/);
});

test('no warning when nothing changed, on create, or without a change', () => {
  assert.equal(toolchainChangeWarning({ isEdit: true, initialToolchainId: 'jvm-21', toolchainId: 'jvm-21', agentCount: 5 }), null);
  assert.equal(toolchainChangeWarning({ isEdit: false, toolchainId: 'jvm-21', agentCount: 5 }), null, 'a new env has no running agents');
  assert.equal(toolchainChangeWarning({}), null);
  // '' and null are the same "no toolchain" state — an empty select value must
  // not read as a change.
  assert.equal(toolchainChangeWarning({ isEdit: true, initialToolchainId: null, toolchainId: '', agentCount: 5 }), null);
});

test('with no running agents the warning drops the interruption claim', () => {
  const w = toolchainChangeWarning({ isEdit: true, initialToolchainId: null, toolchainId: 'jvm-21', agentCount: 0 });
  assert.doesNotMatch(w, /interrupted/);
  assert.match(w, /next time an agent in this environment starts/);
});

// ── #1941: the shipped variants ────────────────────────────────────────────

test('availableToolchains: a shipped variant is installable on a runtime it declares', () => {
  const rows = availableToolchains([{
    id: 'jvm', name: 'JVM', description: 'Java + Maven', ok: true,
    image: 'as-agent-jvm:latest', effectiveImage: 'ar.example.com/p/as-agent-jvm:v1',
    platforms: ['podman', 'kubernetes'],
  }], 'kubernetes');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].installable, true);
  assert.equal(rows[0].reason, '');
  // The operator is shown what will ACTUALLY be pulled, not the manifest's
  // placeholder tag — otherwise the install review describes a different image.
  assert.equal(rows[0].image, 'ar.example.com/p/as-agent-jvm:v1');
});

test('availableToolchains: a podman-only variant is listed but not installable on kubernetes', () => {
  const [row] = availableToolchains([{
    id: 'jvm', name: 'JVM', ok: true, image: 'as-agent-jvm:latest', platforms: ['podman'],
  }], 'kubernetes');
  assert.equal(row.installable, false);
  assert.match(row.reason, /not available on the 'kubernetes' runtime/);
});

test('availableToolchains: an invalid manifest is KEPT with its errors, never dropped', () => {
  // A silently shorter list cannot answer "where is the JVM toolchain?".
  const [row] = availableToolchains([{ id: 'jvm', ok: false, errors: ['versionSource is required'] }], 'podman');
  assert.equal(row.broken, true);
  assert.equal(row.installable, false);
  assert.match(row.reason, /versionSource is required/);
});

test('availableToolchains: tolerates a missing/garbage payload', () => {
  assert.deepEqual(availableToolchains(undefined, 'podman'), []);
  assert.deepEqual(availableToolchains([null, {}, { id: '' }], 'podman'), []);
  // effectiveImage absent (a pre-#1941 server) falls back to the bare image.
  const [row] = availableToolchains([{ id: 'x', ok: true, image: 'as-agent-x:latest', platforms: ['podman'] }], 'podman');
  assert.equal(row.image, 'as-agent-x:latest');
});

test('versionSourceLine states whether a version update is a commit or a release', () => {
  const boot = versionSourceLine({ versionSource: 'bootstrap', versionManager: 'mise', baseline: 'java temurin-21' });
  assert.match(boot, /commit in that repository/);
  assert.match(boot, /via mise/);
  assert.match(boot, /pins nothing gets java temurin-21/);

  const baked = versionSourceLine({ versionSource: 'baked', baseline: 'java temurin-21' });
  assert.match(baked, /platform release/);
  assert.match(baked, /airgapped/);

  // A pre-#1941 registry entry declares neither — say nothing rather than guess.
  assert.equal(versionSourceLine({}), '');
  assert.equal(versionSourceLine(null), '');
});

test('availableToolchains carries the version fields, so a row needs no second lookup', () => {
  const [row] = availableToolchains([{
    id: 'jvm', name: 'JVM', ok: true, image: 'as-agent-jvm:latest', platforms: ['podman'],
    versionSource: 'bootstrap', versionManager: 'mise', baseline: 'java temurin-21, maven 3.9',
  }], 'podman');
  assert.match(versionSourceLine(row), /commit in that repository/);
  assert.match(versionSourceLine(row), /via mise/);
});
