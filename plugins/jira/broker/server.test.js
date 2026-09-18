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
// The orchestrator's own push credential — the ONLY token the credential push
// accepts. A granted team's token must not be able to rewrite the map.
const INTERNAL = mint('jira', '_internal', 'test-secret');

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
      token: INTERNAL,
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
    await call(srv, 'PUT', '/internal/scope-credentials', { token: INTERNAL, body: { scopes: {} } });
    assert.equal(broker.resolveCredential('team-1'), null);
  } finally { srv.close(); }
});

test('scope-credentials: a granted TEAM token cannot rewrite the map (cross-tenant credential tamper)', async () => {
  const srv = await listen();
  try {
    await call(srv, 'PUT', '/internal/scope-credentials', {
      token: INTERNAL,
      body: { scopes: { 'team-2': { 'site-url': 'https://b.example', email: 'b@b.c', 'api-token': 'tokB' } } },
    });
    // Team 1 tries to (a) wipe every other team and (b) repoint team 2 at its own site.
    for (const token of [TOKEN, OTHER, mint('github-issues', '_internal', 'test-secret')]) {
      const r = await call(srv, 'PUT', '/internal/scope-credentials', {
        token,
        body: { scopes: { 'team-2': { 'site-url': 'https://attacker.example', email: 'x', 'api-token': 'y' } } },
      });
      assert.equal(r.status, 401);
    }
    assert.deepEqual(broker.resolveCredential('team-2'), { siteUrl: 'https://b.example', email: 'b@b.c', apiToken: 'tokB' });
    // leave the map as the later tests expect it (empty)
    await call(srv, 'PUT', '/internal/scope-credentials', { token: INTERNAL, body: { scopes: {} } });
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

test('cli writes: comment + transition are role-gated (pass for team scope), cred-gated, audited', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    if (url.includes('/comment')) return { ok: true, status: 201, text: async () => JSON.stringify({ id: '1' }) };
    if (url.includes('/transitions') && (!opts || opts.method === 'GET')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ transitions: [{ id: '9', name: 'Go', to: { name: 'In Progress' } }] }) };
    }
    return { ok: true, status: 204, text: async () => '' };
  };
  const srv = await listen();
  try {
    const c = await call(srv, 'POST', '/cli/comment', { token: TOKEN, body: { issue: 'KAN-6', body: 'picked up' } });
    assert.equal(c.status, 200);
    assert.equal(c.body.issueKey, 'KAN-6');

    const t = await call(srv, 'POST', '/cli/transition', { token: TOKEN, body: { issue: 'KAN-6', to: 'In Progress' } });
    assert.equal(t.status, 200);
    assert.equal(t.body.applied, 'Go');

    // a scope with no credential → 400, not a 500
    const nocred = await call(srv, 'POST', '/cli/comment', { token: OTHER, body: { issue: 'X-1', body: 'y' } });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-credential');

    // a GET on a write path → 404 (writes are POST only)
    assert.equal((await call(srv, 'GET', '/cli/comment', { token: TOKEN })).status, 404);
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /update replaces the description through the client, role- and cred-gated', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    seen.push({ url: String(url), method: opts && opts.method, body: opts && opts.body });
    return { ok: true, status: 204, text: async () => '' };
  };
  const srv = await listen();
  try {
    const u = await call(srv, 'POST', '/cli/update', { token: TOKEN, body: { issue: 'KAN-10', description: 'Refined text' } });
    assert.equal(u.status, 200);
    assert.deepEqual(u.body, { issueKey: 'KAN-10', updated: 'description' });
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/rest\/api\/3\/issue\/KAN-10$/);
    assert.equal(seen[0].method, 'PUT');
    const adf = JSON.parse(seen[0].body).fields.description;
    assert.equal(adf.content[0].content[0].text, 'Refined text');
    assert.match(adf.content[adf.content.length - 1].content[0].text, /team "team-1"/);

    const blank = await call(srv, 'POST', '/cli/update', { token: TOKEN, body: { issue: 'KAN-10', description: ' ' } });
    assert.equal(blank.status, 400);
    assert.equal(seen.length, 1); // no Jira call for a blank body

    const nocred = await call(srv, 'POST', '/cli/update', { token: OTHER, body: { issue: 'X-1', description: 'y' } });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-credential');
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('ui /admin: team-admin only; PUT replaces the watch config', async () => {
  const srv = await listen();
  const { port } = srv.address();
  async function ui(pathname, opts) {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, opts || {});
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  const member = signViewerHeaders({ sub: 'm', role: 'team-member', teamIds: ['team-1'] }, 'test-secret');
  const admin = signViewerHeaders({ sub: 'a', role: 'team-admin', teamIds: ['team-1'] }, 'test-secret');
  try {
    // a team-member is refused /admin
    assert.equal((await ui('/ui/api/admin/watch?team=team-1', { headers: member })).status, 403);

    // a team-admin may PUT
    const put = await ui('/ui/api/admin/watch?team=team-1', {
      method: 'PUT',
      headers: { ...admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ watches: [{ projectKey: 'KAN', statusFilters: ['Ready for Dev', 'In Review'] }, { projectKey: '', statusFilters: ['x'] }] }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.watches.map((w) => w.projectKey), ['KAN']); // blank dropped by normalizeWatch

    const get = await ui('/ui/api/admin/watch?team=team-1', { headers: admin });
    assert.deepEqual(get.body.watches[0].statusFilters, ['Ready for Dev', 'In Review']);
    assert.equal(get.body.setBy, 'a');
  } finally {
    broker.watchStore.teardown('team-1');
    srv.close();
  }
});

test('ui /watches: carries per-watch health + a roll-up; /activity returns the retained log', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' });
  broker.watchStore.setConfig('team-1', { watches: [{ projectKey: 'KAN' }, { projectKey: 'OPS' }] });
  // KAN healthy (baselined), OPS failing
  broker.watchStore.saveCursor('team-1', 'acme::KAN', { seen: ['KAN-1:1'], lastPolledAt: new Date().toISOString() });
  broker.watchStore.saveCursor('team-1', 'acme::OPS', {
    seen: [], consecutiveFailures: 3, skipUntil: new Date(Date.now() + 300000).toISOString(),
    recentErrors: [{ at: new Date().toISOString(), message: 'Jira rejected the credential (401).' }],
  });
  broker.activityStore.append('team-1', [
    { event: { id: 'KAN-6:9', issueKey: 'KAN-6', summary: 'Login', issueType: 'Story', toStatus: 'In Review' }, outcome: 'delivered' },
    { event: { id: 'KAN-7:9', issueKey: 'KAN-7', toStatus: 'Backlog' }, outcome: 'filtered', detail: 'Backlog is not a watched status' },
  ]);
  const srv = await listen();
  const { port } = srv.address();
  const hdrs = signViewerHeaders({ sub: 'alice', role: 'team-member', teamIds: ['team-1'] }, 'test-secret');
  const ui = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers: hdrs });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  try {
    const w = await ui('/ui/api/watches?team=team-1');
    assert.equal(w.status, 200);
    const byKey = Object.fromEntries(w.body.watches.map((x) => [x.projectKey, x.health.status]));
    assert.deepEqual(byKey, { KAN: 'watching', OPS: 'failing' });
    assert.equal(w.body.watches.find((x) => x.projectKey === 'OPS').health.recentErrors.length, 1);
    assert.deepEqual(w.body.health, { watching: 1, degraded: 0, failing: 1, total: 2, worst: 'failing' });

    const a = await ui('/ui/api/activity?team=team-1');
    assert.equal(a.status, 200);
    assert.deepEqual(a.body.rows.map((r) => r.outcome), ['filtered', 'delivered']); // newest-first
    assert.equal(a.body.rows[1].event.summary, 'Login');

    const ctx = await ui('/ui/api/context');
    assert.equal(ctx.body.teams[0].activity, 2);
    assert.equal(ctx.body.teams[0].watchHealth.worst, 'failing');
  } finally {
    broker.scopeCredentials.delete('team-1');
    broker.watchStore.teardown('team-1');
    broker.activityStore.teardown('team-1');
    srv.close();
  }
});

