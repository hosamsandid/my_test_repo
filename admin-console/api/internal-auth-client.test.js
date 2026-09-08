'use strict';

// Tests for the console's control-plane credential wrapper (#1456).
//
// The one that matters most is the LEAK test: this process also talks to GitHub,
// Matrix and LLM providers, and the whole justification for wrapping a global is
// that the scoping predicate is provable. If it is not, wrapping the global is
// strictly worse than editing 126 call sites.

const test = require('node:test');
const assert = require('node:assert/strict');

const client = require('./internal-auth-client');
const orchestratorAuth = require('../../orchestrator/internal-auth');

const ORIGIN = 'http://orchestrator:4002';

// ── The scoping predicate ───────────────────────────────────────────────────

test('an orchestrator /internal/ URL is in scope', () => {
  for (const url of [
    'http://orchestrator:4002/internal/agents',
    'http://orchestrator:4002/internal/agents/a/status',
    'http://orchestrator:4002/internal/admin/users/verify',
    'http://orchestrator:4002/internal/agents/a/usage/summary?days=7',
  ]) {
    assert.equal(client.shouldAttachInternalToken(url, ORIGIN), true, url);
  }
});

test('THE LEAK TEST — no other host ever sees the control-plane token', () => {
  for (const url of [
    'https://api.github.com/repos/o/r/issues',
    'https://api.anthropic.com/v1/messages',
    'http://conduwuit:6167/_matrix/client/v3/login',
    'http://aee-plugin-netzplan:8080/internal/scope-credentials', // a BROKER's own /internal/
    'http://localhost:4000/api/agents',
    'http://orchestrator:4003/hooks/a/b',                          // the webhook server
    'https://orchestrator:4002/internal/agents',                   // scheme differs
    'http://orchestrator.evil.com:4002/internal/agents',           // host differs
  ]) {
    assert.equal(client.shouldAttachInternalToken(url, ORIGIN), false, url);
  }
});

test('a non-/internal path on the orchestrator is out of scope', () => {
  assert.equal(client.shouldAttachInternalToken('http://orchestrator:4002/health', ORIGIN), false);
  // …including one that merely starts with the letters.
  assert.equal(client.shouldAttachInternalToken('http://orchestrator:4002/internalish', ORIGIN), false);
});

test('a malformed or relative URL is out of scope rather than a throw', () => {
  for (const url of ['/internal/agents', 'not a url', '', null, undefined]) {
    assert.equal(client.shouldAttachInternalToken(url, ORIGIN), false, String(url));
  }
});

test('with no resolvable origin nothing is ever in scope', () => {
  assert.equal(client.shouldAttachInternalToken('http://orchestrator:4002/internal/x', null), false);
  assert.equal(client.orchestratorOrigin({ ORCHESTRATOR_URL: 'not-a-url' }), null);
  assert.equal(client.orchestratorOrigin({}), ORIGIN, 'the compose default');
});

// ── Header merging ──────────────────────────────────────────────────────────

test('the header is added without disturbing the caller init', () => {
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
  const out = client.withInternalAuthHeader(init, 'tok');
  assert.equal(out.method, 'POST');
  assert.equal(out.body, '{}');
  assert.equal(out.headers.get('content-type'), 'application/json');
  assert.equal(out.headers.get('authorization'), 'Bearer tok');
  // The caller's object is reused across sites in api.js, so it must be intact.
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
});

test('a caller-set Authorization is never overridden', () => {
  const out = client.withInternalAuthHeader({ headers: { Authorization: 'Bearer mine' } }, 'tok');
  assert.equal(out.headers.get('authorization'), 'Bearer mine');
});

test('an absent init is fine', () => {
  const out = client.withInternalAuthHeader(undefined, 'tok');
  assert.equal(out.headers.get('authorization'), 'Bearer tok');
});

// ── Installation ────────────────────────────────────────────────────────────

function fakeTarget() {
  const calls = [];
  const target = {
    fetch(input, init) {
      calls.push({ input, init });
      return Promise.resolve({ ok: true });
    },
  };
  return { target, calls };
}

test('installing is inert without a token — the pre-adoption stack is untouched', () => {
  const { target } = fakeTarget();
  const before = target.fetch;
  const r = client.installInternalAuthFetch({ env: {}, target });
  assert.equal(r.installed, false);
  assert.equal(target.fetch, before, 'the global must not be replaced');
});

test('installing is idempotent', () => {
  const { target } = fakeTarget();
  const env = { INTERNAL_API_TOKEN: 'tok' };
  assert.equal(client.installInternalAuthFetch({ env, target }).installed, true);
  const wrapped = target.fetch;
  assert.equal(client.installInternalAuthFetch({ env, target }).installed, false);
  assert.equal(target.fetch, wrapped, 'no double-wrapping');
});

test('the installed wrapper attaches on orchestrator calls and only those', async () => {
  const { target, calls } = fakeTarget();
  client.installInternalAuthFetch({ env: { INTERNAL_API_TOKEN: 'tok' }, target });

  await target.fetch('http://orchestrator:4002/internal/agents');
  await target.fetch('https://api.github.com/x', { headers: { 'Content-Type': 'application/json' } });

  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer tok');
  // The GitHub call must be passed through byte-identically — same init object,
  // no Headers coercion, no added key.
  assert.deepEqual(calls[1].init, { headers: { 'Content-Type': 'application/json' } });
});

test('a URL object is handled like a string', async () => {
  const { target, calls } = fakeTarget();
  client.installInternalAuthFetch({ env: { INTERNAL_API_TOKEN: 'tok' }, target });
  await target.fetch(new URL('http://orchestrator:4002/internal/maintenance-mode'));
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer tok');
});

test('ORCHESTRATOR_URL is honoured, so a relocated orchestrator still gets the token', async () => {
  const { target, calls } = fakeTarget();
  client.installInternalAuthFetch({
    env: { INTERNAL_API_TOKEN: 'tok', ORCHESTRATOR_URL: 'http://orch.internal:9999' },
    target,
  });
  await target.fetch('http://orch.internal:9999/internal/agents');
  await target.fetch('http://orchestrator:4002/internal/agents'); // the OLD default
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer tok');
  assert.equal(calls[1].init, undefined, 'a host that is not the configured one gets nothing');
});

// ── Two-sided guard against the orchestrator ────────────────────────────────

test('the token the console sends is the one the orchestrator accepts', () => {
  // Not a restatement: this drives BOTH sides. If either the header name, the
  // `Bearer ` prefix or the comparison changes on one side alone, this fails.
  const env = { INTERNAL_API_TOKEN: 'shared-secret' };
  const init = client.withInternalAuthHeader({}, env.INTERNAL_API_TOKEN);
  const headers = Object.fromEntries(init.headers.entries());
  const config = orchestratorAuth.resolveInternalAuthConfig(env);
  const decision = orchestratorAuth.decideInternalAuth({
    method: 'GET', url: '/internal/agents/processes', headers, config,
  });
  assert.equal(decision.callerKind, 'console-proxy');
  assert.equal(decision.allowed, true);
});

test('the agent-secret derivation matches the orchestrator byte for byte', () => {
  // The two copies exist because the admin-console image copies only `api/*.js`
  // and cannot require the orchestrator package at runtime. Driving both here is
  // what keeps them from drifting — a salt or KDF change on one side fails.
  const token = 'shared-secret';
  assert.equal(
    client.deriveAgentTokenSecret(token),
    orchestratorAuth.resolveInternalAuthConfig({ INTERNAL_API_TOKEN: token }).agentTokenSecret,
  );
  assert.equal(client.deriveAgentTokenSecret(''), '');
});
