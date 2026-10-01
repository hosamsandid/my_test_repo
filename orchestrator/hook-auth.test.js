'use strict';

// #2680 — the webhook server accepts GitHub's X-Hub-Signature-256 as well as
// the plain X-Hook-Secret header. Unit tests for the pure check, plus the real
// hook-server handler sliced out of orchestrator.js and driven over HTTP.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');

const { verifyHookRequest, githubSignature, isGithubPing } = require('./hook-auth');

const SECRET = 's3cret-value';
const BODY = Buffer.from('{"action":"opened","zen":"Keep it logically awesome."}');
const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

test('plain X-Hook-Secret: match passes, mismatch fails', () => {
  assert.deepEqual(verifyHookRequest({ headers: { 'x-hook-secret': SECRET }, rawBody: BODY, secret: SECRET }),
    { ok: true, method: 'secret' });
  assert.equal(verifyHookRequest({ headers: { 'x-hook-secret': 'nope' }, rawBody: BODY, secret: SECRET }).ok, false);
});

test('GitHub X-Hub-Signature-256 over the raw body passes', () => {
  const headers = { 'x-hub-signature-256': sign(SECRET, BODY) };
  assert.deepEqual(verifyHookRequest({ headers, rawBody: BODY, secret: SECRET }), { ok: true, method: 'github-signature' });
  assert.equal(githubSignature(SECRET, BODY), sign(SECRET, BODY));
});

test('GitHub signature: wrong secret, tampered body, or bare hex fails', () => {
  assert.equal(verifyHookRequest({ headers: { 'x-hub-signature-256': sign('other', BODY) }, rawBody: BODY, secret: SECRET }).ok, false);
  const tampered = Buffer.from(BODY.toString().replace('opened', 'closed'));
  assert.equal(verifyHookRequest({ headers: { 'x-hub-signature-256': sign(SECRET, BODY) }, rawBody: tampered, secret: SECRET }).ok, false);
  const bareHex = sign(SECRET, BODY).slice('sha256='.length);
  assert.equal(verifyHookRequest({ headers: { 'x-hub-signature-256': bareHex }, rawBody: BODY, secret: SECRET }).ok, false);
});

test('a wrong X-Hook-Secret is not rescued by a valid signature', () => {
  const headers = { 'x-hook-secret': 'wrong', 'x-hub-signature-256': sign(SECRET, BODY) };
  assert.equal(verifyHookRequest({ headers, rawBody: BODY, secret: SECRET }).ok, false);
});

test('no credentials or no trigger secret is rejected', () => {
  assert.deepEqual(verifyHookRequest({ headers: {}, rawBody: BODY, secret: SECRET }), { ok: false, reason: 'missing' });
  assert.equal(verifyHookRequest({ headers: { 'x-hook-secret': '' }, rawBody: BODY, secret: '' }).ok, false);
  // An empty-body signature keyed with an empty secret must not authenticate.
  assert.equal(verifyHookRequest({ headers: { 'x-hub-signature-256': sign('', Buffer.alloc(0)) }, rawBody: Buffer.alloc(0), secret: '' }).ok, false);
});

test('isGithubPing reads X-GitHub-Event', () => {
  assert.equal(isGithubPing({ 'x-github-event': 'ping' }), true);
  assert.equal(isGithubPing({ 'x-github-event': 'push' }), false);
  assert.equal(isGithubPing({}), false);
});

// ── The real handler from orchestrator.js, over HTTP ───────────────────────

function sliceHookHandler() {
  const src = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');
  const start = src.indexOf('const hookServer = http.createServer(');
  const end = src.indexOf('\n  hookServer.listen(', start);
  assert.ok(start > 0 && end > start, 'hook server block not found in orchestrator.js');
  return src.slice(start, end) + '\nhookServer;';
}

function startHookServer({ triggers, maxBody = 1024 * 1024 }) {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-auth-'));
  fs.mkdirSync(path.join(agentsDir, 'agent-a'));
  const queued = [];
  const ctx = vm.createContext({
    http, fs, path, JSON, Buffer, console: { log() {}, error() {} },
    AGENTS_DIR: agentsDir,
    HOOK_MAX_BODY_BYTES: maxBody,
    verifyHookRequest, isGithubPing,
    loadTriggers: () => triggers,
    enqueuePending: (agentId, entry) => queued.push({ agentId, ...entry }),
  });
  const server = vm.runInContext(sliceHookHandler(), ctx);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, queued, port: server.address().port })));
}

function post(port, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('no response from hook server')));
    req.end(body);
  });
}

const TRIGGERS = [{ id: 'gh', type: 'http', secret: SECRET, prompt: 'go' }];

test('handler: GitHub-signed delivery is queued (202)', async () => {
  const { server, queued, port } = await startHookServer({ triggers: TRIGGERS });
  try {
    const r = await post(port, '/hooks/agent-a/gh', {
      'Content-Type': 'application/json', 'X-GitHub-Event': 'issues', 'X-Hub-Signature-256': sign(SECRET, BODY),
    }, BODY);
    assert.equal(r.status, 202);
    assert.deepEqual(queued, [{ agentId: 'agent-a', triggerId: 'gh' }]);
  } finally { server.close(); }
});

test('handler: plain X-Hook-Secret still works (202)', async () => {
  const { server, queued, port } = await startHookServer({ triggers: TRIGGERS });
  try {
    const r = await post(port, '/hooks/agent-a/gh', { 'X-Hook-Secret': SECRET }, '');
    assert.equal(r.status, 202);
    assert.equal(queued.length, 1);
  } finally { server.close(); }
});

test('handler: bad signature or no credentials is 401 and nothing is queued', async () => {
  const { server, queued, port } = await startHookServer({ triggers: TRIGGERS });
  try {
    const bad = await post(port, '/hooks/agent-a/gh', { 'X-Hub-Signature-256': sign('wrong', BODY) }, BODY);
    assert.equal(bad.status, 401);
    const none = await post(port, '/hooks/agent-a/gh', {}, BODY);
    assert.equal(none.status, 401);
    assert.equal(queued.length, 0);
  } finally { server.close(); }
});

test('handler: signed GitHub ping is acknowledged (200) without firing', async () => {
  const { server, queued, port } = await startHookServer({ triggers: TRIGGERS });
  try {
    const ping = Buffer.from('{"zen":"Design for failure.","hook_id":1}');
    const r = await post(port, '/hooks/agent-a/gh', { 'X-GitHub-Event': 'ping', 'X-Hub-Signature-256': sign(SECRET, ping) }, ping);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).pong, true);
    assert.equal(queued.length, 0);
  } finally { server.close(); }
});

test('handler: oversized body is 413 and nothing is queued', async () => {
  const { server, queued, port } = await startHookServer({ triggers: TRIGGERS, maxBody: 16 });
  try {
    const r = await post(port, '/hooks/agent-a/gh', { 'X-Hub-Signature-256': sign(SECRET, BODY) }, BODY);
    assert.equal(r.status, 413);
    assert.equal(queued.length, 0);
  } finally { server.close(); }
});

test('handler: trigger without a secret is still rejected (401)', async () => {
  const { server, queued, port } = await startHookServer({ triggers: [{ id: 'gh', type: 'http', prompt: 'go' }] });
  try {
    const r = await post(port, '/hooks/agent-a/gh', { 'X-Hub-Signature-256': sign('', BODY) }, BODY);
    assert.equal(r.status, 401);
    assert.equal(queued.length, 0);
  } finally { server.close(); }
});
