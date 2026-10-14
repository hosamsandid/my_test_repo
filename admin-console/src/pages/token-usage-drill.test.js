import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  METRICS, DEFAULT_METRIC, resolveMetric, metricValue, formatMetric, buildGroupDaySeries, chartSummaryUrl,
  chartTitle, groupStack, niceScale, OTHER_SERIES_KEY, TOKEN_CLASSES,
} from './token-usage-view.js';
import { chartTypeOptions, resolveChartType, chartTypeTitle, shareSlices, shareText } from './token-usage-chart-type.js';
import {
  classSeriesFor, classPointValues, rankingSplit, visibleSegments, drillAvailable, isDrillable, allValuesLabel,
  drilledTableSummary, drillValueGone, isActivationKey, INVOCATIONS_SERIES,
} from './token-usage-drill.js';
import { rebucketClassPoints } from './token-usage-range.js';

// #2976 — Phase 4 of the Token Usage chart rework: metric selector, "then by"
// in the chart (Ranking split + drill-down). The figures are checked against
// the REAL aggregation (api/usage-summary.js), so the chart provably matches
// the table columns and nested rows it is compared with.

const require = createRequire(import.meta.url);
const { summarize } = require('../../api/usage-summary.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(HERE, 'TokenUsage.jsx'), 'utf8');

const t4 = (input, output, cacheCreationInput, cacheReadInput) => ({ input, output, cacheCreationInput, cacheReadInput });
const RECORDS = [
  { ts: '2026-10-01T10:00:00Z', agentId: 'a', teamId: 't1', tokens: t4(30, 6, 2, 100),
    modelUsage: { 'model-x': t4(20, 4, 1, 60), 'model-y': t4(10, 2, 1, 40) } },
  { ts: '2026-10-02T10:00:00Z', agentId: 'a', teamId: 't1', tokens: t4(5, 1, 0, 9), modelUsage: { 'model-x': t4(5, 1, 0, 9) } },
  { ts: '2026-10-02T11:00:00Z', agentId: 'b', teamId: 't2', tokens: t4(7, 50, 3, 0), modelUsage: { 'model-y': t4(7, 50, 3, 0) } },
  { ts: '2026-10-03T11:00:00Z', agentId: 'b', teamId: 't2', tokens: t4(9, 0, 0, 1) },
  { ts: '2026-10-03T12:00:00Z', agentId: 'c', teamId: 't1', tokens: t4(1, 1, 1, 1), modelUsage: { 'model-z': t4(1, 1, 1, 1) } },
  { ts: '2026-10-03T13:00:00Z', agentId: 'c', teamId: 't1', tokens: t4(0, 0, 0, 0), modelUsage: { 'model-z': t4(0, 0, 0, 0) } },
];

// ── Metric (AC1, AC2) ─────────────────────────────────────────────────────

test('the metric selector offers total tokens (default), each class and invocations', () => {
  assert.deepEqual(METRICS.map((m) => m.key), ['total', ...TOKEN_CLASSES.map((c) => c.key), 'invocations']);
  assert.equal(DEFAULT_METRIC, 'total');
  assert.equal(resolveMetric('bogus'), 'total');
  assert.equal(metricValue({ tokens: { input: 4, total: 9 }, invocations: 2 }, 'input'), 4);
  assert.equal(metricValue({ tokens: { input: 4, total: 9 }, invocations: 2 }, 'invocations'), 2);
  assert.equal(metricValue(null, 'total'), 0);
  assert.equal(formatMetric(1234, 'output'), '1,234 tokens');
  assert.equal(formatMetric(1, 'invocations'), '1 invocation');
  assert.equal(formatMetric(3, 'invocations'), '3 invocations');
});

test('AC1: for every metric and grouping the chart series equal the table column', () => {
  for (const groupBy of ['agent', 'team', 'model']) {
    const table = summarize(RECORDS, { groupBy });
    const chart = summarize(RECORDS, { groupBy, secondaryGroupBy: 'day' });
    for (const { key: metric } of METRICS) {
      const { series } = buildGroupDaySeries(chart, 8, metric);
      for (const s of series) {
        const row = table.groups.find((g) => g.key === s.key);
        assert.equal(s.total, metricValue(row, metric), `${groupBy}/${metric}/${s.key}`);
      }
      // Ranked by what is measured: output puts agent b (50) first.
      if (groupBy === 'agent' && metric === 'output') assert.equal(series[0].key, 'b');
    }
  }
});

test('AC1: the Day chart draws the selected class / invocations, adding up to the tiles', () => {
  const day = summarize(RECORDS, { groupBy: 'day' });
  const points = rebucketClassPoints(day.groups.map((g) => ({ day: g.key, tokens: g.tokens, invocations: g.invocations })),
    { bucket: 'day', start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 9, 4) }).map(classPointValues);
  for (const { key: metric } of METRICS) {
    const series = classSeriesFor(metric);
    const sum = points.reduce((s, p) => s + groupStack(p, series, []).total, 0);
    // `totals` is flat (the tiles' shape): { input, …, total, invocations }
    assert.equal(sum, day.totals[metric], metric);
  }
  assert.deepEqual(classSeriesFor('total').map((s) => s.key), TOKEN_CLASSES.map((c) => c.key));
  assert.deepEqual(classSeriesFor('cacheReadInput').map((s) => s.key), ['cacheReadInput']);
  assert.deepEqual(classSeriesFor('invocations'), [INVOCATIONS_SERIES]);
});

