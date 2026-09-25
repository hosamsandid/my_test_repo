'use strict';

// Unit tests for the global working-environment / MCP-server publish gate
// (#2158). Mirrors llm-endpoint-global.test.js (#2136), minus the
// oauth-specific cases — neither resource kind has an auth-type axis.
// Run: node --test admin-console/api/global-resource.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGlobalFlag, isGlobalEnvironment, isGlobalCredential } = require('./global-resource');

test('body without a global field keeps the current value', () => {
  assert.deepEqual(resolveGlobalFlag({ currentGlobal: false, scopeAll: false }), { global: false });
  assert.deepEqual(resolveGlobalFlag({ currentGlobal: true, scopeAll: false }), { global: true });
  assert.deepEqual(resolveGlobalFlag({ wantGlobal: null, currentGlobal: true, scopeAll: false }), { global: true });
});

test('a System Admin may publish a record globally (AC1/AC3)', () => {
  assert.deepEqual(
    resolveGlobalFlag({ wantGlobal: true, currentGlobal: false, scopeAll: true }),
    { global: true },
  );
});

test('a System Admin may retract a global record', () => {
  assert.deepEqual(
    resolveGlobalFlag({ wantGlobal: false, currentGlobal: true, scopeAll: true }),
    { global: false },
  );
});

test('a non-System-Admin is refused publishing OR retracting (AC3, fail closed 403)', () => {
  const pub = resolveGlobalFlag({ wantGlobal: true, currentGlobal: false, scopeAll: false });
  assert.equal(pub.status, 403);
  assert.equal(pub.code, 'global-system-admin-only');
  const ret = resolveGlobalFlag({ wantGlobal: false, currentGlobal: true, scopeAll: false });
  assert.equal(ret.status, 403);
});

test('no transition → no gate: a non-admin editing an already-global record\'s content is not refused', () => {
  // e.g. a shared record's assigned team-admin editing its repositories while
  // `global` stays true — unchanged, so it must not be blocked here.
  assert.deepEqual(resolveGlobalFlag({ wantGlobal: true, currentGlobal: true, scopeAll: false }), { global: true });
  assert.deepEqual(resolveGlobalFlag({ wantGlobal: false, currentGlobal: false, scopeAll: false }), { global: false });
});

test('only a literal boolean true publishes; a stray value never opens a record to every team', () => {
  assert.deepEqual(resolveGlobalFlag({ wantGlobal: 'true', currentGlobal: false, scopeAll: false }), { global: false });
  assert.deepEqual(resolveGlobalFlag({ wantGlobal: 1, currentGlobal: false, scopeAll: false }), { global: false });
});

// ── isGlobalEnvironment: re-reads BOTH preconditions on every call (AC5) ────

test('a record is global only with BOTH global:true AND scope:"system"', () => {
  assert.equal(isGlobalEnvironment({ global: true, scope: 'system' }), true);
  assert.equal(isGlobalEnvironment({ global: true, scope: 'team' }), false, 'hand-edited/stale — not global');
  assert.equal(isGlobalEnvironment({ global: false, scope: 'system' }), false);
  assert.equal(isGlobalEnvironment({ scope: 'system' }), false, 'no global key at all — an ordinary orphaned shared record');
});

test('isGlobalEnvironment fails closed on missing/malformed input', () => {
  assert.equal(isGlobalEnvironment(null), false);
  assert.equal(isGlobalEnvironment(undefined), false);
  assert.equal(isGlobalEnvironment({}), false);
});

test('a global record carries no team assignment, but the predicate does not itself require an empty assignedTeamIds — resolveGlobalFlag/api.js force that shape', () => {
  // The shape invariant (assignedTeamIds: []) is enforced at the write routes
  // (api.js forces { scope: 'system', teamId: null, assignedTeamIds: [] } when
  // publishing), not re-derived here — this predicate only re-reads what is on
  // disk, exactly like isGlobalProvider does for model providers.
  assert.equal(isGlobalEnvironment({ global: true, scope: 'system', assignedTeamIds: [] }), true);
});

// ── isGlobalCredential (unified resource access model §4/§12.3, #2357) ───────
// The SSH-key / GitHub-token analog of isGlobalProvider — STRICTER than
// isGlobalEnvironment: a global credential must also be a `service` identity.

test('a global SERVICE credential is global (all three preconditions met)', () => {
  assert.equal(isGlobalCredential({ global: true, scope: 'system', identity: 'service' }), true);
});

test('a HUMAN credential is NEVER global, even flagged global:true + scope:system', () => {
  // The model's core invariant: a secret that acts as one specific person is
  // Personal-only and can never widen to every team (resource-tier isAllowedTierCombo).
  assert.equal(isGlobalCredential({ global: true, scope: 'system', identity: 'human' }), false);
});

test('an UNCLASSIFIED legacy credential (identity absent/null) is not global until migrated', () => {
  // A secret never widens to every team by default — the migration must
  // affirmatively stamp it `service` first.
  assert.equal(isGlobalCredential({ global: true, scope: 'system' }), false);
  assert.equal(isGlobalCredential({ global: true, scope: 'system', identity: null }), false);
  assert.equal(isGlobalCredential({ global: true, scope: 'system', identity: 'bogus' }), false);
});

test('isGlobalCredential re-reads the global flag and the tier on every call', () => {
  assert.equal(isGlobalCredential({ global: true, scope: 'team', identity: 'service' }), false, 'hand-edited/stale — not system-tier');
  assert.equal(isGlobalCredential({ global: false, scope: 'system', identity: 'service' }), false, 'not flagged global');
  assert.equal(isGlobalCredential({ scope: 'system', identity: 'service' }), false, 'no global key at all');
});

test('isGlobalCredential fails closed on missing/malformed input', () => {
  assert.equal(isGlobalCredential(null), false);
  assert.equal(isGlobalCredential(undefined), false);
  assert.equal(isGlobalCredential({}), false);
});
