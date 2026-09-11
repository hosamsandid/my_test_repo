'use strict';

// Unit tests for the global working-environment / MCP-server publish gate
// (#2158). Mirrors llm-endpoint-global.test.js (#2136), minus the
// oauth-specific cases — neither resource kind has an auth-type axis.
// Run: node --test admin-console/api/global-resource.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGlobalFlag, isGlobalEnvironment } = require('./global-resource');

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
