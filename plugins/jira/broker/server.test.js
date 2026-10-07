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
// #2562: every CLI call first asks the orchestrator whose credential it may
// use. The existing route tests run as an AUTONOMOUS call (service account);
// the per-person paths are covered by the dedicated tests at the end.
broker._setGrantResolver(async () => ({ ok: true, mode: 'service', interactive: false, agentId: 'team-1-dev' }));
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

test('the Phase-0 spike-config seam is gone — a scope token cannot reconfigure watches over HTTP', async () => {
  // Watch config is a Team-Admin action through the signed /admin UI route. A
  // granted agent's token (or a prompt-injected run holding it) must not be
  // able to rewrite which projects / transitions wake its team.
  const srv = await listen();
  try {
    const r = await call(srv, 'PUT', '/internal/spike-config', {
      token: TOKEN,
      body: { watches: [{ projectKey: 'ENG', statusFilter: 'Ready for Dev' }] },
    });
    assert.equal(r.status, 404);
    assert.deepEqual(broker.watchStore.loadConfig('team-1').watches, []);
  } finally { srv.close(); }
});

const INBOX_EV = (id, toStatus = 'Done') => ({ id, issueKey: id.split(':')[0], toStatus });

test('inbox: peek is unchanged and scoped to the token', async () => {
  broker.inboxStore.append('team-1', INBOX_EV('ENG-1:1'), { triggerId: 't' });
  const srv = await listen();
  try {
    const peek = await call(srv, 'GET', '/cli/inbox', { token: TOKEN });
    assert.equal(peek.status, 200);
    assert.equal(peek.body.entries.length, 1);
    assert.equal(peek.body.consumed, false);
    assert.equal((await call(srv, 'GET', '/cli/inbox', { token: OTHER })).body.entries.length, 0);
    // a peek never writes
    assert.equal(broker.inboxStore.count('team-1'), 1);
  } finally { srv.close(); broker.inboxStore.teardown('team-1'); }
});

