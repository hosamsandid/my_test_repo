'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  validatePluginManifest,
  grantableGranularities,
  assertGranularityGrantable,
  isValidCapability,
} = require('./plugin-manifest');

// A minimal valid manifest we clone-and-mutate per case.
function base() {
  return {
    pluginVersion: 1,
    id: 'podman-sandbox',
    name: 'Podman Container Sandbox',
    description: 'Agents spawn and manage their own compose stacks.',
    sidecar: { image: 'aee-plugin-podman:latest', capabilities: ['podman-socket'], internalPort: 4004 },
    cli: { name: 'aee-podman', entrypoint: 'bin/aee-podman.py', runtime: 'python3' },
    credentials: [{ key: 'api-token', description: 'Backend API token', required: true }],
    platforms: ['podman'],
    scopes: ['team', 'agent'],
    requiresApproval: ['compose up', 'rm'],
    ui: { title: 'Sandbox Dashboard', routes: [{ path: '/', minRole: 'team-member' }, { path: '/admin', minRole: 'team-admin' }] },
    companionSkill: 'batch-parity-testing',
    promptLine: 'You can spawn containers with `aee-podman`.',
  };
}

test('accepts a complete valid manifest and normalizes it', () => {
  const { ok, errors, manifest } = validatePluginManifest(base());
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  assert.equal(manifest.pluginVersion, 1);
  assert.equal(manifest.id, 'podman-sandbox');
  assert.deepEqual(manifest.scopes, ['team', 'agent']);
  assert.deepEqual(manifest.sidecar.capabilities, ['podman-socket']);
  assert.equal(manifest.ui.routes.length, 2);
  assert.equal(manifest.credentials[0].required, true);
});

test('accepts a minimal manifest and fills defaults', () => {
  const { ok, manifest } = validatePluginManifest({
    pluginVersion: 1,
    id: 'x',
    name: 'X',
    description: 'd',
    sidecar: { image: 'img:1', internalPort: 8080 },
    cli: { name: 'aee-x', entrypoint: 'bin/x.js', runtime: 'node' },
  });
  assert.equal(ok, true);
  assert.deepEqual(manifest.platforms, ['any']);
  assert.deepEqual(manifest.scopes, ['team']);
  assert.deepEqual(manifest.credentials, []);
  assert.deepEqual(manifest.requiresApproval, []);
  assert.deepEqual(manifest.sidecar.capabilities, []);
  assert.equal('ui' in manifest, false);
});

test('rejects non-object input', () => {
  assert.equal(validatePluginManifest(null).ok, false);
  assert.equal(validatePluginManifest('nope').ok, false);
  assert.equal(validatePluginManifest([]).ok, false);
});

test('rejects wrong pluginVersion / bad id / missing name', () => {
  const r = validatePluginManifest({ ...base(), pluginVersion: 2, id: 'Bad Id', name: '' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /pluginVersion/.test(e)));
  assert.ok(r.errors.some((e) => /id must be a slug/.test(e)));
  assert.ok(r.errors.some((e) => /name is required/.test(e)));
});

test('rejects missing/invalid sidecar', () => {
  assert.ok(validatePluginManifest({ ...base(), sidecar: undefined }).errors.some((e) => /sidecar is required/.test(e)));
  const noPort = validatePluginManifest({ ...base(), sidecar: { image: 'i:1' } });
  assert.ok(noPort.errors.some((e) => /internalPort/.test(e)));
  const badPort = validatePluginManifest({ ...base(), sidecar: { image: 'i:1', internalPort: 70000 } });
  assert.ok(badPort.errors.some((e) => /internalPort/.test(e)));
});

