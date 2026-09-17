'use strict';

// Unit tests for the global-provider publish gate (#2136).
// Run: node --test admin-console/api/llm-endpoint-global.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGlobalFlag, isGlobalProvider } = require('./llm-endpoint-global');

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

test('a subscription provider is refused global WITHOUT the single-user ack (400)', () => {
  const r = resolveGlobalFlag({ wantGlobal: true, currentGlobal: false, scopeAll: true, isOauth: true });
  assert.equal(r.status, 400);
  assert.equal(r.code, 'global-oauth-unsupported');
  // hasSingleUserAck: false is the same refusal, made explicit.
  const r2 = resolveGlobalFlag({ wantGlobal: true, currentGlobal: false, scopeAll: true, isOauth: true, hasSingleUserAck: false });
  assert.equal(r2.status, 400);
});

test('the single-user escape hatch: a confirmed subscription MAY be published global', () => {
  assert.deepEqual(
    resolveGlobalFlag({ wantGlobal: true, currentGlobal: false, scopeAll: true, isOauth: true, hasSingleUserAck: true }),
    { global: true },
  );
  // Still System-Admin-only — the single-user ack does not grant a non-admin the
  // publish right, it only lifts the oauth-specific refusal for an admin.
  const nonAdmin = resolveGlobalFlag({ wantGlobal: true, currentGlobal: false, scopeAll: false, isOauth: true, hasSingleUserAck: true });
  assert.equal(nonAdmin.status, 403);
  assert.equal(nonAdmin.code, 'global-system-admin-only');
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

// ── #2136 finding 1 — the mutable-precondition bypass ────────────────────────

test('switching an already-global provider to oauth (without mentioning global) CLEARS the flag (finding 1)', () => {
  // The exact repro: publish api-key global, then PUT { authType: 'oauth-token' }
  // with no `global` in the body. `wantGlobal` is undefined, but the record is now
  // a subscription seat, so the kept flag is unholdable and must be dropped —
  // otherwise the stored record disagrees with isGlobalProvider().
  assert.deepEqual(
    resolveGlobalFlag({ wantGlobal: undefined, currentGlobal: true, scopeAll: false, isOauth: true }),
    { global: false },
  );
  // A non-oauth no-op still keeps the flag (ordinary re-save of a global provider).
  assert.deepEqual(
    resolveGlobalFlag({ wantGlobal: undefined, currentGlobal: true, scopeAll: false, isOauth: false }),
    { global: true },
  );
  // A record that was never global is unaffected by an oauth switch.
  assert.deepEqual(
    resolveGlobalFlag({ wantGlobal: undefined, currentGlobal: false, scopeAll: false, isOauth: true }),
    { global: false },
  );
  // But WITH the single-user ack, an oauth-global record KEEPS the flag on a
  // no-op save — the escape hatch record stays honest, not auto-dropped.
  assert.deepEqual(
    resolveGlobalFlag({ wantGlobal: undefined, currentGlobal: true, scopeAll: false, isOauth: true, hasSingleUserAck: true }),
    { global: true },
  );
});

test('isGlobalProvider requires global === true AND scope === system AND non-oauth (finding 1 — reads the record, not a route invariant)', () => {
  // The healthy case: a published api-key system provider is global.
  assert.equal(isGlobalProvider({ global: true, scope: 'system', authType: 'api-key' }), true);
  assert.equal(isGlobalProvider({ global: true, scope: 'system' }), true, 'a missing authType is api-key, still global');

  // Finding 1: a subscription seat carrying a stale global flag (reached by the
  // mutable auth-type transition) is NOT global — re-read on every call, so the
  // predicate fails closed even if the stored flag was never cleared.
  assert.equal(isGlobalProvider({ global: true, scope: 'system', authType: 'oauth-token' }), false);

  // The single-user escape hatch: a subscription seat WITH the single-user ack IS
  // global (runtime-only — assist excludes oauth upstream, not here)...
  assert.equal(isGlobalProvider({ global: true, scope: 'system', authType: 'oauth-token', complianceAck: { singleUser: true } }), true);
  // ...but a present-yet-not-single-user ack does not qualify.
  assert.equal(isGlobalProvider({ global: true, scope: 'system', authType: 'oauth-token', complianceAck: {} }), false);
  assert.equal(isGlobalProvider({ global: true, scope: 'system', authType: 'oauth-token', complianceAck: { singleUser: false } }), false);

  // Finding 1 (related): a { scope: 'team', global: true } record is NOT global —
  // the answer depends on the record, never on the route invariant that publishing
  // forces scope: 'system'.
  assert.equal(isGlobalProvider({ global: true, scope: 'team', teamId: 't1' }), false);
  assert.equal(isGlobalProvider({ global: true, scope: 'personal', userId: 'u1' }), false);

  // No flag / falsy flag → never global (the flag is inert when absent, AC6).
  assert.equal(isGlobalProvider({ scope: 'system', authType: 'api-key' }), false);
  assert.equal(isGlobalProvider({ global: false, scope: 'system' }), false);
  assert.equal(isGlobalProvider(null), false);
  assert.equal(isGlobalProvider(undefined), false);

  // Finding 2, the property that matters most: a NON-provider credential shape
  // (an SSH key / GitHub token has no baseUrl/authType and is never system-tiered
  // as a provider) carrying a hand-edited global flag is not global unless it is
  // exactly a system-scoped non-oauth record — and even then this predicate is
  // never REACHED for SSH keys/GitHub tokens, because it is applied only at the
  // model-provider call sites. This asserts the predicate itself stays narrow.
  assert.equal(isGlobalProvider({ global: true, scope: 'team' }), false);
});
