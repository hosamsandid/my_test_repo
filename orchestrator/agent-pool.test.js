'use strict';

// Unit tests for the pure agent-pool core (#2246, epic #2251 Phase 1).

const { test } = require('node:test');
const assert = require('node:assert');

const pool = require('./agent-pool');

// ─── normalizePoolConfig ──────────────────────────────────────────────────────

test('normalizePoolConfig: absent/disabled pool reads as not pooled', () => {
  assert.equal(pool.normalizePoolConfig(undefined), null);
  assert.equal(pool.normalizePoolConfig(null), null);
  assert.equal(pool.normalizePoolConfig({}), null);
  assert.equal(pool.normalizePoolConfig({ enabled: false }), null);
  assert.equal(pool.normalizePoolConfig({ enabled: 'true' }), null); // must be the literal boolean
});

test('normalizePoolConfig: minimal enabled config gets full defaults', () => {
  assert.deepEqual(pool.normalizePoolConfig({ enabled: true }), {
    enabled: true,
    maxInstances: null,
    workspace: 'git-clean-base',
    baseBranch: null,
    teardown: { idleTimeoutMs: null, maxRuntimeMs: null, retainLogsMs: null },
  });
});

test('normalizePoolConfig: carries through valid fields, drops invalid ones', () => {
  assert.deepEqual(pool.normalizePoolConfig({
    enabled: true,
    maxInstances: 3,
    workspace: 'input-copy',
    baseBranch: 'develop',
    teardown: { idleTimeoutMs: 60_000, maxRuntimeMs: -5, retainLogsMs: 'nope' },
  }), {
    enabled: true,
    maxInstances: 3,
    workspace: 'input-copy',
    baseBranch: 'develop',
    teardown: { idleTimeoutMs: 60_000, maxRuntimeMs: null, retainLogsMs: null },
  });
});

test('normalizePoolConfig: an unrecognised workspace binding falls back to git-clean-base', () => {
  assert.equal(pool.normalizePoolConfig({ enabled: true, workspace: 'teleport' }).workspace, 'git-clean-base');
});

test('normalizePoolConfig: a non-positive-integer maxInstances is null (unbounded, wipLimit governs)', () => {
  assert.equal(pool.normalizePoolConfig({ enabled: true, maxInstances: 0 }).maxInstances, null);
  assert.equal(pool.normalizePoolConfig({ enabled: true, maxInstances: -1 }).maxInstances, null);
  assert.equal(pool.normalizePoolConfig({ enabled: true, maxInstances: 1.5 }).maxInstances, null);
});

// ─── isPooledRole ──────────────────────────────────────────────────────────────

test('isPooledRole: true only for a template with pool.enabled, never for an instance', () => {
  assert.equal(pool.isPooledRole({ pool: { enabled: true } }), true);
  assert.equal(pool.isPooledRole({ pool: { enabled: false } }), false);
  assert.equal(pool.isPooledRole({}), false);
  assert.equal(pool.isPooledRole(null), false);
  // An already-spawned instance never re-pools, even if it somehow carried the
  // field forward — no nested spawning.
  assert.equal(pool.isPooledRole({ pool: { enabled: true }, poolInstance: true }), false);
});

// ─── poolInstanceId / roleIdFromMemberId ───────────────────────────────────────

test('poolInstanceId: deterministic, item-keyed (D11)', () => {
  assert.equal(pool.poolInstanceId('team1', 'developer', 42), 'team1-developer-i42');
  // Same inputs, same output — the whole idempotency property.
  assert.equal(pool.poolInstanceId('team1', 'developer', 42), pool.poolInstanceId('team1', 'developer', 42));
});

test('roleIdFromMemberId: inverse of the `${teamId}-${roleId}` naming convention', () => {
  assert.equal(pool.roleIdFromMemberId('team1-developer', 'team1'), 'developer');
  // A role id that itself contains a hyphen survives (only the team prefix is stripped).
  assert.equal(pool.roleIdFromMemberId('team1-code-reviewer', 'team1'), 'code-reviewer');
});

test('roleIdFromMemberId: falls back to the bare id when it carries no team prefix', () => {
  assert.equal(pool.roleIdFromMemberId('some-hand-authored-id', 'team1'), 'some-hand-authored-id');
});

// ─── planPoolDispatch ───────────────────────────────────────────────────────────

