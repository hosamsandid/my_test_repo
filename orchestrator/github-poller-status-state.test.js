'use strict';

// #2537: `_pollRepo` persists the per-repo facts the repository status view
// shows — last error (status + GitHub's message), when the failure streak
// started, last successful poll, last event received, and the token/env the
// repo is polled with — and a successful poll returns the row to healthy.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { GitHubPoller } = require('./github-poller');

let reply = { status: 401, body: { message: 'Bad credentials' } };
let server;

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(reply.status, { 'Content-Type': 'application/json', ...(reply.headers || {}) });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.GITHUB_API_BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  delete process.env.GITHUB_API_BASE;
  server.close();
});

function makePoller(t) {
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (String(p).endsWith('/_tokens/tok-a')) return 'ghp_fake\n';
    return realRead.call(fs, p, ...rest);
  });
  const poller = new GitHubPoller({ listEnvironmentIds: () => [] });
  poller.state = {};
  poller._saveState = () => {};
  return poller;
}

test('a failed poll records the error; recovery clears the streak but keeps history', async (t) => {
  const poller = makePoller(t);
  const entry = { tokenId: 'tok-a', envId: 'env-a', subscribers: [] };

  reply = { status: 401, body: { message: 'Bad credentials' } };
  await poller._pollRepo('acme/widgets', entry);
  let st = poller.state['acme/widgets'];
  assert.equal(st.consecutiveFailures, 1);
  assert.deepEqual(st.lastError, { status: 401, message: 'Bad credentials', rateLimited: false });
  assert.ok(st.lastErrorAt);
  assert.equal(st.failingSince, st.lastErrorAt);
  assert.equal(st.tokenId, 'tok-a');
  assert.equal(st.tokenEnvId, 'env-a');

  // A second failure keeps the streak's start.
  const since = st.failingSince;
  st.skipUntil = new Date(Date.now() - 1000).toISOString();
  reply = { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } };
  await poller._pollRepo('acme/widgets', entry);
  st = poller.state['acme/widgets'];
  assert.equal(st.consecutiveFailures, 2);
  assert.equal(st.failingSince, since);
  assert.equal(st.lastError.rateLimited, true);

  // Recovery.
  st.skipUntil = new Date(Date.now() - 1000).toISOString();
  reply = { status: 200, body: [] };
  await poller._pollRepo('acme/widgets', entry);
  st = poller.state['acme/widgets'];
  assert.equal(st.consecutiveFailures, undefined);
  assert.equal(st.failingSince, undefined);
  assert.ok(st.lastPolledAt);
  assert.equal(st.lastError.status, 403, 'the last error stays on file as history');
});

test('a fresh event stamps lastEventAt', async (t) => {
  const poller = makePoller(t);
  poller.state = { 'acme/widgets': { seen: [] } };
  poller._fanOutBatch = async () => {};
  reply = { status: 200, body: [{ id: '1', type: 'WatchEvent', created_at: new Date().toISOString(), payload: {} }] };
  await poller._pollRepo('acme/widgets', { tokenId: 'tok-a', envId: 'env-a', subscribers: [] });
  assert.ok(poller.state['acme/widgets'].lastEventAt);
});

test('lastTickAt is null until the first tick finishes', async () => {
  const poller = new GitHubPoller({ listEnvironmentIds: () => [] });
  poller._buildPollPlan = () => new Map();
  assert.equal(poller.lastTickAt, null);
  await poller._tick();
  assert.ok(poller.lastTickAt);
});
