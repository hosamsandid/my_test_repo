'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SEEN_MAX,
  computeBackoffDelayMs,
  effectiveHorizon,
  passesHorizon,
  selectFreshEvents,
  planBurstHandoffs,
  pruneThrottleState,
  loadThrottleState,
  saveThrottleState,
  checkAndIncThrottle,
} = require('./event-cursor');

// The SDK re-exports every primitive so a broker imports from one place.
test('broker-sdk index re-exports the event-cursor primitives', () => {
  const sdk = require('./index');
  for (const name of ['selectFreshEvents', 'planBurstHandoffs', 'checkAndIncThrottle', 'computeBackoffDelayMs', 'passesHorizon', 'effectiveHorizon']) {
    assert.equal(typeof sdk[name], 'function', name);
  }
});

// ── computeBackoffDelayMs ───────────────────────────────────────────────────

test('computeBackoffDelayMs: 1m, 2m, 4m … capped at 30m', () => {
  assert.equal(computeBackoffDelayMs(1), 60_000);
  assert.equal(computeBackoffDelayMs(2), 120_000);
  assert.equal(computeBackoffDelayMs(3), 240_000);
  assert.equal(computeBackoffDelayMs(10), 30 * 60_000); // capped
  assert.equal(computeBackoffDelayMs(0), 60_000); // non-positive → 1
  assert.equal(computeBackoffDelayMs(null), 60_000);
});

// ── effectiveHorizon / passesHorizon ────────────────────────────────────────

test('effectiveHorizon: activatedAt beats createdAt beats mtime', () => {
  assert.equal(effectiveHorizon({ activatedAt: 'A', createdAt: 'C' }, 'M'), 'A');
  assert.equal(effectiveHorizon({ createdAt: 'C' }, 'M'), 'C');
  assert.equal(effectiveHorizon({}, 'M'), 'M');
  assert.equal(effectiveHorizon(null, null), null);
});

test('passesHorizon: an event within grace of the horizon still delivers', () => {
  const horizon = '2026-01-01T12:00:00.000Z';
  const grace = 5 * 60_000;
  assert.equal(passesHorizon('2026-01-01T12:05:00.000Z', horizon, grace), true);  // after
  assert.equal(passesHorizon('2026-01-01T11:58:00.000Z', horizon, grace), true);  // within grace
  assert.equal(passesHorizon('2026-01-01T11:50:00.000Z', horizon, grace), false); // before grace
  assert.equal(passesHorizon(null, horizon, grace), true);   // missing ts fails open
  assert.equal(passesHorizon('2026-01-01T00:00:00.000Z', null, grace), true); // no horizon
});

// ── selectFreshEvents ───────────────────────────────────────────────────────

test('selectFreshEvents: an unseen id is fresh even with an older timestamp; a seen id never re-delivers', () => {
  const events = [
    { id: 'A-1:10', created: '2026-01-01T00:00:00Z' },
    { id: 'A-1:11', created: '2026-01-02T00:00:00Z' },
  ];
  const first = selectFreshEvents(events, [], SEEN_MAX);
  assert.deepEqual(first.fresh.map((e) => e.id), ['A-1:10', 'A-1:11']);

  // second poll: same two ids visible, plus one new one that is chronologically older
  const second = selectFreshEvents(
    [...events, { id: 'A-1:9', created: '2025-12-31T00:00:00Z' }],
    first.nextSeen,
    SEEN_MAX,
  );
  assert.deepEqual(second.fresh.map((e) => e.id), ['A-1:9']); // only the unseen one
});

test('selectFreshEvents: nextSeen dedups newest-first and caps at seenMax', () => {
  const events = Array.from({ length: 10 }, (_, i) => ({ id: `E${i}` }));
  const { nextSeen } = selectFreshEvents(events, ['E0', 'old-1', 'old-2'], 5);
  assert.equal(nextSeen.length, 5);
  assert.equal(nextSeen[0], 'E0');
  assert.equal(new Set(nextSeen).size, nextSeen.length);
});

