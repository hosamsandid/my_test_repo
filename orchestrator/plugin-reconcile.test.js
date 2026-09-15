'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  planTeamReconcile,
  grantedPluginIds,
  nextBackoffMs,
  isExhausted,
  dueNow,
  recordAttempt,
  DEFAULT_MAX_ATTEMPTS,
} = require('./plugin-reconcile');

const NOW = '2026-07-22T00:00:00.000Z';
const nowMs = Date.parse(NOW);
const minsAgo = (n) => new Date(nowMs - n * 60 * 1000).toISOString();

test('grantedPluginIds: inheriting member gets the whole team grant, override gets its own', () => {
  assert.deepStrictEqual(grantedPluginIds({ id: 'm' }, ['a', { id: 'b', scopeGranularity: 'agent' }]), ['a', 'b']);
  assert.deepStrictEqual(grantedPluginIds({ id: 'm', pluginsOverride: ['b'] }, ['a', 'b']), ['b']);
});

test('grantedPluginIds: an override member with an EMPTY list inherits nothing', () => {
  assert.deepStrictEqual(grantedPluginIds({ id: 'm', pluginsOverride: [] }, ['a', 'b']), []);
});

test('missing-entry detection: only granted-but-unseeded members are due', () => {
  const members = [
    { id: 'm1', token: 't' }, // inherits a,b — has a, missing b
    { id: 'm2', token: 't' }, // inherits a,b — has both
    { id: 'stub' }, // no token → skipped entirely
  ];
  const seeded = { m1: { a: { scopeGranularity: 'team' } }, m2: { a: {}, b: {} } };
  const r = planTeamReconcile({
    members, activeGrant: ['a', 'b'],
    seededOf: (id) => seeded[id], stateOf: () => ({}),
  }, { now: NOW });
  assert.deepStrictEqual(r.due, [{ agentId: 'm1', pluginId: 'b' }]);
});

test('idempotency: nothing missing → no due targets', () => {
  const members = [{ id: 'm1', token: 't' }];
  const seeded = { m1: { a: {}, b: {} } };
  const r = planTeamReconcile({
    members, activeGrant: ['a', 'b'],
    seededOf: (id) => seeded[id], stateOf: () => ({}),
  }, { now: NOW });
  assert.deepStrictEqual(r.due, []);
  assert.deepStrictEqual(r.waiting, []);
  assert.deepStrictEqual(r.exhausted, []);
});

test('bounded retry: an exhausted entry is not retried', () => {
  const members = [{ id: 'm1', token: 't' }];
  const state = { m1: { b: { attempts: DEFAULT_MAX_ATTEMPTS, lastAttemptAt: minsAgo(9999) } } };
  const r = planTeamReconcile({
    members, activeGrant: ['b'],
    seededOf: () => ({}), stateOf: (id) => state[id],
  }, { now: NOW });
  assert.deepStrictEqual(r.due, []);
  assert.deepStrictEqual(r.exhausted, [{ agentId: 'm1', pluginId: 'b' }]);
});

test('backoff: a recent failed attempt is waiting, an old one is due', () => {
  const members = [{ id: 'm1', token: 't' }];
  // attempts=2 → backoff = base(1min)*2^1 = 2 min
  const recent = { m1: { b: { attempts: 2, lastAttemptAt: minsAgo(1) } } };
  const old = { m1: { b: { attempts: 2, lastAttemptAt: minsAgo(10) } } };
  const rRecent = planTeamReconcile({ members, activeGrant: ['b'], seededOf: () => ({}), stateOf: (id) => recent[id] }, { now: NOW });
  const rOld = planTeamReconcile({ members, activeGrant: ['b'], seededOf: () => ({}), stateOf: (id) => old[id] }, { now: NOW });
  assert.deepStrictEqual(rRecent.waiting, [{ agentId: 'm1', pluginId: 'b' }]);
  assert.deepStrictEqual(rRecent.due, []);
  assert.deepStrictEqual(rOld.due, [{ agentId: 'm1', pluginId: 'b' }]);
});

test('nextBackoffMs doubles and caps', () => {
  assert.strictEqual(nextBackoffMs(0), 0);
  assert.strictEqual(nextBackoffMs(1, { baseBackoffMs: 1000, maxBackoffMs: 100000 }), 1000);
  assert.strictEqual(nextBackoffMs(3, { baseBackoffMs: 1000, maxBackoffMs: 100000 }), 4000);
  assert.strictEqual(nextBackoffMs(99, { baseBackoffMs: 1000, maxBackoffMs: 5000 }), 5000);
});

test('dueNow: never-attempted is due', () => {
  assert.strictEqual(dueNow({}, nowMs, {}), true);
  assert.strictEqual(dueNow({ attempts: 0 }, nowMs, {}), true);
});

test('isExhausted honours maxAttempts', () => {
  assert.strictEqual(isExhausted({ attempts: 4 }, 5), false);
  assert.strictEqual(isExhausted({ attempts: 5 }, 5), true);
});

test('recordAttempt clears on success and bumps on failure', () => {
  assert.strictEqual(recordAttempt({ attempts: 2 }, { ok: true, now: NOW }), null);
  const failed = recordAttempt({ attempts: 2 }, { ok: false, error: 'ENOENT', now: NOW });
  assert.strictEqual(failed.attempts, 3);
  assert.strictEqual(failed.lastError, 'ENOENT');
  assert.strictEqual(failed.lastAttemptAt, NOW);
});

test('override member: only its own listed plugins reconcile', () => {
  const members = [{ id: 'm1', token: 't', pluginsOverride: ['b'] }];
  const r = planTeamReconcile({
    members, activeGrant: ['a', 'b'],
    seededOf: () => ({}), stateOf: () => ({}),
  }, { now: NOW });
  assert.deepStrictEqual(r.due, [{ agentId: 'm1', pluginId: 'b' }]);
});
