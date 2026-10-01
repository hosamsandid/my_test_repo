'use strict';

// #2760 — the provisioning-slot registry that makes an in-flight pool spawn
// count against its role's `maxInstances` cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const slots = require('./pool-spawn-slots');

test('countedInstanceIds: live + provisioning, each id once', () => {
  assert.deepEqual(slots.countedInstanceIds(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(slots.countedInstanceIds(), []);
});

test('reserve/provisioningIds/pending/release track one role at a time', () => {
  const s = slots.createSpawnSlots();
  const p1 = Promise.resolve();
  const p2 = Promise.resolve();
  s.reserve('t-dev', 't-dev-i1', p1);
  s.reserve('t-dev', 't-dev-i2', p2);
  s.reserve('t-qa', 't-qa-i1', p1);
  assert.deepEqual(s.provisioningIds('t-dev'), ['t-dev-i1', 't-dev-i2']);
  assert.equal(s.pending('t-dev-i2'), p2);
  s.release('t-dev-i2', p2);
  assert.deepEqual(s.provisioningIds('t-dev'), ['t-dev-i1']);
  assert.equal(s.pending('t-dev-i2'), null);
  assert.deepEqual(s.provisioningIds('t-qa'), ['t-qa-i1']);
});

test('release ignores a stale promise — a late-settling earlier attempt never frees a newer slot', () => {
  const s = slots.createSpawnSlots();
  const old = Promise.resolve();
  const fresh = Promise.resolve();
  s.reserve('r', 'r-i1', fresh);
  s.release('r-i1', old);
  assert.equal(s.pending('r-i1'), fresh);
});

test('noteFailure counts per instance; clearFailures resets', () => {
  const s = slots.createSpawnSlots();
  assert.equal(s.noteFailure('x'), 1);
  assert.equal(s.noteFailure('x'), 2);
  assert.equal(s.noteFailure('y'), 1);
  s.clearFailures('x');
  assert.equal(s.noteFailure('x'), 1);
});

test('spawnRetryDelayMs: a bounded backoff, null once exhausted or for nonsense', () => {
  assert.equal(slots.spawnRetryDelayMs(1), slots.SPAWN_RETRY_DELAYS_MS[0]);
  assert.equal(slots.spawnRetryDelayMs(slots.SPAWN_RETRY_DELAYS_MS.length), slots.SPAWN_RETRY_DELAYS_MS.at(-1));
  assert.equal(slots.spawnRetryDelayMs(slots.SPAWN_RETRY_DELAYS_MS.length + 1), null);
  assert.equal(slots.spawnRetryDelayMs(0), null);
  assert.equal(slots.spawnRetryDelayMs('1'), null);
});
