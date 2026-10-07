'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginCredentialWiring, shapeCredentialTest } = require('./plugin-credential-routes');
const { PluginCredentialStore } = require('./plugin-credential-store');

const JIRA_CREDS = [
  { key: 'site-url', required: true },
  { key: 'email', required: true },
  { key: 'api-token', required: true },
];

// A minimal fake platform: two teams, jira granted to team-1 only.
function harness({ testScopeCredential } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcr-'));
  const credentialStore = new PluginCredentialStore({ dir });
  const configs = {
    'team-1': { id: 'team-1', role: 'team', token: 't', displayName: 'Team One', plugins: [{ id: 'jira', scopeGranularity: 'team' }] },
    'team-2': { id: 'team-2', role: 'team', token: 't', displayName: 'Team Two', plugins: [] },
    'stub': { id: 'stub', role: 'team-member', parentTeamId: 'team-1', plugins: [] }, // no token
  };
  const pushes = [];
  const tests = [];
  const wiring = createPluginCredentialWiring({
    listAgentIds: () => Object.keys(configs),
    loadAgentConfig: (id) => configs[id] || null,
    pluginRegistry: {
      installedManifests: () => ({ jira: { id: 'jira', credentials: JIRA_CREDS }, 'github-issues': { id: 'github-issues', credentials: [] } }),
      readPluginManifest: (id) => (id === 'jira' ? { ok: true, manifest: { id: 'jira', credentials: JIRA_CREDS } } : { ok: false }),
    },
    pluginRuntime: {
      pushScopeCredentials: async (m, scopes) => { pushes.push({ id: m.id, scopes }); },
      testScopeCredential: async (m, scopeId) => {
        tests.push({ id: m.id, scopeId });
        return testScopeCredential ? testScopeCredential(m, scopeId) : { ok: true, status: 200, body: { ok: true, state: 'connected', message: 'Connected as Bot.', account: 'Bot' } };
      },
    },
    effectivePlugins: (cfg) => cfg.plugins || [],
    pluginGrantFor: (grants, pid) => (grants || []).find((g) => g.id === pid) || null,
    resolveScopeId: (cfg, gran) => (cfg.role === 'team' ? cfg.id : cfg.parentTeamId),
    credentialStore,
  });
  return { wiring, credentialStore, pushes, tests, dir };
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

test('POST …/:scopeId/test: asks the broker for a granted scope; 409 for another; wrong method 405 (#2640)', async () => {
  const { wiring, tests } = harness();
  let res = fakeRes();
  let handled = await wiring.handleCredentialRoute(
    { method: 'POST', url: '/internal/plugins/jira/credentials/team-1/test' }, res, { sendJson, readBody: readBodyOf({}) },
  );
  assert.equal(handled, true);
  assert.equal(res._status, 200);
  assert.deepEqual(tests, [{ id: 'jira', scopeId: 'team-1' }]);
  assert.equal(res._body.scopeId, 'team-1');
  assert.equal(res._body.result.ok, true);
  assert.equal(res._body.result.message, 'Connected as Bot.');
  assert.equal(res._body.result.account, 'Bot');

  res = fakeRes();
  await wiring.handleCredentialRoute(
    { method: 'POST', url: '/internal/plugins/jira/credentials/team-2/test' }, res, { sendJson, readBody: readBodyOf({}) },
  );
  assert.equal(res._status, 409);
  assert.equal(tests.length, 1); // a scope the plugin is not granted to never reaches the broker

  res = fakeRes();
  await wiring.handleCredentialRoute(
    { method: 'GET', url: '/internal/plugins/jira/credentials/team-1/test' }, res, { sendJson, readBody: readBodyOf({}) },
  );
  assert.equal(res._status, 405);
  assert.equal(tests.length, 1);
});

test('POST …/test: a throwing runtime is a shown result, not a 500', async () => {
  const { wiring } = harness({ testScopeCredential: async () => { throw new Error('boom'); } });
  const res = fakeRes();
  await wiring.handleCredentialRoute(
    { method: 'POST', url: '/internal/plugins/jira/credentials/team-1/test' }, res, { sendJson, readBody: readBodyOf({}) },
  );
  assert.equal(res._status, 200);
  assert.equal(res._body.result.ok, false);
  assert.equal(res._body.result.state, 'broker-unreachable');
});

test('shapeCredentialTest: broker answers become a fixed-shape result; nothing else passes through', () => {
  assert.equal(shapeCredentialTest({ ok: false, supported: false }).state, 'unsupported');
  assert.equal(shapeCredentialTest({ ok: false, status: 404, body: { error: 'not found' } }).state, 'not-testable');
  assert.equal(shapeCredentialTest({ ok: false, error: 'timeout' }).state, 'broker-unreachable');
  assert.equal(shapeCredentialTest({ ok: false, error: 'no token' }).state, 'broker-unreachable');
  const e = shapeCredentialTest({ ok: false, status: 500, body: { error: 'x' } });
  assert.equal(e.state, 'broker-error');
  assert.match(e.message, /HTTP 500/);

  const r = shapeCredentialTest({ ok: true, status: 200, body: {
    ok: false, state: 'rejected', message: 'Token rejected (401).', httpStatus: 401, account: null,
    checkedAt: '2026-09-30T00:00:00.000Z', apiToken: 'supersecrettoken', values: { 'api-token': 'supersecrettoken' },
  } });
  assert.deepEqual(Object.keys(r).sort(), ['account', 'checkedAt', 'httpStatus', 'message', 'ok', 'state']);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'rejected');
  assert.equal(r.httpStatus, 401);
  assert.equal(JSON.stringify(r).includes('supersecrettoken'), false);

  // `ok` must be literally true — a truthy string is not success
  assert.equal(shapeCredentialTest({ ok: true, status: 200, body: { ok: 'yes', message: 'm' } }).ok, false);
  // an over-long message is capped
  assert.equal(shapeCredentialTest({ ok: true, status: 200, body: { ok: true, message: 'x'.repeat(1000) } }).message.length, 300);
});

