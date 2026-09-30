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
  isInvalidInstalled,
  needsBrokerPoll,
  BROKER_START_WINDOW_MS,
  uninstallDialog,
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
  assert.equal(a.label, 'Cannot install');
  // The error is listed on the card already; the hint must not repeat it (#2649).
  assert.doesNotMatch(a.hint, /unknown entries/);
  assert.match(a.hint, /errors above/);
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
  // No manifest → no invented defaults (#2649).
  assert.equal(row.quota, '');
  assert.deepEqual(row.scopes, []);
  assert.equal(row.invalid, false, 'an available (not installed) broken entry is not an invalid INSTALLED one');
});

// ── #2649: starting state, and invalid registry entries ─────────────────────

test('a broker just installed from the page reads "starting", not "not running"', () => {
  const entry = { id: 'p', ok: true, errors: [], manifest: manifest(), installed: true, sidecarRunning: false };
  const s = sidecarStatus(entry, { startingSince: 1000, now: 1000 + 5_000, stackRuntime: 'podman' });
  assert.equal(s.state, 'starting');
  assert.match(s.label, /starting/i);
  assert.doesNotMatch(s.label, /not running/i);
  // Without an install from this page the old "not running" still applies.
  assert.equal(sidecarStatus(entry, { stackRuntime: 'podman' }).state, 'stopped');
});

test('once running, the starting window no longer matters', () => {
  const entry = { id: 'p', ok: true, errors: [], manifest: manifest(), installed: true, sidecarRunning: true };
  assert.equal(sidecarStatus(entry, { startingSince: 1000, now: 1001 }).state, 'running');
});

test('a broker that never comes up turns into "did not start" with a reason', () => {
  const entry = { id: 'p', ok: true, errors: [], manifest: manifest(), installed: true, sidecarRunning: false };
  const at = (ms) => sidecarStatus(entry, { startingSince: 0, now: ms, stackRuntime: 'podman' });
  assert.equal(at(BROKER_START_WINDOW_MS - 1).state, 'starting');
  const s = at(BROKER_START_WINDOW_MS);
  assert.equal(s.state, 'failed');
  assert.equal(s.tone, 'warn');
  assert.match(s.label, /did not start/);
  assert.match(s.reason, /make plugin-images/);
  assert.match(s.reason, /orchestrator log/);
});

test('a platform mismatch is named as the reason instead of a "starting" wait', () => {
  const entry = { id: 'p', ok: true, errors: [], manifest: manifest({ platforms: ['podman'] }), installed: true, sidecarRunning: false };
  const s = sidecarStatus(entry, { startingSince: 0, now: 1, stackRuntime: 'kubernetes' });
  assert.equal(s.state, 'stopped');
  assert.match(s.reason, /declares podman but the stack runs kubernetes/);
  // Also on a plain page load, not only right after install.
  assert.match(sidecarStatus(entry, { stackRuntime: 'kubernetes' }).reason, /runs kubernetes/);
  assert.equal(sidecarStatus(entry, { stackRuntime: 'podman' }).reason, '');
});

test('needsBrokerPoll is true only while some broker is starting', () => {
  const mk = (state) => ({ status: { state } });
  assert.equal(needsBrokerPoll([mk('running'), mk('starting')]), true);
  assert.equal(needsBrokerPoll([mk('running'), mk('stopped'), mk('failed'), mk('invalid')]), false);
  assert.equal(needsBrokerPoll([]), false);
  assert.equal(needsBrokerPoll(null), false);
});

test('pluginRegistryRow threads the starting window into the status', () => {
  const entry = { id: 'p', ok: true, errors: [], manifest: manifest(), installed: true, sidecarRunning: false };
  const row = pluginRegistryRow(entry, { canManage: true, stackRuntime: 'podman', startingSince: 0, now: 10 });
  assert.equal(row.status.state, 'starting');
  assert.equal(needsBrokerPoll([row]), true);
});

test('an invalid installed entry is marked broken, with no plugin defaults', () => {
  const entry = {
    id: 'jira.bak-20260930-210131', ok: false, installed: true, sidecarRunning: null, manifest: null,
    errors: ['invalid plugin id "jira.bak-20260930-210131": a plugin id must be …'],
  };
  assert.equal(isInvalidInstalled(entry), true);
  const row = pluginRegistryRow(entry, { canManage: true, stackRuntime: 'podman', startingSince: 0, now: 1 });
  assert.equal(row.invalid, true);
  assert.equal(row.status.state, 'invalid');
  assert.doesNotMatch(row.status.label, /broker/i);
  assert.deepEqual(row.scopes, []);
  assert.equal(row.quota, '');
  assert.deepEqual(row.capabilities, []);
  assert.equal(row.errors.length, 1);
  assert.equal(needsBrokerPoll([row]), false, 'a broken entry never polls');
});

test('an invalid installed entry can be removed by a System Admin only', () => {
  const entry = { id: 'x.bak', ok: false, installed: true, errors: ['e'], manifest: null };
  const admin = installAction(entry, { canManage: true, stackRuntime: 'podman' });
  assert.equal(admin.action, 'uninstall');
  assert.equal(admin.label, 'Remove');
  assert.equal(admin.disabled, false);
  assert.equal(admin.hint, '');
  const viewer = installAction(entry, { canManage: false, stackRuntime: 'podman' });
  assert.equal(viewer.disabled, true);
  assert.match(viewer.hint, /System Admin/);
});

test('the remove confirm for a broken entry does not talk about a broker', () => {
  const d = uninstallDialog({ id: 'x.bak', name: 'x.bak', invalid: true });
  assert.equal(d.title, 'Remove x.bak?');
  assert.equal(d.confirmLabel, 'Remove');
  assert.match(d.body, /not a valid plugin/);
  const u = uninstallDialog({ id: 'jira', name: 'Jira', invalid: false });
  assert.equal(u.title, 'Uninstall Jira?');
  assert.equal(u.confirmLabel, 'Uninstall');
  assert.equal(u.body, '');
});
