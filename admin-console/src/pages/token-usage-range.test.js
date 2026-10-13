import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RANGE_PRESETS, BUCKET_OPTIONS, rangeBounds, rangeQuery, rangeQueryString, customRangeError, parseDateInput,
  autoBucket, hourBucketAllowed, resolveBucket, bucketDisplay, sourceGranularity, parseTimeKey, bucketStart,
  nextBucketStart, bucketKey, earliestKeyStart, rebucketClassPoints, rebucketGroupPoints, bucketRangeText,
  axisLabels, barLayout, bucketUnit,
} from './token-usage-range.js';
import {
  buildDaySeries, buildGroupDaySeries, chartSummaryUrl, chartDimension, chartGranularity, chartTitle,
  buildExportUrl, groupStack, CHART_SERIES_LIMIT, OTHER_SERIES_KEY,
} from './token-usage-view.js';

const require = (await import('node:module')).createRequire(import.meta.url);
const { summarize } = require('../../api/usage-summary.js');

// #2974 — Token Usage: flexible time ranges and hour/day/week/month buckets.

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const T = (s) => Date.parse(s);
const DAY = 24 * 60 * 60 * 1000;
// Wednesday 2026-10-14 15:42:10 UTC
const NOW = T('2026-10-14T15:42:10.000Z');

// ── AC1: every preset and its UTC window ───────────────────────────────────

test('AC1: the preset list is exactly the one the issue names, plus Custom', () => {
  assert.deepEqual(RANGE_PRESETS.map((r) => r.label), [
    'Last 24 hours', 'Today', 'Yesterday', 'Last 7 days', 'This week', 'Last 30 days',
    'This month', 'Last month', 'Last 90 days', 'All time', 'Custom range…',
  ]);
});