const POOL = pool.normalizePoolConfig({ enabled: true });

test('planPoolDispatch: no item key → unpooled (dispatch the template itself)', () => {
  assert.deepEqual(
    pool.planPoolDispatch({ teamId: 't', roleId: 'developer', pool: POOL, itemKey: null }),
    { action: 'unpooled' },
  );
  assert.deepEqual(
    pool.planPoolDispatch({ teamId: 't', roleId: 'developer', pool: POOL, itemKey: undefined }),
    { action: 'unpooled' },
  );
});

test('planPoolDispatch: a brand-new item spawns a fresh, deterministically-named instance', () => {
  assert.deepEqual(
    pool.planPoolDispatch({ teamId: 't', roleId: 'developer', pool: POOL, itemKey: 7, existingInstanceIds: [] }),
    { action: 'spawn', instanceId: 't-developer-i7' },
  );
});

test('planPoolDispatch: a redelivered item for an instance that already exists is reused, not re-spawned (D11)', () => {
  assert.deepEqual(
    pool.planPoolDispatch({
      teamId: 't', roleId: 'developer', pool: POOL, itemKey: 7,
      existingInstanceIds: ['t-developer-i7'],
    }),
    { action: 'reuse', instanceId: 't-developer-i7' },
  );
});

test('planPoolDispatch: maxInstances refuses a new item once the per-role cap is reached', () => {
  const capped = pool.normalizePoolConfig({ enabled: true, maxInstances: 2 });
  assert.deepEqual(
    pool.planPoolDispatch({
      teamId: 't', roleId: 'developer', pool: capped, itemKey: 9,
      existingInstanceIds: ['t-developer-i7', 't-developer-i8'],
    }),
    { action: 'refuse', reason: 'max-instances', instanceId: 't-developer-i9' },
  );
});

test('planPoolDispatch: maxInstances never refuses a REUSE of an already-existing instance', () => {
  const capped = pool.normalizePoolConfig({ enabled: true, maxInstances: 1 });
  assert.deepEqual(
    pool.planPoolDispatch({
      teamId: 't', roleId: 'developer', pool: capped, itemKey: 7,
      existingInstanceIds: ['t-developer-i7'],
    }),
    { action: 'reuse', instanceId: 't-developer-i7' },
  );
});

test('planPoolDispatch: an unset maxInstances (null) is unbounded — only wipLimit governs (D5)', () => {
  assert.deepEqual(
    pool.planPoolDispatch({
      teamId: 't', roleId: 'developer', pool: POOL, itemKey: 100,
      existingInstanceIds: Array.from({ length: 50 }, (_, i) => `t-developer-i${i}`),
    }),
    { action: 'spawn', instanceId: 't-developer-i100' },
  );
});

// ─── isInstanceTimedOut (D8 hard timeout) ───────────────────────────────────────

test('isInstanceTimedOut: no maxRuntimeMs configured → never times out', () => {
  assert.equal(pool.isInstanceTimedOut({ spawnedAt: '2026-01-01T00:00:00.000Z', maxRuntimeMs: null }, Date.now()), false);
  assert.equal(pool.isInstanceTimedOut({ spawnedAt: '2026-01-01T00:00:00.000Z', maxRuntimeMs: undefined }, Date.now()), false);
});

test('isInstanceTimedOut: unresolvable spawnedAt never times out (fails closed, not stuck-forever-by-accident)', () => {
  assert.equal(pool.isInstanceTimedOut({ spawnedAt: null, maxRuntimeMs: 1000 }, Date.now()), false);
  assert.equal(pool.isInstanceTimedOut({ spawnedAt: 'not-a-date', maxRuntimeMs: 1000 }, Date.now()), false);
});

test('isInstanceTimedOut: within budget → false, at/after the deadline → true', () => {
  const spawnedAt = '2026-01-01T00:00:00.000Z';
  const start = Date.parse(spawnedAt);
  assert.equal(pool.isInstanceTimedOut({ spawnedAt, maxRuntimeMs: 3_600_000 }, start + 3_599_999), false);
  assert.equal(pool.isInstanceTimedOut({ spawnedAt, maxRuntimeMs: 3_600_000 }, start + 3_600_000), true);
  assert.equal(pool.isInstanceTimedOut({ spawnedAt, maxRuntimeMs: 3_600_000 }, start + 10_000_000), true);
});
