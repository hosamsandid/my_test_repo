'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  PLUGIN_ID_RE,
  REGISTRY_DIR_NAME_RE,
  invalidPluginIdMessage,
  isValidPluginId,
  isRemovableRegistryDirName,
} = require('./plugin-registry-ids');

test('valid plugin ids pass both rules', () => {
  for (const id of ['jira', 'patterns-catalog', 'a', '0x']) {
    assert.equal(isValidPluginId(id), true, id);
    assert.equal(isRemovableRegistryDirName(id), true, id);
  }
});

test('a backup copy with a dot is not a plugin id but is removable (#2649)', () => {
  const name = 'jira.bak-20260930-210131';
  assert.equal(isValidPluginId(name), false);
  assert.equal(isRemovableRegistryDirName(name), true);
});

test('nothing that could leave the registry dir is removable', () => {
  for (const name of ['', '.', '..', '../x', 'a/b', 'a\\b', '.hidden', '_secret', '_credentials', '-x', 'x'.repeat(129), null, undefined, 42]) {
    assert.equal(isRemovableRegistryDirName(name), false, String(name));
    assert.equal(isValidPluginId(name), false, String(name));
  }
});

test('the invalid-id message names the id and the allowed characters', () => {
  const m = invalidPluginIdMessage('jira.bak');
  assert.match(m, /"jira\.bak"/);
  assert.match(m, /lowercase letters, digits or hyphens/);
});

test('api.js uses the shared rules: readPluginDir message and a DELETE that can remove a broken entry', () => {
  const src = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  assert.doesNotMatch(src, /const PLUGIN_ID_RE = /, 'PLUGIN_ID_RE must come from plugin-registry-ids.js');
  assert.match(src, /errors: \[invalidPluginIdMessage\(id\)\]/);
  const start = src.indexOf("app.delete('/api/plugins/:id',");
  const del = src.slice(start, src.indexOf('\n});', start));
  assert.match(del, /if \(!isRemovableRegistryDirName\(id\)\) return res\.status\(400\)/);
  // Credentials are only reaped for a valid id.
  assert.match(del, /if \(PLUGIN_ID_RE\.test\(id\)\) \{\s*try \{\s*const credRoot/);
});

test('PLUGIN_ID_RE is unchanged', () => {
  assert.equal(PLUGIN_ID_RE.source, '^[a-z0-9][a-z0-9-]{0,62}$');
});

test('the console view gates Remove on the same dir-name rule DELETE uses', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'plugin-registry-view.js'), 'utf8');
  const m = view.match(/export const REMOVABLE_DIR_NAME_RE = \/(.+)\/;/);
  assert.ok(m, 'REMOVABLE_DIR_NAME_RE literal not found');
  assert.equal(m[1], REGISTRY_DIR_NAME_RE.source);
});

test('GET /api/plugins reports the stack runtime from AEE_CONTAINER_RUNTIME (#2649 B1)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const start = src.indexOf("app.get('/api/plugins', ");
  assert.ok(start >= 0);
  const get = src.slice(start, src.indexOf('\n});', start));
  assert.match(get, /stackRuntime: normalizeToolchainRuntime\(process\.env\.AEE_CONTAINER_RUNTIME\),/);
  assert.match(src, /normalizeRuntime: normalizeToolchainRuntime,[\s\S]*?\} = require\('\.\/toolchain-registry'\);/);
  // …and the values it can report are exactly the ones a manifest's `platforms` uses.
  const { normalizeRuntime } = require('./toolchain-registry');
  assert.equal(normalizeRuntime('kubernetes'), 'kubernetes');
  assert.equal(normalizeRuntime('K8S'), 'kubernetes');
  assert.equal(normalizeRuntime(undefined), 'podman');
  assert.equal(normalizeRuntime('podman'), 'podman');
});

test('the k8s overlay tells the console it runs on kubernetes', () => {
  const yaml = fs.readFileSync(path.join(__dirname, '..', '..', 'deploy', 'k8s', 'base', 'app', '50-admin-console.yaml'), 'utf8');
  assert.match(yaml, /- name: AEE_CONTAINER_RUNTIME\s+value: kubernetes/);
});
