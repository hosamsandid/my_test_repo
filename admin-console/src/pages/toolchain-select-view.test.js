import test from 'node:test';
import assert from 'node:assert/strict';
import { toolchainOptions, toolchainEmptyState, toolchainChangeWarning } from './toolchain-select-view.js';

const JVM = { id: 'jvm-21', name: 'JVM 21', image: 'localhost/as-agent-jvm:latest', platforms: ['podman'], description: 'JDK 21 + Maven' };
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

test('toolchainOptions treats a platform-less entry as available everywhere and tolerates junk', () => {
  const [any] = toolchainOptions([{ id: 'x', image: 'y:1' }], 'kubernetes');
  assert.equal(any.available, true);
  assert.equal(any.label, 'x', 'falls back to the id when no name is set');
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
