'use strict';

// Unit tests for the global-provider publish gate (#2136).
// Run: node --test admin-console/api/llm-endpoint-global.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGlobalFlag } = require('./llm-endpoint-global');

test('body without a global field keeps the current value', () => {
  assert.deepEqual(resolveGlobalFlag({ currentGlobal: false, scopeAll: false }), { global: false });
  assert.deepEqual(resolveGlobalFlag({ currentGlobal: true, scopeAll: false }), { global: true });
  assert.deepEqual(resolveGlobalFlag({ wantGlobal: null, currentGlobal: true, scopeAll: false }), { global: true });
});

test('a System Admin may publish a (non-oauth) provider globally (AC1)', () => {
  assert.deepEqual(
    resolveGlobalFlag({ wantGlobal: true, currentGlobal: false, scopeAll: true, isOauth: false }),
    { global: true },
  );
});

test('a System Admin may retract a global provider', () => {
  assert.deepEqual(
    resolveGlobalFlag({ wantGlobal: false, currentGlobal: true, scopeAll: true }),
    { global: false },
  );
});

test('a non-System-Admin is refused publishing OR retracting (AC5, fail closed 403)', () => {
  const pub = resolveGlobalFlag({ wantGlobal: true, currentGlobal: false, scopeAll: false, isOauth: false });
  assert.equal(pub.status, 403);
  assert.equal(pub.code, 'global-system-admin-only');
  const ret = resolveGlobalFlag({ wantGlobal: false, currentGlobal: true, scopeAll: false });
  assert.equal(ret.status, 403);
});

test('a subscription (oauth-token) provider can never be made global (edge case, 400)', () => {
  const r = resolveGlobalFlag({ wantGlobal: true, currentGlobal: false, scopeAll: true, isOauth: true });
  assert.equal(r.status, 400);
  assert.equal(r.code, 'global-oauth-unsupported');
});

test('no transition → no gate: a non-admin re-saving an already-global provider is not refused', () => {
  // e.g. a Team Admin editing the model list of a provider that is already global
  // (they can see it) — global is unchanged, so it must not be blocked here.
  assert.deepEqual(resolveGlobalFlag({ wantGlobal: true, currentGlobal: true, scopeAll: false, isOauth: false }), { global: true });
  assert.deepEqual(resolveGlobalFlag({ wantGlobal: false, currentGlobal: false, scopeAll: false }), { global: false });
});

test('only a literal boolean true publishes; a stray value never opens a provider', () => {
  assert.deepEqual(resolveGlobalFlag({ wantGlobal: 'true', currentGlobal: false, scopeAll: false }), { global: false });
  assert.deepEqual(resolveGlobalFlag({ wantGlobal: 1, currentGlobal: false, scopeAll: false }), { global: false });
});
