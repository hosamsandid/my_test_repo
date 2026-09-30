import test from 'node:test';
import assert from 'node:assert';

import {
  describeCapability,
  describeCapabilities,
  quotaSummary,
  formatDuration,
  installAction,
  sidecarStatus,
  pluginRegistryRow,
} from './plugin-registry-view.js';

function manifest(extra = {}) {
  return {
    pluginVersion: 1,
    id: 'podman-sandbox',
    name: 'Podman Container Sandbox',
    description: 'spawn compose stacks',
    sidecar: { image: 'i', capabilities: ['podman-socket'], internalPort: 4004 },
    cli: { name: 'aee-podman', entrypoint: 'bin/aee-podman.py', runtime: 'python3' },
    scopes: ['team', 'agent'],
    platforms: ['podman'],
    quota: { maxObjects: 8, ttlSeconds: 86400 },
    ...extra,
  };
}

test('podman-socket is described as high risk in plain language', () => {
  const d = describeCapability('podman-socket');
  assert.equal(d.risk, 'high');
  assert.match(d.title, /container runtime/i);
  // The isolation claim must be stated together with what the broker itself holds.
  assert.match(d.detail, /scopes cannot see each other/i);
  assert.match(d.detail, /full socket access/i);
});

test('a host-mount capability names the actual path', () => {
  const d = describeCapability('host-mount:/srv/data');
  assert.match(d.title, /\/srv\/data/);
  assert.match(d.detail, /read-only/i);
});

test('an unrecognised capability is surfaced, not silently dropped', () => {
  const d = describeCapability('root-everything');
  assert.equal(d.risk, 'unknown');
  assert.match(d.detail, /will not install/i);
});

test('describeCapabilities tolerates a manifest with no sidecar block', () => {
  assert.deepEqual(describeCapabilities(null), []);
  assert.deepEqual(describeCapabilities({}), []);
  assert.deepEqual(describeCapabilities({ sidecar: {} }), []);
});

test('quotaSummary states the cap, or its honest absence', () => {
  assert.match(quotaSummary(manifest()), /Up to 8 objects per scope, reaped after 1d/);
  assert.match(quotaSummary(manifest({ quota: { maxObjects: 1 } })), /Up to 1 object per scope\./);
  assert.match(quotaSummary(manifest({ quota: undefined })), /uncapped/i);
});

test('formatDuration picks the coarsest exact unit', () => {
  assert.equal(formatDuration(86400), '1d');
  assert.equal(formatDuration(3600), '1h');
  assert.equal(formatDuration(90), '90s');
  assert.equal(formatDuration(120), '2m');
});

test('an invalid manifest can never be installed, regardless of role', () => {
  const entry = { id: 'x', ok: false, errors: ['capabilities has unknown entries: root'], manifest: null };
  const a = installAction(entry, { canManage: true, stackRuntime: 'podman' });
  assert.equal(a.disabled, true);
  assert.match(a.hint, /unknown entries/);
});

test('a non-System-Admin sees the button disabled with an honest reason', () => {
  const entry = { id: 'p', ok: true, errors: [], manifest: manifest(), installed: false };
  const a = installAction(entry, { canManage: false, stackRuntime: 'podman' });
  assert.equal(a.disabled, true);
  assert.match(a.hint, /System Admin/);
});

test('a platform mismatch warns but does not block the install', () => {
  const entry = { id: 'p', ok: true, errors: [], manifest: manifest(), installed: false };
  const a = installAction(entry, { canManage: true, stackRuntime: 'kubernetes' });
  assert.equal(a.disabled, false, 'seeding still works; the operator may have a reason');
  assert.match(a.hint, /broker will not start here/);
});

test('a matching platform installs with no warning', () => {
  const entry = { id: 'p', ok: true, errors: [], manifest: manifest(), installed: false };
  const a = installAction(entry, { canManage: true, stackRuntime: 'podman' });
  assert.equal(a.hint, '');
  assert.equal(a.action, 'install');
});

test('"platforms: any" matches every runtime', () => {
  const entry = { id: 'p', ok: true, errors: [], manifest: manifest({ platforms: ['any'] }), installed: false };
  assert.equal(installAction(entry, { canManage: true, stackRuntime: 'kubernetes' }).hint, '');
});

test('unknown broker status is distinct from stopped', () => {
  assert.equal(sidecarStatus({ installed: true, sidecarRunning: true }).state, 'running');
  assert.equal(sidecarStatus({ installed: true, sidecarRunning: false }).state, 'stopped');
  // The orchestrator was unreachable — claiming "not running" would be a guess.
  assert.equal(sidecarStatus({ installed: true, sidecarRunning: null }).state, 'unknown');
  assert.equal(sidecarStatus({ installed: false }).state, 'not-installed');
});

