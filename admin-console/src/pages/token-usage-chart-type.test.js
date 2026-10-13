import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHART_TYPES, defaultChartType, chartTypeOptions, resolveChartType, isOverTime, chartTypeTitle,
  classShareItems, shareSlices, rankingBars, shareText, donutAngles, arcPath, MIN_SLICE_SWEEP,
  lineSeries, lineVisibleMax,
} from './token-usage-chart-type.js';
import {
  GROUP_OPTIONS, TOKEN_CLASSES, CLASS_COLOR, OTHER_SERIES_KEY, CHART_SERIES_LIMIT,
  buildGroupDaySeries, buildDaySeries, groupStack, hiddenSeriesFor, toggleHiddenSeries,
} from './token-usage-view.js';
import { rebucketGroupPoints } from './token-usage-range.js';

const require = (await import('node:module')).createRequire(import.meta.url);
const { summarize } = require('../../api/usage-summary.js');

// #2975: chart-type switch — stacked bars, lines, donut (share), ranking.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(HERE, 'TokenUsage.jsx'), 'utf8');

const rec = (ts, agentId, tokens, extra = {}) => ({
  ts, agentId, teamId: 't',
  tokens: typeof tokens === 'number' ? { input: tokens, output: 0, cacheCreationInput: 0, cacheReadInput: 0 } : tokens,
  ...extra,
});

// The chart's group items exactly as the page builds them from the chart summary.
const groupItems = (summary) => buildGroupDaySeries(summary).series.map((s) => ({ key: s.key, label: s.key, color: s.color, value: s.total }));

test('the switch offers exactly the four types, in order (AC1)', () => {
  assert.deepEqual(CHART_TYPES.map((t) => t.key), ['stacked', 'lines', 'donut', 'ranking']);
  assert.deepEqual(CHART_TYPES.map((t) => t.label), ['Stacked bars over time', 'Lines over time', 'Donut (share)', 'Ranking']);
  assert.ok(isOverTime('stacked') && isOverTime('lines') && !isOverTime('donut') && !isOverTime('ranking'));
});

test('each Group by has the default from the issue table (AC2)', () => {
  const expected = { model: 'donut', provider: 'donut', providerTier: 'donut', agent: 'ranking', team: 'ranking', user: 'ranking', day: 'stacked' };
  for (const { key } of GROUP_OPTIONS) {
    assert.equal(defaultChartType(key), expected[key], key);
    assert.equal(resolveChartType(null, key), expected[key], key);
  }
});

test('Group by = Day offers no ranking; every other grouping offers all four (AC9)', () => {
  assert.deepEqual(chartTypeOptions('day').map((t) => t.key), ['stacked', 'lines', 'donut']);
  for (const { key } of GROUP_OPTIONS.filter((g) => g.key !== 'day')) {
    assert.equal(chartTypeOptions(key).length, 4, key);
  }
});

test('a chosen type is kept across groupings, except where it is not offered (AC3)', () => {
  for (const { key } of GROUP_OPTIONS) {
    assert.equal(resolveChartType('lines', key), 'lines');
    assert.equal(resolveChartType('donut', key), 'donut');
  }
  assert.equal(resolveChartType('ranking', 'model'), 'ranking');
  assert.equal(resolveChartType('ranking', 'day'), 'stacked');
  // The choice itself survives the Day detour: back on Agent it is Ranking again.
  assert.equal(resolveChartType('ranking', 'agent'), 'ranking');
  assert.equal(resolveChartType('bogus', 'model'), 'donut');
});

test('the page keeps the choice in component state, not per grouping or request (AC3)', () => {
  assert.match(PAGE, /const \[chartTypeChoice, setChartTypeChoice\] = useState\(null\);/);
  assert.match(PAGE, /resolveChartType\(chartTypeChoice, chartDim\)/);
  assert.match(PAGE, /<select value=\{chartType\} onChange=\{\(e\) => setChartTypeChoice\(e\.target\.value\)\} style=\{CONTROL_STYLE\} aria-label="Chart type">/);
  assert.match(PAGE, /chartTypeOptions\(chartDim\)\.map/);
});

