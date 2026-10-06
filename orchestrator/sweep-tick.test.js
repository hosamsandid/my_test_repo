'use strict';

// Unit tests for the sweep-tick stagger + slow-tick logger (#569).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SWEEP_TICK_SLOT_MS, DEFAULT_SLOW_TICK_MS, sweepTickSchedule, slowTickConfigFromEnv, createSlowTickLogger, formatSlowTickLine,
} = require('./sweep-tick');

const firstRuns = (intervals, opts) => sweepTickSchedule(intervals, opts).map((s) => s.firstRunMs);

test('five 60 s ticks first run one slot apart, the last exactly one interval after start-up', () => {
  assert.equal(SWEEP_TICK_SLOT_MS, 6_000);
  assert.deepEqual(firstRuns([60_000, 60_000, 60_000, 60_000, 60_000]), [36_000, 42_000, 48_000, 54_000, 60_000]);
  assert.deepEqual(sweepTickSchedule([60_000, 60_000]).map((s) => s.intervalMs), [60_000, 60_000]);
});

test('no first run is ever later than its own interval (the pre-stagger first run)', () => {
  for (const intervals of [[60_000, 30_000, 90_000, 60_000, 10_000], [5_000, 600_000, 60_000], [1, 1, 1]]) {
    sweepTickSchedule(intervals).forEach((s, i) => {
      assert.ok(s.firstRunMs <= intervals[i], `${intervals}: slot ${i} first run ${s.firstRunMs} > ${intervals[i]}`);
      assert.ok(s.firstRunMs > 0, 'a first run never fires in the start-up turn');
    });
  }
});

test('slots are one common step, so equal intervals stay a step apart forever', () => {
  const intervals = [60_000, 60_000, 60_000, 60_000, 60_000];
  const sched = sweepTickSchedule(intervals);
  // The k-th run of tick i fires at firstRun_i + k·interval_i.
  for (const k of [0, 1, 100]) {
    const at = sched.map((s) => s.firstRunMs + k * s.intervalMs);
    for (let i = 1; i < at.length; i++) assert.equal(at[i] - at[i - 1], 6_000);
  }
});

test('the step is bounded by the smallest interval, so the spread fits inside every interval', () => {
  // smallest 10 s / 5 slots → 2 s step, not the 6 s default
  assert.deepEqual(firstRuns([60_000, 10_000, 60_000, 60_000, 60_000]), [52_000, 4_000, 56_000, 58_000, 60_000]);
  assert.deepEqual(firstRuns([60_000, 60_000], { maxSlotMs: 1_000 }), [59_000, 60_000]);
});

test('bad input degrades to the plain intervals, never a negative or NaN delay', () => {
  assert.deepEqual(sweepTickSchedule(undefined), []);
  assert.deepEqual(firstRuns([60_000, NaN, 60_000]), [48_000, 0, 60_000]);
  assert.deepEqual(firstRuns([60_000, 60_000], { maxSlotMs: 0 }), [60_000, 60_000]);
  assert.deepEqual(firstRuns([60_000, 60_000], { maxSlotMs: 'x' }), [60_000, 60_000]);
  for (const s of sweepTickSchedule([0, -5, 'x'])) assert.equal(s.firstRunMs, 0);
});

test('the slow-tick logger logs at/above the threshold only', () => {
  const lines = [];
  let t = 10_000;
  const logSlow = createSlowTickLogger({ slowMs: 500, now: () => t, log: (l) => lines.push(l) });
  logSlow('admission', 9_600);
  logSlow('pool-reap', 9_500);
  t = 22_000;
  logSlow('recurring-pool', 10_000);
  assert.deepEqual(lines, ['[perf] tick=pool-reap ms=500', '[perf] tick=recurring-pool ms=12000']);
});

test('the slow-tick logger is silent when perf logging is disabled', () => {
  const lines = [];
  const logSlow = createSlowTickLogger({ enabled: false, slowMs: 1, now: () => 1e9, log: (l) => lines.push(l) });
  logSlow('admission', 0);
  assert.deepEqual(lines, []);
});

test('line format is one greppable [perf] token', () => {
  assert.equal(formatSlowTickLine({ name: 'flow-supervisor', ms: 1234.6 }), '[perf] tick=flow-supervisor ms=1235');
});

test('slow-tick config reads AEE_PERF_LOG / AEE_SLOW_REQUEST_MS with a 500 ms default', () => {
  assert.equal(DEFAULT_SLOW_TICK_MS, 500);
  assert.deepEqual(slowTickConfigFromEnv({}), { enabled: true, slowMs: 500 });
  assert.deepEqual(slowTickConfigFromEnv(), { enabled: true, slowMs: 500 });
  assert.deepEqual(slowTickConfigFromEnv({ AEE_SLOW_REQUEST_MS: '1500' }), { enabled: true, slowMs: 1500 });
  for (const bad of ['0', '-5', 'abc', '']) {
    assert.equal(slowTickConfigFromEnv({ AEE_SLOW_REQUEST_MS: bad }).slowMs, 500, `AEE_SLOW_REQUEST_MS=${bad}`);
  }
  assert.equal(slowTickConfigFromEnv({ AEE_PERF_LOG: '0' }).enabled, false);
  assert.equal(slowTickConfigFromEnv({ AEE_PERF_LOG: ' 0 ' }).enabled, false);
  assert.equal(slowTickConfigFromEnv({ AEE_PERF_LOG: '1' }).enabled, true);
});
