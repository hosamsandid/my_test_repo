import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasSnapshot,
  isMaintenance,
  formatPercent,
  formatInt,
  formatCompact,
  formatDuration,
  snapshotMeta,
  metricTiles,
} from './hill-climb-view.js';

// A representative snapshot with a sufficient sample — mirrors the shape
// computeHillClimbMetrics (#1222) persists.
function fullSnapshot() {
  return {
    teamId: 'team-x',
    generatedAt: '2026-08-03T10:00:00.000Z',
    windowDays: 7,
    minRunsPerWindow: 20,
    window: { from: '2026-07-27T10:00:00.000Z', to: '2026-08-03T10:00:00.000Z' },
    totalRuns: 42,
    insufficientData: false,
    metrics: {
      insufficientData: false,
      runSuccessRate: 0.874,
      reworkRatio: 0.5,
      timeToDone: { p50Ms: 7_320_000, p90Ms: 26_400_000 },
      anomalyRecurrence: 3,
      waste: { wasteRuns: 6, failedRunTokens: 123456, throttleDrops: 2, digestFolds: 1 },
      deadConfig: { zeroFireTriggers: [{ agentId: 'a', triggerId: 't' }], unconsumedEmits: ['x', 'y'] },
    },
  };
}

test('hasSnapshot / isMaintenance interpret the API envelopes', () => {
  assert.equal(hasSnapshot({ teamId: 't', snapshot: fullSnapshot() }), true);
  assert.equal(hasSnapshot({ teamId: 't', snapshot: null }), false);
  assert.equal(hasSnapshot(null), false);
  assert.equal(isMaintenance({ maintenance: true, snapshot: null }), true);
  assert.equal(isMaintenance({ maintenance: false, snapshot: fullSnapshot() }), false);
  assert.equal(isMaintenance({}), false);
});

test('formatPercent rounds a 0..1 ratio and nulls non-numbers', () => {
  assert.equal(formatPercent(0.874), '87%');
  assert.equal(formatPercent(1), '100%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(null), null);
  assert.equal(formatPercent(undefined), null);
});

test('formatInt / formatCompact', () => {
  assert.equal(formatInt(1234), '1,234');
  assert.equal(formatInt(0), '0');
  assert.equal(formatInt(NaN), '0');
  assert.equal(formatCompact(123456), '123.5k');
  assert.equal(formatCompact(1_234_567), '1.2M');
  assert.equal(formatCompact(999), '999');
});

test('formatDuration spans seconds → days', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(180_000), '3m');
  assert.equal(formatDuration(7_320_000), '2h 2m');
  assert.equal(formatDuration(7_200_000), '2h');
  assert.equal(formatDuration(100_800_000), '1d 4h');
  assert.equal(formatDuration(-1), null);
  assert.equal(formatDuration(null), null);
});

test('snapshotMeta pulls header data with defaults', () => {
  const meta = snapshotMeta(fullSnapshot());
  assert.equal(meta.totalRuns, 42);
  assert.equal(meta.minRuns, 20);
  assert.equal(meta.windowDays, 7);
  assert.equal(meta.insufficientData, false);
  assert.equal(meta.from, '2026-07-27T10:00:00.000Z');
  const empty = snapshotMeta(null);
  assert.equal(empty.totalRuns, 0);
  assert.equal(empty.generatedAt, null);
});

test('metricTiles renders real values when the sample is sufficient', () => {
  const tiles = metricTiles(fullSnapshot());
  const by = Object.fromEntries(tiles.map((t) => [t.key, t]));
  assert.equal(by['success-rate'].state, 'ok');
  assert.equal(by['success-rate'].value, '87%');
  assert.equal(by['rework-ratio'].value, '0.50 / PR');
  assert.equal(by['time-to-done'].value, '2h 2m');
  assert.equal(by['time-to-done'].sub, 'p90 7h 20m');
  assert.equal(by['anomaly-recurrence'].value, '3');
  assert.equal(by['waste'].value, '6 runs');
  assert.equal(by['waste'].sub, '123.5k tokens');
  assert.equal(by['dead-config'].value, '3'); // 1 zero-fire + 2 unconsumed
});

test('insufficient data suppresses ONLY the ratio tiles as an explicit state', () => {
  const snap = fullSnapshot();
  snap.insufficientData = true;
  snap.totalRuns = 4;
  snap.metrics.insufficientData = true;
  snap.metrics.runSuccessRate = null;
  snap.metrics.reworkRatio = null;
  snap.metrics.timeToDone = null;
  const by = Object.fromEntries(metricTiles(snap).map((t) => [t.key, t]));
  // Ratio metrics → explicit insufficient state, never a zero.
  for (const k of ['success-rate', 'rework-ratio', 'time-to-done']) {
    assert.equal(by[k].state, 'insufficient', `${k} must be insufficient`);
    assert.equal(by[k].value, null, `${k} must not show a value`);
  }
  // Counting metrics stay meaningful on a thin sample.
  assert.equal(by['anomaly-recurrence'].state, 'ok');
  assert.equal(by['anomaly-recurrence'].value, '3');
  assert.equal(by['waste'].state, 'ok');
  assert.equal(by['dead-config'].state, 'ok');
});

test('a sufficient sample with no denominator renders an honest none, not zero', () => {
  const snap = fullSnapshot();
  snap.metrics.reworkRatio = null;   // no merged PRs
  snap.metrics.timeToDone = null;    // no completed runs
  snap.metrics.runSuccessRate = null; // no gradable runs
  const by = Object.fromEntries(metricTiles(snap).map((t) => [t.key, t]));
  assert.equal(by['rework-ratio'].state, 'none');
  assert.equal(by['rework-ratio'].note, 'No merged PRs in the window.');
  assert.equal(by['time-to-done'].state, 'none');
  assert.equal(by['success-rate'].state, 'none');
});