test('a command-only plugin reports a neutral broker status, not "not running" (#1861)', () => {
  // No `sidecar` block → nothing to run. `sidecarRunning` is null (the
  // orchestrator never lists a broker-less plugin), which would otherwise read
  // as "Broker status unknown" — the command-only branch must win first.
  const commandOnly = {
    installed: true,
    sidecarRunning: null,
    manifest: { pluginVersion: 1, id: 'spec-kit', name: 'Spec Kit', commands: { namespace: 'speckit' } },
  };
  const s = sidecarStatus(commandOnly);
  assert.equal(s.state, 'none');
  assert.equal(s.tone, 'muted');
  assert.match(s.label, /command-only/i);
  assert.doesNotMatch(s.label, /not running/i);

  // A broker-backed plugin is unchanged whether the manifest is present or not.
  assert.equal(sidecarStatus({ installed: true, sidecarRunning: true, manifest: manifest() }).state, 'running');
  assert.equal(sidecarStatus({ installed: true, sidecarRunning: false, manifest: manifest() }).state, 'stopped');
  assert.equal(sidecarStatus({ installed: true, sidecarRunning: null, manifest: manifest() }).state, 'unknown');
  // An unreadable manifest (invalid plugin) can't be classified command-only —
  // it must fall through to the existing running/unknown logic.
  assert.equal(sidecarStatus({ installed: true, sidecarRunning: false, manifest: null }).state, 'stopped');
});

test('pluginRegistryRow folds an entry into a renderable row', () => {
  const entry = { id: 'podman-sandbox', ok: true, errors: [], manifest: manifest(), installed: true, sidecarRunning: true };
  const row = pluginRegistryRow(entry, { canManage: true, stackRuntime: 'podman' });
  assert.equal(row.name, 'Podman Container Sandbox');
  assert.equal(row.cliName, 'aee-podman');
  assert.deepEqual(row.scopes, ['team', 'agent']);
  assert.equal(row.capabilities.length, 1);
  assert.equal(row.status.state, 'running');
  assert.equal(row.action.action, 'uninstall');
});

test('pluginRegistryRow flags a globally-visible UI plugin (#1599)', () => {
  // A UI-bearing plugin that opted in.
  const uiGlobal = manifest({ ui: { title: 'Catalog', global: true, routes: [{ path: '/', minRole: 'team-member' }] } });
  assert.equal(pluginRegistryRow({ id: 'p', ok: true, errors: [], manifest: uiGlobal, installed: true }).globalUi, true);
  // A UI plugin that did NOT opt in.
  const uiPlain = manifest({ ui: { title: 'Board', routes: [{ path: '/', minRole: 'team-member' }] } });
  assert.equal(pluginRegistryRow({ id: 'p', ok: true, errors: [], manifest: uiPlain, installed: true }).globalUi, false);
  // A plugin with no UI at all — the flag is only meaningful for UI plugins.
  assert.equal(pluginRegistryRow({ id: 'p', ok: true, errors: [], manifest: manifest(), installed: true }).globalUi, false);
});

test('pluginRegistryRow degrades safely on a broken entry', () => {
  const row = pluginRegistryRow({ id: 'broken', ok: false, errors: ['bad'], manifest: null, installed: false });
  assert.equal(row.name, 'broken');
  assert.deepEqual(row.capabilities, []);
  assert.equal(row.action.disabled, true);
  assert.match(row.quota, /uncapped/i);
});

// ─── build identity (#2646) ─────────────────────────────────────────────────

import {
  describeBuild,
  isAgentStudioImage,
  fetchedVersionText,
  brokerBuildLine,
  imageBuildLine,
  buildIdentity,
  BROKER_MISMATCH_HINT,
  BROKER_MISMATCH_DETAIL,
  BROKER_IMAGE_MISMATCH_HINT,
  BROKER_IMAGE_MISMATCH_DETAIL,
} from './plugin-registry-view.js';
import { absoluteWhen } from '../components/format-when.js';
import fs from 'node:fs';

const NEW = { commit: 'bbbbbbb', dirty: '', commitTime: '2026-09-30T21:08:25+02:00' };
const OLD = { commit: 'aaaaaaa', dirty: '', commitTime: '2026-09-29T08:05:00Z' };
const brokerManifest = (image = 'localhost/aee-plugin-jira:latest') => manifest({ id: 'jira', sidecar: { image, capabilities: ['egress'], internalPort: 4009 } });