test('a non-credentials URL is not handled (returns false)', async () => {
  const { wiring } = harness();
  const handled = await wiring.handleCredentialRoute({ method: 'GET', url: '/internal/plugins/jira/granted-agents' }, fakeRes(), { sendJson, readBody: readBodyOf({}) });
  assert.equal(handled, false);
});

// ── personal credentials (#2562) ────────────────────────────────────────────

const PERSONAL = [{ key: 'email', required: true, secret: false }, { key: 'api-token', required: true }];

function personalHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcr-personal-'));
  const credentialStore = new PluginCredentialStore({ dir });
  const pushes = [];
  const readIds = [];
  const jira = { id: 'jira', name: 'Jira', credentials: JIRA_CREDS, personalCredentials: PERSONAL };
  const wiring = createPluginCredentialWiring({
    listAgentIds: () => [],
    loadAgentConfig: () => null,
    pluginRegistry: {
      installedManifests: () => ({ jira, other: { id: 'other', credentials: [] } }),
      readPluginManifest: (id) => (readIds.push(id), id === 'jira' ? { ok: true, manifest: jira } : id === 'other' ? { ok: true, manifest: { id: 'other', credentials: [] } } : { ok: false }),
    },
    pluginRuntime: { pushScopeCredentials: async (m, scopes) => { pushes.push({ id: m.id, scopes }); } },
    effectivePlugins: () => [],
    pluginGrantFor: () => null,
    resolveScopeId: () => null,
    credentialStore,
  });
  return { wiring, credentialStore, pushes, readIds };
}

async function personalCall(wiring, method, url, body) {
  const res = fakeRes();
  const handled = await wiring.handlePersonalCredentialRoute({ method, url }, res, { sendJson, readBody: readBodyOf(body) });
  return { handled, status: res._status, body: res._body };
}