test('AC1: Donut shares and titles follow the metric', () => {
  const chart = summarize(RECORDS, { groupBy: 'agent', secondaryGroupBy: 'day' });
  const { series } = buildGroupDaySeries(chart, 8, 'invocations');
  const { slices, total } = shareSlices(series.map((s) => ({ key: s.key, label: s.key, value: s.total })), []);
  assert.equal(total, 6);
  assert.match(shareText(slices.find((s) => s.key === 'a'), 'invocations'), /^a: 2 invocations \(33\.[34]%\)$/);
  assert.equal(chartTitle('agent', 'day', 'input'), 'Input tokens per day by Agent');
  assert.equal(chartTitle('day', 'week', 'invocations'), 'Invocations per week');
  assert.equal(chartTypeTitle('donut', 'model', 'day', 'output'), 'Share of output tokens by Model');
  assert.equal(chartTypeTitle('ranking', 'agent', 'day', 'invocations'), 'Invocations by Agent, ranked');
  assert.equal(chartTypeTitle('stacked', 'agent'), 'Tokens per day by Agent', 'default unchanged');
});

test('the Day donut (a token-class split) is offered only for total tokens', () => {
  assert.ok(chartTypeOptions('day', 'total').some((t) => t.key === 'donut'));
  for (const metric of ['input', 'invocations']) {
    assert.deepEqual(chartTypeOptions('day', metric).map((t) => t.key), ['stacked', 'lines']);
    assert.equal(resolveChartType('donut', 'day', metric), 'stacked');
  }
  assert.equal(chartTypeOptions('agent', 'invocations').length, 4);
});

test('AC2: invocations — a hidden series empties the stack and the axis stays whole counts', () => {
  const p = classPointValues({ tokens: t4(1, 2, 3, 4), invocations: 3 });
  assert.equal(groupStack(p, [INVOCATIONS_SERIES], []).total, 3);
  assert.deepEqual(groupStack(p, [INVOCATIONS_SERIES], ['invocations']).segments, []);
  for (const max of [1, 2, 3, 7, 13]) {
    const { ticks, top } = niceScale(max);
    assert.ok(ticks.every(Number.isInteger), `ticks for ${max}: ${ticks}`);
    assert.ok(top >= max);
  }
  // the page keeps a separate (session) hidden set for the invocation series
  assert.match(PAGE, /resolveMetric\(metric\) === 'invocations' \? hiddenSeriesFor\(hiddenGroups, 'day'\)/);
});

// ── Ranking split by "then by" (AC3) ──────────────────────────────────────

test('AC3: each Ranking bar is split into exactly the nested table rows', () => {
  for (const [groupBy, secondaryGroupBy] of [['agent', 'model'], ['model', 'agent'], ['team', 'agent']]) {
    const nested = summarize(RECORDS, { groupBy, secondaryGroupBy });
    const chart = summarize(RECORDS, { groupBy, secondaryGroupBy: 'day' });
    for (const metric of ['total', 'input', 'invocations']) {
      const { series } = buildGroupDaySeries(chart, 8, metric);
      const { segmentsOf } = rankingSplit(series, nested, metric);
      for (const g of nested.groups) {
        const want = g.subgroups.filter((s) => metricValue(s, metric) > 0).map((s) => [s.key, metricValue(s, metric)]).sort();
        const got = (segmentsOf.get(g.key) || []).map((s) => [s.key, s.value]).sort();
        assert.deepEqual(got, want, `${groupBy}×${secondaryGroupBy}/${metric}/${g.key}`);
        // Tokens always add up to the primary row. Invocations do too, except
        // split by model: a multi-model turn is one invocation of its agent
        // but one of EACH model — the nested table counts it the same way.
        if (!(metric === 'invocations' && secondaryGroupBy === 'model')) {
          assert.equal(visibleSegments(segmentsOf.get(g.key), []).total, metricValue(g, metric));
        }
      }
    }
  }
});