test('chart titles name what each type shows', () => {
  assert.equal(chartTypeTitle('stacked', 'model', 'week'), 'Tokens per week by Model');
  assert.equal(chartTypeTitle('lines', 'day', 'day'), 'Tokens per day');
  assert.equal(chartTypeTitle('donut', 'model'), 'Share of tokens by Model');
  assert.equal(chartTypeTitle('donut', 'day'), 'Share of tokens by token class');
  assert.equal(chartTypeTitle('ranking', 'agent'), 'Tokens by Agent, ranked');
});

test('donut slices add up to 100% and match the table rows, Other = sum of folded rows (AC4)', () => {
  const records = [];
  // 11 agents with awkward sizes so rounding matters; some on two days.
  const sizes = [1000, 777, 333, 333, 333, 120, 99, 50, 7, 3, 1];
  sizes.forEach((n, i) => {
    records.push(rec('2026-10-01T10:00:00Z', `a${i}`, n));
    if (i % 2) records.push(rec('2026-10-02T10:00:00Z', `a${i}`, { input: n, output: 3, cacheCreationInput: 0, cacheReadInput: 1 }));
  });
  const table = summarize(records, { groupBy: 'agent' });
  const chart = summarize(records, { groupBy: 'agent', secondaryGroupBy: 'day' });
  const { slices, total } = shareSlices(groupItems(chart), []);
  const sum = slices.reduce((s, x) => s + x.pct, 0);
  assert.ok(Math.abs(sum - 100) <= 0.1, `sum ${sum}`);
  assert.equal(total, table.totals.total);
  const rowTotal = new Map(table.groups.map((g) => [g.key, g.tokens.total]));
  for (const s of slices.filter((x) => x.key !== OTHER_SERIES_KEY)) assert.equal(s.value, rowTotal.get(s.key), s.key);
  const folded = table.groups.slice(CHART_SERIES_LIMIT).reduce((n, g) => n + g.tokens.total, 0);
  assert.equal(slices.find((x) => x.key === OTHER_SERIES_KEY).value, folded);
});

test('the model donut reconciles with the table for multi-model runs (#2972)', () => {
  const records = [
    rec('2026-10-01T10:00:00Z', 'a', { input: 100, output: 50, cacheCreationInput: 0, cacheReadInput: 0 }, {
      modelUsage: { m1: { inputTokens: 60, outputTokens: 30 }, m2: { inputTokens: 40, outputTokens: 20 } },
    }),
    rec('2026-10-02T10:00:00Z', 'b', 10, { model: 'm2' }),
  ];
  const table = summarize(records, { groupBy: 'model' });
  const chart = summarize(records, { groupBy: 'model', secondaryGroupBy: 'day' });
  const { slices, total } = shareSlices(groupItems(chart), []);
  assert.equal(total, table.totals.total);
  for (const s of slices) assert.equal(s.value, table.groups.find((g) => g.key === s.key).tokens.total);
});

test('ranking is sorted by total descending, Other always last, values match the table (AC5)', () => {
  const items = [
    { key: 'a', label: 'a', value: 5 },
    { key: OTHER_SERIES_KEY, label: 'Other', value: 999 },
    { key: 'b', label: 'b', value: 50 },
    { key: 'c', label: 'c', value: 20 },
  ];
  const { bars } = rankingBars(items, []);
  assert.deepEqual(bars.map((b) => b.key), ['b', 'c', 'a', OTHER_SERIES_KEY]);
  assert.equal(bars.find((b) => b.key === OTHER_SERIES_KEY).widthPct, 100);
  const records = [rec('2026-10-01T10:00:00Z', 'x', 3), rec('2026-10-01T10:00:00Z', 'y', 9), rec('2026-10-02T10:00:00Z', 'x', 1)];
  const table = summarize(records, { groupBy: 'agent' });
  const ranked = rankingBars(groupItems(summarize(records, { groupBy: 'agent', secondaryGroupBy: 'day' })), []).bars;
  assert.deepEqual(ranked.map((b) => [b.key, b.value]), table.groups.map((g) => [g.key, g.tokens.total]));
});

