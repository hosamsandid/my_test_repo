import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHART_SERIES_LIMIT, OTHER_SERIES_KEY, SERIES_COLORS, OTHER_SERIES_COLOR,
  chartDimension, chartSummaryUrl, buildGroupDaySeries, seriesLabel, chartTitle,
  hiddenSeriesFor, toggleHiddenSeries, groupStack, groupVisibleMax, GROUP_OPTIONS,
} from './token-usage-view.js';
import { themeTokens, resolveToken, contrastRatio, THEMES } from '../theme/theme-tokens.js';

const require = (await import('node:module')).createRequire(import.meta.url);
const { summarize } = require('../../api/usage-summary.js');

// #2973: the "Tokens per day" chart follows the selected Group-by dimension.

const rec = (ts, agentId, total, extra = {}) => ({
  ts, agentId, teamId: 't', tokens: { input: total, output: 0, cacheCreationInput: 0, cacheReadInput: 0 }, ...extra,
});

test('chartSummaryUrl asks for the primary dimension split by day, never the secondary (AC8/AC11)', () => {
  assert.equal(chartSummaryUrl({ groupBy: 'model' }), '/api/usage/summary?groupBy=model&secondaryGroupBy=day');
  assert.equal(
    chartSummaryUrl({ since: '2026-10-01T00:00:00.000Z', team: 'a b', groupBy: 'agent', secondaryGroupBy: 'model' }),
    '/api/usage/summary?since=2026-10-01T00%3A00%3A00.000Z&team=a+b&groupBy=agent&secondaryGroupBy=day',
  );
});

test('chartSummaryUrl keeps the token-class day request for Group by = Day (AC3)', () => {
  assert.equal(chartSummaryUrl({ groupBy: 'day' }), '/api/usage/summary?groupBy=day');
  assert.equal(chartSummaryUrl({ groupBy: 'bogus' }), '/api/usage/summary?groupBy=day');
});

test('every non-day Group-by option yields a group chart; day stays the class chart (AC1/AC2/AC3)', () => {
  for (const { key } of GROUP_OPTIONS) {
    const s = summarize([rec('2026-10-01T10:00:00Z', 'a', 5)], { groupBy: key, secondaryGroupBy: key === 'day' ? undefined : 'day' });
    assert.equal(chartDimension(s), key);
  }
  assert.equal(chartDimension(null), 'day');
});

test('chartTitle names the dimension', () => {
  assert.equal(chartTitle('model'), 'Tokens per day by Model');
  assert.equal(chartTitle('providerTier'), 'Tokens per day by Provider tier');
  assert.equal(chartTitle('day'), 'Tokens per day');
});