test('selectFreshEvents: events without an id are ignored, never throws', () => {
  const { fresh } = selectFreshEvents([{ foo: 1 }, null, { id: 'X' }], [], SEEN_MAX);
  assert.deepEqual(fresh.map((e) => e.id), ['X']);
});

// ── planBurstHandoffs ───────────────────────────────────────────────────────

test('planBurstHandoffs: a group over the cap collapses into one digest, others stay individual', () => {
  const deliverables = [
    { agentId: 'a', convKey: 'issue:P-1' },
    { agentId: 'a', convKey: 'issue:P-1' },
    { agentId: 'a', convKey: 'issue:P-1' },
    { agentId: 'a', convKey: 'issue:P-1' }, // 4 > cap 3 → digest
    { agentId: 'b', convKey: 'issue:P-2' }, // 1 → individual
  ];
  const plans = planBurstHandoffs(deliverables, 3);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].mode, 'digest');
  assert.equal(plans[0].items.length, 4);
  assert.equal(plans[1].mode, 'individual');
});

test('planBurstHandoffs: group + per-group order preserved; missing agentId dropped', () => {
  const plans = planBurstHandoffs(
    [{ agentId: 'z', convKey: 'k', n: 1 }, { convKey: 'k' }, { agentId: 'z', convKey: 'k', n: 2 }],
    3,
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].items.map((i) => i.n), [1, 2]);
});

// ── throttle ────────────────────────────────────────────────────────────────

test('checkAndIncThrottle: drops past the threshold and warns exactly once', () => {
  const buckets = {};
  const opts = { windowMs: 3600_000, threshold: 3 };
  const results = [];
  for (let i = 0; i < 6; i += 1) results.push(checkAndIncThrottle(buckets, 'a:k', opts));
  assert.deepEqual(results.map((r) => r.drop), [false, false, false, true, true, true]);
  assert.deepEqual(results.map((r) => r.justWarned), [false, false, false, true, false, false]);
});

test('checkAndIncThrottle: a fresh window resets the count', () => {
  const buckets = { 'a:k': { count: 9, windowStart: new Date(Date.now() - 7200_000).toISOString(), warned: true } };
  const r = checkAndIncThrottle(buckets, 'a:k', { windowMs: 3600_000, threshold: 3 });
  assert.equal(r.count, 1);
  assert.equal(r.drop, false);
});

test('throttle state round-trips through the fs helpers and prunes stale buckets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-cursor-'));
  const file = path.join(dir, 'throttle-state.json');
  const buckets = {
    fresh: { count: 2, windowStart: new Date().toISOString(), warned: false },
    stale: { count: 9, windowStart: new Date(Date.now() - 5 * 3600_000).toISOString(), warned: true },
  };
  saveThrottleState(file, buckets);
  const loaded = loadThrottleState(file, 3600_000);
  assert.ok(loaded.fresh);
  assert.equal(loaded.stale, undefined); // older than 2× the window
});

test('loadThrottleState: a missing file is an empty map, never throws', () => {
  assert.deepEqual(loadThrottleState('/no/such/throttle.json', 3600_000), {});
});

test('pruneThrottleState: drops closed-window buckets, keeps live ones, tolerates junk', () => {
  const now = Date.now();
  const out = pruneThrottleState({
    live: { count: 1, windowStart: new Date(now - 1000).toISOString() },
    old: { count: 9, windowStart: new Date(now - 5 * 3600_000).toISOString() },
    junk: null,
    noStart: { count: 3 },
  }, 3600_000);
  assert.deepEqual(Object.keys(out), ['live']);
});

test('saveThrottleState prunes on write, so a long-lived in-memory map cannot bloat the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-cursor-'));
  const file = path.join(dir, 'throttle-state.json');
  saveThrottleState(file, {
    keep: { count: 1, windowStart: new Date().toISOString() },
    drop: { count: 9, windowStart: new Date(Date.now() - 5 * 3600_000).toISOString() },
  }, 3600_000);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.buckets), ['keep']);
});