// AC4 / AC7: same formatter as the console's own version display.
test('describeBuild: hash (with -dirty) and commit timestamp in version-info.js format', () => {
  assert.deepStrictEqual(describeBuild(NEW), { known: true, hash: 'bbbbbbb', time: '2026-09-30 21:08 +0200', text: 'bbbbbbb · 2026-09-30 21:08 +0200' });
  assert.strictEqual(describeBuild({ ...NEW, dirty: 'dirty' }).hash, 'bbbbbbb-dirty');
  assert.strictEqual(describeBuild(OLD).time, '2026-09-29 08:05 +0000');
  assert.strictEqual(describeBuild({ commit: 'bbbbbbb', dirty: '', commitTime: '' }).text, 'bbbbbbb · time unknown');
});

// AC6: never empty — unknown is said out loud.
test('describeBuild: missing / unknown build → "unknown"', () => {
  for (const b of [null, undefined, {}, { commit: 'unknown', dirty: 'dirty', commitTime: '2026-09-30T21:08:25+02:00' }, { commit: '' }]) {
    assert.deepStrictEqual(describeBuild(b), { known: false, hash: 'unknown', time: 'unknown', text: 'unknown' });
  }
});

test('isAgentStudioImage: reference broker images vs third-party images', () => {
  assert.strictEqual(isAgentStudioImage('localhost/aee-plugin-jira:latest'), true);
  assert.strictEqual(isAgentStudioImage('aee-plugin-jira'), true);
  assert.strictEqual(isAgentStudioImage('europe-west3-docker.pkg.dev/p/r/aee-plugin-jira@sha256:abc'), true);
  assert.strictEqual(isAgentStudioImage('docker.io/library/busybox:latest'), false);
  assert.strictEqual(isAgentStudioImage(''), false);
  assert.strictEqual(isAgentStudioImage(undefined), false);
});

test('fetchedVersionText: repo@ref plus the local fetch time', () => {
  const iv = { repo: 'github/spec-kit', ref: 'v0.0.90', fetchedAt: '2026-09-30T19:08:25.000Z', fileCount: 9 };
  assert.strictEqual(fetchedVersionText(iv), `github/spec-kit@v0.0.90, fetched ${absoluteWhen(iv.fetchedAt)}`);
  assert.strictEqual(fetchedVersionText({ repo: 'github/spec-kit', ref: 'main', fetchedAt: 'garbage' }), 'github/spec-kit@main');
  assert.strictEqual(fetchedVersionText(null), '');
  assert.strictEqual(fetchedVersionText({ ref: 'main' }), '');
});

test('brokerBuildLine: running broker reports its build', () => {
  const line = brokerBuildLine({ installed: true, manifest: brokerManifest(), sidecarRunning: true, brokerBuild: OLD });
  assert.strictEqual(line.state, 'known');
  assert.strictEqual(line.text, 'aaaaaaa · 2026-09-29 08:05 +0000');
});

// AC6 + edge cases: every "don't know" case is named, never blank.
test('brokerBuildLine: unknown cases are explicit', () => {
  const entry = (extra) => ({ installed: true, manifest: brokerManifest(), ...extra });
  assert.strictEqual(brokerBuildLine(entry({ sidecarRunning: true, brokerBuild: null })).text, 'unknown (image reports no build)');
  assert.strictEqual(brokerBuildLine(entry({ sidecarRunning: true, brokerBuild: { commit: 'unknown' } })).text, 'unknown (image reports no build)');
  assert.strictEqual(brokerBuildLine(entry({ sidecarRunning: false })).text, 'unknown (broker not running)');
  assert.strictEqual(brokerBuildLine(entry({ sidecarRunning: null })).text, 'unknown (broker status unknown)');
  // dummy-echo runs busybox: an external image, not an error.
  const ext = brokerBuildLine({ installed: true, manifest: brokerManifest('busybox:latest'), sidecarRunning: true, brokerBuild: null });
  assert.strictEqual(ext.state, 'external');
  assert.strictEqual(ext.text, 'unknown (external image)');
});

test('brokerBuildLine: no line for command-only, not-installed or invalid plugins', () => {
  assert.strictEqual(brokerBuildLine({ installed: true, manifest: manifest({ id: 'spec-kit', sidecar: undefined }), sidecarRunning: null }), null);
  assert.strictEqual(brokerBuildLine({ installed: false, manifest: brokerManifest(), sidecarRunning: false }), null);
  assert.strictEqual(brokerBuildLine({ installed: true, manifest: null, sidecarRunning: null }), null);
  assert.strictEqual(brokerBuildLine(null), null);
});

