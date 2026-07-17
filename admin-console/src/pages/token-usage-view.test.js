import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOKEN_CLASSES,
  GROUP_OPTIONS,
  formatInt,
  formatCompact,
  niceScale,
  buildDaySeries,
  stackSegments,
  buildExportUrl,
} from './token-usage-view.js';

test('TOKEN_CLASSES matches the four-class API contract, in display order', () => {
  assert.deepEqual(TOKEN_CLASSES.map((c) => c.key), [
    'input', 'output', 'cacheCreationInput', 'cacheReadInput',
  ]);
});

test('GROUP_OPTIONS covers every groupBy the summary endpoint supports', () => {
  assert.deepEqual(GROUP_OPTIONS.map((g) => g.key).sort(), [
    'agent', 'day', 'model', 'provider', 'team',
  ]);
});

test('formatInt separates thousands and coerces junk to 0', () => {
  assert.equal(formatInt(29736), '29,736');
  assert.equal(formatInt(0), '0');
  assert.equal(formatInt(undefined), '0');
  assert.equal(formatInt(NaN), '0');
});

test('formatCompact abbreviates with k/M/B, one decimal only when it adds info', () => {
  assert.equal(formatCompact(156_000_000), '156M');
  assert.equal(formatCompact(9_300_000), '9.3M');
  assert.equal(formatCompact(500_000), '500k');
  assert.equal(formatCompact(1_500), '1.5k');
  assert.equal(formatCompact(1_000), '1k');
  assert.equal(formatCompact(2_500_000_000), '2.5B');
  // Under 1,000 → plain integer; junk → 0.
  assert.equal(formatCompact(999), '999');
  assert.equal(formatCompact(0), '0');
  assert.equal(formatCompact(undefined), '0');
  assert.equal(formatCompact(NaN), '0');
});

test('niceScale picks a round top ≥ max with ~3–5 evenly spaced ticks from 0', () => {
  for (const max of [800, 28936, 156_000_000, 7, 250000, 9_300_000]) {
    const { top, ticks } = niceScale(max);
    assert.ok(top >= max, `top ${top} must be ≥ max ${max} (a bar can never overflow)`);
    assert.equal(ticks[0], 0, 'axis starts at 0');
    assert.equal(ticks[ticks.length - 1], top, 'axis ends at the top tick');
    assert.ok(ticks.length >= 3 && ticks.length <= 6, `tick count ${ticks.length} in range`);
    // Evenly spaced.
    const step = ticks[1] - ticks[0];
    for (let i = 1; i < ticks.length; i++) {
      assert.equal(ticks[i] - ticks[i - 1], step, 'ticks evenly spaced');
    }
  }
});

test('niceScale produces recognisable round scales for known ranges', () => {
  assert.deepEqual(niceScale(28936), { top: 30000, ticks: [0, 10000, 20000, 30000] });
  assert.deepEqual(niceScale(800), { top: 800, ticks: [0, 200, 400, 600, 800] });
  assert.deepEqual(niceScale(156_000_000), {
    top: 200_000_000, ticks: [0, 50_000_000, 100_000_000, 150_000_000, 200_000_000],
  });
});

test('niceScale renders a flat 0-baseline axis for zero/near-zero/junk (no divide-by-zero)', () => {
  assert.deepEqual(niceScale(0), { top: 0, ticks: [0] });
  assert.deepEqual(niceScale(-5), { top: 0, ticks: [0] });
  assert.deepEqual(niceScale(NaN), { top: 0, ticks: [0] });
  assert.deepEqual(niceScale(undefined), { top: 0, ticks: [0] });
});

test('buildDaySeries orders points by day ascending and finds the max total', () => {
  const summary = {
    groups: [
      { key: '2026-07-16', tokens: { total: 28936 }, invocations: 2 },
      { key: '2026-07-15', tokens: { total: 800 }, invocations: 1 },
    ],
  };
  const { points, maxTotal } = buildDaySeries(summary);
  assert.deepEqual(points.map((p) => p.day), ['2026-07-15', '2026-07-16']);
  assert.equal(maxTotal, 28936);
});

test('buildDaySeries tolerates missing/empty groups', () => {
  assert.deepEqual(buildDaySeries(null), { points: [], maxTotal: 0 });
  assert.deepEqual(buildDaySeries({ groups: [] }), { points: [], maxTotal: 0 });
});

test('stackSegments scales each nonzero class to a percent of maxTotal', () => {
  const tokens = { input: 10, output: 0, cacheCreationInput: 40, cacheReadInput: 50, total: 100 };
  const segs = stackSegments(tokens, 100);
  // output (0) is dropped; the rest are kept in display order.
  assert.deepEqual(segs.map((s) => s.key), ['input', 'cacheCreationInput', 'cacheReadInput']);
  assert.deepEqual(segs.map((s) => s.heightPct), [10, 40, 50]);
});

test('stackSegments returns nothing when maxTotal is 0 (no divide-by-zero)', () => {
  assert.deepEqual(stackSegments({ input: 5 }, 0), []);
});

test('buildExportUrl builds a scoped, windowed download URL per view and format', () => {
  assert.equal(
    buildExportUrl('summary', { since: '2026-07-16T00:00:00Z', format: 'csv' }),
    '/api/usage/summary/export?since=2026-07-16T00%3A00%3A00Z&format=csv',
  );
  assert.equal(
    buildExportUrl('work-items', { format: 'json' }),
    '/api/usage/work-items/export?format=json',
  );
  // Unknown/absent format defaults to csv; absent since is simply omitted.
  assert.equal(buildExportUrl('summary', {}), '/api/usage/summary/export?format=csv');
  assert.equal(buildExportUrl('summary', { format: 'xml' }), '/api/usage/summary/export?format=csv');
});