test('personal routes: GET lists only plugins with a personal tier, metadata only; PUT/DELETE are self-service', async () => {
  const { wiring, credentialStore, pushes } = personalHarness();
  let r = await personalCall(wiring, 'GET', '/internal/users/alice/plugin-credentials');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.plugins.map((p) => p.pluginId), ['jira']);
  assert.equal(r.body.plugins[0].complete, false);

  r = await personalCall(wiring, 'PUT', '/internal/users/alice/plugin-credentials/jira', { values: { email: 'a@b.c', 'api-token': 'ATATT-very-secret' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.complete, true);
  assert.equal(JSON.stringify(r.body).includes('ATATT-very-secret'), false, 'the token is never echoed');
  assert.equal(credentialStore.readPersonal('jira', 'alice').values['api-token'], 'ATATT-very-secret');
  assert.deepEqual(pushes, [], 'personal values are never pushed to a broker');

  // another user sees their OWN (empty) document, never alice's
  r = await personalCall(wiring, 'GET', '/internal/users/bob/plugin-credentials');
  assert.equal(r.body.plugins[0].complete, false);

  r = await personalCall(wiring, 'DELETE', '/internal/users/alice/plugin-credentials/jira');
  assert.equal(r.status, 200);
  assert.equal(credentialStore.readPersonal('jira', 'alice'), null);
});

test('personal routes: unknown plugin / no personal tier → 404; bad ids → 400; other paths are not handled', async () => {
  const { wiring } = personalHarness();
  assert.equal((await personalCall(wiring, 'PUT', '/internal/users/alice/plugin-credentials/other', { values: {} })).status, 404);
  assert.equal((await personalCall(wiring, 'PUT', '/internal/users/alice/plugin-credentials/nope', { values: {} })).status, 404);
  assert.equal((await personalCall(wiring, 'GET', '/internal/users/..%2F..%2Fetc/plugin-credentials')).status, 400);
  // A traversal pluginId is refused before it names a registry path (review S1, CodeQL).
  const { wiring: w2, readIds } = personalHarness();
  for (const url of ['/internal/users/alice/plugin-credentials/..%2F..%2Fetc', '/internal/users/alice/plugin-credentials/..']) {
    assert.equal((await personalCall(w2, 'PUT', url, { values: {} })).status, 404, url);
    assert.equal((await personalCall(w2, 'DELETE', url)).status, 404, url);
  }
  assert.deepEqual(readIds, [], 'readPluginManifest is never called with an invalid id');
  const bad = await personalCall(wiring, 'PUT', '/internal/users/alice/plugin-credentials/jira', { values: { email: 5 } });
  assert.equal(bad.status, 400);
  assert.equal((await personalCall(wiring, 'GET', '/internal/users/alice/other')).handled, false);
});

test('personal GET: carries personal-field labels and the team-connection readiness', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcr-conn-'));
  const credentialStore = new PluginCredentialStore({ dir });
  // A Jira-shaped manifest: site-url is the interactive team connection; personal
  // fields carry labels.
  const jira = {
    id: 'jira', name: 'Jira',
    credentials: [{ key: 'site-url', requiredFor: ['interactive', 'automated'], required: true }],
    personalCredentials: [
      { key: 'email', label: 'Your Atlassian e-mail', required: true, secret: false },
      { key: 'api-token', label: 'Your API token', required: true },
    ],
  };
  const wiring = createPluginCredentialWiring({
    listAgentIds: () => ['team-1'],
    loadAgentConfig: (id) => (id === 'team-1' ? { id: 'team-1', role: 'team', token: 't', plugins: [{ id: 'jira', scopeGranularity: 'team' }] } : null),
    pluginRegistry: {
      installedManifests: () => ({ jira }),
      readPluginManifest: () => ({ ok: true, manifest: jira }),
    },
    pluginRuntime: { pushScopeCredentials: async () => {} },
    effectivePlugins: (cfg) => (cfg && cfg.plugins) || [],
    pluginGrantFor: (grants, id) => (grants || []).find((g) => g.id === id) || null,
    resolveScopeId: (cfg) => cfg.id,
    credentialStore,
  });

  // site not set yet → the personal page can warn
  let r = await personalCall(wiring, 'GET', '/internal/users/alice/plugin-credentials');
  const p = r.body.plugins[0];
  assert.deepEqual(p.credentials.map((c) => c.label), ['Your Atlassian e-mail', 'Your API token']);
  assert.deepEqual(p.teamConnection, { keys: ['site-url'], granted: true, configured: false });

  // once a Team Admin sets the site, the readiness flips
  credentialStore.write('jira', 'team-1', { 'site-url': 'acme' }, jira.credentials, { setBy: 'admin' });
  r = await personalCall(wiring, 'GET', '/internal/users/alice/plugin-credentials');
  assert.equal(r.body.plugins[0].teamConnection.configured, true);
});