// AC5 / AC8: the old sidecar keeps running after the plugin files moved on.
test('buildIdentity: running broker on another commit → mismatch hint', () => {
  const b = buildIdentity({ installed: true, manifest: brokerManifest(), sidecarRunning: true, sourceBuild: NEW, brokerBuild: OLD });
  assert.strictEqual(b.filesLabel, 'Installed files');
  assert.strictEqual(b.files.text, 'bbbbbbb · 2026-09-30 21:08 +0200');
  assert.strictEqual(b.broker.text, 'aaaaaaa · 2026-09-29 08:05 +0000');
  assert.strictEqual(b.mismatch, true);
  assert.deepStrictEqual(b.hints, [{ text: BROKER_MISMATCH_HINT, detail: BROKER_MISMATCH_DETAIL }]);
});

test('buildIdentity: same commit → no hint; dirty vs clean counts as different', () => {
  const same = buildIdentity({ installed: true, manifest: brokerManifest(), sidecarRunning: true, sourceBuild: NEW, brokerBuild: { ...NEW } });
  assert.strictEqual(same.mismatch, false);
  assert.deepStrictEqual(same.hints, []);
  const dirty = buildIdentity({ installed: true, manifest: brokerManifest(), sidecarRunning: true, sourceBuild: NEW, brokerBuild: { ...NEW, dirty: 'dirty' } });
  assert.strictEqual(dirty.mismatch, true);
});

// An unknown side is not evidence of a difference: say "unknown", no hint.
test('buildIdentity: no mismatch hint when either side is unknown', () => {
  const noFiles = buildIdentity({ installed: true, manifest: brokerManifest(), sidecarRunning: true, sourceBuild: null, brokerBuild: OLD });
  assert.strictEqual(noFiles.files.text, 'unknown');
  assert.strictEqual(noFiles.mismatch, false);
  const noBroker = buildIdentity({ installed: true, manifest: brokerManifest(), sidecarRunning: false, sourceBuild: NEW, brokerBuild: null });
  assert.strictEqual(noBroker.mismatch, false);
});

test('imageBuildLine: the image a recreated sidecar would run', () => {
  const entry = (extra) => ({ installed: true, manifest: brokerManifest(), sidecarRunning: true, ...extra });
  const known = imageBuildLine(entry({ imageBuild: NEW }));
  assert.strictEqual(known.state, 'known');
  assert.strictEqual(known.text, 'bbbbbbb · 2026-09-30 21:08 +0200');
  // Also shown when the broker is not running — the next start uses it.
  assert.strictEqual(imageBuildLine(entry({ sidecarRunning: false, imageBuild: NEW })).text, known.text);
  assert.strictEqual(imageBuildLine(entry({ imageBuild: { commit: 'unknown', dirty: '', commitTime: '' } })).text, 'unknown (image reports no build)');
  assert.strictEqual(imageBuildLine(entry({ imageBuild: null })).text, 'unknown (image not inspectable)');
  assert.strictEqual(imageBuildLine(entry({})).text, 'unknown (image not inspectable)');
  assert.strictEqual(imageBuildLine({ installed: true, manifest: brokerManifest('busybox:latest'), imageBuild: { commit: 'unknown' } }).text, 'unknown (external image)');
  assert.strictEqual(imageBuildLine({ installed: true, manifest: manifest({ id: 'spec-kit', sidecar: undefined }) }), null);
  assert.strictEqual(imageBuildLine({ installed: false, manifest: brokerManifest(), imageBuild: NEW }), null);
  assert.strictEqual(imageBuildLine(null), null);
});

// AC8: `make plugin-images` on a new commit while the old sidecar keeps
// running. The registry files are untouched by a rebuild, so files and broker
// agree — only the image moved on. The page must show the old running commit
// and the hint until the sidecar is recreated.
test('buildIdentity: image rebuilt under a running old sidecar → image mismatch hint', () => {
  const b = buildIdentity({ installed: true, manifest: brokerManifest(), sidecarRunning: true, sourceBuild: OLD, brokerBuild: OLD, imageBuild: NEW });
  assert.strictEqual(b.broker.text, 'aaaaaaa · 2026-09-29 08:05 +0000');
  assert.strictEqual(b.image.text, 'bbbbbbb · 2026-09-30 21:08 +0200');
  assert.strictEqual(b.mismatch, true);
  assert.deepStrictEqual(b.hints, [{ text: BROKER_IMAGE_MISMATCH_HINT, detail: BROKER_IMAGE_MISMATCH_DETAIL }]);
  // …and the hint clears once the sidecar is recreated from the new image.
  const recreated = buildIdentity({ installed: true, manifest: brokerManifest(), sidecarRunning: true, sourceBuild: OLD, brokerBuild: NEW, imageBuild: NEW });
  assert.deepStrictEqual(recreated.hints.map((h) => h.text), [BROKER_MISMATCH_HINT]);
  const inStep = buildIdentity({ installed: true, manifest: brokerManifest(), sidecarRunning: true, sourceBuild: NEW, brokerBuild: NEW, imageBuild: NEW });
  assert.strictEqual(inStep.mismatch, false);
});