test('AC3: secondary values beyond the limit fold into one Other segment; colours are per value', () => {
  const nested = summarize(RECORDS, { groupBy: 'agent', secondaryGroupBy: 'model' });
  const chart = summarize(RECORDS, { groupBy: 'agent', secondaryGroupBy: 'day' });
  const { series: primary } = buildGroupDaySeries(chart);
  const { series, segmentsOf } = rankingSplit(primary, nested, 'total', 2);
  // ranked over the whole range: model-y 113, model-x 100, then the rest
  assert.deepEqual(series.map((s) => s.key), ['model-y', 'model-x', OTHER_SERIES_KEY]);
  assert.deepEqual(series[2].members.sort(), ['model-z', 'unknown']);
  const a = segmentsOf.get('a');
  const b = segmentsOf.get('b');
  assert.deepEqual(b.map((s) => s.key), ['model-y', OTHER_SERIES_KEY]);
  assert.equal(b[0].color, a[0].color, 'model-y has one colour in every bar');
  assert.equal(b[0].color, series[0].color);
  // hiding a secondary value shortens the bar by that segment
  assert.equal(visibleSegments(b, ['model-y']).total, 10);
});

test('AC3: a folded primary "Other" bar sums its members\' rows', () => {
  const nested = summarize(RECORDS, { groupBy: 'agent', secondaryGroupBy: 'team' });
  const chart = summarize(RECORDS, { groupBy: 'agent', secondaryGroupBy: 'day' });
  const { series } = buildGroupDaySeries(chart, 1);
  const { segmentsOf } = rankingSplit(series, nested, 'total');
  const other = series.find((s) => s.key === OTHER_SERIES_KEY);
  const want = other.members.reduce((s, k) => s + nested.groups.find((g) => g.key === k).tokens.total, 0);
  assert.equal(visibleSegments(segmentsOf.get(OTHER_SERIES_KEY), []).total, want);
});

// ── Drill-down (AC4–AC7) ──────────────────────────────────────────────────

test('drill-down is offered only with a then-by, on the primary chart, not for Day, one level deep', () => {
  const base = { groupBy: 'agent', secondaryGroupBy: 'model', chartDim: 'agent', drilled: false };
  assert.equal(drillAvailable(base), true);
  assert.equal(drillAvailable({ ...base, secondaryGroupBy: '' }), false, 'no then-by');
  assert.equal(drillAvailable({ ...base, drilled: true }), false, 'one level only');
  assert.equal(drillAvailable({ ...base, chartDim: 'model' }), false, 'stale response of another dimension');
  assert.equal(drillAvailable({ groupBy: 'day', secondaryGroupBy: 'agent', chartDim: 'day', drilled: false }), false);
  assert.equal(isDrillable(OTHER_SERIES_KEY), false, '"Other" combines several values');
  assert.equal(isDrillable('agent-a'), true);
});

test('AC4: a drilled chart shows only that value, split by the then-by dimension', () => {
  const url = new URL(chartSummaryUrl({ since: 's', team: 't1', groupBy: 'model', granularity: 'day', filterBy: 'agent', filterKey: 'a' }), 'http://x');
  assert.equal(url.searchParams.get('groupBy'), 'model');
  assert.equal(url.searchParams.get('secondaryGroupBy'), 'day');
  assert.equal(url.searchParams.get('filterBy'), 'agent');
  assert.equal(url.searchParams.get('filterKey'), 'a');
  const plain = new URL(chartSummaryUrl({ groupBy: 'agent' }), 'http://x');
  assert.equal(plain.searchParams.has('filterBy'), false);
  // …and the drilled data is that value's nested rows, per model
  const drilled = summarize(RECORDS, { groupBy: 'model', secondaryGroupBy: 'day', filterBy: 'agent', filterKey: 'a' });
  const row = summarize(RECORDS, { groupBy: 'agent', secondaryGroupBy: 'model' }).groups.find((g) => g.key === 'a');
  const { series } = buildGroupDaySeries(drilled);
  assert.deepEqual(series.map((s) => [s.key, s.total]), row.subgroups.map((s) => [s.key, s.tokens.total]));
});

