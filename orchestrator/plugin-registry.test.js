'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  listPluginIds,
  readPluginManifest,
  listPlugins,
  installedManifests,
  cliEntrypointPath,
  promptDisplayFor,
  readOrCreateSigningSecret,
  SECRET_FILE,
} = require('./plugin-registry');

function tmpRegistry() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-registry-'));
}

function writePlugin(dir, id, manifest, { cli = 'bin/aee-x.py' } = {}) {
  const pluginDir = path.join(dir, id);
  fs.mkdirSync(path.join(pluginDir, path.dirname(cli)), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, cli), '#!/usr/bin/env python3\n');
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  return pluginDir;
}

function validManifest(id, extra = {}) {
  return {
    pluginVersion: 1,
    id,
    name: `Plugin ${id}`,
    description: 'a test plugin',
    sidecar: { image: `localhost/aee-plugin-${id}:latest`, capabilities: [], internalPort: 4004 },
    cli: { name: 'aee-x', entrypoint: 'bin/aee-x.py', runtime: 'python3' },
    ...extra,
  };
}

test('a missing registry directory is an empty registry, not an error', () => {
  assert.deepEqual(listPluginIds('/nonexistent/registry/path'), []);
  assert.deepEqual(listPlugins('/nonexistent/registry/path'), []);
  assert.deepEqual(installedManifests('/nonexistent/registry/path'), {});
});

test('listPluginIds returns sorted plugin dirs and skips platform state', () => {
  const dir = tmpRegistry();
  writePlugin(dir, 'zeta', validManifest('zeta'));
  writePlugin(dir, 'alpha', validManifest('alpha'));
  fs.writeFileSync(path.join(dir, SECRET_FILE), 'shhh\n');
  fs.mkdirSync(path.join(dir, '_scratch'));
  fs.mkdirSync(path.join(dir, '.hidden'));

  assert.deepEqual(listPluginIds(dir), ['alpha', 'zeta']);
});

test('a valid manifest reads back normalised', () => {
  const dir = tmpRegistry();
  writePlugin(dir, 'demo', validManifest('demo', { scopes: ['team', 'agent'], defaultScopeGranularity: 'agent' }));

  const entry = readPluginManifest('demo', dir);
  assert.equal(entry.ok, true);
  assert.deepEqual(entry.errors, []);
  assert.equal(entry.manifest.id, 'demo');
  assert.deepEqual(entry.manifest.scopes, ['team', 'agent']);
  assert.equal(entry.manifest.defaultScopeGranularity, 'agent');
});

test('a manifest whose id disagrees with its directory is refused', () => {
  const dir = tmpRegistry();
  writePlugin(dir, 'on-disk', validManifest('in-manifest'));

  const entry = readPluginManifest('on-disk', dir);
  assert.equal(entry.ok, false);
  assert.equal(entry.manifest, null);
  assert.match(entry.errors[0], /does not match registry directory/);
});

test('unreadable and malformed manifests report errors instead of throwing', () => {
  const dir = tmpRegistry();
  fs.mkdirSync(path.join(dir, 'empty'));
  fs.mkdirSync(path.join(dir, 'broken'));
  fs.writeFileSync(path.join(dir, 'broken', 'plugin.json'), '{ not json');

  assert.match(readPluginManifest('empty', dir).errors[0], /cannot read plugin\.json/);
  assert.match(readPluginManifest('broken', dir).errors[0], /invalid JSON/);
});

test('readPluginManifest refuses an id that is not a single registry directory name', () => {
  const dir = tmpRegistry();
  const outside = path.join(dir, '..', `escape-${path.basename(dir)}`);
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'plugin.json'), JSON.stringify({ id: 'x' }));
  for (const id of [`../escape-${path.basename(dir)}`, 'a/b', '..', '.', '_secret', '', undefined]) {
    const entry = readPluginManifest(id, dir);
    assert.equal(entry.ok, false, `id ${String(id)}`);
    assert.deepEqual(entry.errors, ['invalid plugin id']);
  }
  fs.rmSync(outside, { recursive: true, force: true });
});

test('installedManifests fails closed — an invalid plugin is not installed for the privileged paths', () => {
  const dir = tmpRegistry();
  writePlugin(dir, 'good', validManifest('good'));
  // capabilities is a closed enum: an unknown entry must not reach the sidecar path.
  writePlugin(dir, 'bad', validManifest('bad', { sidecar: { image: 'x', capabilities: ['root-everything'], internalPort: 1 } }));

  const listed = listPlugins(dir);
  assert.equal(listed.length, 2, 'the registry UI still sees the broken plugin');
  assert.equal(listed.find((e) => e.id === 'bad').ok, false);

  const manifests = installedManifests(dir);
  assert.deepEqual(Object.keys(manifests), ['good'], 'the privileged path only sees the valid one');
});

test('cliEntrypointPath resolves inside the plugin dir and refuses an escape', () => {
  const dir = tmpRegistry();
  writePlugin(dir, 'demo', validManifest('demo'));
  const manifest = readPluginManifest('demo', dir).manifest;

  assert.equal(cliEntrypointPath(manifest, dir), path.resolve(dir, 'demo', 'bin/aee-x.py'));

  // The validator already rejects "..", but containment is re-checked here so a
  // hand-built manifest object cannot walk out of the plugin directory.
  const escaping = { ...manifest, cli: { ...manifest.cli, entrypoint: 'bin/../../other/evil.py' } };
  assert.equal(cliEntrypointPath(escaping, dir), null);
});

test('promptDisplayFor carries the authored line and the grant granularity', () => {
  const dir = tmpRegistry();
  writePlugin(dir, 'demo', validManifest('demo', {
    scopes: ['team', 'agent'],
    defaultScopeGranularity: 'agent',
    promptLine: 'You can do the thing with `aee-x`.',
  }));
  const manifest = readPluginManifest('demo', dir).manifest;

  assert.deepEqual(promptDisplayFor(manifest, 'team'), {
    id: 'demo',
    name: 'Plugin demo',
    cliName: 'aee-x',
    scopeGranularity: 'team',
    promptLine: 'You can do the thing with `aee-x`.',
  });
  // No granularity supplied → the manifest's own default, not the platform one.
  assert.equal(promptDisplayFor(manifest).scopeGranularity, 'agent');
});

test('the signing secret is created once, 0600, and stable across reads', () => {
  const dir = tmpRegistry();
  const first = readOrCreateSigningSecret(dir);
  assert.ok(first.length >= 32);

  const mode = fs.statSync(path.join(dir, SECRET_FILE)).mode & 0o777;
  assert.equal(mode, 0o600);

  assert.equal(readOrCreateSigningSecret(dir), first, 'a second read must not re-mint');
});

test('a loosely-permissioned secret is tightened on read', () => {
  const dir = tmpRegistry();
  readOrCreateSigningSecret(dir);
  const file = path.join(dir, SECRET_FILE);
  fs.chmodSync(file, 0o644);

  readOrCreateSigningSecret(dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