test('rejects unknown sidecar capability but accepts host-mount', () => {
  const bad = validatePluginManifest({ ...base(), sidecar: { image: 'i:1', internalPort: 1, capabilities: ['root-fs'] } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /unknown entries/.test(e)));

  const good = validatePluginManifest({ ...base(), sidecar: { image: 'i:1', internalPort: 1, capabilities: ['host-mount:/srv/data', 'egress'] } });
  assert.equal(good.ok, true);
  assert.deepEqual(good.manifest.sidecar.capabilities, ['host-mount:/srv/data', 'egress']);
});

test('isValidCapability guards host-mount path traversal + relative paths', () => {
  assert.equal(isValidCapability('podman-socket'), true);
  assert.equal(isValidCapability('egress'), true);
  assert.equal(isValidCapability('host-mount:/srv/x'), true);
  assert.equal(isValidCapability('host-mount:relative'), false);
  assert.equal(isValidCapability('host-mount:/a/../etc'), false);
  assert.equal(isValidCapability('host-mount:/'), false);
  assert.equal(isValidCapability('nonsense'), false);
});

test('rejects invalid cli (bad runtime, absolute/traversal entrypoint)', () => {
  assert.ok(validatePluginManifest({ ...base(), cli: { name: 'x', entrypoint: 'bin/x', runtime: 'ruby' } }).errors.some((e) => /cli.runtime/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), cli: { name: 'x', entrypoint: '/etc/passwd', runtime: 'node' } }).errors.some((e) => /entrypoint/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), cli: { name: 'x', entrypoint: '../x', runtime: 'node' } }).errors.some((e) => /entrypoint/.test(e)));
});

// ── ACCEPTANCE: grant-able granularity absent from `scopes` ──────────────────
test('rejects scopes with an unknown granularity', () => {
  const r = validatePluginManifest({ ...base(), scopes: ['team', 'organization'] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown granularities/.test(e)));
});

test('rejects scopes missing the mandatory "team" default', () => {
  const r = validatePluginManifest({ ...base(), scopes: ['agent'] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /must include "team"/.test(e)));
});

test('assertGranularityGrantable rejects a granularity absent from scopes', () => {
  const teamOnly = validatePluginManifest({ ...base(), scopes: ['team'] }).manifest;
  assert.equal(assertGranularityGrantable(teamOnly, 'team'), null);
  assert.ok(/does not honour/.test(assertGranularityGrantable(teamOnly, 'agent')));

  const both = validatePluginManifest(base()).manifest;
  assert.equal(assertGranularityGrantable(both, 'agent'), null);

  assert.ok(/unknown scope granularity/.test(assertGranularityGrantable(both, 'galaxy')));
  assert.deepEqual(grantableGranularities(teamOnly), ['team']);
});

// ── ACCEPTANCE: ui.routes entry with an unknown minRole ──────────────────────
test('rejects a ui.routes entry with an unknown minRole', () => {
  const r = validatePluginManifest({ ...base(), ui: { routes: [{ path: '/', minRole: 'superuser' }] } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown role "superuser"/.test(e)));
});

test('rejects ui.routes path without leading slash and duplicate paths', () => {
  assert.ok(validatePluginManifest({ ...base(), ui: { routes: [{ path: 'admin', minRole: 'team-admin' }] } }).errors.some((e) => /path must be/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), ui: { routes: [{ path: '/', minRole: 'team-member' }, { path: '/', minRole: 'team-admin' }] } }).errors.some((e) => /duplicate ui.routes path/.test(e)));
});

test('rejects duplicate credential keys and non-string env values', () => {
  assert.ok(validatePluginManifest({ ...base(), credentials: [{ key: 'a' }, { key: 'a' }] }).errors.some((e) => /duplicate credential key/.test(e)));
  assert.ok(validatePluginManifest({ ...base(), sidecar: { image: 'i:1', internalPort: 1, env: { N: 5 } } }).errors.some((e) => /env values must all be strings/.test(e)));
});

test('rejects unknown platforms', () => {
  assert.ok(validatePluginManifest({ ...base(), platforms: ['k8s'] }).errors.some((e) => /platforms has unknown/.test(e)));
});