test('buildIdentity: broker differs from both image and files → both hints', () => {
  const b = buildIdentity({ installed: true, manifest: brokerManifest(), sidecarRunning: true, sourceBuild: NEW, brokerBuild: OLD, imageBuild: NEW });
  assert.deepStrictEqual(b.hints.map((h) => h.text), [BROKER_IMAGE_MISMATCH_HINT, BROKER_MISMATCH_HINT]);
  const dirtyImage = buildIdentity({ installed: true, manifest: brokerManifest(), sidecarRunning: true, sourceBuild: null, brokerBuild: NEW, imageBuild: { ...NEW, dirty: 'dirty' } });
  assert.deepStrictEqual(dirtyImage.hints.map((h) => h.text), [BROKER_IMAGE_MISMATCH_HINT]);
});

test('buildIdentity: no image hint when the broker or the image is unknown', () => {
  const notRunning = buildIdentity({ installed: true, manifest: brokerManifest(), sidecarRunning: false, sourceBuild: NEW, brokerBuild: null, imageBuild: OLD });
  assert.strictEqual(notRunning.mismatch, false);
  const noImage = buildIdentity({ installed: true, manifest: brokerManifest(), sidecarRunning: true, sourceBuild: OLD, brokerBuild: OLD, imageBuild: null });
  assert.strictEqual(noImage.mismatch, false);
  assert.strictEqual(noImage.image.text, 'unknown (image not inspectable)');
});

test('buildIdentity: available plugin shows its pool source only', () => {
  const b = buildIdentity({ installed: false, manifest: brokerManifest(), sidecarRunning: false, sourceBuild: NEW, installedVersion: { repo: 'x/y', ref: 'main' } });
  assert.strictEqual(b.filesLabel, 'Source');
  assert.strictEqual(b.files.text, 'bbbbbbb · 2026-09-30 21:08 +0200');
  assert.strictEqual(b.broker, null);
  assert.strictEqual(b.image, null);
  assert.strictEqual(b.fetched, '');
});

test('buildIdentity: command-only fetch plugin shows its upstream version', () => {
  const b = buildIdentity({
    installed: true, manifest: manifest({ id: 'spec-kit', sidecar: undefined }), sidecarRunning: null,
    sourceBuild: NEW, installedVersion: { repo: 'github/spec-kit', ref: 'v0.0.90', fetchedAt: '2026-09-30T19:08:25.000Z' },
  });
  assert.strictEqual(b.broker, null);
  assert.strictEqual(b.mismatch, false);
  assert.ok(b.fetched.startsWith('github/spec-kit@v0.0.90, fetched '));
});

test('pluginRegistryRow: carries the build identity', () => {
  const row = pluginRegistryRow({ id: 'jira', ok: true, errors: [], installed: true, manifest: brokerManifest(), sidecarRunning: true, sourceBuild: NEW, brokerBuild: OLD });
  assert.strictEqual(row.build.mismatch, true);
  assert.strictEqual(row.build.files.hash, 'bbbbbbb');
});

// #651 source guard: the card renders every build field the view computes.
test('Plugins.jsx renders the build identity block', () => {
  const src = fs.readFileSync(new URL('./Plugins.jsx', import.meta.url), 'utf8');
  assert.match(src, /<BuildIdentity build=\{row\.build\} \/>/);
  assert.match(src, /\{build\.filesLabel\}: <code style=\{mono\}>\{build\.files\.text\}<\/code>/);
  assert.match(src, /\{build\.broker && \(\s*<span>Running broker: <code style=\{mono\}>\{build\.broker\.text\}<\/code><\/span>/);
  assert.match(src, /\{build\.fetched && <span>Fetched from: <code style=\{mono\}>\{build\.fetched\}<\/code><\/span>\}/);
  assert.match(src, /\{build\.image && \(\s*<span>Broker image: <code style=\{mono\}>\{build\.image\.text\}<\/code><\/span>/);
  assert.match(src, /\{build\.hints\.map\(\(hint\) => \(/);
  assert.match(src, /title=\{hint\.detail\}/);
  assert.match(src, /\{hint\.text\}\s*<\/span>/);
});
