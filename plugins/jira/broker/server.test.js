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

test('teardown-scope reaps one scope\'s watch + inbox, bearer-authed', async () => {
  broker.watchStore.setConfig('team-2', { watches: [{ projectKey: 'X' }] });
  broker.inboxStore.append('team-2', { id: 'X-1:1', issueKey: 'X-1' });
  const srv = await listen();
  try {
    assert.equal((await call(srv, 'POST', '/internal/teardown-scope')).status, 401);
    const r = await call(srv, 'POST', '/internal/teardown-scope', { token: OTHER });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(broker.watchStore.loadConfig('team-2').watches, []);
    assert.equal(broker.inboxStore.count('team-2'), 0);
  } finally { srv.close(); }
});
