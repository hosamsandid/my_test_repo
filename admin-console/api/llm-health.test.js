'use strict';

// Tests for the pure Model Provider health-poller logic (#1843).
// Run: node --test admin-console/api/llm-health.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./llm-health');

const T0 = Date.parse('2026-09-02T00:00:00.000Z');
const at = ms => new Date(ms).toISOString();

test('backoffMs: 0 for a healthy endpoint, exponential + capped for failures', () => {
  const base = 5 * 60_000;
  const max = 60 * 60_000;
  const o = { baseMs: base, maxMs: max };
  assert.equal(H.backoffMs(0, o), 0);
  assert.equal(H.backoffMs(-3, o), 0);
  assert.equal(H.backoffMs(1, o), base);          // 5m
  assert.equal(H.backoffMs(2, o), base * 2);      // 10m
  assert.equal(H.backoffMs(3, o), base * 4);      // 20m
  assert.equal(H.backoffMs(4, o), base * 8);      // 40m
  assert.equal(H.backoffMs(5, o), max);           // 80m -> capped at 60m
  assert.equal(H.backoffMs(20, o), max);          // stays capped
});

test('backoffMs: falls back to defaults on bogus opts', () => {
  assert.equal(H.backoffMs(1, {}), H.DEFAULT_BACKOFF_BASE_MS);
  assert.equal(H.backoffMs(1, { baseMs: 'x', maxMs: -1 }), H.DEFAULT_BACKOFF_BASE_MS);
});

test('applyProbeResult: success resets consecutiveFailures and clears reason', () => {
  const prev = { ok: false, status: 500, reason: 'HTTP 500', checkedAt: at(T0), consecutiveFailures: 3 };
  const rec = H.applyProbeResult(prev, { ok: true, status: 200, error: null }, T0 + 1000);
  assert.equal(rec.ok, true);
  assert.equal(rec.status, 200);
  assert.equal(rec.reason, null);
  assert.equal(rec.consecutiveFailures, 0);
  assert.equal(rec.checkedAt, at(T0 + 1000));
});

test('applyProbeResult: failure increments from prior and keeps the honest reason', () => {
  const prev = { ok: true, status: 200, reason: null, checkedAt: at(T0), consecutiveFailures: 0 };
  const rec = H.applyProbeResult(prev, { ok: false, status: 401, error: 'HTTP 401 — bad token' }, T0);
  assert.equal(rec.ok, false);
  assert.equal(rec.status, 401);
  assert.equal(rec.reason, 'HTTP 401 — bad token');
  assert.equal(rec.consecutiveFailures, 1);
});

test('applyProbeResult: first-ever failure (no prev) starts at 1, unreachable status 0', () => {
  const rec = H.applyProbeResult(null, { ok: false, status: 0, error: 'timeout' }, T0);
  assert.equal(rec.consecutiveFailures, 1);
  assert.equal(rec.status, 0);
  assert.equal(rec.reason, 'timeout');
});

test('applyProbeResult: missing error string on a failure degrades to a generic reason', () => {
  const rec = H.applyProbeResult(null, { ok: false, status: 0, error: null }, T0);
  assert.equal(rec.reason, 'request failed');
});

test('nextDueMs / isDue: healthy record uses the plain interval', () => {
  const interval = 5 * 60_000;
  const rec = { ok: true, checkedAt: at(T0), consecutiveFailures: 0 };
  assert.equal(H.nextDueMs(rec, { intervalMs: interval }), T0 + interval);
  assert.equal(H.isDue(rec, T0 + interval - 1, { intervalMs: interval }), false);
  assert.equal(H.isDue(rec, T0 + interval, { intervalMs: interval }), true);
});

test('nextDueMs: failing record uses backoff, not the interval', () => {
  const interval = 5 * 60_000;
  const base = 5 * 60_000;
  const rec = { ok: false, checkedAt: at(T0), consecutiveFailures: 3 };
  // 3 failures -> 20m backoff, well past the 5m interval.
  assert.equal(H.nextDueMs(rec, { intervalMs: interval, baseMs: base }), T0 + base * 4);
});

test('isDue: a missing record is due immediately', () => {
  assert.equal(H.isDue(undefined, T0), true);
  assert.equal(H.isDue(null, T0), true);
  assert.equal(H.isDue({ checkedAt: 'not-a-date' }, T0), true);
});

test('isStale: missing/blank/old -> true; fresh -> false', () => {
  const stale = 2 * 60_000;
  assert.equal(H.isStale(null, T0, stale), true);
  assert.equal(H.isStale({ checkedAt: 'garbage' }, T0, stale), true);
  assert.equal(H.isStale({ checkedAt: at(T0) }, T0 + stale, stale), true);
  assert.equal(H.isStale({ checkedAt: at(T0) }, T0 + stale - 1, stale), false);
});

test('selectDueEndpointIds: only due endpoints, skips id-less entries', () => {
  const interval = 5 * 60_000;
  const endpoints = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { notAnId: true }];
  const healthMap = {
    a: { ok: true, checkedAt: at(T0), consecutiveFailures: 0 },        // fresh -> not due
    b: { ok: false, checkedAt: at(T0 - 30 * 60_000), consecutiveFailures: 1 }, // old -> due
    // c: no record -> due
  };
  const due = H.selectDueEndpointIds(endpoints, healthMap, T0 + 60_000, { intervalMs: interval });
  assert.deepEqual(due.sort(), ['b', 'c']);
});

test('healthView: unknown when no record (AC6 — never a guessed green)', () => {
  assert.deepEqual(H.healthView(null), { status: 'unknown', reason: null, checkedAt: null, httpStatus: null });
  assert.deepEqual(H.healthView({}), { status: 'unknown', reason: null, checkedAt: null, httpStatus: null });
});

test('healthView: ok and error views', () => {
  assert.deepEqual(
    H.healthView({ ok: true, status: 200, reason: null, checkedAt: at(T0), consecutiveFailures: 0 }),
    { status: 'ok', reason: null, checkedAt: at(T0), httpStatus: 200 },
  );
  assert.deepEqual(
    H.healthView({ ok: false, status: 401, reason: 'HTTP 401 — nope', checkedAt: at(T0), consecutiveFailures: 2 }),
    { status: 'error', reason: 'HTTP 401 — nope', checkedAt: at(T0), httpStatus: 401 },
  );
});

test('coerceMs: positive numbers pass, everything else falls back', () => {
  assert.equal(H.coerceMs(1234, 99), 1234);
  assert.equal(H.coerceMs(0, 99), 99);
  assert.equal(H.coerceMs(-5, 99), 99);
  assert.equal(H.coerceMs('nope', 99), 99);
  assert.equal(H.coerceMs(undefined, 99), 99);
});