test('each day stacks one segment per group value and sums to that day (AC1/AC4)', () => {
  const records = [
    rec('2026-10-01T10:00:00Z', 'a', 10),
    rec('2026-10-01T11:00:00Z', 'b', 5),
    rec('2026-10-02T10:00:00Z', 'a', 7),
  ];
  const { series, points } = buildGroupDaySeries(summarize(records, { groupBy: 'agent', secondaryGroupBy: 'day' }));
  assert.deepEqual(series.map((s) => s.key), ['a', 'b']);
  assert.deepEqual(points.map((p) => p.day), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(points[0].values, { a: 10, b: 5 });
  // A value present on only some days has no segment elsewhere (edge case)…
  assert.deepEqual(points[1].values, { a: 7 });
  // …and keeps one colour across the chart.
  assert.equal(series[0].color, SERIES_COLORS[0]);
  // Per-day stack == that day's total in a groupBy=day summary over the same records.
  const byDay = summarize(records, { groupBy: 'day' }).groups;
  for (const p of points) {
    assert.equal(groupStack(p, series, []).total, byDay.find((g) => g.key === p.day).tokens.total);
  }
});

test('Group by = Model splits a multi-model turn across segments and still reconciles (#2972 edge)', () => {
  const records = [rec('2026-10-01T10:00:00Z', 'a', 100, {
    modelUsage: { 'm-big': { inputTokens: 0, input: 3 }, 'm-small': { input: 1 } },
  })];
  const { series, points } = buildGroupDaySeries(summarize(records, { groupBy: 'model', secondaryGroupBy: 'day' }));
  assert.deepEqual(points[0].values, { 'm-big': 75, 'm-small': 25 });
  assert.equal(groupStack(points[0], series, []).total, 100);
});

test('more than N values → exactly N named series plus one "Other" holding the rest (AC5)', () => {
  const records = [];
  for (let i = 0; i < CHART_SERIES_LIMIT + 3; i++) {
    records.push(rec('2026-10-01T10:00:00Z', `agent-${String(i).padStart(2, '0')}`, 1000 - i * 10));
    records.push(rec('2026-10-02T10:00:00Z', `agent-${String(i).padStart(2, '0')}`, 1));
  }
  const summary = summarize(records, { groupBy: 'agent', secondaryGroupBy: 'day' });
  const { series, points } = buildGroupDaySeries(summary);
  assert.equal(series.length, CHART_SERIES_LIMIT + 1);
  const other = series[series.length - 1];
  assert.equal(other.key, OTHER_SERIES_KEY);
  assert.equal(other.color, OTHER_SERIES_COLOR);
  assert.deepEqual(other.members, summary.groups.slice(CHART_SERIES_LIMIT).map((g) => g.key));
  const rest = summary.groups.slice(CHART_SERIES_LIMIT).reduce((s, g) => s + g.tokens.total, 0);
  assert.equal(other.total, rest);
  // Named series are the largest values, in the table's order.
  assert.deepEqual(series.slice(0, -1).map((s) => s.key), summary.groups.slice(0, CHART_SERIES_LIMIT).map((g) => g.key));
  // Stacks still add up to the grand total, Other included (AC4).
  assert.equal(points.reduce((s, p) => s + groupStack(p, series, []).total, 0), summary.totals.total);
});

test('exactly N values → no "Other" series', () => {
  const records = Array.from({ length: CHART_SERIES_LIMIT }, (_, i) => rec('2026-10-01T10:00:00Z', `a${i}`, 10 + i));
  const { series } = buildGroupDaySeries(summarize(records, { groupBy: 'agent', secondaryGroupBy: 'day' }));
  assert.equal(series.length, CHART_SERIES_LIMIT);
  assert.ok(!series.some((s) => s.key === OTHER_SERIES_KEY));
});

test('no usage → no points, so the empty state shows (AC9)', () => {
  const { series, points } = buildGroupDaySeries(summarize([], { groupBy: 'model', secondaryGroupBy: 'day' }));
  assert.deepEqual(series, []);
  assert.deepEqual(points, []);
  assert.deepEqual(buildGroupDaySeries(null), { series: [], points: [] });
});

test('legend labels match the table labels for User and Provider tier (AC6)', () => {
  const names = new Map([['u-1', 'Ada Lovelace']]);
  assert.equal(seriesLabel('user', { key: 'u-1', members: ['u-1'] }, names).label, 'Ada Lovelace');
  assert.equal(seriesLabel('user', { key: 'unknown', members: ['unknown'] }, names).label, 'Unattributed');
  assert.equal(seriesLabel('user', { key: 'u-gone', members: ['u-gone'] }, names).label, 'Deleted user');
  assert.equal(seriesLabel('providerTier', { key: 'global', members: ['global'] }).label, 'Global');
  assert.equal(seriesLabel('providerTier', { key: 'unknown', members: ['unknown'] }).label, 'Unknown');
  assert.equal(seriesLabel('model', { key: 'unknown', members: ['unknown'] }).label, 'unknown');
  const other = seriesLabel('agent', { key: OTHER_SERIES_KEY, members: ['x', 'y'] });
  assert.equal(other.label, 'Other');
  assert.match(other.hint, /2 more values/);
});

test('hiding a series removes it from every stack and rescales the axis (AC7)', () => {
  const series = [{ key: 'a' }, { key: 'b' }];
  const points = [{ day: 'd1', values: { a: 100, b: 5 } }, { day: 'd2', values: { b: 8 } }];
  assert.equal(groupVisibleMax(points, series, []), 105);
  assert.equal(groupVisibleMax(points, series, ['a']), 8);
  assert.deepEqual(groupStack(points[0], series, ['a']).segments.map((s) => s.key), ['b']);
  assert.equal(groupVisibleMax(points, series, ['a', 'b']), 0);
});

test('hidden series are kept per dimension and toggle immutably (AC7)', () => {
  let h = {};
  h = toggleHiddenSeries(h, 'model', 'm1');
  h = toggleHiddenSeries(h, 'agent', 'm1');
  assert.deepEqual(hiddenSeriesFor(h, 'model'), ['m1']);
  assert.deepEqual(hiddenSeriesFor(h, 'agent'), ['m1']);
  const before = h;
  h = toggleHiddenSeries(h, 'model', 'm1');
  assert.deepEqual(hiddenSeriesFor(h, 'model'), []);
  assert.deepEqual(hiddenSeriesFor(before, 'model'), ['m1']);
  assert.deepEqual(hiddenSeriesFor(undefined, 'team'), []);
});

// AC10: every series colour is a theme token, clears 3:1 against the chart
// surface (WCAG 1.4.11 non-text contrast) and differs from its neighbours.
const TOKENS = themeTokens(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'theme', 'tokens.css'), 'utf8'));
const tokenOf = (v) => /^var\((--[\w-]+)\)$/.exec(v)[1];

