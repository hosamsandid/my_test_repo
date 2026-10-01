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
  assert.deepEqual(H.healthView(null), { status: 'unknown', reason: null, checkedAt: null, httpStatus: null, budget: null });
  assert.deepEqual(H.healthView({}), { status: 'unknown', reason: null, checkedAt: null, httpStatus: null, budget: null });
});

test('healthView: ok and error views', () => {
  assert.deepEqual(
    H.healthView({ ok: true, status: 200, reason: null, checkedAt: at(T0), consecutiveFailures: 0 }),
    { status: 'ok', reason: null, checkedAt: at(T0), httpStatus: 200, budget: null },
  );
  assert.deepEqual(
    H.healthView({ ok: false, status: 401, reason: 'HTTP 401 — nope', checkedAt: at(T0), consecutiveFailures: 2 }),
    { status: 'error', reason: 'HTTP 401 — nope', checkedAt: at(T0), httpStatus: 401, budget: null },
  );
});

test('coerceMs: positive numbers pass, everything else falls back', () => {
  assert.equal(H.coerceMs(1234, 99), 1234);
  assert.equal(H.coerceMs(0, 99), 99);
  assert.equal(H.coerceMs(-5, 99), 99);
  assert.equal(H.coerceMs('nope', 99), 99);
  assert.equal(H.coerceMs(undefined, 99), 99);
});

// ─── #2732: budget-driven Warning ────────────────────────────────────────────

const budgetRec = (spend, maxBudget, source = 'key', extra = {}) => ({
  ok: true, status: 200, reason: null, checkedAt: at(T0), consecutiveFailures: 0,
  budget: { status: 'ok', budget: { source, spend, maxBudget, budgetDuration: '30d', resetAt: '2026-11-01T00:00:00Z' } },
  ...extra,
});

test('applyProbeResult: carries the budget lookup but never lets it change ok/failures (AC5/AC10)', () => {
  const lookup = { status: 'ok', budget: { source: 'team', spend: 1900, maxBudget: 2000, budgetDuration: null, resetAt: null } };
  const rec = H.applyProbeResult({ consecutiveFailures: 0 }, { ok: true, status: 200 }, T0, lookup);
  assert.equal(rec.ok, true);
  assert.equal(rec.consecutiveFailures, 0);
  assert.deepEqual(rec.budget, lookup);
  const unavailable = H.applyProbeResult(null, { ok: true, status: 200 }, T0, { status: 'unavailable', reason: 'HTTP 500' });
  assert.equal(unavailable.ok, true);
  assert.equal(unavailable.consecutiveFailures, 0);
  // No lookup → no budget key at all (old records keep their shape).
  assert.equal('budget' in H.applyProbeResult(null, { ok: true, status: 200 }, T0), false);
});

test('a Warning record keeps the normal interval — no failure backoff (AC10)', () => {
  const rec = budgetRec(1900, 2000);
  assert.equal(H.nextDueMs(rec, { intervalMs: 300_000, baseMs: 60_000 }), T0 + 300_000);
});

test('healthView: ≥ 90 % → warning with the budget reason (AC6)', () => {
  const v = H.healthView(budgetRec(1840, 2000, 'team'));
  assert.equal(v.status, 'warning');
  assert.equal(v.reason, 'Budget 92 % used ($1,840 / $2,000, team)');
  assert.equal(v.budget.status, 'ok');
  assert.equal(v.budget.source, 'team');
  assert.equal(v.budget.pct, 92);
  assert.equal(v.budget.resetAt, '2026-11-01T00:00:00Z');
  // Exactly at the line counts.
  assert.equal(H.healthView(budgetRec(1800, 2000)).status, 'warning');
});

test('healthView: below the threshold stays ok and still exposes the budget (AC3)', () => {
  const v = H.healthView(budgetRec(291.94, 2000));
  assert.equal(v.status, 'ok');
  assert.equal(v.reason, null);
  assert.equal(v.budget.spend, 291.94);
  assert.equal(v.budget.maxBudget, 2000);
});

test('healthView: the warn threshold is configurable (AC7)', () => {
  assert.equal(H.healthView(budgetRec(1500, 2000), { warnPct: 75 }).status, 'warning');
  assert.equal(H.healthView(budgetRec(1840, 2000), { warnPct: 95 }).status, 'ok');
  // Bogus config falls back to the 90 % default.
  assert.equal(H.healthView(budgetRec(1840, 2000), { warnPct: 'x' }).status, 'warning');
});

test('healthView: ≥ 100 % (incl. overshoot) is Error with the real % (AC8)', () => {
  const v = H.healthView(budgetRec(2080, 2000, 'key'));
  assert.equal(v.status, 'error');
  assert.equal(v.reason, 'Budget 104 % used ($2,080 / $2,000, key)');
  assert.equal(H.healthView(budgetRec(2000, 2000)).status, 'error');
});

test('healthView: a failed probe stays Error with its own reason, budget or not (AC8)', () => {
  const v = H.healthView(budgetRec(1900, 2000, 'key', { ok: false, status: 400, reason: 'HTTP 400 — Budget has been exceeded!' }));
  assert.equal(v.status, 'error');
  assert.equal(v.reason, 'HTTP 400 — Budget has been exceeded!');
});

test('healthView: none / unavailable budgets never change health (AC4/AC5)', () => {
  const base = { ok: true, status: 200, reason: null, checkedAt: at(T0), consecutiveFailures: 0 };
  const none = H.healthView({ ...base, budget: { status: 'none' } });
  assert.equal(none.status, 'ok');
  assert.deepEqual(none.budget, { status: 'none' });
  const failed = H.healthView({ ...base, budget: { status: 'unavailable', reason: 'HTTP 503' } });
  assert.equal(failed.status, 'ok');
  assert.deepEqual(failed.budget, { status: 'unavailable', reason: 'HTTP 503' });
});