test('lines show the same per-bucket value per series as the stacked bars (AC6)', () => {
  const records = [
    rec('2026-10-01T10:00:00Z', 'a', 10), rec('2026-10-01T11:00:00Z', 'b', 5),
    rec('2026-10-03T10:00:00Z', 'a', 7), rec('2026-10-08T10:00:00Z', 'b', 2),
  ];
  const { series, points: raw } = buildGroupDaySeries(summarize(records, { groupBy: 'agent', secondaryGroupBy: 'day' }));
  for (const bucket of ['day', 'week']) {
    const points = rebucketGroupPoints(raw, { bucket, start: Date.UTC(2026, 8, 28), end: Date.UTC(2026, 9, 12) });
    const valueOf = (p, k) => (p.values && p.values[k]) || 0;
    const top = lineVisibleMax(points, series, [], valueOf);
    const lines = lineSeries(points, series, [], valueOf, top);
    points.forEach((p, i) => {
      const stack = groupStack(p, series, []);
      for (const line of lines) {
        const seg = stack.segments.find((s) => s.key === line.key);
        assert.equal(line.coords[i][1] * top, seg ? seg.value : 0, `${bucket} ${i} ${line.key}`);
      }
    });
    // x is the centre of each column.
    assert.equal(lines[0].coords[0][0], 0.5 / points.length);
  }
});

test('a group value has the same colour in every chart type (AC7)', () => {
  const records = [rec('2026-10-01T10:00:00Z', 'a', 10), rec('2026-10-01T10:00:00Z', 'b', 30)];
  const { series, points } = buildGroupDaySeries(summarize(records, { groupBy: 'agent', secondaryGroupBy: 'day' }));
  const colour = new Map(series.map((s) => [s.key, s.color]));
  const items = series.map((s) => ({ key: s.key, label: s.key, color: s.color, value: s.total }));
  for (const s of shareSlices(items, []).slices) assert.equal(s.color, colour.get(s.key));
  for (const b of rankingBars(items, []).bars) assert.equal(b.color, colour.get(b.key));
  for (const l of lineSeries(points, series, [], (p, k) => p.values[k], 30)) assert.equal(l.color, colour.get(l.key));
  for (const s of groupStack(points[0], series, []).segments) assert.equal(s.color, colour.get(s.key));
});

test('hiding a series removes it from every type and re-bases the donut percentages (AC8)', () => {
  const items = [{ key: 'a', label: 'a', value: 50 }, { key: 'b', label: 'b', value: 30 }, { key: 'c', label: 'c', value: 20 }];
  const hidden = toggleHiddenSeries({}, 'agent', 'a');
  const off = hiddenSeriesFor(hidden, 'agent');
  const { slices, total } = shareSlices(items, off);
  assert.deepEqual(slices.map((s) => [s.key, s.pct]), [['b', 60], ['c', 40]]);
  assert.equal(total, 50);
  assert.deepEqual(rankingBars(items, off).bars.map((b) => b.key), ['b', 'c']);
  const series = items.map((i) => ({ key: i.key, color: i.key }));
  assert.deepEqual(lineSeries([{ values: {} }], series, off, () => 0, 1).map((l) => l.key), ['b', 'c']);
  // Everything hidden: nothing to draw (the page shows the existing hint).
  assert.deepEqual(shareSlices(items, ['a', 'b', 'c']).slices, []);
});