test('series colours reach 3:1 on the chart surface in every theme and are pairwise distinct (AC10)', () => {
  for (const theme of THEMES) {
    const vars = TOKENS[theme];
    const surface = resolveToken(vars, '--eb-bg-elevated');
    const resolved = [...SERIES_COLORS, OTHER_SERIES_COLOR].map((c) => resolveToken(vars, tokenOf(c)));
    for (const c of resolved) {
      const r = contrastRatio(c, surface);
      assert.ok(r >= 3, `${theme}: ${c} on ${surface} is ${r.toFixed(2)}:1`);
    }
    assert.equal(new Set(resolved).size, resolved.length, `${theme}: duplicate series colour`);
  }
});

// Source-reading wiring guard (#651): the page draws the chart from the
// group-aware request and only falls back to the class chart for Day.
const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'TokenUsage.jsx'), 'utf8');

test('TokenUsage.jsx feeds the chart from chartSummaryUrl and switches on chartDimension', () => {
  // The chart follows the primary Group by; only a drill-down (#2976) swaps in
  // the "then by" dimension, narrowed to the drilled primary value.
  assert.match(SRC, /const chartGroupBy = drilled \? secondaryGroupBy : groupBy;/);
  assert.match(SRC, /chartSummaryUrl\(\{\s*since, until, team, groupBy: chartGroupBy, granularity: sourceGranularity\(bucket\),\s*filterBy: drilled \? groupBy : null, filterKey: drilled \? drill : null,\s*\}\)/);
  assert.match(SRC, /chartDimension\(chartSummary\)/);
  assert.match(SRC, /chartDim === 'day' \? \(\s*chartType === 'donut' \? \(\s*<ClassShareChart[\s\S]{0,120}\) : \(\s*<TimeSeries/);
  assert.match(SRC, /<GroupTimeSeries/);
  assert.match(SRC, /chartTypeTitle\(chartType, chartDim, bucketUnit\(drawnBucket\), metric\)/);
  // Outside a drill-down the secondary dimension never reaches the chart
  // request (#2973 AC11): `drilled` needs both a drill value and a "then by".
  assert.match(SRC, /const drilled = !!drill && nested;/);
  // Refresh reloads the chart too.
  assert.match(SRC, /const refresh = \(\) => \{ refetch\(\); refetchChart\(\); refetchPrev\(\); \};/);
});

test('one series colour per slot, so a named series never shares a colour', () => {
  assert.equal(SERIES_COLORS.length, CHART_SERIES_LIMIT);
});
