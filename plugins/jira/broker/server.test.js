'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// The broker reads its config from env at require() time, so set it first.
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-srv-'));
process.env.JIRA_BROKER_SIGNING_SECRET = 'test-secret';
process.env.JIRA_STATE_DIR = STATE;
process.env.JIRA_AUDIT_DIR = path.join(STATE, 'audit');

const { mint } = require('../../../broker-sdk');
const broker = require('./server');
const { signViewerHeaders } = require('./viewer-headers');

const TOKEN = mint('jira', 'team-1', 'test-secret');
const OTHER = mint('jira', 'team-2', 'test-secret');

function listen() {
  return new Promise((resolve) => {
    const srv = http.createServer(broker.handleRequest);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
async function call(srv, method, urlPath, { token, body } = {}) {
  const { port } = srv.address();
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('healthz answers unauthenticated', async () => {
  const srv = await listen();
  try {
    const r = await call(srv, 'GET', '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  } finally { srv.close(); }
});

test('cli endpoints require a valid jira scope token', async () => {
  const srv = await listen();
  try {
    assert.equal((await call(srv, 'GET', '/cli/whoami')).status, 401);
    assert.equal((await call(srv, 'GET', '/cli/whoami', { token: 'garbage' })).status, 401);
    const r = await call(srv, 'GET', '/cli/whoami', { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.scopeId, 'team-1');
  } finally { srv.close(); }
});

test('spike-config sets a watch + doorbell for the token\'s scope only', async () => {
  const srv = await listen();
  try {
    const r = await call(srv, 'PUT', '/internal/spike-config', {
      token: TOKEN,
      body: { watches: [{ projectKey: 'ENG', statusFilter: 'Ready for Dev' }], doorbell: { url: 'http://host:4003/hooks/a/h', secret: 's' }, setBy: 'alice' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.watches[0].projectKey, 'ENG');
    // team-2's config is untouched
    assert.deepEqual(broker.watchStore.loadConfig('team-2').watches, []);
    // and team-1's is persisted with attribution
    assert.equal(broker.watchStore.loadConfig('team-1').setBy, 'alice');
  } finally { srv.close(); }
});

test('inbox: peek then consume, scoped to the token', async () => {
  broker.inboxStore.append('team-1', { id: 'ENG-1:1', issueKey: 'ENG-1', toStatus: 'Done' }, { triggerId: 't' });
  const srv = await listen();
  try {
    const peek = await call(srv, 'GET', '/cli/inbox', { token: TOKEN });
    assert.equal(peek.body.entries.length, 1);
    assert.equal(peek.body.consumed, false);

    const drain = await call(srv, 'GET', '/cli/inbox?consume=1', { token: TOKEN });
    assert.equal(drain.body.entries.length, 1);
    assert.equal(drain.body.consumed, true);

    // team-2 sees nothing of team-1's inbox
    assert.equal((await call(srv, 'GET', '/cli/inbox', { token: OTHER })).body.entries.length, 0);
    // and team-1's inbox is now empty
    assert.equal((await call(srv, 'GET', '/cli/inbox', { token: TOKEN })).body.entries.length, 0);
  } finally { srv.close(); }
});

test('scope-credentials: the orchestrator push populates the per-scope map; resolveCredential reads it', async () => {
  const srv = await listen();
  try {
    assert.equal((await call(srv, 'PUT', '/internal/scope-credentials')).status, 401); // bearer required
    const r = await call(srv, 'PUT', '/internal/scope-credentials', {
      token: TOKEN,
      body: { scopes: {
        'team-1': { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' },
        'team-2': { 'site-url': 'acme' }, // incomplete
      } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.scopes, 2);
    assert.equal(r.body.usable, 1); // only team-1 is complete
    assert.deepEqual(broker.resolveCredential('team-1'), { siteUrl: 'acme', email: 'a@b.c', apiToken: 'tok' });
    assert.equal(broker.resolveCredential('team-2'), null); // incomplete → not usable
    assert.equal(broker.resolveCredential('team-9'), null); // unknown scope

    // a re-push replaces the whole map (a revoked team disappears)
    await call(srv, 'PUT', '/internal/scope-credentials', { token: OTHER, body: { scopes: {} } });
    assert.equal(broker.resolveCredential('team-1'), null);
  } finally { srv.close(); }
});

test('cli reads: /projects, /list, /show need the per-scope credential and call Jira server-side', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    // Only intercept the Jira API — let the test's own requests to the broker
    // (127.0.0.1) pass through to the real server.
    if (String(url).includes('127.0.0.1') || String(url).includes('localhost')) return origFetch(url, opts);
    calls.push(url);
    if (url.includes('/project/search')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [{ key: 'KAN', name: 'Kanban', id: '1', projectTypeKey: 'software' }] }) };
    }
    if (url.includes('/search/jql')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ issues: [{ key: 'KAN-6', fields: { summary: 'Login', status: { name: 'Ready for Dev' } } }] }) };
    }
    // getIssue
    return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'KAN-6', fields: { summary: 'Login', status: { name: 'Ready for Dev' } } }) };
  };
  const srv = await listen();
  try {
    const projects = await call(srv, 'GET', '/cli/projects', { token: TOKEN });
    assert.equal(projects.status, 200);
    assert.deepEqual(projects.body.projects.map((p) => p.key), ['KAN']);

    const list = await call(srv, 'GET', '/cli/list?project=KAN&status=Ready+for+Dev', { token: TOKEN });
    assert.equal(list.status, 200);
    assert.equal(list.body.issues[0].key, 'KAN-6');

    const show = await call(srv, 'GET', '/cli/show?issue=KAN-6', { token: TOKEN });
    assert.equal(show.status, 200);
    assert.equal(show.body.issue.key, 'KAN-6');

    // a scope with no credential → 400 no-credential (not a 500)
    const nocred = await call(srv, 'GET', '/cli/projects', { token: OTHER });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-credential');
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('ui: requires signed viewer headers; /ui/api/context lists the viewer\'s teams; role gate enforced', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' });
  broker.watchStore.setConfig('team-1', { watches: [{ projectKey: 'KAN', statusFilter: 'Ready for Dev' }] });
  const srv = await listen();
  const { port } = srv.address();
  async function ui(pathname, headers) {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: headers || {} });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  try {
    // no headers → 401
    assert.equal((await ui('/ui/api/context')).status, 401);
    // forged → 401 (bad signature)
    assert.equal((await ui('/ui/api/context', { 'x-aee-plugin-user': 'eve', 'x-aee-plugin-role': 'team-admin', 'x-aee-plugin-teams': 'team-1', 'x-aee-plugin-sig': 'forged' })).status, 401);

    const hdrs = signViewerHeaders({ sub: 'alice', role: 'team-member', teamIds: ['team-1'] }, 'test-secret');
    const ctx = await ui('/ui/api/context', hdrs);
    assert.equal(ctx.status, 200);
    assert.equal(ctx.body.teams[0].teamId, 'team-1');
    assert.equal(ctx.body.teams[0].hasCredential, true);
    assert.deepEqual(ctx.body.teams[0].watches, ['KAN']);

    // the watch view is reachable at team-member
    const w = await ui('/ui/api/watches?team=team-1', hdrs);
    assert.equal(w.status, 200);
    assert.equal(w.body.watches[0].projectKey, 'KAN');

    // static asset served
    const idx = await fetch(`http://127.0.0.1:${port}/ui/`, { headers: hdrs });
    assert.equal(idx.status, 200);
    assert.match(await idx.text(), /<title>Jira<\/title>/);
  } finally {
    broker.scopeCredentials.delete('team-1');
    broker.watchStore.teardown('team-1');
    srv.close();
  }
});

test('deliver: POSTs /internal/plugin-event to the orchestrator with a minted jira scope token', async () => {
  const captured = [];
  const orch = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      captured.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, delivered: 1 }));
    });
  });
  await new Promise((r) => orch.listen(0, '127.0.0.1', r));
  const prev = process.env.AEE_ORCHESTRATOR_URL;
  process.env.AEE_ORCHESTRATOR_URL = `http://127.0.0.1:${orch.address().port}`;
  try {
    await broker.deliver({
      scopeId: 'team-1', kind: 'events',
      events: [{ id: 'KAN-6:10312', event: 'status_changed', issueKey: 'KAN-6', fromStatus: 'To Do', toStatus: 'Ready for Dev' }],
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, '/internal/plugin-event');
    assert.match(captured[0].auth, /^Bearer jira\.team-1\./);
    assert.equal(captured[0].body.event, 'status_changed');
    assert.equal(captured[0].body.eventId, 'KAN-6:10312');
    assert.match(captured[0].body.summary, /KAN-6.*Ready for Dev/);
  } finally {
    if (prev === undefined) delete process.env.AEE_ORCHESTRATOR_URL; else process.env.AEE_ORCHESTRATOR_URL = prev;
    orch.close();
  }
});

test('teardown-scope reaps one scope\'s watch + inbox + credential, bearer-authed', async () => {
  broker.watchStore.setConfig('team-2', { watches: [{ projectKey: 'X' }] });
  broker.inboxStore.append('team-2', { id: 'X-1:1', issueKey: 'X-1' });
  broker.scopeCredentials.set('team-2', { 'site-url': 'a', email: 'b', 'api-token': 'c' });
  const srv = await listen();
  try {
    assert.equal((await call(srv, 'POST', '/internal/teardown-scope')).status, 401);
    const r = await call(srv, 'POST', '/internal/teardown-scope', { token: OTHER });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(broker.watchStore.loadConfig('team-2').watches, []);
    assert.equal(broker.inboxStore.count('team-2'), 0);
    assert.equal(broker.scopeCredentials.has('team-2'), false);
  } finally { srv.close(); }
});