test('inbox: consume by id drains exactly those ids, leaves a teammate\'s entries, reports missing', async () => {
  broker.inboxStore.append('team-1', INBOX_EV('KAN-1:11', 'Ready for Refinement'));
  broker.inboxStore.append('team-1', INBOX_EV('KAN-2:12', 'Ready for Dev'));
  broker.inboxStore.append('team-1', INBOX_EV('KAN-3:13', 'Ready for Dev'));
  const srv = await listen();
  try {
    const r = await call(srv, 'GET', `/cli/inbox?consume=${encodeURIComponent('KAN-2:12,KAN-3:13,KAN-9:99')}`, { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.consumed, true);
    assert.deepEqual(r.body.entries.map((e) => e.event.id), ['KAN-2:12', 'KAN-3:13']);
    assert.deepEqual(r.body.missing, ['KAN-9:99']);
    // the Refinement agent's entry is still there
    assert.deepEqual(broker.inboxStore.list('team-1').map((e) => e.event.id), ['KAN-1:11']);
    // team-2's token cannot reach team-1's ids
    const other = await call(srv, 'GET', `/cli/inbox?consume=${encodeURIComponent('KAN-1:11')}`, { token: OTHER });
    assert.deepEqual(other.body, { entries: [], consumed: true, missing: ['KAN-1:11'] });
    assert.equal(broker.inboxStore.count('team-1'), 1);
  } finally { srv.close(); broker.inboxStore.teardown('team-1'); }
});

test('inbox: a bare / legacy consume (consume=1, consume=, consume=true) is refused with 400 and drains nothing', async () => {
  broker.inboxStore.append('team-1', INBOX_EV('KAN-1:11'));
  const srv = await listen();
  try {
    for (const q of ['consume=1', 'consume=', 'consume=true', 'consume=all']) {
      const r = await call(srv, 'GET', `/cli/inbox?${q}`, { token: TOKEN });
      assert.equal(r.status, 400, q);
      assert.equal(r.body.error, 'consume-requires-ids', q);
      assert.match(r.body.message, /--consume <event-id>/);
    }
    // a list with one malformed id is refused as a whole — nothing is half-drained
    const mixed = await call(srv, 'GET', `/cli/inbox?consume=${encodeURIComponent('KAN-1:11,not an id')}`, { token: TOKEN });
    assert.equal(mixed.status, 400);
    assert.equal(mixed.body.error, 'consume-requires-ids');
    assert.equal(broker.inboxStore.count('team-1'), 1);
  } finally { srv.close(); broker.inboxStore.teardown('team-1'); }
});

test('inbox: more than 200 ids in one consume is refused', async () => {
  const srv = await listen();
  try {
    const ids = Array.from({ length: 201 }, (_, i) => `KAN-${i}:${i}`).join(',');
    const r = await call(srv, 'GET', `/cli/inbox?consume=${encodeURIComponent(ids)}`, { token: TOKEN });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'too-many-ids');
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
    assert.deepEqual(broker.resolveCredential('team-1'), { siteUrl: 'acme', email: 'a@b.c', apiToken: 'tok', readableCustomFields: [], writableCustomFields: [] });
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
    assert.deepEqual(broker.resolveCredential('team-2'), { siteUrl: 'https://b.example', email: 'b@b.c', apiToken: 'tokB', readableCustomFields: [], writableCustomFields: [] });
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
    if (/\/comment\/10042$/.test(url)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: '10042', author: { displayName: 'Jane' }, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'full text' }] }] } }) };
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
    assert.ok(!('comment' in show.body)); // a plain show carries no comment

    // show --comment <id>: the full text of one comment (bodyTruncated wakes)
    const withComment = await call(srv, 'GET', '/cli/show?issue=KAN-6&comment=10042', { token: TOKEN });
    assert.equal(withComment.status, 200);
    assert.equal(withComment.body.issue.key, 'KAN-6');
    assert.deepEqual(withComment.body.comment, { id: '10042', author: 'Jane', created: null, body: 'full text' });
    const badComment = await call(srv, 'GET', '/cli/show?issue=KAN-6&comment=..%2Fx', { token: TOKEN });
    assert.equal(badComment.status, 400);

    // arbitrary JQL search, scoped by the credential, shaped like /list
    const search = await call(srv, 'GET', '/cli/search?jql=issuetype+%3D+Story&limit=5', { token: TOKEN });
    assert.equal(search.status, 200);
    assert.equal(search.body.jql, 'issuetype = Story');
    assert.equal(search.body.issues[0].key, 'KAN-6');

    // a search with no --jql → 400 (the credential is fine, the query is missing)
    const noJql = await call(srv, 'GET', '/cli/search?jql=', { token: TOKEN });
    assert.equal(noJql.status, 400);

    // a scope with no service account → 400 no-service-account (not a 500)
    const nocred = await call(srv, 'GET', '/cli/projects', { token: OTHER });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-service-account');
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli reads: /statuses returns a project\'s workflow statuses grouped by issue type (#2421)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1') || String(url).includes('localhost')) return origFetch(url, opts);
    if (String(url).match(/\/rest\/api\/3\/project\/KAN\/statuses$/)) {
      return { ok: true, status: 200, text: async () => JSON.stringify([
        { name: 'Story', statuses: [{ name: 'To Do', statusCategory: { key: 'new' } }, { name: 'Done', statusCategory: { key: 'done' } }] },
      ]) };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  const srv = await listen();
  try {
    const ok = await call(srv, 'GET', '/cli/statuses?project=KAN', { token: TOKEN });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.project, 'KAN');
    assert.deepEqual(ok.body.statuses, [
      { issueType: 'Story', statuses: [{ name: 'To Do', category: 'new' }, { name: 'Done', category: 'done' }] },
    ]);

    // a missing --project is a 400, never a Jira call
    const noProject = await call(srv, 'GET', '/cli/statuses', { token: TOKEN });
    assert.equal(noProject.status, 400);

    // a scope with no service account → 400 no-service-account
    const nocred = await call(srv, 'GET', '/cli/statuses?project=KAN', { token: OTHER });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-service-account');
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli reads: custom fields via the admin allow-list and per-request --fields (#2416)', async () => {
  // The admin configures a default readable custom field "Team"; a per-request
  // --fields adds "Priority" on top.
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok', 'readable-custom-fields': 'Team' });
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1') || String(url).includes('localhost')) return origFetch(url, opts);
    if (String(url).match(/\/rest\/api\/3\/field$/)) {
      return { ok: true, status: 200, text: async () => JSON.stringify([
        { id: 'customfield_20001', name: 'Team' },
        { id: 'customfield_20002', name: 'Priority' },
      ]) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({
      key: 'KAN-6', fields: { summary: 'Login', status: { name: 'Ready for Dev' }, customfield_20001: { title: 'Payments' }, customfield_20002: null },
    }) };
  };
  const srv = await listen();
  try {
    // No --fields: the admin default set (Team) is surfaced automatically.
    const dflt = await call(srv, 'GET', '/cli/show?issue=KAN-6', { token: TOKEN });
    assert.equal(dflt.status, 200);
    assert.deepEqual(dflt.body.issue.customFields, { Team: { value: 'Payments' } });

    // --fields adds Priority (empty → null) on top of the default Team.
    const withFields = await call(srv, 'GET', '/cli/show?issue=KAN-6&fields=Priority', { token: TOKEN });
    assert.equal(withFields.status, 200);
    assert.deepEqual(withFields.body.issue.customFields, { Team: { value: 'Payments' }, Priority: null });
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli reads: /attachment fetches one attachment by id, cred-gated, 404 for an unknown id', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1') || String(url).includes('localhost')) return origFetch(url, opts);
    if (url.includes('?fields=attachment')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        key: 'KAN-6', fields: { attachment: [{ id: '10312', filename: 'notes.md', mimeType: 'text/markdown', size: 5, author: { displayName: 'Jane' } }] },
      }) };
    }
    // attachment content download
    return { ok: true, status: 200, headers: { get: () => 'text/markdown' }, arrayBuffer: async () => Buffer.from('hello', 'utf8') };
  };
  const srv = await listen();
  try {
    const got = await call(srv, 'GET', '/cli/attachment?issue=KAN-6&id=10312', { token: TOKEN });
    assert.equal(got.status, 200);
    assert.equal(got.body.attachment.encoding, 'text');
    assert.equal(got.body.attachment.content, 'hello');
    assert.equal(got.body.attachment.filename, 'notes.md');

    // an id not on the issue → 404 domain error, not a 500
    const missing = await call(srv, 'GET', '/cli/attachment?issue=KAN-6&id=999', { token: TOKEN });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /not on issue KAN-6/);

    // a scope with no service account → 400 no-service-account
    const nocred = await call(srv, 'GET', '/cli/attachment?issue=KAN-6&id=10312', { token: OTHER });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-service-account');

    // a missing id arg → 400
    assert.equal((await call(srv, 'GET', '/cli/attachment?issue=KAN-6', { token: TOKEN })).status, 400);
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /attachment/add uploads one file per call server-side, cred-gated, 4xx mapped (#2408)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1') || String(url).includes('localhost')) return origFetch(url, opts);
    seen.push({ url: String(url), method: opts && opts.method, token: opts.headers && opts.headers['X-Atlassian-Token'], isForm: opts.body instanceof FormData });
    if (String(url).includes('/NOPE-1/')) return { ok: false, status: 404, text: async () => 'no issue' };
    return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 30011, filename: 'part-1.pdf', mimeType: 'application/pdf', size: 3 }]) };
  };
  const srv = await listen();
  try {
    const contentBase64 = Buffer.from('abc').toString('base64');
    const ok = await call(srv, 'POST', '/cli/attachment/add', { token: TOKEN, body: { issue: 'KAN-6', filename: 'part-1.pdf', contentBase64 } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.attachment.id, '30011');
    assert.equal(ok.body.attachment.filename, 'part-1.pdf');
    assert.match(seen[0].url, /\/rest\/api\/3\/issue\/KAN-6\/attachments$/);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].token, 'no-check');
    assert.equal(seen[0].isForm, true);

    // an unknown issue → mapped 404, not a 500 (AC4)
    const missing = await call(srv, 'POST', '/cli/attachment/add', { token: TOKEN, body: { issue: 'NOPE-1', filename: 'a.txt', contentBase64 } });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /not found/i);

    // missing filename / content → 400 before any upload
    assert.equal((await call(srv, 'POST', '/cli/attachment/add', { token: TOKEN, body: { issue: 'KAN-6', contentBase64 } })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/attachment/add', { token: TOKEN, body: { issue: 'KAN-6', filename: 'a.txt' } })).status, 400);

    // no service account → 400 no-service-account
    const nocred = await call(srv, 'POST', '/cli/attachment/add', { token: OTHER, body: { issue: 'KAN-6', filename: 'a.txt', contentBase64 } });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-service-account');

    // a GET on the upload path → 404 (upload is POST only)
    assert.equal((await call(srv, 'GET', '/cli/attachment/add', { token: TOKEN })).status, 404);
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
    // recorded before the reply → the poller stamps its echo origin: agent
    assert.ok(broker.ownWritesStore.snapshot('team-1').comments['KAN-6:c1']);

    const t = await call(srv, 'POST', '/cli/transition', { token: TOKEN, body: { issue: 'KAN-6', to: 'In Progress' } });
    assert.equal(t.status, 200);
    // a transition records the wildcard field write (resolution & screen fields echo as origin: agent)
    assert.equal(broker.ownWritesStore.snapshot('team-1').fields['KAN-6|*'].length, 1);
    assert.equal(t.body.applied, 'Go');

    // a scope with no credential → 400, not a 500
    const nocred = await call(srv, 'POST', '/cli/comment', { token: OTHER, body: { issue: 'X-1', body: 'y' } });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-service-account');

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
    assert.equal(nocred.body.code, 'no-service-account');
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /set-field sets an allow-listed custom field, refuses one that is not (#2417)', async () => {
  // The admin sanctions "Team" as writable; "Priority" is not on the list. A
  // distinct site keeps the process-lifetime field catalog off the schema-less
  // fixture other tests cached for `acme` (real Jira always returns the schema).
  broker.scopeCredentials.set('team-1', { 'site-url': 'setfieldco', email: 'a@b.c', 'api-token': 'tok', 'writable-custom-fields': 'Team' });
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    seen.push({ url: String(url), method: opts && opts.method, body: opts && opts.body });
    if (String(url).match(/\/rest\/api\/3\/field$/)) {
      return { ok: true, status: 200, text: async () => JSON.stringify([
        { id: 'customfield_20001', name: 'Team', schema: { type: 'team' } },
      ]) };
    }
    if (opts && opts.method === 'PUT') return { ok: true, status: 204, text: async () => '' };
    // idempotency pre-read: the field is currently unset
    return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'KAN-6', fields: { customfield_20001: null } }) };
  };
  const srv = await listen();
  try {
    const ok = await call(srv, 'POST', '/cli/set-field', { token: TOKEN, body: { issue: 'KAN-6', field: 'Team', value: '42' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { issueKey: 'KAN-6', field: 'Team', fieldId: 'customfield_20001', changed: true, value: '42' });
    // the write is in the own-writes registry under the field id (→ origin: agent on the echo)
    assert.equal(broker.ownWritesStore.snapshot('team-1').fields['KAN-6|customfield_20001'].length, 1);
    const put = seen.find((s) => s.method === 'PUT');
    assert.deepEqual(JSON.parse(put.body), { fields: { customfield_20001: { id: '42' } } });

    // a field NOT on the allow-list → 403, no Jira write (acceptance)
    const refused = await call(srv, 'POST', '/cli/set-field', { token: TOKEN, body: { issue: 'KAN-6', field: 'Priority', value: 'High' } });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /not writable/);

    // missing field / value → 400 before any Jira call
    assert.equal((await call(srv, 'POST', '/cli/set-field', { token: TOKEN, body: { issue: 'KAN-6', value: 'x' } })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/set-field', { token: TOKEN, body: { issue: 'KAN-6', field: 'Team' } })).status, 400);

    // a scope with no service account → 400 no-service-account
    const nocred = await call(srv, 'POST', '/cli/set-field', { token: OTHER, body: { issue: 'X-1', field: 'Team', value: '1' } });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-service-account');

    // a GET on the write path → 404 (set-field is POST only)
    assert.equal((await call(srv, 'GET', '/cli/set-field', { token: TOKEN })).status, 404);
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /set-field with an empty writable-custom-fields allow-list permits any field (#2449)', async () => {
  // Empty/unset allow-list now means UNRESTRICTED: a field that resolves via the
  // site catalog is writable even though no admin named it. A distinct site keeps
  // the process-lifetime field catalog off other tests' cached fixtures.
  broker.scopeCredentials.set('team-1', { 'site-url': 'unrestrictedco', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    seen.push({ url: String(url), method: opts && opts.method, body: opts && opts.body });
    if (String(url).match(/\/rest\/api\/3\/field$/)) {
      return { ok: true, status: 200, text: async () => JSON.stringify([
        { id: 'customfield_30001', name: 'Team', schema: { type: 'team' } },
      ]) };
    }
    if (opts && opts.method === 'PUT') return { ok: true, status: 204, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'KAN-6', fields: { customfield_30001: null } }) };
  };
  const srv = await listen();
  try {
    // no admin ever named "Team", yet with an empty allow-list the write succeeds
    const ok = await call(srv, 'POST', '/cli/set-field', { token: TOKEN, body: { issue: 'KAN-6', field: 'Team', value: '42' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { issueKey: 'KAN-6', field: 'Team', fieldId: 'customfield_30001', changed: true, value: '42' });
    const put = seen.find((s) => s.method === 'PUT');
    assert.deepEqual(JSON.parse(put.body), { fields: { customfield_30001: { id: '42' } } });

    // an unknown/unresolvable field is still a 400 regardless of the allow-list (AC3)
    const unknown = await call(srv, 'POST', '/cli/set-field', { token: TOKEN, body: { issue: 'KAN-6', field: 'Nope', value: 'x' } });
    assert.equal(unknown.status, 400);
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /create-epic with an empty writable-custom-fields allow-list permits any custom field (#2449)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'unrestrictedepicco', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  const created = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    if (String(url).match(/\/rest\/api\/3\/field$/)) {
      return { ok: true, status: 200, text: async () => JSON.stringify([
        { id: 'customfield_30001', name: 'Team', schema: { type: 'team' } },
      ]) };
    }
    if (opts && opts.method === 'POST' && String(url).match(/\/rest\/api\/3\/issue$/)) {
      const body = JSON.parse(opts.body);
      created.push(body.fields);
      const isEpic = body.fields.issuetype.name === 'Epic';
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: isEpic ? 'KAN-1' : `KAN-${created.length}` }) };
    }
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  };
  const srv = await listen();
  try {
    const ok = await call(srv, 'POST', '/cli/create-epic', {
      token: TOKEN,
      body: { project: 'KAN', epic: { summary: 'Ask' }, stories: [{ summary: 'Task', fields: { Team: '42' } }] },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.failed, 0);
    const story = created.find((f) => f.issuetype.name === 'Story');
    assert.deepEqual(story.customfield_30001, { id: '42' });
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /create-epic creates an epic + child stories, allow-list-gating custom fields (#2424)', async () => {
  // A distinct site keeps the process-lifetime field catalog off another test's
  // schema-less `acme` fixture (real Jira always returns the schema).
  broker.scopeCredentials.set('team-1', { 'site-url': 'createco', email: 'a@b.c', 'api-token': 'tok', 'writable-custom-fields': 'Team' });
  const origFetch = global.fetch;
  const created = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    if (String(url).match(/\/rest\/api\/3\/field$/)) {
      return { ok: true, status: 200, text: async () => JSON.stringify([
        { id: 'customfield_20001', name: 'Team', schema: { type: 'team' } },
      ]) };
    }
    if (opts && opts.method === 'POST' && String(url).match(/\/rest\/api\/3\/issue$/)) {
      const body = JSON.parse(opts.body);
      created.push(body.fields);
      const isEpic = body.fields.issuetype.name === 'Epic';
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: isEpic ? 'KAN-1' : `KAN-${created.length}` }) };
    }
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  };
  const srv = await listen();
  try {
    const ok = await call(srv, 'POST', '/cli/create-epic', {
      token: TOKEN,
      body: { project: 'KAN', epic: { summary: 'Ask' }, stories: [{ summary: 'Task', fields: { Team: '42' } }] },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.epic.key, 'KAN-1');
    assert.equal(ok.body.created, 2);
    assert.equal(ok.body.failed, 0);
    assert.equal(ok.body.stories[0].key, 'KAN-2');
    // every created key is in the own-writes registry (→ origin: agent on the echo)
    assert.deepEqual(Object.keys(broker.ownWritesStore.snapshot('team-1').issues).sort(), ['KAN-1', 'KAN-2']);
    assert.ok(broker.ownWritesStore.snapshot('team-1').fields['KAN-2|*'], 'a created story is covered for its follow-up transition');
    // the story create linked to the epic (native parent) and shaped Team
    const story = created.find((f) => f.issuetype.name === 'Story');
    assert.deepEqual(story.parent, { key: 'KAN-1' });
    assert.deepEqual(story.customfield_20001, { id: '42' });

    // a custom field NOT on the allow-list → 403, nothing created
    const refused = await call(srv, 'POST', '/cli/create-epic', {
      token: TOKEN,
      body: { project: 'KAN', epic: { summary: 'E' }, stories: [{ summary: 'S', fields: { Priority: 'High' } }] },
    });
    assert.equal(refused.status, 403);

    // missing project / epic → 400
    assert.equal((await call(srv, 'POST', '/cli/create-epic', { token: TOKEN, body: { epic: { summary: 'E' } } })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/create-epic', { token: TOKEN, body: { project: 'KAN' } })).status, 400);

    // no service account → 400 no-service-account
    const nocred = await call(srv, 'POST', '/cli/create-epic', { token: OTHER, body: { project: 'X', epic: { summary: 'E' } } });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-service-account');

    // GET on the create path → 404 (POST only)
    assert.equal((await call(srv, 'GET', '/cli/create-epic', { token: TOKEN })).status, 404);
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /add-stories creates stories under an existing Epic, registers own writes, audits (#2890)', async () => {
  // A distinct site keeps the process-lifetime field catalog off other fixtures.
  broker.scopeCredentials.set('team-1', { 'site-url': 'addstoriesco', email: 'a@b.c', 'api-token': 'tok', 'writable-custom-fields': 'Team' });
  const origFetch = global.fetch;
  const created = [];
  const ISSUES = {
    'KAN-12': { key: 'KAN-12', fields: { summary: 'Payments', project: { key: 'KAN' }, issuetype: { name: 'Epic', hierarchyLevel: 1 } } },
    'KAN-7': { key: 'KAN-7', fields: { summary: 'A story', project: { key: 'KAN' }, issuetype: { name: 'Story', hierarchyLevel: 0 } } },
  };
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    if (String(url).match(/\/rest\/api\/3\/field$/)) {
      return { ok: true, status: 200, text: async () => JSON.stringify([
        { id: 'customfield_20001', name: 'Team', schema: { type: 'team' } },
      ]) };
    }
    const get = String(url).match(/\/rest\/api\/3\/issue\/([^/?]+)\?fields=/);
    if (get && (!opts || !opts.method || opts.method === 'GET')) {
      const issue = ISSUES[decodeURIComponent(get[1])];
      return issue
        ? { ok: true, status: 200, text: async () => JSON.stringify(issue) }
        : { ok: false, status: 404, text: async () => '{"errorMessages":["Issue does not exist or you do not have permission to see it."]}' };
    }
    if (opts && opts.method === 'POST' && String(url).match(/\/rest\/api\/3\/issue$/)) {
      const body = JSON.parse(opts.body);
      created.push(body.fields);
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: `KAN-${100 + created.length}` }) };
    }
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  };
  const srv = await listen();
  try {
    const ok = await call(srv, 'POST', '/cli/add-stories', {
      token: TOKEN,
      body: { epic: 'kan-12', stories: [{ summary: 'One', fields: { Team: '42' } }, { summary: 'Two' }] },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.epic.key, 'KAN-12');
    assert.equal(ok.body.created, 2);
    assert.equal(ok.body.failed, 0);
    assert.deepEqual(ok.body.stories.map((s) => s.key), ['KAN-101', 'KAN-102']);
    assert.ok(created.every((f) => f.issuetype.name === 'Story' && f.parent.key === 'KAN-12'), 'only Stories, each under the Epic');
    assert.deepEqual(created[0].customfield_20001, { id: '42' });
    const own = broker.ownWritesStore.snapshot('team-1');
    assert.ok(own.issues['KAN-101'] && own.issues['KAN-102'], 'created stories are own writes');
    assert.ok(own.fields['KAN-101|*']);
    assert.ok(auditLines().some((l) => l.subcommand === 'add-stories' && l.outcome === 'ok' && l.detail === 'KAN-12 +2/2 stories'));

    const before = created.length;
    // a key Jira does not return (absent / outside the team's scope) → 404, nothing created
    const missing = await call(srv, 'POST', '/cli/add-stories', { token: TOKEN, body: { epic: 'OTHER-1', stories: [{ summary: 'S' }] } });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /OTHER-1 was not found, or it is outside this team's Jira scope/);
    // not an Epic → 400 naming the type
    const notEpic = await call(srv, 'POST', '/cli/add-stories', { token: TOKEN, body: { epic: 'KAN-7', stories: [{ summary: 'S' }] } });
    assert.equal(notEpic.status, 400);
    assert.match(notEpic.body.error, /KAN-7 is a Story, not an Epic/);
    // a custom field off the non-empty allow-list → 403
    const refused = await call(srv, 'POST', '/cli/add-stories', {
      token: TOKEN, body: { epic: 'KAN-12', stories: [{ summary: 'S', fields: { Priority: 'High' } }] },
    });
    assert.equal(refused.status, 403);
    // no epic / no stories / a story without a summary → 400
    assert.equal((await call(srv, 'POST', '/cli/add-stories', { token: TOKEN, body: { stories: [{ summary: 'S' }] } })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/add-stories', { token: TOKEN, body: { epic: 'KAN-12', stories: [] } })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/add-stories', { token: TOKEN, body: { epic: 'KAN-12', stories: [{}] } })).status, 400);
    assert.equal(created.length, before, 'no refused call created anything');

    // no service account → 400 no-service-account
    const nocred = await call(srv, 'POST', '/cli/add-stories', { token: OTHER, body: { epic: 'X-1', stories: [{ summary: 'S' }] } });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-service-account');
    // POST only
    assert.equal((await call(srv, 'GET', '/cli/add-stories', { token: TOKEN })).status, 404);
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /add-subtasks creates Sub-tasks under an existing issue, registers own writes, audits (#2900)', async () => {
  // A distinct site keeps the process-lifetime field catalog off other fixtures.
  broker.scopeCredentials.set('team-1', { 'site-url': 'addsubtasksco', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  const created = [];
  const ISSUES = {
    'KAN-10': { key: 'KAN-10', fields: { summary: 'Checkout', project: { key: 'KAN' }, issuetype: { name: 'Story', hierarchyLevel: 0 } } },
    'KAN-12': { key: 'KAN-12', fields: { summary: 'Payments', project: { key: 'KAN' }, issuetype: { name: 'Epic', hierarchyLevel: 1 } } },
  };
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('127.0.0.1')) return origFetch(url, opts);
    if (u.match(/\/rest\/api\/3\/field$/)) return { ok: true, status: 200, text: async () => '[]' };
    const get = u.match(/\/rest\/api\/3\/issue\/([^/?]+)\?fields=/);
    if (get && (!opts || !opts.method || opts.method === 'GET')) {
      const issue = ISSUES[decodeURIComponent(get[1])];
      return issue
        ? { ok: true, status: 200, text: async () => JSON.stringify(issue) }
        : { ok: false, status: 404, text: async () => '{"errorMessages":["Issue does not exist or you do not have permission to see it."]}' };
    }
    if (u.match(/\/rest\/api\/3\/project\/KAN$/)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'KAN', issueTypes: [
        { id: '1', name: 'Story', hierarchyLevel: 0 }, { id: '4', name: 'Epic', hierarchyLevel: 1 }, { id: '5', name: 'Sub-task', subtask: true, hierarchyLevel: -1 },
      ] }) };
    }
    if (u.includes('/rest/api/3/issue/createmeta/')) return { ok: true, status: 200, text: async () => JSON.stringify({ total: 0, fields: [] }) };
    if (opts && opts.method === 'POST' && u.match(/\/rest\/api\/3\/issue$/)) {
      created.push(JSON.parse(opts.body).fields);
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: `KAN-${300 + created.length}` }) };
    }
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  };
  const srv = await listen();
  try {
    const ok = await call(srv, 'POST', '/cli/add-subtasks', {
      token: TOKEN, body: { parent: 'kan-10', subtasks: [{ summary: 'One' }, { summary: 'Two' }, { summary: 'Three' }] },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.parent.key, 'KAN-10');
    assert.equal(ok.body.created, 3);
    assert.deepEqual(ok.body.subtasks.map((s) => s.key), ['KAN-301', 'KAN-302', 'KAN-303']);
    assert.ok(created.every((f) => f.issuetype.id === '5' && f.parent.key === 'KAN-10'), 'Sub-tasks, each under KAN-10');
    const own = broker.ownWritesStore.snapshot('team-1');
    assert.ok(own.issues['KAN-301'] && own.issues['KAN-302'] && own.issues['KAN-303'], 'created Sub-tasks are own writes (origin = agent)');
    assert.ok(own.fields['KAN-301|*']);
    // AC7: the poller's issue_created for a created Sub-task reads origin = agent
    const { extractIssueCreatedEvents } = require('./event-extract');
    const [ev] = extractIssueCreatedEvents({ key: 'KAN-302', issueType: 'Sub-task', created: new Date().toISOString() }, { ownWrites: own });
    assert.equal(ev.origin, 'agent');
    assert.ok(auditLines().some((l) => l.subcommand === 'add-subtasks' && l.outcome === 'ok' && l.detail === 'KAN-10 +3/3 sub-tasks'));

    const before = created.length;
    const missing = await call(srv, 'POST', '/cli/add-subtasks', { token: TOKEN, body: { parent: 'OTHER-1', subtasks: [{ summary: 'S' }] } });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /OTHER-1 was not found, or it is outside this team's Jira scope/);
    const epic = await call(srv, 'POST', '/cli/add-subtasks', { token: TOKEN, body: { parent: 'KAN-12', subtasks: [{ summary: 'S' }] } });
    assert.equal(epic.status, 400);
    assert.match(epic.body.error, /KAN-12 is an Epic — Jira does not allow Sub-tasks directly under an Epic/);
    assert.equal((await call(srv, 'POST', '/cli/add-subtasks', { token: TOKEN, body: { subtasks: [{ summary: 'S' }] } })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/add-subtasks', { token: TOKEN, body: { parent: 'KAN-10', subtasks: [] } })).status, 400);
    assert.equal(created.length, before, 'no refused call created anything');

    const nocred = await call(srv, 'POST', '/cli/add-subtasks', { token: OTHER, body: { parent: 'X-1', subtasks: [{ summary: 'S' }] } });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-service-account');
    assert.equal((await call(srv, 'GET', '/cli/add-subtasks', { token: TOKEN })).status, 404);
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /add-stories with a type creates a Bug and a Task under the Epic; a bad type fails only its issue (#2896)', async () => {
  // A distinct site keeps the process-lifetime field catalog off other fixtures.
  broker.scopeCredentials.set('team-1', { 'site-url': 'addtypedco', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  const created = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('127.0.0.1')) return origFetch(url, opts);
    if (u.match(/\/rest\/api\/3\/field$/)) return { ok: true, status: 200, text: async () => '[]' };
    if (u.match(/\/rest\/api\/3\/issue\/KAN-12\?fields=/)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'KAN-12', fields: { summary: 'Payments', project: { key: 'KAN' }, issuetype: { name: 'Epic', hierarchyLevel: 1 } } }) };
    }
    if (u.match(/\/rest\/api\/3\/project\/KAN$/)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'KAN', issueTypes: [
        { id: '1', name: 'Story', hierarchyLevel: 0 }, { id: '2', name: 'Task', hierarchyLevel: 0 },
        { id: '3', name: 'Bug', hierarchyLevel: 0 }, { id: '4', name: 'Epic', hierarchyLevel: 1 },
      ] }) };
    }
    if (u.includes('/rest/api/3/issue/createmeta/')) return { ok: true, status: 200, text: async () => JSON.stringify({ total: 0, fields: [] }) };
    if (opts && opts.method === 'POST' && u.match(/\/rest\/api\/3\/issue$/)) {
      created.push(JSON.parse(opts.body).fields);
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: `KAN-${200 + created.length}` }) };
    }
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  };
  const srv = await listen();
  try {
    const r = await call(srv, 'POST', '/cli/add-stories', {
      token: TOKEN,
      body: { epic: 'KAN-12', type: 'bug', stories: [{ summary: 'Login fails' }, { summary: 'Rotate keys', type: 'Task' }, { summary: 'X', type: 'Initiative' }] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, 2);
    assert.equal(r.body.failed, 1);
    assert.deepEqual(r.body.stories.map((s) => s.issueType || null), ['Bug', 'Task', null]);
    assert.match(r.body.stories[2].error, /no issue type "Initiative"\. Available: Story, Task, Bug\./);
    assert.deepEqual(created.map((f) => [f.issuetype.id, f.parent.key]), [['3', 'KAN-12'], ['2', 'KAN-12']]);
    const own = broker.ownWritesStore.snapshot('team-1');
    assert.ok(own.issues['KAN-201'] && own.issues['KAN-202'], 'typed issues are own writes (origin = agent)');
    assert.ok(auditLines().some((l) => l.subcommand === 'add-stories' && l.outcome === 'ok' && l.detail === 'KAN-12 +2/3 stories'));
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /set-epic re-parents existing issues, per-issue outcomes, own writes, audit (#2895)', async () => {
  // A distinct site keeps the process-lifetime field catalog off other fixtures.
  broker.scopeCredentials.set('team-1', { 'site-url': 'setepicco', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  const puts = [];
  const ISSUES = {
    'KAN-5': { type: 'Epic', level: 1 }, 'KAN-12': { type: 'Epic', level: 1 }, 'KAN-7': { type: 'Story', level: 0 },
    'KAN-30': { type: 'Story', level: 0 }, 'KAN-31': { type: 'Task', level: 0, parent: 'KAN-5' }, 'KAN-32': { type: 'Bug', level: 0, parent: 'KAN-12' },
  };
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    if (String(url).match(/\/rest\/api\/3\/field$/)) return { ok: true, status: 200, text: async () => '[]' };
    const m = String(url).match(/\/rest\/api\/3\/issue\/([^/?]+)/);
    const issue = m && ISSUES[decodeURIComponent(m[1])];
    if (!issue) return { ok: false, status: 404, text: async () => '{"errorMessages":["Issue does not exist or you do not have permission to see it."]}' };
    if (opts && opts.method === 'PUT') {
      const { fields } = JSON.parse(opts.body);
      puts.push([decodeURIComponent(m[1]), fields]);
      issue.parent = fields.parent ? fields.parent.key : null;
      return { ok: true, status: 204, text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({
      key: decodeURIComponent(m[1]),
      fields: { summary: 'S', issuetype: { name: issue.type, hierarchyLevel: issue.level }, ...(issue.parent ? { parent: { key: issue.parent } } : {}) },
    }) };
  };
  const srv = await listen();
  try {
    const ok = await call(srv, 'POST', '/cli/set-epic', { token: TOKEN, body: { epic: 'kan-12', issues: ['KAN-30', 'KAN-31', 'KAN-32', 'KAN-5', 'GONE-1', 'KAN-30'] } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.epic.key, 'KAN-12');
    assert.deepEqual(ok.body.issues.map((i) => [i.issue, i.outcome]), [
      ['KAN-30', 'added'], ['KAN-31', 'moved'], ['KAN-32', 'unchanged'], ['KAN-5', 'failed'], ['GONE-1', 'failed'],
    ]);
    assert.match(ok.body.issues[4].error, /GONE-1 was not found, or it is outside this team's Jira scope/);
    assert.deepEqual(puts, [['KAN-30', { parent: { key: 'KAN-12' } }], ['KAN-31', { parent: { key: 'KAN-12' } }]]);
    const own = broker.ownWritesStore.snapshot('team-1');
    for (const k of ['KAN-30|parent', 'KAN-30|issueparentassociation', 'KAN-30|epic link', 'KAN-31|parent', 'KAN-12|epic child', 'KAN-5|epic child']) {
      assert.ok(own.fields[k], `own write ${k}`);
    }
    assert.equal(own.fields['KAN-32|parent'], undefined, 'an unchanged issue wrote nothing');
    assert.ok(auditLines().some((l) => l.subcommand === 'set-epic' && l.outcome === 'ok' && l.detail === 'KAN-12: 2 changed, 1 unchanged, 2 failed of 5'));

    // take out of the Epic
    const out = await call(srv, 'POST', '/cli/set-epic', { token: TOKEN, body: { remove: true, issues: ['KAN-30'] } });
    assert.equal(out.status, 200);
    assert.equal(out.body.epic, null);
    assert.deepEqual(out.body.issues.map((i) => i.message), ['removed from KAN-12']);
    assert.deepEqual(puts.slice(-1), [['KAN-30', { parent: null }]]);

    const before = puts.length;
    // the target is refused before anything changes: outside scope (404), not an Epic (400)
    const missing = await call(srv, 'POST', '/cli/set-epic', { token: TOKEN, body: { epic: 'OTHER-1', issues: ['KAN-30'] } });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /Epic OTHER-1 was not found, or it is outside this team's Jira scope/);
    const notEpic = await call(srv, 'POST', '/cli/set-epic', { token: TOKEN, body: { epic: 'KAN-7', issues: ['KAN-30'] } });
    assert.equal(notEpic.status, 400);
    assert.match(notEpic.body.error, /KAN-7 is a Story, not an Epic/);
    // shape: no target, both targets, no issues → 400
    assert.equal((await call(srv, 'POST', '/cli/set-epic', { token: TOKEN, body: { issues: ['KAN-30'] } })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/set-epic', { token: TOKEN, body: { epic: 'KAN-12', remove: true, issues: ['KAN-30'] } })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/set-epic', { token: TOKEN, body: { epic: 'KAN-12', issues: [] } })).status, 400);
    assert.equal(puts.length, before, 'no refused call changed anything');

    // no service account → 400 no-service-account
    const nocred = await call(srv, 'POST', '/cli/set-epic', { token: OTHER, body: { epic: 'X-1', issues: ['X-2'] } });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-service-account');
    // POST only
    assert.equal((await call(srv, 'GET', '/cli/set-epic', { token: TOKEN })).status, 404);
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /set-epic is gated by its own `set-epic` policy, audited when denied (#2895)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  const policy = require('./broker-policy');
  const orig = policy.authorizeWrite;
  policy.authorizeWrite = (op) => (op === 'set-epic' ? { allow: false, code: 'scope-not-allowed', reason: 'not for you' } : orig(op));
  const origFetch = global.fetch;
  const jiraCalls = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    jiraCalls.push(url);
    throw new Error('Jira must not be called');
  };
  const srv = await listen();
  try {
    const r = await call(srv, 'POST', '/cli/set-epic', { token: TOKEN, body: { epic: 'KAN-1', issues: ['KAN-2'] } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: 'not for you', code: 'scope-not-allowed' });
    assert.equal(jiraCalls.length, 0);
    assert.ok(auditLines().some((l) => l.subcommand === 'set-epic' && l.outcome === 'denied' && l.detail === 'scope-not-allowed'));
  } finally {
    policy.authorizeWrite = orig;
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /edit changes standard fields in one Jira edit, own writes per field, audit (#2897)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'editco', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  const puts = [];
  const issue = { summary: 'Old', priority: { name: 'Medium' }, labels: ['web'], components: [], fixVersions: [], duedate: null, assignee: null };
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    if (/\/priority$/.test(u)) return ok([{ name: 'High' }, { name: 'Medium' }]);
    if (/\/project\/KAN\/components$/.test(u)) return ok([{ name: 'Backend' }]);
    const m = u.match(/\/rest\/api\/3\/issue\/([^/?]+)/);
    if (!m || decodeURIComponent(m[1]) !== 'KAN-10') return { ok: false, status: 404, text: async () => '{"errorMessages":["Issue does not exist or you do not have permission to see it."]}' };
    if (opts && opts.method === 'PUT') {
      puts.push(JSON.parse(opts.body));
      return { ok: true, status: 204, text: async () => '' };
    }
    return ok({ key: 'KAN-10', fields: { project: { key: 'KAN' }, ...issue } });
  };
  const srv = await listen();
  try {
    const r = await call(srv, 'POST', '/cli/edit', { token: TOKEN, body: {
      issue: 'kan-10', summary: 'New', priority: 'Medium', labels: { add: ['backend'] }, components: { set: ['backend'] }, dueDate: '2026-10-31', assignee: 'acc-1',
    } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.issue, 'KAN-10');
    assert.deepEqual(r.body.fields.map((f) => [f.field, f.outcome]), [
      ['summary', 'changed'], ['assignee', 'changed'], ['priority', 'unchanged'], ['labels', 'changed'], ['components', 'changed'], ['dueDate', 'changed'],
    ]);
    assert.deepEqual(puts, [{
      fields: { summary: 'New', assignee: { accountId: 'acc-1' }, components: [{ name: 'Backend' }], duedate: '2026-10-31' },
      update: { labels: [{ add: 'backend' }] },
    }]);
    const own = broker.ownWritesStore.snapshot('team-1');
    for (const k of ['KAN-10|summary', 'KAN-10|assignee', 'KAN-10|labels', 'KAN-10|components', 'KAN-10|duedate']) assert.ok(own.fields[k], `own write ${k}`);
    assert.equal(own.fields['KAN-10|priority'], undefined, 'an unchanged field wrote nothing');
    assert.ok(auditLines().some((l) => l.subcommand === 'edit' && l.outcome === 'ok'
      && l.detail === 'KAN-10: changed summary, assignee, labels, components, dueDate, 1 unchanged'));

    // refusals before Jira: invalid date, label with a space, nothing to change, no issue
    const bad = await call(srv, 'POST', '/cli/edit', { token: TOKEN, body: { issue: 'KAN-10', dueDate: '31.10.2026' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /not a valid due date/);
    assert.equal((await call(srv, 'POST', '/cli/edit', { token: TOKEN, body: { issue: 'KAN-10', labels: { add: ['a b'] } } })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/edit', { token: TOKEN, body: { issue: 'KAN-10' } })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/edit', { token: TOKEN, body: { summary: 'x' } })).status, 400);
    // outside the scope (404)
    const gone = await call(srv, 'POST', '/cli/edit', { token: TOKEN, body: { issue: 'OTHER-1', summary: 'x' } });
    assert.equal(gone.status, 404);
    assert.match(gone.body.error, /OTHER-1 was not found, or it is outside this team's Jira scope/);
    assert.ok(auditLines().some((l) => l.subcommand === 'edit' && l.outcome === 'domain-error' && /^OTHER-1: /.test(l.detail)));
    assert.equal(puts.length, 1, 'no refused call wrote anything');

    const nocred = await call(srv, 'POST', '/cli/edit', { token: OTHER, body: { issue: 'X-1', summary: 'x' } });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-service-account');
    assert.equal((await call(srv, 'GET', '/cli/edit', { token: TOKEN })).status, 404);
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /edit is gated by its own `edit` policy, audited when denied (#2897)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  const policy = require('./broker-policy');
  const orig = policy.authorizeWrite;
  policy.authorizeWrite = (op) => (op === 'edit' ? { allow: false, code: 'scope-not-allowed', reason: 'not for you' } : orig(op));
  const origFetch = global.fetch;
  const jiraCalls = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    jiraCalls.push(url);
    throw new Error('Jira must not be called');
  };
  const srv = await listen();
  try {
    const r = await call(srv, 'POST', '/cli/edit', { token: TOKEN, body: { issue: 'KAN-1', summary: 'x' } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: 'not for you', code: 'scope-not-allowed' });
    assert.equal(jiraCalls.length, 0);
    assert.ok(auditLines().some((l) => l.subcommand === 'edit' && l.outcome === 'denied' && l.detail === 'scope-not-allowed'));
  } finally {
    policy.authorizeWrite = orig;
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /add-stories is denied by the same `create` policy as /create-epic, same error shape (#2890 AC10)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  const policy = require('./broker-policy');
  const orig = policy.authorizeWrite;
  policy.authorizeWrite = (op) => (op === 'create' ? { allow: false, code: 'scope-not-allowed', reason: 'not for you' } : orig(op));
  const origFetch = global.fetch;
  const jiraCalls = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    jiraCalls.push(url);
    throw new Error('Jira must not be called');
  };
  const srv = await listen();
  try {
    const epic = await call(srv, 'POST', '/cli/create-epic', { token: TOKEN, body: { project: 'KAN', epic: { summary: 'E' } } });
    const add = await call(srv, 'POST', '/cli/add-stories', { token: TOKEN, body: { epic: 'KAN-1', stories: [{ summary: 'S' }] } });
    assert.equal(add.status, 403);
    assert.deepEqual(add.body, epic.body);
    assert.deepEqual(add.body, { error: 'not for you', code: 'scope-not-allowed' });
    assert.equal(jiraCalls.length, 0);
    assert.ok(auditLines().some((l) => l.subcommand === 'add-stories' && l.outcome === 'denied' && l.detail === 'scope-not-allowed'));
  } finally {
    policy.authorizeWrite = orig;
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /create-issue creates one standalone issue, registers own writes, audits; refusals create nothing (#2894)', async () => {
  // A distinct site keeps the process-lifetime field catalog off other fixtures.
  broker.scopeCredentials.set('team-1', { 'site-url': 'createissueco', email: 'svc@b.c', 'api-token': 'svc-tok', 'writable-custom-fields': 'Team' });
  const origFetch = global.fetch;
  const created = [];
  const auths = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    auths.push(opts && opts.headers && opts.headers.Authorization);
    if (String(url).match(/\/rest\/api\/3\/field$/)) {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 'customfield_20001', name: 'Team', schema: { type: 'team' } }]) };
    }
    const project = String(url).match(/\/rest\/api\/3\/project\/([^/?]+)$/);
    if (project) {
      return decodeURIComponent(project[1]) === 'KAN'
        ? { ok: true, status: 200, text: async () => JSON.stringify({ key: 'KAN', issueTypes: [
          { id: '1', name: 'Bug', subtask: false, hierarchyLevel: 0 },
          { id: '2', name: 'Task', subtask: false, hierarchyLevel: 0 },
          { id: '3', name: 'Epic', subtask: false, hierarchyLevel: 1 },
        ] }) }
        : { ok: false, status: 404, text: async () => '{"errorMessages":["No project could be found."]}' };
    }
    if (String(url).includes('/issue/createmeta/')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ total: 1, fields: [{ fieldId: 'summary', name: 'Summary', required: true }] }) };
    }
    if (opts && opts.method === 'POST' && String(url).match(/\/rest\/api\/3\/issue$/)) {
      created.push(JSON.parse(opts.body).fields);
      return { ok: true, status: 201, text: async () => JSON.stringify({ key: `KAN-${41 + created.length}` }) };
    }
    if (String(url).endsWith('/transitions') && (!opts || opts.method !== 'POST')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ transitions: [{ id: '21', name: 'Start', to: { name: 'In Progress' } }] }) };
    }
    throw new Error(`unexpected ${opts && opts.method} ${url}`);
  };
  const srv = await listen();
  try {
    const ok = await call(srv, 'POST', '/cli/create-issue', {
      token: TOKEN, body: { project: 'kan', type: 'bug', issue: { summary: 'Login fails', labels: ['web'], fields: { Team: '42' } } },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.key, 'KAN-42');
    assert.equal(ok.body.issueType, 'Bug');
    assert.match(ok.body.url, /\/browse\/KAN-42$/);
    assert.deepEqual(created[0].issuetype, { id: '1' });
    assert.equal('parent' in created[0], false, 'no parent');
    assert.deepEqual(created[0].customfield_20001, { id: '42' });
    const own = broker.ownWritesStore.snapshot('team-1');
    assert.ok(own.issues['KAN-42'], 'the created issue is an own write → issue_created carries origin = agent');
    assert.ok(own.fields['KAN-42|*']);
    assert.ok(auditLines().some((l) => l.subcommand === 'create-issue' && l.outcome === 'ok' && l.detail === 'KAN-42 (Bug)'));
    assert.ok(auths.every((a) => a === basic('svc@b.c', 'svc-tok')), 'an automated run uses the service account');

    // an impossible status: still created, the failed transition reported
    const partial = await call(srv, 'POST', '/cli/create-issue', {
      token: TOKEN, body: { project: 'KAN', type: 'Task', issue: { summary: 'S', status: 'Released' } },
    });
    assert.equal(partial.status, 200);
    assert.equal(partial.body.key, 'KAN-43');
    assert.match(partial.body.statusError, /no transition to "Released"/);
    assert.ok(broker.ownWritesStore.snapshot('team-1').issues['KAN-43']);

    const before = created.length;
    const outside = await call(srv, 'POST', '/cli/create-issue', { token: TOKEN, body: { project: 'OTHER', type: 'Bug', issue: { summary: 'S' } } });
    assert.equal(outside.status, 404);
    assert.match(outside.body.error, /outside this team's Jira scope/);
    const epic = await call(srv, 'POST', '/cli/create-issue', { token: TOKEN, body: { project: 'KAN', type: 'Epic', issue: { summary: 'S' } } });
    assert.equal(epic.status, 400);
    assert.match(epic.body.error, /create-epic/);
    const unknown = await call(srv, 'POST', '/cli/create-issue', { token: TOKEN, body: { project: 'KAN', type: 'Story', issue: { summary: 'S' } } });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /Available: Bug, Task\./);
    const refused = await call(srv, 'POST', '/cli/create-issue', {
      token: TOKEN, body: { project: 'KAN', type: 'Bug', issue: { summary: 'S', fields: { Priority: 'High' } } },
    });
    assert.equal(refused.status, 403);
    assert.equal((await call(srv, 'POST', '/cli/create-issue', { token: TOKEN, body: { type: 'Bug', issue: { summary: 'S' } } })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/create-issue', { token: TOKEN, body: { project: 'KAN', issue: { summary: 'S' } } })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/create-issue', { token: TOKEN, body: { project: 'KAN', type: 'Bug' } })).status, 400);
    assert.equal(created.length, before, 'no refused call created anything');

    const nocred = await call(srv, 'POST', '/cli/create-issue', { token: OTHER, body: { project: 'KAN', type: 'Bug', issue: { summary: 'S' } } });
    assert.equal(nocred.status, 400);
    assert.equal(nocred.body.code, 'no-service-account');
    assert.equal((await call(srv, 'GET', '/cli/create-issue', { token: TOKEN })).status, 404);

    // a chat turn: the sender's own token, audited under their identity
    auths.length = 0;
    broker._setGrantResolver(async () => ({ ok: true, mode: 'personal', interactive: true, agentId: 'team-1-dev', userId: 'alice', values: { email: 'alice@b.c', 'api-token': 'alice-tok' } }));
    const chat = await callAs(srv, 'POST', '/cli/create-issue', {
      token: TOKEN, caller: 'aeecall1.x.y', body: { project: 'KAN', type: 'Task', issue: { summary: 'From chat' } },
    });
    assert.equal(chat.status, 200);
    assert.ok(auths.length > 0 && auths.every((a) => a === basic('alice@b.c', 'alice-tok')), 'every Jira call as alice');
    assert.ok(auditLines().some((l) => l.subcommand === 'create-issue' && l.identity === 'alice' && l.outcome === 'ok'));
  } finally {
    broker._setGrantResolver(SERVICE_GRANT);
    global.fetch = origFetch;
    broker.ownWritesStore.teardown('team-1');
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli writes: /create-issue is denied by the same `create` policy as /create-epic (#2894)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  const policy = require('./broker-policy');
  const orig = policy.authorizeWrite;
  policy.authorizeWrite = (op) => (op === 'create' ? { allow: false, code: 'scope-not-allowed', reason: 'not for you' } : orig(op));
  const origFetch = global.fetch;
  const jiraCalls = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    jiraCalls.push(url);
    throw new Error('Jira must not be called');
  };
  const srv = await listen();
  try {
    const r = await call(srv, 'POST', '/cli/create-issue', { token: TOKEN, body: { project: 'KAN', type: 'Bug', issue: { summary: 'S' } } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: 'not for you', code: 'scope-not-allowed' });
    assert.equal(jiraCalls.length, 0);
    assert.ok(auditLines().some((l) => l.subcommand === 'create-issue' && l.outcome === 'denied' && l.detail === 'scope-not-allowed'));
  } finally {
    policy.authorizeWrite = orig;
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
  const admin = signViewerHeaders({ sub: 'a', role: 'team-admin', teamIds: ['team-1'], teamRoles: { 'team-1': 'team-admin' } }, 'test-secret');
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

    // a body without a watches array (lost in a proxy) is refused, never read as "clear"
    for (const bad of ['', '{}', 'not json']) {
      const r = await ui('/ui/api/admin/watch?team=team-1', { method: 'PUT', headers: { ...admin, 'Content-Type': 'application/json' }, body: bad });
      assert.equal(r.status, 400, `body ${JSON.stringify(bad)}`);
    }

    const get = await ui('/ui/api/admin/watch?team=team-1', { headers: admin });
    assert.deepEqual(get.body.watches[0].statusFilters, ['Ready for Dev', 'In Review']);
    assert.deepEqual(get.body.watches[0].events, ['status_changed']); // migrated default
    // the checkbox vocabulary comes from the broker, one entry per KNOWN_EVENTS kind
    const { KNOWN_EVENTS } = require('./event-extract');
    assert.deepEqual(get.body.eventKinds.map((k) => k.name), KNOWN_EVENTS);
    assert.ok(get.body.eventKinds.every((k) => typeof k.label === 'string' && k.label));
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
  const admin = signViewerHeaders({ sub: 'a', role: 'team-admin', teamIds: ['team-1'], teamRoles: { 'team-1': 'team-admin' } }, 'test-secret');
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

test('ui /admin: the gate is the SELECTED team\'s role — admin of A, member of B cannot reconfigure B (F4)', async () => {
  // The proxy signs a flat `role` (the caller's MAX across granted teams) AND
  // a per-team map. `?team=` lets the request choose the team; gating /admin
  // on the flat role would let U (admin of A, member of B) rewrite which
  // projects / transitions wake B's agents, under B's Jira credential.
  const srv = await listen();
  const { port } = srv.address();
  async function ui(pathname, opts) {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, opts || {});
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  const u = signViewerHeaders({
    sub: 'u', role: 'team-admin', teamIds: ['team-1', 'team-2'],
    teamRoles: { 'team-1': 'team-admin', 'team-2': 'team-member' },
  }, 'test-secret');
  const json = { ...u, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ watches: [{ projectKey: 'EVIL' }] });
  try {
    // B: every elevated route refuses, and nothing was written
    assert.equal((await ui('/ui/api/admin/watch?team=team-2', { headers: u })).status, 403);
    assert.equal((await ui('/ui/api/admin/watch?team=team-2', { method: 'PUT', headers: json, body })).status, 403);
    assert.equal((await ui('/ui/api/admin/retry?team=team-2', { method: 'POST', headers: json, body: JSON.stringify({ projectKey: 'KAN' }) })).status, 403);
    assert.deepEqual(broker.watchStore.loadConfig('team-2').watches, []);
    // …while B's team-member routes still work for U
    assert.equal((await ui('/ui/api/watches?team=team-2', { headers: u })).status, 200);
    // A: U really is admin there
    assert.equal((await ui('/ui/api/admin/watch?team=team-1', { method: 'PUT', headers: json, body })).status, 200);
    assert.equal(broker.watchStore.loadConfig('team-1').watches[0].projectKey, 'EVIL');
    // /context tells the UI per team, so the admin page only offers A
    const ctx = await ui('/ui/api/context', { headers: u });
    assert.equal(ctx.body.isAdmin, true);
    assert.deepEqual(ctx.body.teams.map((t) => [t.teamId, t.isAdmin]), [['team-1', true], ['team-2', false]]);
    // A header from an OLDER proxy (no per-team map) can never elevate: the
    // flat role alone does not open /admin for any team.
    const legacy = signViewerHeaders({ sub: 'u', role: 'team-admin', teamIds: ['team-1'] }, 'test-secret');
    assert.equal((await ui('/ui/api/admin/watch?team=team-1', { headers: legacy })).status, 403);
  } finally {
    broker.watchStore.teardown('team-1');
    broker.watchStore.teardown('team-2');
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

    // A project digest (F8): one wake, no eventId, the collapsed set in the
    // payload (capped at 20, `count` says how many really), projectKey on top.
    const events = Array.from({ length: 25 }, (_, i) => ({ id: `KAN-${i}:${i}`, event: 'status_changed', issueKey: `KAN-${i}`, projectKey: 'KAN', fromStatus: 'To Do', toStatus: 'Ready for Dev' }));
    await broker.deliver({ scopeId: 'team-1', kind: 'digest', convKey: 'project:KAN', projectKey: 'KAN', events });
    assert.equal(captured.length, 2);
    const dg = captured[1].body;
    assert.equal(dg.event, 'status_changed');
    assert.equal('eventId' in dg, false);
    assert.equal(dg.summary, '25 status changes in KAN');
    assert.equal(dg.payload.kind, 'digest');
    assert.equal(dg.payload.projectKey, 'KAN');
    assert.equal(dg.payload.count, 25);
    // The WHOLE folded set travels: the orchestrator filters per target and
    // only then caps what goes into a prompt. A broker-side cut would hide
    // events past the cut from every agent's payloadFilter match.
    assert.equal(dg.payload.events.length, 25);
    assert.equal('truncated' in dg.payload, false);

    // Only the hard safety cap (DIGEST_MAX_EVENTS) cuts, and then says so.
    const huge = Array.from({ length: broker.DIGEST_MAX_EVENTS + 1 }, (_, i) => ({ id: `KAN-${i}:${i}`, event: 'status_changed', issueKey: `KAN-${i}`, projectKey: 'KAN', toStatus: 'Ready for Dev' }));
    await broker.deliver({ scopeId: 'team-1', kind: 'digest', convKey: 'project:KAN', projectKey: 'KAN', events: huge });
    assert.equal(captured.length, 3);
    assert.equal(captured[2].body.payload.count, broker.DIGEST_MAX_EVENTS + 1);
    assert.equal(captured[2].body.payload.events.length, broker.DIGEST_MAX_EVENTS);
    assert.equal(captured[2].body.payload.truncated, true);
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

test('test-scope-credential: orchestrator-only; one /myself read with the pushed credential; token never returned (#2640)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'supersecrettoken' });
  broker.scopeCredentials.set('team-2', { 'site-url': 'acme' }); // site only
  const origFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    seen.push({ url: String(url), auth: opts && opts.headers && opts.headers.Authorization });
    if (String(url).endsWith('/rest/api/3/myself')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ accountId: 'a1', displayName: 'Jira Bot', active: true }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ baseUrl: 'https://acme.atlassian.net' }) };
  };
  const srv = await listen();
  try {
    // bearer required, and a granted TEAM token is not enough — only `_internal`
    assert.equal((await call(srv, 'POST', '/internal/test-scope-credential', { body: { scopeId: 'team-1' } })).status, 401);
    assert.equal((await call(srv, 'POST', '/internal/test-scope-credential', { token: TOKEN, body: { scopeId: 'team-1' } })).status, 401);
    assert.equal(seen.length, 0);
    assert.equal((await call(srv, 'POST', '/internal/test-scope-credential', { token: INTERNAL, body: {} })).status, 400);

    const r = await call(srv, 'POST', '/internal/test-scope-credential', { token: INTERNAL, body: { scopeId: 'team-1' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.scopeId, 'team-1');
    assert.equal(r.body.ok, true);
    assert.equal(r.body.state, 'connected');
    assert.equal(r.body.account, 'Jira Bot');
    assert.deepEqual(seen.map((s) => s.url), ['https://acme.atlassian.net/rest/api/3/myself']);
    assert.equal(seen[0].auth, `Basic ${Buffer.from('a@b.c:supersecrettoken').toString('base64')}`);
    assert.equal(JSON.stringify(r.body).includes('supersecrettoken'), false);

    // site only → anonymous serverInfo, no Authorization header
    const s = await call(srv, 'POST', '/internal/test-scope-credential', { token: INTERNAL, body: { scopeId: 'team-2' } });
    assert.equal(s.body.state, 'site-reachable');
    assert.equal(seen[1].url, 'https://acme.atlassian.net/rest/api/3/serverInfo');
    assert.equal(seen[1].auth, undefined);

    // unknown scope → not-configured, no Jira call
    const n = await call(srv, 'POST', '/internal/test-scope-credential', { token: INTERNAL, body: { scopeId: 'team-9' } });
    assert.equal(n.body.state, 'not-configured');
    assert.equal(seen.length, 2);
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    broker.scopeCredentials.delete('team-2');
    srv.close();
  }
});

test('cli sprint: /sprint/list reads a board sprints; /sprint/create + /sprint/bulk-create write (#2450)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'sprintco', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  const created = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    const u = String(url);
    if (/\/rest\/agile\/1\.0\/board\?/.test(u)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [{ id: 42, name: 'Team Scrum Board', type: 'scrum' }] }) };
    }
    if (/\/rest\/agile\/1\.0\/board\/42\/sprint/.test(u)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [
        { id: 1, name: 'Prev', state: 'future', startDate: '2026-10-19T00:00:00.000Z', endDate: '2026-10-25T00:00:00.000Z', originBoardId: 42 },
      ] }) };
    }
    if (/\/rest\/agile\/1\.0\/sprint$/.test(u) && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      created.push(body);
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 100 + created.length, name: body.name, state: 'future', originBoardId: 42 }) };
    }
    throw new Error(`unexpected ${opts && opts.method} ${u}`);
  };
  const srv = await listen();
  try {
    // read: list sprints on the board
    const listed = await call(srv, 'GET', '/cli/sprint/list?board=' + encodeURIComponent('Team Scrum Board'), { token: TOKEN });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.board.id, '42');
    assert.equal(listed.body.sprints[0].name, 'Prev');

    // write: create one sprint
    const one = await call(srv, 'POST', '/cli/sprint/create', {
      token: TOKEN, body: { board: 'Team Scrum Board', name: 'Sprint 12', start: '2026-10-26', end: '2026-11-01' },
    });
    assert.equal(one.status, 200);
    assert.equal(one.body.sprint.id, '101');
    assert.deepEqual(created[created.length - 1], {
      name: 'Sprint 12', originBoardId: 42, startDate: '2026-10-26T00:00:00.000Z', endDate: '2026-11-01T00:00:00.000Z',
    });

    // write: bulk-create continues from Prev's end (Mon 2026-10-26) through the target date
    const bulk = await call(srv, 'POST', '/cli/sprint/bulk-create', {
      token: TOKEN, body: { board: 'Team Scrum Board', nameTemplate: 'Acc2.0 {MMM}_{weekOfMonth}', until: '2026-11-08' },
    });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.body.requested, 2);
    assert.equal(bulk.body.created, 2);
    assert.equal(bulk.body.sprints[0].name, 'Acc2.0 Oct_4');
    assert.equal(bulk.body.sprints[1].name, 'Acc2.0 Nov_1');

    // board name required
    assert.equal((await call(srv, 'GET', '/cli/sprint/list', { token: TOKEN })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/sprint/create', { token: TOKEN, body: { name: 'x' } })).status, 400);

    // a scope with no service account → 400 no-service-account (both read and write)
    assert.equal((await call(srv, 'GET', '/cli/sprint/list?board=B', { token: OTHER })).body.code, 'no-service-account');
    const nocred = await call(srv, 'POST', '/cli/sprint/bulk-create', { token: OTHER, body: { board: 'B', nameTemplate: 'S{n}', until: '2026-01-01' } });
    assert.equal(nocred.body.code, 'no-service-account');

    // a GET on a write path → 404 (POST only)
    assert.equal((await call(srv, 'GET', '/cli/sprint/create', { token: TOKEN })).status, 404);
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli sprint: /sprint/close, /sprint/start and /sprint/advance transition sprint state (#2491)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'sprintco', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  const writes = [];
  // one active (id 1) + one future (id 2) sprint on board 42
  const sprintList = [
    { id: 1, name: 'Cur', state: 'active', startDate: '2026-10-19T00:00:00.000Z', endDate: '2026-10-25T00:00:00.000Z', originBoardId: 42 },
    { id: 2, name: 'Next', state: 'future', startDate: '2026-10-26T00:00:00.000Z', endDate: '2026-11-01T00:00:00.000Z', originBoardId: 42 },
  ];
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    const u = String(url);
    if (/\/rest\/agile\/1\.0\/board\?/.test(u)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [{ id: 42, name: 'Team Scrum Board', type: 'scrum' }] }) };
    }
    if (/\/rest\/agile\/1\.0\/sprint\/\d+\/issue/.test(u)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ total: 1, issues: [{ id: 'x', fields: { status: { statusCategory: { key: 'new' } } } }] }) };
    }
    if (/\/rest\/agile\/1\.0\/board\/42\/sprint/.test(u)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: sprintList }) };
    }
    if (/\/rest\/agile\/1\.0\/sprint\/(\d+)$/.test(u) && opts.method === 'POST') {
      const id = Number(u.match(/\/sprint\/(\d+)$/)[1]);
      const body = JSON.parse(opts.body);
      writes.push({ id, state: body.state });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id, name: body.name, state: body.state, originBoardId: 42 }) };
    }
    throw new Error(`unexpected ${opts && opts.method} ${u}`);
  };
  const srv = await listen();
  try {
    // close the active sprint → reports incompleteIssues
    const closed = await call(srv, 'POST', '/cli/sprint/close', { token: TOKEN, body: { board: 'Team Scrum Board' } });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.sprint.id, '1');
    assert.equal(closed.body.sprint.state, 'closed');
    assert.equal(closed.body.incompleteIssues, 1);

    // with no active sprint left, start the next future one
    sprintList[0].state = 'closed';
    const started = await call(srv, 'POST', '/cli/sprint/start', { token: TOKEN, body: { board: 'Team Scrum Board' } });
    assert.equal(started.status, 200);
    assert.equal(started.body.sprint.id, '2');
    assert.equal(started.body.sprint.state, 'active');

    // board name required + POST-only
    assert.equal((await call(srv, 'POST', '/cli/sprint/close', { token: TOKEN, body: {} })).status, 400);
    assert.equal((await call(srv, 'GET', '/cli/sprint/advance', { token: TOKEN })).status, 404);

    // no-credential scope
    assert.equal((await call(srv, 'POST', '/cli/sprint/start', { token: OTHER, body: { board: 'B' } })).body.code, 'no-service-account');
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli sprint: /sprint/advance reports a partial roll-over distinctly (#2491)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'sprintco', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    const u = String(url);
    if (/\/rest\/agile\/1\.0\/board\?/.test(u)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [{ id: 42, name: 'Team Scrum Board', type: 'scrum' }] }) };
    }
    if (/\/rest\/agile\/1\.0\/sprint\/\d+\/issue/.test(u)) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ total: 0, issues: [] }) };
    }
    if (/\/rest\/agile\/1\.0\/board\/42\/sprint/.test(u)) {
      // only an active sprint, no future one to start
      return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [
        { id: 1, name: 'Cur', state: 'active', startDate: '2026-10-19T00:00:00.000Z', endDate: '2026-10-25T00:00:00.000Z', originBoardId: 42 },
      ] }) };
    }
    if (/\/rest\/agile\/1\.0\/sprint\/(\d+)$/.test(u) && opts.method === 'POST') {
      const id = Number(u.match(/\/sprint\/(\d+)$/)[1]);
      const body = JSON.parse(opts.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ id, state: body.state }) };
    }
    throw new Error(`unexpected ${opts && opts.method} ${u}`);
  };
  const srv = await listen();
  try {
    const adv = await call(srv, 'POST', '/cli/sprint/advance', { token: TOKEN, body: { board: 'Team Scrum Board' } });
    assert.equal(adv.status, 200); // partial is a 200 with a failed flag, not an HTTP error
    assert.equal(adv.body.close.ok, true);
    assert.equal(adv.body.start.ok, false);
    assert.match(adv.body.start.error, /no future sprint to start/);
    assert.equal(adv.body.failed, true);
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

// ── per-person Jira credentials (#2562) ─────────────────────────────────────

const SERVICE_GRANT = async () => ({ ok: true, mode: 'service', interactive: false, agentId: 'team-1-dev' });

async function callAs(srv, method, urlPath, { token, body, caller } = {}) {
  const { port } = srv.address();
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(caller ? { 'X-AEE-Agent-Token': caller } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function basic(email, token) {
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

function auditLines() {
  const dir = path.join(STATE, 'audit');
  return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

function stubJira(seen, { status = 200 } = {}) {
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    seen.push({ url: String(url), auth: opts && opts.headers && opts.headers.Authorization });
    if (status !== 200) return { ok: false, status, text: async () => '' };
    if (String(url).includes('/comment')) return { ok: true, status: 201, text: async () => JSON.stringify({ id: '1' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ isLast: true, values: [{ key: 'KAN', name: 'Kanban', id: '1' }] }) };
  };
  return () => { global.fetch = origFetch; };
}

test('a chat turn uses the SENDER\'s own Jira credential on the team\'s site, per call; the audit names them', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok', 'readable-custom-fields': 'Team' });
  const grants = [];
  broker._setGrantResolver(async (req) => {
    grants.push(req);
    const who = grants.length === 1 ? 'alice' : 'bob';
    return { ok: true, mode: 'personal', interactive: true, agentId: 'team-1-dev', userId: who, values: { email: `${who}@b.c`, 'api-token': `${who}-tok` } };
  });
  const seen = [];
  const restore = stubJira(seen);
  const srv = await listen();
  try {
    // consecutive turns from different members each use their own token (AC8)
    const r1 = await callAs(srv, 'GET', '/cli/projects', { token: TOKEN, caller: 'aeecall1.x.y' });
    assert.equal(r1.status, 200);
    const r2 = await callAs(srv, 'POST', '/cli/comment', { token: TOKEN, caller: 'aeecall1.x.y', body: { issue: 'KAN-1', body: 'hi' } });
    assert.equal(r2.status, 200);
    assert.equal(seen[0].auth, basic('alice@b.c', 'alice-tok'));
    assert.ok(seen[0].url.includes('acme'));
    assert.ok(seen.slice(1).every((c) => c.auth === basic('bob@b.c', 'bob-tok')), 'the write is authored by bob');
    assert.ok(seen.every((c) => c.auth !== basic('svc@b.c', 'svc-tok')), 'never the service account');
    // the CLI's caller token is what the broker forwards — nothing else
    assert.deepEqual(grants.map((g) => g.callerToken), ['aeecall1.x.y', 'aeecall1.x.y']);
    assert.deepEqual(grants.map((g) => g.scopeId), ['team-1', 'team-1']);
    // audit: identity, agent, interactive (AC11); no secret in the line
    const lines = auditLines().filter((l) => l.identity === 'alice' || l.identity === 'bob');
    assert.ok(lines.some((l) => l.identity === 'alice' && l.subcommand === 'projects' && l.agentId === 'team-1-dev' && l.interactive === true));
    assert.ok(lines.some((l) => l.identity === 'bob' && l.subcommand === 'comment' && l.interactive === true));
    assert.equal(JSON.stringify(auditLines()).includes('-tok'), false);
    // the personal token was never stored in the broker's pushed map
    assert.equal(broker.scopeCredentials.get('team-1')['api-token'], 'svc-tok');
  } finally {
    restore();
    broker._setGrantResolver(SERVICE_GRANT);
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

// ── project versions (#2902) ─────────────────────────────────────────────────

function versionJira({ canAdmin = true, unresolved = 0 } = {}) {
  const versions = [
    { id: '10001', name: '1.3', released: true, archived: false, releaseDate: '2026-09-01', self: 'http://jira/rest/api/3/version/10001' },
    { id: '10002', name: '1.4', released: false, archived: false, startDate: '2026-09-02', releaseDate: '2026-10-31', self: 'http://jira/rest/api/3/version/10002' },
    { id: '10003', name: '1.5', released: false, archived: false, self: 'http://jira/rest/api/3/version/10003' },
  ];
  const writes = [];
  const handler = async (url, opts) => {
    const u = new URL(String(url));
    const method = (opts && opts.method) || 'GET';
    const ok = (body, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(body) });
    const no = (status, body) => ({ ok: false, status, text: async () => JSON.stringify(body) });
    if (u.pathname === '/rest/api/3/project/KAN') return ok({ id: '100', key: 'KAN' });
    if (u.pathname === '/rest/api/3/project/KAN/versions') return ok(versions);
    if (/^\/rest\/api\/3\/project\//.test(u.pathname)) return no(404, { errorMessages: ['No project could be found with key \'OTHER\'.'] });
    if (u.pathname === '/rest/api/3/version' && method === 'POST') {
      if (!canAdmin) return no(403, { errorMessages: ['You do not have permission'] });
      const body = JSON.parse(opts.body);
      writes.push({ method, path: u.pathname, body });
      const created = { id: '10009', self: 'http://jira/rest/api/3/version/10009', released: false, archived: false, ...body };
      versions.push(created);
      return ok(created, 201);
    }
    const count = u.pathname.match(/^\/rest\/api\/3\/version\/(\d+)\/unresolvedIssueCount$/);
    if (count) return ok({ issuesUnresolvedCount: unresolved, issuesCount: unresolved + 2 });
    if (u.pathname === '/rest/api/3/search/jql') return ok({ issues: Array.from({ length: unresolved }, (_, i) => ({ key: `KAN-${20 + i}` })), isLast: true });
    const put = u.pathname.match(/^\/rest\/api\/3\/version\/(\d+)$/);
    if (put && method === 'PUT') {
      if (!canAdmin) return no(403, { errorMessages: ['You do not have permission'] });
      const body = JSON.parse(opts.body);
      writes.push({ method, path: u.pathname, body });
      const v = versions.find((x) => x.id === put[1]);
      Object.assign(v, { released: body.released, releaseDate: body.releaseDate });
      return ok(v);
    }
    return no(404, {});
  };
  return { handler, writes };
}

async function withVersionJira(opts, fn) {
  broker.scopeCredentials.set('team-1', { 'site-url': 'verco', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  const jira = versionJira(opts);
  global.fetch = async (url, o) => (String(url).includes('127.0.0.1') ? origFetch(url, o) : jira.handler(url, o));
  const srv = await listen();
  try {
    await fn(srv, jira.writes);
  } finally {
    global.fetch = origFetch;
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
}

test('cli: /version/list returns the versions unreleased first, audited (#2902 AC1)', async () => {
  await withVersionJira({}, async (srv) => {
    const r = await call(srv, 'GET', '/cli/version/list?project=kan', { token: TOKEN });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.project, 'KAN');
    assert.deepEqual(r.body.versions.map((v) => [v.name, v.released]), [['1.4', false], ['1.5', false], ['1.3', true]]);
    assert.ok(auditLines().some((l) => l.subcommand === 'version-list' && l.outcome === 'ok' && l.detail === 'KAN:3'));
    const gone = await call(srv, 'GET', '/cli/version/list?project=OTHER', { token: TOKEN });
    assert.equal(gone.status, 404);
    assert.match(gone.body.error, /Project OTHER was not found, or it is outside this team's Jira scope/);
    assert.equal((await call(srv, 'GET', '/cli/version/list', { token: TOKEN })).status, 400);
  });
});

test('cli writes: /version/create creates a version, refuses a duplicate name, audited (#2902 AC2/AC3/AC8)', async () => {
  await withVersionJira({}, async (srv, writes) => {
    const r = await call(srv, 'POST', '/cli/version/create', { token: TOKEN, body: { project: 'KAN', name: '1.6', releaseDate: '2026-12-01' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.version.name, '1.6');
    assert.deepEqual(writes[0].body, { name: '1.6', projectId: 100, releaseDate: '2026-12-01' });
    assert.ok(auditLines().some((l) => l.subcommand === 'version-create' && l.outcome === 'ok' && l.detail === 'KAN:1.6 (10009)'));
    const list = await call(srv, 'GET', '/cli/version/list?project=KAN', { token: TOKEN });
    assert.ok(list.body.versions.some((v) => v.name === '1.6' && v.releaseDate === '2026-12-01'));

    const dup = await call(srv, 'POST', '/cli/version/create', { token: TOKEN, body: { project: 'KAN', name: '1.5' } });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /project KAN already has a version "1\.5" \(unreleased\)\. Nothing was created\./);
    assert.equal(writes.length, 1, 'a duplicate is refused before Jira is asked to create');
    assert.ok(auditLines().some((l) => l.subcommand === 'version-create' && l.outcome === 'domain-error' && /^KAN: /.test(l.detail)));
  });
});

test('cli writes: /version/release releases, moves unresolved issues and stamps them as own writes (#2902 AC4/AC5/AC8)', async () => {
  await withVersionJira({ unresolved: 2 }, async (srv, writes) => {
    const r = await call(srv, 'POST', '/cli/version/release', { token: TOKEN, body: { project: 'KAN', name: '1.4', releaseDate: '2026-10-07', moveTo: '1.5' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outcome, 'released');
    assert.equal(r.body.unresolvedIssues, 2);
    assert.equal(r.body.movedTo, '1.5');
    assert.deepEqual(writes[0].body, { released: true, releaseDate: '2026-10-07', moveUnfixedIssuesTo: 'http://jira/rest/api/3/version/10003' });
    const own = broker.ownWritesStore.snapshot('team-1');
    for (const k of ['KAN-20|fixversions', 'KAN-21|fixversions', 'KAN-20|fix version']) assert.ok(own.fields[k], `own write ${k}`);
    assert.ok(auditLines().some((l) => l.subcommand === 'version-release' && l.outcome === 'ok'
      && l.detail === 'KAN:1.4 released 2026-10-07, 2 unresolved moved to 1.5'));
    const again = await call(srv, 'POST', '/cli/version/release', { token: TOKEN, body: { project: 'KAN', name: '1.4' } });
    assert.equal(again.status, 200);
    assert.equal(again.body.outcome, 'already-released');
    assert.equal(writes.length, 1);
  });
});

test('cli writes: a 403 from Jira on a version write names the missing permission (#2902 AC6)', async () => {
  await withVersionJira({ canAdmin: false }, async (srv) => {
    for (const [url, body] of [['/cli/version/create', { project: 'KAN', name: '2.0' }], ['/cli/version/release', { project: 'KAN', name: '1.4' }]]) {
      const r = await call(srv, 'POST', url, { token: TOKEN, body });
      assert.equal(r.status, 403, url);
      assert.match(r.body.error, /may not manage versions in project KAN \(403\) — creating and releasing versions needs the Jira "Administer Projects" permission/);
    }
  });
});

test('cli writes: version-create / version-release are gated by their own policy, audited when denied (#2902 AC8)', async () => {
  const policy = require('./broker-policy');
  const orig = policy.authorizeWrite;
  policy.authorizeWrite = (op) => (op.startsWith('version-') ? { allow: false, code: 'scope-not-allowed', reason: 'not for you' } : orig(op));
  try {
    await withVersionJira({}, async (srv, writes) => {
      for (const [url, sub] of [['/cli/version/create', 'version-create'], ['/cli/version/release', 'version-release']]) {
        const r = await call(srv, 'POST', url, { token: TOKEN, body: { project: 'KAN', name: '1.4' } });
        assert.equal(r.status, 403);
        assert.deepEqual(r.body, { error: 'not for you', code: 'scope-not-allowed' });
        assert.ok(auditLines().some((l) => l.subcommand === sub && l.outcome === 'denied' && l.detail === 'scope-not-allowed'));
      }
      assert.equal(writes.length, 0);
    });
  } finally {
    policy.authorizeWrite = orig;
  }
});

test('a refused grant blocks EVERY subcommand before Jira is touched (AC4/AC5)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  broker._setGrantResolver(async () => ({
    ok: false, status: 424, code: 'personal-credential-required', agentId: 'team-1-dev',
    message: 'You have no personal Jira credential yet. … Connections → Plugin Tokens (/plugin-tokens) … Nothing was sent to Jira.',
  }));
  const seen = [];
  const restore = stubJira(seen);
  const srv = await listen();
  try {
    const routes = [
      ['GET', '/cli/whoami'], ['GET', '/cli/inbox'], ['GET', '/cli/inbox?consume=KAN-1:1'], ['GET', '/cli/projects'],
      ['GET', '/cli/show?issue=KAN-1'], ['GET', '/cli/sprint/list?board=B'], ['GET', '/cli/attachment?issue=KAN-1&id=1'], ['GET', '/cli/users?query=Anna'], ['GET', '/cli/comments?issue=KAN-1'], ['GET', '/cli/version/list?project=KAN'],
      ['POST', '/cli/comment'], ['POST', '/cli/transition'], ['POST', '/cli/create-epic'], ['POST', '/cli/add-stories'], ['POST', '/cli/add-subtasks'], ['POST', '/cli/create-issue'], ['POST', '/cli/set-epic'], ['POST', '/cli/edit'], ['POST', '/cli/sprint/create'],
      ['POST', '/cli/version/create'], ['POST', '/cli/version/release'],
      ['POST', '/cli/attachment/add'],
    ];
    for (const [method, url] of routes) {
      const r = await callAs(srv, method, url, { token: TOKEN, body: method === 'POST' ? { issue: 'KAN-1', body: 'x' } : undefined });
      assert.equal(r.status, 424, `${method} ${url}`);
      assert.equal(r.body.code, 'personal-credential-required');
      assert.match(r.body.error, /\/plugin-tokens/);
    }
    assert.equal(seen.length, 0, 'nothing was sent to Jira');
    assert.ok(auditLines().some((l) => l.outcome === 'denied' && l.detail === 'personal-credential-required' && l.agentId === 'team-1-dev'));
  } finally {
    restore();
    broker._setGrantResolver(SERVICE_GRANT);
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('personal 401 → "renew your token"; 403 passes through unchanged and is never retried as the service account', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  broker._setGrantResolver(async () => ({ ok: true, mode: 'personal', interactive: true, agentId: 'team-1-dev', userId: 'alice', values: { email: 'a@b.c', 'api-token': 'old' } }));
  const srv = await listen();
  try {
    let seen = [];
    let restore = stubJira(seen, { status: 401 });
    let r = await callAs(srv, 'GET', '/cli/projects', { token: TOKEN });
    restore();
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'personal-credential-rejected');
    assert.match(r.body.error, /renew it/);

    seen = [];
    restore = stubJira(seen, { status: 403 });
    r = await callAs(srv, 'POST', '/cli/comment', { token: TOKEN, body: { issue: 'KAN-1', body: 'x' } });
    restore();
    assert.equal(r.status, 403);
    assert.ok(seen.length >= 1);
    assert.ok(seen.every((c) => c.auth === basic('a@b.c', 'old')), 'no retry under the service account');
  } finally {
    broker._setGrantResolver(SERVICE_GRANT);
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('autonomous run: service account, audited as non-interactive; none configured → no-service-account (AC7)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  broker._setGrantResolver(async () => ({ ok: true, mode: 'service', interactive: false, agentId: 'team-1-cron' }));
  const seen = [];
  const restore = stubJira(seen);
  const srv = await listen();
  try {
    const r = await callAs(srv, 'GET', '/cli/projects', { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(seen[0].auth, basic('svc@b.c', 'svc-tok'));
    assert.ok(auditLines().some((l) => l.agentId === 'team-1-cron' && l.identity === 'service-account' && l.interactive === false));
    const who = await callAs(srv, 'GET', '/cli/whoami', { token: TOKEN });
    assert.equal(who.body.identity, 'service-account');

    const none = await callAs(srv, 'GET', '/cli/projects', { token: OTHER });
    assert.equal(none.status, 400);
    assert.equal(none.body.code, 'no-service-account');
    assert.match(none.body.error, /service account/);
  } finally {
    restore();
    broker._setGrantResolver(SERVICE_GRANT);
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('the default grant resolver asks the orchestrator with the reserved grant token + caller token and fails closed', async () => {
  broker._setGrantResolver(null); // the real round-trip
  const origFetch = global.fetch;
  const asked = [];
  let answer = { status: 200, body: { ok: true, mode: 'service', interactive: false, agentId: 'team-1-dev' } };
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    if (String(url).endsWith('/internal/plugin-credential-grant')) {
      asked.push({ auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
      if (answer === 'throw') throw new Error('ECONNREFUSED');
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
    }
    throw new Error(`unexpected ${url}`);
  };
  const srv = await listen();
  try {
    let r = await callAs(srv, 'GET', '/cli/whoami', { token: TOKEN, caller: 'aeecall1.abc.def' });
    assert.equal(r.status, 200);
    // The reserved grant scope — never the team token the agent holds (review B1).
    assert.equal(asked[0].auth, `Bearer ${mint('jira', '_grant-team-1', 'test-secret')}`);
    assert.notEqual(asked[0].auth, `Bearer ${TOKEN}`);
    assert.deepEqual(asked[0].body, { callerToken: 'aeecall1.abc.def' });

    answer = { status: 403, body: { ok: false, code: 'untrusted-sender', message: 'Refused: not a member.' } };
    r = await callAs(srv, 'GET', '/cli/whoami', { token: TOKEN });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'untrusted-sender');

    answer = 'throw';
    r = await callAs(srv, 'GET', '/cli/whoami', { token: TOKEN });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'grant-unavailable');
  } finally {
    global.fetch = origFetch;
    broker._setGrantResolver(SERVICE_GRANT);
    srv.close();
  }
});

// ── audit outcomes (the SDK rewrites any outcome outside its set to `ok`) ────

const lastAudit = (sub) => auditLines().filter((l) => l.subcommand === sub).pop();

test('audit: a Jira 403 on a read is recorded as domain-error, not ok', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' });
  const restore = stubJira([], { status: 403 });
  const srv = await listen();
  try {
    const r = await call(srv, 'GET', '/cli/show?issue=KAN-6', { token: TOKEN });
    assert.equal(r.status, 403);
    assert.equal(lastAudit('show').outcome, 'domain-error');
  } finally { restore(); broker.scopeCredentials.delete('team-1'); srv.close(); }
});

test('audit: a transport failure on a write is recorded as unreachable', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'a@b.c', 'api-token': 'tok' });
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  const srv = await listen();
  try {
    const r = await call(srv, 'POST', '/cli/comment', { token: TOKEN, body: { issue: 'KAN-1', body: 'x' } });
    assert.ok(r.status >= 500, String(r.status));
    assert.equal(lastAudit('comment').outcome, 'unreachable');
  } finally { global.fetch = origFetch; broker.scopeCredentials.delete('team-1'); srv.close(); }
});

test('audit: a refused bare consume is recorded as usage-error', async () => {
  const srv = await listen();
  try {
    const r = await call(srv, 'GET', '/cli/inbox?consume=1', { token: TOKEN });
    assert.equal(r.status, 400);
    assert.equal(lastAudit('inbox').outcome, 'usage-error');
  } finally { srv.close(); }
});

test('audit: a wake the orchestrator answers with 500 is domain-error with the status in detail', async () => {
  const orch = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{}'); });
  });
  await new Promise((r) => orch.listen(0, '127.0.0.1', r));
  const prev = process.env.AEE_ORCHESTRATOR_URL;
  process.env.AEE_ORCHESTRATOR_URL = `http://127.0.0.1:${orch.address().port}`;
  try {
    await broker.deliver({ scopeId: 'team-1', kind: 'events', events: [{ id: 'KAN-6:1', event: 'status_changed', issueKey: 'KAN-6', toStatus: 'Done' }] });
    const line = lastAudit('wake');
    assert.equal(line.outcome, 'domain-error');
    assert.match(line.detail, /^http-500 /);
  } finally {
    if (prev === undefined) delete process.env.AEE_ORCHESTRATOR_URL; else process.env.AEE_ORCHESTRATOR_URL = prev;
    orch.close();
  }
});

// ── issue links (#2884) ─────────────────────────────────────────────────────

const LINK_TYPES_FIXTURE = [
  { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  { id: '10003', name: 'Relates', inward: 'relates to', outward: 'relates to' },
];

// A stub Jira for the link routes. `links` is each issue's raw `issuelinks`.
function stubLinkJira(seen, links) {
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    seen.push({ url: u, method, auth: opts && opts.headers && opts.headers.Authorization, body: opts && opts.body });
    const res = (status, body, headers = {}) => ({
      ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)),
      headers: { get: (h) => headers[h.toLowerCase()] || null },
    });
    if (/\/issueLinkType$/.test(u)) return res(200, { issueLinkTypes: LINK_TYPES_FIXTURE });
    if (/\/configuration$/.test(u)) return res(200, { issueLinkingEnabled: true });
    const m = /\/issue\/([^/?]+)\?fields=issuelinks$/.exec(u);
    if (m) return res(200, { key: m[1], fields: { issuelinks: links[m[1]] || [] } });
    if (/\/issueLink$/.test(u) && method === 'POST') return res(201, undefined, { location: 'https://acme.atlassian.net/rest/api/3/issueLink/555' });
    if (/\/issueLink\/\d+$/.test(u) && method === 'DELETE') return res(204);
    if (/\/issueLink\/42$/.test(u)) return res(200, { id: '42', type: LINK_TYPES_FIXTURE[0], inwardIssue: { key: 'KAN-3' }, outwardIssue: { key: 'KAN-4' } });
    return res(404, {});
  };
  return () => { global.fetch = origFetch; };
}

test('cli link / unlink / link-types: authorised write, audited, both ends stamped as own writes (#2884 AC2/AC3/AC6/AC9/AC11)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  broker._setGrantResolver(SERVICE_GRANT);
  broker.ownWritesStore.teardown('team-1');
  const seen = [];
  const restore = stubLinkJira(seen, { 'KAN-6': [{ id: '77', type: LINK_TYPES_FIXTURE[0], outwardIssue: { key: 'KAN-8' } }] });
  const srv = await listen();
  try {
    const types = await call(srv, 'GET', '/cli/link-types', { token: TOKEN });
    assert.equal(types.status, 200);
    assert.deepEqual(types.body.linkTypes, LINK_TYPES_FIXTURE);

    const linked = await call(srv, 'POST', '/cli/link', { token: TOKEN, body: { from: 'KAN-1', type: 'blocks', to: 'KAN-2' } });
    assert.equal(linked.status, 200);
    assert.deepEqual(linked.body, { created: true, id: '555', type: 'Blocks', statement: 'KAN-1 blocks KAN-2', issues: ['KAN-1', 'KAN-2'] });
    const fields = () => broker.ownWritesStore.snapshot('team-1').fields;
    assert.equal(fields()['KAN-1|link'].length, 1);
    assert.equal(fields()['KAN-2|link'].length, 1);

    // an idempotent re-link writes nothing to Jira and stamps nothing
    const again = await call(srv, 'POST', '/cli/link', { token: TOKEN, body: { from: 'KAN-6', type: 'Blocks', to: 'KAN-8' } });
    assert.deepEqual([again.status, again.body.created, again.body.id], [200, false, '77']);
    assert.equal(fields()['KAN-6|link'], undefined);

    const unlinked = await call(srv, 'POST', '/cli/unlink', { token: TOKEN, body: { id: '42' } });
    assert.equal(unlinked.status, 200);
    assert.deepEqual(unlinked.body, { removed: true, id: '42', type: 'Blocks', issues: ['KAN-3', 'KAN-4'] });
    assert.equal(fields()['KAN-3|link'].length, 1);
    assert.equal(fields()['KAN-4|link'].length, 1);

    // refusals before any Jira write: missing words, self-link, unknown type
    const writesBefore = seen.filter((s) => s.method !== 'GET').length;
    assert.equal((await call(srv, 'POST', '/cli/link', { token: TOKEN, body: { from: 'KAN-1', to: 'KAN-2' } })).status, 400);
    assert.equal((await call(srv, 'POST', '/cli/unlink', { token: TOKEN, body: {} })).status, 400);
    const self = await call(srv, 'POST', '/cli/link', { token: TOKEN, body: { from: 'KAN-1', type: 'blocks', to: 'KAN-1' } });
    assert.equal(self.status, 400);
    assert.match(self.body.error, /itself/);
    const unknown = await call(srv, 'POST', '/cli/link', { token: TOKEN, body: { from: 'KAN-1', type: 'causes', to: 'KAN-2' } });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /Available: Blocks \(blocks \/ is blocked by\), Relates/);
    assert.equal(seen.filter((s) => s.method !== 'GET').length, writesBefore);

    // every call is audited with the calling scope; link/unlink go through their own policy entries
    const lines = auditLines().filter((l) => l.scopeId === 'team-1' && ['link', 'unlink', 'link-types'].includes(l.subcommand));
    assert.ok(lines.some((l) => l.subcommand === 'link' && l.outcome === 'ok' && /KAN-1 blocks KAN-2 \(555\)/.test(l.detail) && l.identity === 'service-account'));
    assert.ok(lines.some((l) => l.subcommand === 'link' && l.outcome === 'ok' && /existing/.test(l.detail)));
    assert.ok(lines.some((l) => l.subcommand === 'unlink' && l.outcome === 'ok' && /\(42\)/.test(l.detail)));
    assert.ok(lines.some((l) => l.subcommand === 'link' && l.outcome === 'domain-error' && /itself/.test(l.detail)));
    assert.ok(lines.some((l) => l.subcommand === 'link-types' && l.outcome === 'ok'));
    assert.deepEqual(brokerPolicyOf('link'), { allow: true });
    assert.deepEqual(brokerPolicyOf('unlink'), { allow: true });

    // GET on a write path → 404
    assert.equal((await call(srv, 'GET', '/cli/link', { token: TOKEN })).status, 404);
    // no service account → refused before Jira
    const nocred = await call(srv, 'POST', '/cli/link', { token: OTHER, body: { from: 'X-1', type: 'blocks', to: 'X-2' } });
    assert.equal(nocred.body.code, 'no-service-account');
  } finally {
    restore();
    broker.ownWritesStore.teardown('team-1');
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

// #2898 — a stubbed Jira for `users`: /user/search, /user/assignable/search and
// the project / issue visibility lookups (KAN visible, OTHER outside scope).
const ANNA = { accountId: 'acc-anna', displayName: 'Anna Schmidt', emailAddress: 'anna@acme.com', active: true, accountType: 'atlassian' };
const ANNA_OLD = { accountId: 'acc-anna-old', displayName: 'Anna Old', active: false, accountType: 'atlassian' };
function stubUsersJira(seen) {
  const origFetch = global.fetch;
  const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    seen.push({ url: String(url), auth: opts && opts.headers && opts.headers.Authorization });
    const u = new URL(String(url));
    if (/\/project\/KAN$/.test(u.pathname)) return res(200, { key: 'KAN' });
    if (/\/project\/|\/issue\//.test(u.pathname)) return res(404, {});
    if (/\/user\/assignable\/search$/.test(u.pathname)) return res(200, [ANNA, ANNA_OLD]);
    if (/\/user\/search$/.test(u.pathname)) return res(200, u.searchParams.get('query') === 'nobody' ? [] : [ANNA, ANNA_OLD]);
    return res(404, {});
  };
  return () => { global.fetch = origFetch; };
}

test('cli users: name → accountId, assignable narrowing, out-of-scope refusal, audit without personal data (#2898)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  broker._setGrantResolver(SERVICE_GRANT);
  const seen = [];
  const restore = stubUsersJira(seen);
  const srv = await listen();
  try {
    const all = await call(srv, 'GET', '/cli/users?query=Anna', { token: TOKEN });
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.users, [
      { accountId: 'acc-anna', displayName: 'Anna Schmidt', email: 'anna@acme.com', active: true, accountType: 'atlassian' },
      { accountId: 'acc-anna-old', displayName: 'Anna Old', email: null, active: false, accountType: 'atlassian' },
    ]);
    assert.equal(all.body.assignableOnly, false);
    assert.equal(all.body.truncated, false);

    const inKan = await call(srv, 'GET', '/cli/users?query=Anna&project=KAN', { token: TOKEN });
    assert.equal(inKan.status, 200);
    assert.deepEqual(inKan.body.users.map((u) => u.accountId), ['acc-anna'], 'inactive accounts are left out when narrowing');
    assert.equal(inKan.body.project, 'KAN');
    assert.ok(seen.some((s) => /\/user\/assignable\/search\?.*project=KAN/.test(s.url)));

    const none = await call(srv, 'GET', '/cli/users?query=nobody', { token: TOKEN });
    assert.equal(none.status, 200);
    assert.deepEqual(none.body.users, []);
    assert.match(none.body.note, /No user found matching "nobody"/);

    const other = await call(srv, 'GET', '/cli/users?query=Anna&project=OTHER', { token: TOKEN });
    assert.equal(other.status, 404);
    assert.match(other.body.error, /Project OTHER was not found, or it is outside this team's Jira scope/);
    assert.ok(!seen.some((s) => /assignable\/search\?.*project=OTHER/.test(s.url)), 'no user search outside scope');

    assert.equal((await call(srv, 'GET', '/cli/users', { token: TOKEN })).status, 400);
    assert.equal((await call(srv, 'GET', '/cli/users?query=A&project=KAN&issue=KAN-1', { token: TOKEN })).status, 400);
    assert.equal((await call(srv, 'GET', '/cli/users?query=A&limit=0', { token: TOKEN })).status, 400);

    const lines = auditLines().filter((l) => l.scopeId === 'team-1' && l.subcommand === 'users');
    assert.ok(lines.some((l) => l.outcome === 'ok' && l.detail === 'site:2'));
    assert.ok(lines.some((l) => l.outcome === 'ok' && l.detail === 'KAN:1'));
    assert.ok(lines.every((l) => !/Anna|anna@|acc-anna/.test(JSON.stringify(l))), 'no query or person in the audit');

    // a read: POST is not a route; no service account → refused before Jira
    assert.equal((await call(srv, 'POST', '/cli/users', { token: TOKEN, body: {} })).status, 404);
    const nocred = await call(srv, 'GET', '/cli/users?query=Anna', { token: OTHER });
    assert.equal(nocred.body.code, 'no-service-account');
  } finally {
    restore();
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli users: a chat turn searches with the member\'s own Jira token (#2898)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  broker._setGrantResolver(async () => ({ ok: true, mode: 'personal', interactive: true, agentId: 'team-1-dev', userId: 'alice', values: { email: 'a@b.c', 'api-token': 'mine' } }));
  const seen = [];
  const restore = stubUsersJira(seen);
  const srv = await listen();
  try {
    const r = await callAs(srv, 'GET', '/cli/users?query=Anna', { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(seen[0].auth, `Basic ${Buffer.from('a@b.c:mine').toString('base64')}`);
  } finally {
    restore();
    broker._setGrantResolver(SERVICE_GRANT);
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

// #2899 — a stubbed Jira for `comments`: KAN-10 has two comments (one the team
// posted), KAN-11 none, anything else is invisible (outside the scope).
function stubCommentsJira(seen) {
  const origFetch = global.fetch;
  const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const doc = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return origFetch(url, opts);
    seen.push({ url: String(url), auth: opts && opts.headers && opts.headers.Authorization });
    const u = new URL(String(url));
    if (/\/issue\/KAN-10\/comment$/.test(u.pathname)) {
      return res(200, { startAt: 0, total: 2, comments: [
        { id: '202', created: '2026-10-02T10:00:00Z', updated: '2026-10-02T10:00:00Z', author: { displayName: 'Service Bot' }, body: doc('On it.') },
        { id: '201', created: '2026-10-01T10:00:00Z', updated: '2026-10-01T12:00:00Z', author: { displayName: 'Anna' }, body: doc('Please fix the login.') },
      ] });
    }
    if (/\/issue\/KAN-11\/comment$/.test(u.pathname)) return res(200, { startAt: 0, total: 0, comments: [] });
    if (/\/field$/.test(u.pathname)) return res(200, []);
    if (/\/issue\/KAN-10\/transitions$/.test(u.pathname)) return res(200, { transitions: [] });
    if (/\/issue\/KAN-10$/.test(u.pathname)) return res(200, { key: 'KAN-10', fields: { summary: 'Login', status: { name: 'To Do' } } });
    return res(404, {});
  };
  return () => { global.fetch = origFetch; };
}

test('cli comments: newest first with origin from the own-writes registry, empty list, out-of-scope refusal, audit without text (#2899)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  broker._setGrantResolver(SERVICE_GRANT);
  broker.ownWritesStore.recordComment('team-1', 'KAN-10', '202');
  const seen = [];
  const restore = stubCommentsJira(seen);
  const srv = await listen();
  try {
    const r = await call(srv, 'GET', '/cli/comments?issue=KAN-10', { token: TOKEN });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.comments, [
      { id: '202', author: 'Service Bot', created: '2026-10-02T10:00:00Z', updated: '2026-10-02T10:00:00Z', body: 'On it.', bodyTruncated: false, origin: 'agent' },
      { id: '201', author: 'Anna', created: '2026-10-01T10:00:00Z', updated: '2026-10-01T12:00:00Z', body: 'Please fix the login.', bodyTruncated: false, origin: 'human' },
    ]);
    assert.equal(r.body.hasMore, false);
    assert.match(seen[seen.length - 1].url, /\/issue\/KAN-10\/comment\?orderBy=-created&startAt=0&maxResults=20$/);

    const paged = await call(srv, 'GET', '/cli/comments?issue=KAN-10&limit=5&offset=20', { token: TOKEN });
    assert.equal(paged.status, 200);
    assert.match(seen[seen.length - 1].url, /startAt=20&maxResults=5$/);

    const none = await call(srv, 'GET', '/cli/comments?issue=KAN-11', { token: TOKEN });
    assert.equal(none.status, 200);
    assert.deepEqual(none.body.comments, []);

    const other = await call(srv, 'GET', '/cli/comments?issue=OTHER-1', { token: TOKEN });
    assert.equal(other.status, 404);
    assert.match(other.body.error, /Issue OTHER-1 was not found, or it is outside this team's Jira scope/);

    assert.equal((await call(srv, 'GET', '/cli/comments', { token: TOKEN })).status, 400);
    assert.equal((await call(srv, 'GET', '/cli/comments?issue=KAN-10&limit=0', { token: TOKEN })).status, 400);

    const lines = auditLines().filter((l) => l.scopeId === 'team-1' && l.subcommand === 'comments');
    assert.ok(lines.some((l) => l.outcome === 'ok' && l.detail === 'KAN-10:2@0'));
    assert.ok(lines.every((l) => !/On it|Please fix/.test(JSON.stringify(l))), 'no comment text in the audit');

    // a read: POST is not a route; no service account → refused before Jira
    assert.equal((await call(srv, 'POST', '/cli/comments', { token: TOKEN, body: {} })).status, 404);
    const nocred = await call(srv, 'GET', '/cli/comments?issue=KAN-10', { token: OTHER });
    assert.equal(nocred.body.code, 'no-service-account');
  } finally {
    restore();
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli show: a plain show still lists no comments and never reads the comment list (#2899 AC8)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  broker._setGrantResolver(SERVICE_GRANT);
  const seen = [];
  const restore = stubCommentsJira(seen);
  const srv = await listen();
  try {
    const r = await call(srv, 'GET', '/cli/show?issue=KAN-10', { token: TOKEN });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ['issue']);
    assert.ok(!('comments' in r.body.issue) && !('comment' in r.body.issue));
    assert.ok(!seen.some((s) => /\/comment/.test(s.url)), 'no comment read on a plain show');
  } finally {
    restore();
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli comments: a chat turn reads with the member\'s own Jira token (#2899)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  broker._setGrantResolver(async () => ({ ok: true, mode: 'personal', interactive: true, agentId: 'team-1-dev', userId: 'alice', values: { email: 'a@b.c', 'api-token': 'mine' } }));
  const seen = [];
  const restore = stubCommentsJira(seen);
  const srv = await listen();
  try {
    const r = await callAs(srv, 'GET', '/cli/comments?issue=KAN-10', { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(seen[0].auth, `Basic ${Buffer.from('a@b.c:mine').toString('base64')}`);
  } finally {
    restore();
    broker._setGrantResolver(SERVICE_GRANT);
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

function brokerPolicyOf(op) {
  return require('./broker-policy').authorizeWrite(op);
}

test('cli link: a policy denial refuses the write before Jira is touched (#2884 AC9)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  const policy = require('./broker-policy');
  const orig = policy.authorizeWrite;
  policy.authorizeWrite = (op) => (op === 'link' || op === 'unlink' ? { allow: false, code: 'scope-not-allowed', reason: 'not for you' } : orig(op));
  const seen = [];
  const restore = stubLinkJira(seen, {});
  const srv = await listen();
  try {
    for (const route of ['/cli/link', '/cli/unlink']) {
      const r = await call(srv, 'POST', route, { token: TOKEN, body: { from: 'KAN-1', type: 'blocks', to: 'KAN-2' } });
      assert.equal(r.status, 403, route);
      assert.equal(r.body.code, 'scope-not-allowed');
    }
    assert.equal(seen.length, 0);
    assert.ok(auditLines().some((l) => l.subcommand === 'unlink' && l.outcome === 'denied' && l.detail === 'scope-not-allowed'));
  } finally {
    policy.authorizeWrite = orig;
    restore();
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});

test('cli link in a chat turn uses the sender\'s own Jira token; an automated run the service account (#2884 AC10)', async () => {
  broker.scopeCredentials.set('team-1', { 'site-url': 'acme', email: 'svc@b.c', 'api-token': 'svc-tok' });
  const seen = [];
  const restore = stubLinkJira(seen, {});
  const srv = await listen();
  try {
    broker._setGrantResolver(async () => ({ ok: true, mode: 'personal', interactive: true, agentId: 'team-1-dev', userId: 'alice', values: { email: 'alice@b.c', 'api-token': 'alice-tok' } }));
    const chat = await callAs(srv, 'POST', '/cli/link', { token: TOKEN, caller: 'aeecall1.x.y', body: { from: 'KAN-1', type: 'blocks', to: 'KAN-2' } });
    assert.equal(chat.status, 200);
    assert.ok(seen.length > 0 && seen.every((c) => c.auth === basic('alice@b.c', 'alice-tok')), 'every Jira call as alice');
    assert.ok(auditLines().some((l) => l.subcommand === 'link' && l.identity === 'alice' && l.interactive === true));

    seen.length = 0;
    broker._setGrantResolver(SERVICE_GRANT);
    const auto = await call(srv, 'POST', '/cli/link', { token: TOKEN, body: { from: 'KAN-1', type: 'blocks', to: 'KAN-2' } });
    assert.equal(auto.status, 200);
    assert.ok(seen.length > 0 && seen.every((c) => c.auth === basic('svc@b.c', 'svc-tok')), 'every Jira call as the service account');
  } finally {
    restore();
    broker._setGrantResolver(SERVICE_GRANT);
    broker.ownWritesStore.teardown('team-1');
    broker.scopeCredentials.delete('team-1');
    srv.close();
  }
});