test('ui /admin/retry: team-admin clears the backoff on one watch', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' });
  broker.watchStore.setConfig('team-1', { watches: [{ projectKey: 'OPS' }] });
  broker.watchStore.saveCursor('team-1', 'acme::OPS', { seen: [], consecutiveFailures: 4, skipUntil: '2099-01-01T00:00:00Z' });
  const srv = await listen();
  const { port } = srv.address();
  const admin = signViewerHeaders({ sub: 'a', role: 'team-admin', teamIds: ['team-1'] }, 'test-secret');
  const member = signViewerHeaders({ sub: 'm', role: 'team-member', teamIds: ['team-1'] }, 'test-secret');
  const post = async (headers, body) => {
    const res = await fetch(`http://127.0.0.1:${port}/ui/api/admin/retry?team=team-1`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  try {
    assert.equal((await post(member, { projectKey: 'OPS' })).status, 403); // team-member refused
    assert.equal((await post(admin, {})).status, 400);                     // projectKey required
    assert.equal((await post(admin, { projectKey: 'OPS' })).status, 200);
    const cur = broker.watchStore.getCursor('team-1', 'acme::OPS');
    assert.equal(cur.consecutiveFailures, 0);
    assert.equal(cur.skipUntil, undefined);
    assert.deepEqual(cur.seen, []); // untouched
  } finally {
    broker.scopeCredentials.delete('team-1');
    broker.watchStore.teardown('team-1');
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