test('Group by = Day: the donut is the token-class split and matches the class tiles (AC9)', () => {
  const records = [
    rec('2026-10-01T10:00:00Z', 'a', { input: 10, output: 20, cacheCreationInput: 30, cacheReadInput: 940 }),
    rec('2026-10-02T10:00:00Z', 'b', { input: 1, output: 2, cacheCreationInput: 0, cacheReadInput: 7 }),
  ];
  const summary = summarize(records, { groupBy: 'day' });
  const items = classShareItems(summary.totals);
  assert.deepEqual(items.map((i) => i.key), TOKEN_CLASSES.map((c) => c.key));
  for (const it of items) {
    assert.equal(it.value, summary.totals[it.key]);
    assert.equal(it.color, CLASS_COLOR[it.key]);
  }
  const { slices, total } = shareSlices(items, []);
  assert.equal(total, summary.totals.total);
  assert.ok(Math.abs(slices.reduce((s, x) => s + x.pct, 0) - 100) <= 0.1);
  // The day series still sums to the same total (the time charts are unchanged).
  assert.equal(buildDaySeries(summary).points.reduce((s, p) => s + p.tokens.total, 0), total);
});

test('a single value is one full ring at 100% and one ranking bar (edge case)', () => {
  const { slices } = shareSlices([{ key: 'only', label: 'only', value: 42 }], []);
  assert.equal(slices[0].pct, 100);
  const [arc] = donutAngles(slices);
  assert.equal(arc.start, 0);
  assert.equal(arc.end, 2 * Math.PI);
  const d = arcPath(50, 50, 40, 25, arc.start, arc.end);
  assert.equal((d.match(/M/g) || []).length, 2, 'drawn as two half arcs');
  assert.ok(!/NaN/.test(d));
  assert.equal(rankingBars([{ key: 'only', label: 'only', value: 42 }], []).bars.length, 1);
});

test('very small slices keep a visible minimum sweep; angles still close the ring (edge case)', () => {
  const { slices } = shareSlices([{ key: 'big', label: 'big', value: 10000 }, { key: 'tiny', label: 'tiny', value: 3 }], []);
  assert.equal(slices[1].pct, 0); // 0.03% honestly rounded…
  const arcs = donutAngles(slices);
  assert.ok(arcs[1].end - arcs[1].start >= MIN_SLICE_SWEEP - 1e-12, '…but still drawn as a target');
  assert.equal(arcs[arcs.length - 1].end, 2 * Math.PI);
  assert.ok(Math.abs(arcs[0].end - arcs[1].start) < 1e-12);
});

test('shareText gives label, full number and share', () => {
  assert.equal(shareText({ label: 'claude', value: 1234567, pct: 12.5 }), 'claude: 1,234,567 tokens (12.5%)');
});

test('empty data yields no slices, bars or lines', () => {
  assert.deepEqual(shareSlices([], []), { slices: [], total: 0 });
  assert.deepEqual(rankingBars([], []).bars, []);
  assert.deepEqual(donutAngles([]), []);
  assert.equal(lineVisibleMax([], [], [], () => 0), 0);
});

test('every chart type has an accessible name and keeps the empty state (AC10/AC11)', () => {
  // One named region for every type…
  assert.match(PAGE, /role="group" aria-label=\{title\}/);
  // …focusable slices and bars named by their readout…
  assert.match(PAGE, /<path[\s\S]{0,400}tabIndex=\{0\}[\s\S]{0,200}aria-label=\{shareText\(s\)\}/);
  assert.match(PAGE, /<li[\s\S]{0,200}tabIndex=\{0\}[\s\S]{0,200}aria-label=\{shareText\(b\)\}/);
  // …and the over-time lines are a named image (the table is the text equivalent).
  assert.match(PAGE, /<svg role="img" aria-label=/);
  // The empty state and the "nothing to draw" hint are shared by every type.
  assert.equal((PAGE.match(/No usage in this range\./g) || []).length, 1);
  assert.match(PAGE, /function ChartEmpty/);
  assert.match(PAGE, /No series selected — click a legend item below to show it\./);
});