test('AC1: each preset produces the expected UTC window', () => {
  const win = (key) => {
    const b = rangeBounds({ key }, NOW);
    return [iso(b.start), iso(b.end)];
  };
  assert.deepEqual(win('24h'), ['2026-10-13T15:42:10.000Z', '2026-10-14T15:42:10.000Z']);
  assert.deepEqual(win('today'), ['2026-10-14T00:00:00.000Z', '2026-10-14T15:42:10.000Z']);
  assert.deepEqual(win('yesterday'), ['2026-10-13T00:00:00.000Z', '2026-10-14T00:00:00.000Z']);
  assert.deepEqual(win('7d'), ['2026-10-07T15:42:10.000Z', '2026-10-14T15:42:10.000Z']);
  // This week starts on Monday 00:00 UTC.
  assert.deepEqual(win('thisWeek'), ['2026-10-12T00:00:00.000Z', '2026-10-14T15:42:10.000Z']);
  assert.deepEqual(win('30d'), ['2026-09-14T15:42:10.000Z', '2026-10-14T15:42:10.000Z']);
  assert.deepEqual(win('thisMonth'), ['2026-10-01T00:00:00.000Z', '2026-10-14T15:42:10.000Z']);
  // Last month covers the full previous calendar month.
  assert.deepEqual(win('lastMonth'), ['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
  assert.deepEqual(win('90d'), ['2026-07-16T15:42:10.000Z', '2026-10-14T15:42:10.000Z']);
  assert.deepEqual(win('all'), [null, '2026-10-14T15:42:10.000Z']);
});

test('AC1: This week on a Sunday and on a Monday still starts on that Monday', () => {
  assert.equal(iso(rangeBounds({ key: 'thisWeek' }, T('2026-10-18T23:59:00Z')).start), '2026-10-12T00:00:00.000Z');
  assert.equal(iso(rangeBounds({ key: 'thisWeek' }, T('2026-10-12T00:00:01Z')).start), '2026-10-12T00:00:00.000Z');
});

test('AC1: Last month crosses a year boundary', () => {
  const b = rangeBounds({ key: 'lastMonth' }, T('2026-01-10T08:00:00Z'));
  assert.deepEqual([iso(b.start), iso(b.end)], ['2025-12-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
});

test('AC1: open-ended presets send no `until`; closed ones send the boundary', () => {
  assert.deepEqual(rangeQuery({ key: 'today' }, NOW), { since: '2026-10-14T00:00:00.000Z', until: null });
  assert.deepEqual(rangeQuery({ key: 'all' }, NOW), { since: null, until: null });
  assert.deepEqual(rangeQuery({ key: 'yesterday' }, NOW), { since: '2026-10-13T00:00:00.000Z', until: '2026-10-14T00:00:00.000Z' });
  assert.deepEqual(rangeQuery({ key: 'lastMonth' }, NOW), { since: '2026-09-01T00:00:00.000Z', until: '2026-10-01T00:00:00.000Z' });
  assert.equal(rangeQueryString({ since: null, until: null }), '');
  assert.equal(
    rangeQueryString(rangeQuery({ key: 'yesterday' }, NOW)),
    'since=2026-10-13T00%3A00%3A00.000Z&until=2026-10-14T00%3A00%3A00.000Z&',
  );
});

// ── AC2 / AC3: custom range ────────────────────────────────────────────────

test('AC2: a custom D1..D2 range is [D1 00:00 UTC, D2+1 00:00 UTC)', () => {
  const r = { key: 'custom', from: '2026-09-28', to: '2026-10-02' };
  assert.deepEqual(rangeQuery(r, NOW), { since: '2026-09-28T00:00:00.000Z', until: '2026-10-03T00:00:00.000Z' });
  // a single day
  assert.deepEqual(rangeQuery({ key: 'custom', from: '2026-10-01', to: '2026-10-01' }, NOW),
    { since: '2026-10-01T00:00:00.000Z', until: '2026-10-02T00:00:00.000Z' });
});

test('AC2: the custom window includes D1 00:00 and D2 23:59:59, excludes D2+1 00:00 (real summarize)', () => {
  const rec = (ts) => ({ ts, agentId: 'a', tokens: { input: 1, output: 0, cacheCreationInput: 0, cacheReadInput: 0 } });
  const records = ['2026-09-27T23:59:59.999Z', '2026-09-28T00:00:00.000Z', '2026-10-02T23:59:59.999Z', '2026-10-03T00:00:00.000Z'].map(rec);
  const q = rangeQuery({ key: 'custom', from: '2026-09-28', to: '2026-10-02' }, NOW);
  assert.equal(summarize(records, { ...q, groupBy: 'agent' }).totals.invocations, 2);
});

test('AC3: an end date before the start date cannot be applied, and says why', () => {
  assert.equal(customRangeError('2026-10-05', '2026-10-01'), 'The end date is before the start date.');
  assert.equal(customRangeError('2026-10-01', '2026-10-01'), null);
  assert.match(customRangeError('', '2026-10-01'), /both/);
  assert.match(customRangeError('2026-02-31', '2026-03-01'), /YYYY-MM-DD/);
  assert.equal(parseDateInput('2026-02-31'), null);
  // An invalid custom range never reaches the API as a bogus window.
  assert.equal(rangeQuery({ key: 'custom', from: '2026-10-05', to: '2026-10-01' }, NOW).until, null);
});

// ── AC4: Auto bucket thresholds + display ──────────────────────────────────

test('AC4: Auto picks Hour ≤ 2 days, Day ≤ 60 days, Week ≤ 365 days, Month above', () => {
  assert.equal(autoBucket(2 * DAY), 'hour');
  assert.equal(autoBucket(2 * DAY + 1), 'day');
  assert.equal(autoBucket(60 * DAY), 'day');
  assert.equal(autoBucket(60 * DAY + 1), 'week');
  assert.equal(autoBucket(365 * DAY), 'week');
  assert.equal(autoBucket(365 * DAY + 1), 'month');
  const span = (key) => { const b = rangeBounds({ key }, NOW); return b.end - b.start; };
  assert.equal(autoBucket(span('24h')), 'hour');
  assert.equal(autoBucket(span('yesterday')), 'hour');
  assert.equal(autoBucket(span('7d')), 'day');
  assert.equal(autoBucket(span('90d')), 'week');
});

test('AC4: the chosen bucket is visible, e.g. "Auto (Week)"', () => {
  assert.equal(bucketDisplay('auto', 'week'), 'Auto (Week)');
  assert.equal(bucketDisplay('auto', 'hour'), 'Auto (Hour)');
  assert.equal(bucketDisplay('month', 'month'), 'Month');
  assert.deepEqual(BUCKET_OPTIONS.map((o) => o.key), ['auto', 'hour', 'day', 'week', 'month']);
  assert.equal(resolveBucket('auto', 90 * DAY), 'week');
  assert.equal(resolveBucket('day', 400 * DAY), 'day');
  assert.equal(resolveBucket('auto', null), 'day');
});

test('Hour is offered only for spans of 7 days or less; a too-long manual Hour falls back to Auto', () => {
  assert.equal(hourBucketAllowed(7 * DAY), true);
  assert.equal(hourBucketAllowed(7 * DAY + 1), false);
  assert.equal(hourBucketAllowed(null), false);
  assert.equal(resolveBucket('hour', 7 * DAY), 'hour');
  assert.equal(resolveBucket('hour', 30 * DAY), 'day');
  // A 7-day custom range (both ends inclusive) still allows Hour, 8 days does not.
  const span = (from, to) => { const b = rangeBounds({ key: 'custom', from, to }, NOW); return b.end - b.start; };
  assert.equal(hourBucketAllowed(span('2026-10-01', '2026-10-07')), true);
  assert.equal(hourBucketAllowed(span('2026-10-01', '2026-10-08')), false);
});

test('edge: All time with Auto derives the bucket from the earliest record', () => {
  const pts = [{ day: '2026-10-13' }, { day: 'unknown' }, { day: '2026-10-14' }];
  const start = earliestKeyStart(pts);
  assert.equal(iso(start), '2026-10-13T00:00:00.000Z');
  assert.equal(resolveBucket('auto', NOW - start), 'hour');
  assert.equal(resolveBucket('auto', NOW - earliestKeyStart([{ day: '2025-01-01' }])), 'month');
  assert.equal(earliestKeyStart([]), null);
});

// ── Buckets ────────────────────────────────────────────────────────────────

test('bucket arithmetic is UTC and week buckets start on Monday', () => {
  const ms = T('2026-10-14T15:42:10Z');
  assert.equal(iso(bucketStart(ms, 'hour')), '2026-10-14T15:00:00.000Z');
  assert.equal(iso(bucketStart(ms, 'day')), '2026-10-14T00:00:00.000Z');
  assert.equal(iso(bucketStart(ms, 'week')), '2026-10-12T00:00:00.000Z');
  assert.equal(iso(bucketStart(ms, 'month')), '2026-10-01T00:00:00.000Z');
  assert.equal(iso(nextBucketStart(T('2026-12-01T00:00:00Z'), 'month')), '2027-01-01T00:00:00.000Z');
  assert.equal(bucketKey(T('2026-10-14T15:00:00Z'), 'hour'), '2026-10-14T15');
  assert.equal(bucketKey(T('2026-10-01T00:00:00Z'), 'month'), '2026-10');
  assert.equal(sourceGranularity('hour'), 'hour');
  for (const b of ['day', 'week', 'month']) assert.equal(sourceGranularity(b), 'day');
});

test('edge: missing / invalid time keys make no bucket', () => {
  assert.equal(parseTimeKey('unknown'), null);
  assert.equal(parseTimeKey(undefined), null);
  assert.equal(parseTimeKey('2026-10-14T25'), null);
  assert.equal(parseTimeKey('garbage'), null);
  assert.equal(iso(parseTimeKey('2026-10-14T09')), '2026-10-14T09:00:00.000Z');
  const pts = rebucketClassPoints(
    [{ day: 'unknown', tokens: { total: 5, input: 5 }, invocations: 1 }],
    { bucket: 'day', start: null, end: null },
  );
  assert.deepEqual(pts, []);
});

// ── AC5 / AC6: one bar per bucket, empty buckets at zero, sums reconcile ───

const REC = (ts, agentId, model, input) => ({
  ts, agentId, teamId: 't',
  tokens: { input, output: 1, cacheCreationInput: 0, cacheReadInput: 2 },
  modelUsage: { [model]: { input } },
});
// Usage on Tue, Wed and Fri of one week (Thursday empty), plus one record the
// week before, in a few hours of each day.
const RECORDS = [
  REC('2026-10-06T23:30:00.000Z', 'dev', 'opus', 3),
  REC('2026-10-13T08:05:00.000Z', 'dev', 'opus', 100),
  REC('2026-10-13T08:55:00.000Z', 'rev', 'sonnet', 40),
  REC('2026-10-14T10:00:00.000Z', 'dev', 'sonnet', 7),
  REC('2026-10-16T22:59:59.999Z', 'qa', 'haiku', 11),
];

// What the page computes for one bucket: request the chart at the bucket's
// source granularity through the real aggregator and rebucket the points.
function classBars(records, bucket, window) {
  const gran = sourceGranularity(bucket);
  const s = summarize(records, { since: iso(window.start), until: iso(window.end), groupBy: gran });
  return { totals: summarize(records, { since: iso(window.start), until: iso(window.end), groupBy: 'agent' }).totals,
    bars: rebucketClassPoints(buildDaySeries(s).points, { bucket, ...window }) };
}

test('AC5: one bar per bucket inside the range; buckets without usage are zero-height, not dropped', () => {
  const window = { start: T('2026-10-13T00:00:00Z'), end: T('2026-10-17T00:00:00Z') }; // Tue..Fri
  const { bars } = classBars(RECORDS, 'day', window);
  assert.deepEqual(bars.map((b) => b.key), ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  assert.equal(bars[2].tokens.total, 0); // Thursday: empty, still a bar

  const hours = classBars(RECORDS, 'hour', { start: T('2026-10-13T00:00:00Z'), end: T('2026-10-14T00:00:00Z') }).bars;
  assert.equal(hours.length, 24);
  assert.equal(hours[8].key, '2026-10-13T08');
  assert.equal(hours[8].tokens.total, 103 + 43);
  assert.equal(hours.filter((b) => b.tokens.total === 0).length, 23);

  const weeks = classBars(RECORDS, 'week', { start: T('2026-10-01T00:00:00Z'), end: T('2026-10-31T00:00:00Z') }).bars;
  assert.deepEqual(weeks.map((b) => b.key), ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
  const months = classBars(RECORDS, 'month', { start: T('2026-08-15T00:00:00Z'), end: T('2026-10-20T00:00:00Z') }).bars;
  assert.deepEqual(months.map((b) => b.key), ['2026-08', '2026-09', '2026-10']);
});

test('AC6: for every bucket size the bars add up to the Total tokens tile (real summarize)', () => {
  const windows = [
    { start: T('2026-10-13T00:00:00Z'), end: T('2026-10-17T00:00:00Z') },
    { start: T('2026-10-01T00:00:00Z'), end: NOW },
    { start: T('2026-10-13T08:30:00Z'), end: T('2026-10-16T12:00:00Z') }, // partial first/last buckets
  ];
  for (const window of windows) {
    for (const bucket of ['hour', 'day', 'week', 'month']) {
      const { totals, bars } = classBars(RECORDS, bucket, window);
      const sum = bars.reduce((s, b) => s + b.tokens.total, 0);
      assert.equal(sum, totals.total, `${bucket} over ${iso(window.start)}`);
      assert.equal(bars.reduce((s, b) => s + b.invocations, 0), totals.invocations);
    }
  }
});

test('AC6: a record outside the drawn window (after the page loaded) still gets a bar, so sums hold', () => {
  const window = { start: T('2026-10-13T00:00:00Z'), end: T('2026-10-14T00:00:00Z') };
  const s = summarize(RECORDS, { since: iso(window.start), groupBy: 'day' }); // open-ended
  const bars = rebucketClassPoints(buildDaySeries(s).points, { bucket: 'day', ...window });
  assert.equal(bars.reduce((sum, b) => sum + b.tokens.total, 0), s.totals.total);
});

// ── AC9: Phase 1 (Group by, top N + Other) with every bucket size ──────────

test('AC9: the group chart (top N + Other) works with every bucket size and still reconciles', () => {
  const many = [];
  for (let i = 0; i < CHART_SERIES_LIMIT + 3; i += 1) {
    many.push(REC(`2026-10-${String(10 + (i % 5)).padStart(2, '0')}T0${i % 10}:00:00.000Z`, `agent-${i}`, 'opus', 10 + i));
  }
  const window = { start: T('2026-10-09T00:00:00Z'), end: T('2026-10-16T00:00:00Z') };
  const since = iso(window.start);
  const until = iso(window.end);
  for (const bucket of ['hour', 'day', 'week', 'month']) {
    for (const groupBy of ['agent', 'model']) {
      const gran = sourceGranularity(bucket);
      const s = summarize(many, { since, until, groupBy, secondaryGroupBy: gran });
      assert.equal(chartDimension(s), groupBy);
      assert.equal(chartGranularity(s), gran);
      const { series, points } = buildGroupDaySeries(s);
      const bars = rebucketGroupPoints(points, { bucket, ...window });
      const sum = bars.reduce((acc, b) => acc + groupStack(b, series, []).total, 0);
      assert.equal(sum, s.totals.total, `${groupBy} × ${bucket}`);
      if (groupBy === 'agent') assert.equal(series[series.length - 1].key, OTHER_SERIES_KEY);
      // Hiding a series removes exactly its share (AC6 "apart from hidden series").
      const hidden = [series[0].key];
      const visible = bars.reduce((acc, b) => acc + groupStack(b, series, hidden).total, 0);
      assert.equal(visible, s.totals.total - series[0].total);
    }
  }
});

test('the chart request asks for hour or day keys per bucket, for both chart kinds', () => {
  assert.equal(chartSummaryUrl({ groupBy: 'day', granularity: 'hour' }), '/api/usage/summary?groupBy=hour');
  assert.equal(chartSummaryUrl({ groupBy: 'model', granularity: 'hour' }), '/api/usage/summary?groupBy=model&secondaryGroupBy=hour');
  assert.equal(
    chartSummaryUrl({ since: '2026-09-01T00:00:00.000Z', until: '2026-10-01T00:00:00.000Z', groupBy: 'agent' }),
    '/api/usage/summary?since=2026-09-01T00%3A00%3A00.000Z&until=2026-10-01T00%3A00%3A00.000Z&groupBy=agent&secondaryGroupBy=day',
  );
  assert.equal(chartDimension({ groupBy: 'hour' }), 'day');
  assert.equal(chartGranularity({ groupBy: 'hour' }), 'hour');
  assert.equal(chartGranularity({ groupBy: 'agent', secondaryGroupBy: 'day' }), 'day');
  assert.equal(chartGranularity(null), 'day');
  assert.equal(chartTitle('model', bucketUnit('week')), 'Tokens per week by Model');
  assert.equal(chartTitle('day', bucketUnit('hour')), 'Tokens per hour');
});

// ── AC7: axis labels ───────────────────────────────────────────────────────

test('AC7: axis labels per bucket size, with the date at hour-label day changes', () => {
  const at = (s, bucket) => ({ start: T(s), end: nextBucketStart(T(s), bucket) });
  assert.deepEqual(axisLabels([at('2026-10-13T00:00:00Z', 'day')], 'day'), ['10-13']);
  assert.deepEqual(axisLabels([at('2026-10-12T00:00:00Z', 'week')], 'week'), ['week of 10-12']);
  assert.deepEqual(axisLabels([at('2026-10-01T00:00:00Z', 'month')], 'month'), ['2026-10']);
  const hours = [];
  for (let s = T('2026-10-13T22:00:00Z'); s < T('2026-10-14T02:00:00Z'); s = nextBucketStart(s, 'hour')) hours.push({ start: s });
  assert.deepEqual(axisLabels(hours, 'hour'), ['10-13 22:00', '23:00', '10-14 00:00', '01:00']);
});

test('AC7: #699 thinning still caps labels at ~12 (always the first) for every bucket size', () => {
  for (const [bucket, n] of [['hour', 168], ['day', 90], ['week', 52], ['month', 36]]) {
    const pts = [];
    let s = T('2024-01-01T00:00:00Z');
    for (let i = 0; i < n; i += 1, s = nextBucketStart(s, bucket)) pts.push({ start: s });
    const labels = axisLabels(pts, bucket);
    assert.equal(labels.length, n);
    assert.notEqual(labels[0], null);
    assert.ok(labels.filter((l) => l != null).length <= 12, `${bucket}: ${labels.filter(Boolean).length}`);
  }
  // 168 hourly bars still fit (narrow gap), a short series keeps the old spacing.
  assert.deepEqual(barLayout(169), { gap: 1, minWidth: 1 });
  assert.deepEqual(barLayout(7), { gap: 'var(--eb-space-2)', minWidth: 8 });
});

test('edge: a partial first/last bucket is one bar whose tooltip names the dates it covers', () => {
  const window = rangeBounds({ key: 'thisWeek' }, NOW); // Mon..Wed 15:42
  const bars = rebucketClassPoints([{ day: '2026-10-13', tokens: { total: 1, input: 1 }, invocations: 1 }], { bucket: 'week', ...window });
  assert.equal(bars.length, 1);
  assert.equal(bucketRangeText(bars[0], 'week', window.start, window.end), '2026-10-12 – 2026-10-14 (UTC)');
  const day = { start: T('2026-10-13T00:00:00Z'), end: T('2026-10-14T00:00:00Z') };
  assert.equal(bucketRangeText(day, 'day', null, null), '2026-10-13 (UTC)');
  assert.equal(bucketRangeText({ start: T('2026-10-13T23:00:00Z') }, 'hour'), '2026-10-13 23:00–00:00 UTC');
  const lastMonth = rangeBounds({ key: 'lastMonth' }, NOW);
  assert.equal(bucketRangeText({ start: lastMonth.start, end: lastMonth.end }, 'month', lastMonth.start, lastMonth.end),
    '2026-09-01 – 2026-09-30 (UTC)');
});

// ── AC8: export uses the on-screen window ──────────────────────────────────

test('AC8: the export URL carries the same since/until as the screen', () => {
  const q = rangeQuery({ key: 'lastMonth' }, NOW);
  assert.equal(
    buildExportUrl('summary', { ...q, format: 'csv', groupBy: 'agent' }),
    '/api/usage/summary/export?since=2026-09-01T00%3A00%3A00.000Z&until=2026-10-01T00%3A00%3A00.000Z&groupBy=agent&format=csv',
  );
  assert.equal(buildExportUrl('work-items', { since: null, until: null, format: 'json' }), '/api/usage/work-items/export?format=json');
});

// ── Source-reading wiring guard (#651) ─────────────────────────────────────

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'TokenUsage.jsx'), 'utf8');

test('all three tabs use the shared RangeControl and send since/until to every request and export', () => {
  assert.equal((SRC.match(/<RangeControl value=\{range\} onChange=\{setRange\} \/>/g) || []).length, 3);
  assert.equal((SRC.match(/= useRangeWindow\(range\);/g) || []).length, 3);
  assert.doesNotMatch(SRC, /rangeKey/);
  assert.match(SRC, /\/api\/usage\/summary\?\$\{rangeQ\}/);
  assert.match(SRC, /\/api\/usage\/work-items\?\$\{rangeQ\}/);
  assert.match(SRC, /\/api\/usage\/agent-models\?\$\{rangeQ\}/);
  assert.match(SRC, /\/\$\{addr\}\?\$\{rangeQ\}/);
  assert.equal((SRC.match(/<ExportButtons kind="[^"]+" since=\{since\} until=\{until\}/g) || []).length, 2);
  assert.match(SRC, /buildExportUrl\(kind, \{ since, until, format/);
});

test('AC10: the custom date fields are labelled inputs and the error is announced', () => {
  assert.match(SRC, /<label style=\{labelStyle\}>\s*From\s*<input type="date"/);
  assert.match(SRC, /<label style=\{labelStyle\}>\s*To\s*<input type="date"/);
  assert.match(SRC, /<form onSubmit=\{apply\}/);
  assert.match(SRC, /<button type="submit" disabled=\{!!invalid\}/);
  assert.match(SRC, /role="alert"/);
  assert.match(SRC, /aria-describedby=\{invalid \? errorId : undefined\}/);
});

test('the chart bars follow the resolved bucket and window', () => {
  assert.match(SRC, /rebucketClassPoints\(raw, \{ bucket, start, end \}\)/);
  assert.match(SRC, /rebucketGroupPoints\(raw, \{ bucket, start, end \}\)/);
  assert.match(SRC, /const bucket = resolveBucket\(bucketChoice, span\);/);
  assert.match(SRC, /disabled=\{o\.key === 'hour' && !hourBucketAllowed\(span\)\}/);
  assert.match(SRC, /bucketDisplay\('auto'/);
  assert.match(SRC, /Time \(UTC\)/);
});