test('AC4: the breadcrumb names the top level and the drilled value', () => {
  assert.equal(allValuesLabel('model'), 'All models');
  assert.equal(allValuesLabel('providerTier'), 'All provider tiers');
  assert.equal(allValuesLabel('agent'), 'All agents');
  assert.match(PAGE, /<DrillBreadcrumb trail=\{\[allValuesLabel\(groupBy\), groupValueCell\(groupBy, drill, userNames\)\.label\]\} onBack=\{leaveDrill\}/);
  assert.match(PAGE, /<nav aria-label="Chart drill-down"/);
  assert.match(PAGE, /<button ref=\{backRef\} type="button" onClick=\{onBack\}/);
  assert.match(PAGE, /aria-current="location"/);
});

test('AC4: drilling pins the chart type on screen; metric, range and legend state are not touched', () => {
  const enter = /const enterDrill = \(key\) => \{([\s\S]*?)\n {2}\};/.exec(PAGE);
  assert.ok(enter, 'enterDrill exists');
  assert.match(enter[1], /if \(chartTypeChoice == null\) setChartTypeChoice\(chartType\);/);
  assert.match(enter[1], /setDrill\(key\);/);
  assert.doesNotMatch(enter[1], /setMetric|setRange|setHidden|setHiddenGroups/);
  const leave = /const leaveDrill = \(\) => \{([\s\S]*?)\n {2}\};/.exec(PAGE);
  assert.match(leave[1], /setDrill\(null\);/);
  assert.doesNotMatch(leave[1], /setMetric|setRange|setHidden|setHiddenGroups|setChartTypeChoice/);
});

test('AC5: while drilled the table shows only the drilled primary value', () => {
  const nested = summarize(RECORDS, { groupBy: 'agent', secondaryGroupBy: 'model' });
  const only = drilledTableSummary(nested, 'b');
  assert.deepEqual(only.groups.map((g) => g.key), ['b']);
  assert.deepEqual(only.totals, nested.totals);
  assert.equal(drilledTableSummary(nested, null), nested, 'not drilled: the full table');
  assert.match(PAGE, /<NestedSummaryTable summary=\{drilled \? drilledTableSummary\(summary, drill\) : summary\}/);
});

test('AC6: segments, points and slices drill by mouse and by Enter / Space on focus', () => {
  assert.ok(isActivationKey('Enter'));
  assert.ok(isActivationKey(' '));
  assert.ok(!isActivationKey('Tab'));
  const props = /function drillProps\(drill, key, text\) \{([\s\S]*?)\n\}/.exec(PAGE)[1];
  assert.match(props, /role: 'button'/);
  assert.match(props, /tabIndex: 0/);
  assert.match(props, /onClick: go/);
  assert.match(props, /if \(isActivationKey\(e\.key\)\) \{\s*e\.preventDefault\(\);\s*go\(\);/);
  // every drillable surface goes through it, and only for a drillable value
  assert.equal((PAGE.match(/drill && isDrillable\([^)]*\) \? drillProps\(drill, /g) || []).length, 3);
});

test('AC7: Group by, then by, team and range return to the top level', () => {
  assert.match(PAGE, /useEffect\(\(\) => \{ setDrill\(null\); \}, \[groupBy, secondaryGroupBy, team, range\]\);/);
  // …and a drilled value that has no data any more leaves by itself
  const nested = summarize(RECORDS, { groupBy: 'agent', secondaryGroupBy: 'model', since: '2026-10-03' });
  assert.equal(drillValueGone(nested, 'a', 'agent'), true);
  assert.equal(drillValueGone(nested, 'b', 'agent'), false);
  assert.equal(drillValueGone(nested, 'a', 'team'), false, 'a response for another grouping never ends it');
  assert.equal(drillValueGone(null, 'a', 'agent'), false);
});

test('AC10: the export still follows the full view, never the drill-down', () => {
  const exp = /<ExportButtons kind="summary"[^>]*\/>/.exec(PAGE)[0];
  assert.doesNotMatch(exp, /drill/);
  assert.match(exp, /groupBy=\{groupBy\} secondaryGroupBy=\{nested \? secondaryGroupBy : ''\}/);
});

test('the metric selector is wired and every chart reads it', () => {
  assert.match(PAGE, /const \[metric, setMetric\] = useState\(DEFAULT_METRIC\);/);
  assert.match(PAGE, /<select value=\{metric\} onChange=\{\(e\) => setMetric\(resolveMetric\(e\.target\.value\)\)\} style=\{CONTROL_STYLE\} aria-label="Chart metric">/);
  for (const chart of ['<TimeSeries summary={chartSummary} metric={metric}', '<GroupTimeSeries', '<GroupShareChart']) {
    const at = PAGE.indexOf(chart);
    assert.ok(at > 0, chart);
    assert.match(PAGE.slice(at, at + 200), /metric=\{metric\}/, chart);
  }
});
