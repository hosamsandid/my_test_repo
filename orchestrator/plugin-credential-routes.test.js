'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginCredentialWiring } = require('./plugin-credential-routes');
const { PluginCredentialStore } = require('./plugin-credential-store');

const JIRA_CREDS = [
  { key: 'site-url', required: true },
  { key: 'email', required: true },
  { key: 'api-token', required: true },
];

// A minimal fake platform: two teams, jira granted to team-1 only.
function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcr-'));
  const credentialStore = new PluginCredentialStore({ dir });
  const configs = {
    'team-1': { id: 'team-1', role: 'team', token: 't', displayName: 'Team One', plugins: [{ id: 'jira', scopeGranularity: 'team' }] },
    'team-2': { id: 'team-2', role: 'team', token: 't', displayName: 'Team Two', plugins: [] },
    'stub': { id: 'stub', role: 'team-member', parentTeamId: 'team-1', plugins: [] }, // no token
  };
  const pushes = [];
  const wiring = createPluginCredentialWiring({
    listAgentIds: () => Object.keys(configs),
    loadAgentConfig: (id) => configs[id] || null,
    pluginRegistry: {
      installedManifests: () => ({ jira: { id: 'jira', credentials: JIRA_CREDS }, 'github-issues': { id: 'github-issues', credentials: [] } }),
      readPluginManifest: (id) => (id === 'jira' ? { ok: true, manifest: { id: 'jira', credentials: JIRA_CREDS } } : { ok: false }),
    },
    pluginRuntime: { pushScopeCredentials: async (m, scopes) => { pushes.push({ id: m.id, scopes }); } },
    effectivePlugins: (cfg) => cfg.plugins || [],
    pluginGrantFor: (grants, pid) => (grants || []).find((g) => g.id === pid) || null,
    resolveScopeId: (cfg, gran) => (cfg.role === 'team' ? cfg.id : cfg.parentTeamId),
    credentialStore,
  });
  return { wiring, credentialStore, pushes, dir };
}

function fakeRes() {
  return { _status: 0, _body: null, writeHead(s) { this._status = s; }, end(b) { this._body = JSON.parse(b); } };
}
const sendJson = (res, s, o) => { res.writeHead(s); res.end(JSON.stringify(o)); };
const readBodyOf = (obj) => () => Promise.resolve(obj);

test('grantedTeamScopeIds: only teams with the grant; tokenless stub excluded', () => {
  const { wiring } = harness();
  assert.deepEqual(wiring.grantedTeamScopeIds('jira'), ['team-1']);
});

test('grantedTeamScopeIds: one malformed agent config is skipped, not a throw for every caller', () => {
  // `loadAgentConfig` throws on invalid JSON. Unguarded, one corrupt
  // `config.json` anywhere in the installation 500s the credential routes AND
  // every plugin-event delivery (the same scan) — with the broker's cursor
  // already advanced, those events are lost.
  const h = harness();
  const configs = {
    'team-1': { id: 'team-1', role: 'team', token: 't', plugins: [{ id: 'jira', scopeGranularity: 'team' }] },
    'broken': null,
    'team-3': { id: 'team-3', role: 'team', token: 't', plugins: [{ id: 'jira', scopeGranularity: 'team' }] },
  };
  const wiring = createPluginCredentialWiring({
    listAgentIds: () => Object.keys(configs),
    loadAgentConfig: (id) => { if (id === 'broken') throw new SyntaxError('Unexpected token } in JSON'); return configs[id]; },
    pluginRegistry: { installedManifests: () => ({}), readPluginManifest: () => ({ ok: false }) },
    pluginRuntime: { pushScopeCredentials: async () => {} },
    effectivePlugins: (cfg) => cfg.plugins || [],
    pluginGrantFor: (grants, pid) => (grants || []).find((g) => g.id === pid) || null,
    resolveScopeId: (cfg) => cfg.id,
    credentialStore: h.credentialStore,
  });
  assert.deepEqual(wiring.grantedTeamScopeIds('jira'), ['team-1', 'team-3']);
});

test('pushDeclaredScopeCredentials: pushes jira only (github-issues skipped); every granted scope gets an entry', async () => {
  const { wiring, credentialStore, pushes } = harness();
  credentialStore.write('jira', 'team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' }, JIRA_CREDS, { setBy: 'x' });
  await wiring.pushDeclaredScopeCredentials();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].id, 'jira');
  assert.deepEqual(pushes[0].scopes, { 'team-1': { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' } });
});

test('GET route: metadata for every granted scope, no raw values', async () => {
  const { wiring, credentialStore } = harness();
  credentialStore.write('jira', 'team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'supersecrettoken' }, JIRA_CREDS, { setBy: 'alice' });
  const res = fakeRes();
  const handled = await wiring.handleCredentialRoute(
    { method: 'GET', url: '/internal/plugins/jira/credentials' }, res, { sendJson, readBody: readBodyOf({}) },
  );
  assert.equal(handled, true);
  assert.equal(res._status, 200);
  assert.deepEqual(res._body.scopes.map((s) => s.scopeId), ['team-1']);
  assert.equal(res._body.scopes[0].complete, true);
  assert.equal(res._body.scopes[0].setBy, 'alice');
  assert.equal(JSON.stringify(res._body).includes('supersecrettoken'), false);
});

test('PUT route: writes, re-pushes, refuses a scope the plugin is not granted to', async () => {
  const { wiring, credentialStore, pushes } = harness();
  // not granted → 409
  let res = fakeRes();
  await wiring.handleCredentialRoute(
    { method: 'PUT', url: '/internal/plugins/jira/credentials/team-2' }, res,
    { sendJson, readBody: readBodyOf({ values: { 'site-url': 'x' }, setBy: 'bob' }) },
  );
  assert.equal(res._status, 409);

  // granted → 200 + a push happened
  res = fakeRes();
  await wiring.handleCredentialRoute(
    { method: 'PUT', url: '/internal/plugins/jira/credentials/team-1' }, res,
    { sendJson, readBody: readBodyOf({ values: { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' }, setBy: 'bob' }) },
  );
  assert.equal(res._status, 200);
  assert.equal(res._body.complete, true);
  assert.equal(credentialStore.meta('jira', 'team-1', JIRA_CREDS).setBy, 'bob');
  assert.equal(pushes.length, 1);
});

test('DELETE route: clears + re-pushes', async () => {
  const { wiring, credentialStore, pushes } = harness();
  credentialStore.write('jira', 'team-1', { 'site-url': 'a', email: 'b', 'api-token': 'c' }, JIRA_CREDS, { setBy: 'x' });
  const res = fakeRes();
  await wiring.handleCredentialRoute(
    { method: 'DELETE', url: '/internal/plugins/jira/credentials/team-1' }, res, { sendJson, readBody: readBodyOf({}) },
  );
  assert.equal(res._status, 200);
  assert.equal(credentialStore.read('jira', 'team-1'), null);
  assert.equal(pushes.length, 1);
});

test('a non-credentials URL is not handled (returns false)', async () => {
  const { wiring } = harness();
  const handled = await wiring.handleCredentialRoute({ method: 'GET', url: '/internal/plugins/jira/granted-agents' }, fakeRes(), { sendJson, readBody: readBodyOf({}) });
  assert.equal(handled, false);
});
