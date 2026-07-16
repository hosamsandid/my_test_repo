import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOKEN_CLASSES,
  GROUP_OPTIONS,
  formatInt,
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
