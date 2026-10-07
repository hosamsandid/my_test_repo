'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkScopeCredential } = require('./credential-check');

const SITE = { siteUrl: 'acme', readableCustomFields: [], writableCustomFields: [] };
const CRED = { ...SITE, email: 'bot@acme.com', apiToken: 'supersecrettoken' };

function httpError(status) { const e = new Error(`HTTP ${status}`); e.status = status; return e; }
function transportError() { const e = new Error('fetch failed (ENOTFOUND)'); e.transport = true; return e; }

// A fake jira-client that records which call was made and with what.
function client({ whoAmI, serverInfo } = {}) {
  const calls = [];
  return {
    calls,
    whoAmI: async (cred) => { calls.push(['whoAmI', cred]); if (whoAmI instanceof Error) throw whoAmI; return whoAmI; },
    serverInfo: async (site) => { calls.push(['serverInfo', site]); if (serverInfo instanceof Error) throw serverInfo; return serverInfo; },
  };
}

test('no site → not-configured, no Jira call', async () => {
  const c = client();
  const r = await checkScopeCredential({ site: null, cred: null }, { client: c });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'not-configured');
  assert.equal(c.calls.length, 0);
});

test('site + service account → GET /myself as the service account; "Connected as …"', async () => {
  const c = client({ whoAmI: { accountId: 'a1', displayName: 'Jira Bot', active: true } });
  const r = await checkScopeCredential({ site: SITE, cred: CRED }, { client: c });
  assert.deepEqual(c.calls, [['whoAmI', CRED]]);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'connected');
  assert.equal(r.account, 'Jira Bot');
  assert.equal(r.message, 'Connected as Jira Bot.');
  assert.ok(r.checkedAt);
});

test('connected account falls back to e-mail, then account id', async () => {
  let r = await checkScopeCredential({ site: SITE, cred: CRED }, { client: client({ whoAmI: { accountId: 'a1', emailAddress: 'bot@acme.com' } }) });
  assert.equal(r.account, 'bot@acme.com');
  r = await checkScopeCredential({ site: SITE, cred: CRED }, { client: client({ whoAmI: { accountId: 'a1' } }) });
  assert.equal(r.account, 'a1');
});

test('a deactivated account is not ok', async () => {
  const r = await checkScopeCredential({ site: SITE, cred: CRED }, { client: client({ whoAmI: { displayName: 'Old Bot', active: false } }) });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'inactive');
  assert.match(r.message, /deactivated/);
});

test('401 / 403 / 404 / other / transport map to a readable status', async () => {
  const cases = [
    [httpError(401), 'rejected', 401, /Token rejected \(401\)/],
    [httpError(403), 'forbidden', 403, /\(403\)/],
    [httpError(404), 'not-found', 404, /site not found \(404\)/],
    [httpError(500), 'error', 500, /HTTP 500/],
    [transportError(), 'unreachable', null, /Could not reach the Jira site/],
  ];
  for (const [err, state, httpStatus, re] of cases) {
    const r = await checkScopeCredential({ site: SITE, cred: CRED }, { client: client({ whoAmI: err }) });
    assert.equal(r.ok, false, state);
    assert.equal(r.state, state);
    assert.equal(r.httpStatus, httpStatus);
    assert.match(r.message, re);
  }
});

test('site only (no service account) → anonymous serverInfo; never calls /myself', async () => {
  const c = client({ serverInfo: { baseUrl: 'https://acme.atlassian.net' } });
  const r = await checkScopeCredential({ site: SITE, cred: null }, { client: c });
  assert.deepEqual(c.calls, [['serverInfo', 'acme']]);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'site-reachable');
  assert.match(r.message, /No service account set/);
});

test('site only, wrong site → not-found / unreachable', async () => {
  let r = await checkScopeCredential({ site: SITE, cred: null }, { client: client({ serverInfo: httpError(404) }) });
  assert.equal(r.state, 'not-found');
  r = await checkScopeCredential({ site: SITE, cred: null }, { client: client({ serverInfo: transportError() }) });
  assert.equal(r.state, 'unreachable');
});

test('the result never carries the token, whatever Jira answers', async () => {
  for (const whoAmI of [{ displayName: 'Bot' }, httpError(401), transportError()]) {
    const r = await checkScopeCredential({ site: SITE, cred: CRED }, { client: client({ whoAmI }) });
    assert.equal(JSON.stringify(r).includes('supersecrettoken'), false);
  }
});
