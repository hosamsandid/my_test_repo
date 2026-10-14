// React-free helpers for the "then by" side of the Token Usage chart (#2976,
// Phase 4 of the chart rework): the Ranking split by the second grouping, the
// one-level drill-down into a primary value, and the series the Day chart draws
// for each metric. Pure so the figures are covered by `node --test`;
// TokenUsage.jsx only draws them.

import {
  TOKEN_CLASSES, CLASS_COLOR, GROUP_OPTIONS, CHART_SERIES_LIMIT, OTHER_SERIES_KEY, SERIES_COLORS,
  OTHER_SERIES_COLOR, DEFAULT_METRIC, resolveMetric, metricValue,
} from './token-usage-view.js';

// ── Day chart series per metric ────────────────────────────────────────────
// Group by = Day stacks each bar by token class. Total tokens keeps all four
// classes; a single class draws just that class; Invocations draws one count
// series. Keys are the fields of classPointValues, so the stacked, line and
// legend code read every metric the same way.
export const INVOCATIONS_SERIES = { key: 'invocations', label: 'Invocations', color: 'var(--eb-chart-series-1)' };

export function classSeriesFor(metric = DEFAULT_METRIC) {
  const m = resolveMetric(metric);
  if (m === 'invocations') return [INVOCATIONS_SERIES];
  const classes = m === DEFAULT_METRIC ? TOKEN_CLASSES : TOKEN_CLASSES.filter((c) => c.key === m);
  return classes.map((c) => ({ key: c.key, label: c.label, color: CLASS_COLOR[c.key] }));
}

// A rebucketed class point with a `values` map (class key / `invocations` →
// figure), the shape groupStack and lineSeries read.
export function classPointValues(point) {
  const tokens = (point && point.tokens) || {};
  const values = { invocations: (point && point.invocations) || 0 };
  for (const c of TOKEN_CLASSES) values[c.key] = tokens[c.key] || 0;
  return { ...point, values };
}

// ── Ranking split by "then by" ─────────────────────────────────────────────
// With a second grouping set, each Ranking bar is stacked by its secondary
// values. The cells come from the nested table summary (#2440), so every
// segment is exactly one nested table row. The secondary values are ranked
// across the whole range and the largest `limit` get a colour, the rest fold
// into one "Other" segment per bar — a value keeps one colour in every bar.
//   primarySeries: buildGroupDaySeries(...).series ({ key, members })
//   -> { series: [{ key, color, total, members }], segmentsOf: Map(primaryKey → [{ key, color, value }]) }
// Segments follow series order and skip empty cells.
export function rankingSplit(primarySeries, nestedSummary, metric = DEFAULT_METRIC, limit = CHART_SERIES_LIMIT) {
  const groups = nestedSummary && Array.isArray(nestedSummary.groups) ? nestedSummary.groups : [];
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const totals = new Map();
  for (const g of groups) {
    for (const sub of Array.isArray(g.subgroups) ? g.subgroups : []) {
      totals.set(sub.key, (totals.get(sub.key) || 0) + metricValue(sub, metric));
    }
  }
  const ranked = [...totals.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const fold = ranked.length > limit;
  const seriesOf = new Map();
  const series = (fold ? ranked.slice(0, limit) : ranked).map(([key, total], i) => {
    const s = { key, total, color: SERIES_COLORS[i % SERIES_COLORS.length], members: [key] };
    seriesOf.set(key, s);
    return s;
  });
  if (fold) {
    const other = { key: OTHER_SERIES_KEY, total: 0, color: OTHER_SERIES_COLOR, members: [] };
    for (const [key, total] of ranked.slice(limit)) {
      other.members.push(key);
      other.total += total;
      seriesOf.set(key, other);
    }
    series.push(other);
  }
  const segmentsOf = new Map();
  for (const p of primarySeries || []) {
    const sums = new Map();
    for (const member of p.members || [p.key]) {
      const g = byKey.get(member);
      for (const sub of (g && Array.isArray(g.subgroups) ? g.subgroups : [])) {
        const s = seriesOf.get(sub.key);
        if (!s) continue;
        sums.set(s.key, (sums.get(s.key) || 0) + metricValue(sub, metric));
      }
    }
    segmentsOf.set(p.key, series
      .filter((s) => sums.get(s.key) > 0)
      .map((s) => ({ key: s.key, color: s.color, value: sums.get(s.key) })));
  }
  return { series, segmentsOf };
}

// The visible segments of one bar and their sum (the bar's value).
export function visibleSegments(segments, hidden) {
  const off = new Set(hidden || []);
  const shown = (segments || []).filter((s) => !off.has(s.key));
  return { segments: shown, total: shown.reduce((sum, s) => sum + s.value, 0) };
}

// ── Drill-down ─────────────────────────────────────────────────────────────
// One level deep: clicking a primary value's segment, line point or slice
// narrows the chart to that value, split by the "then by" dimension.

// Whether the chart on screen offers drilling: a second grouping is set, the
// chart shows the primary dimension (not Day, whose segments are token classes
// and whose bars may span several days), and we are not already drilled.
export function drillAvailable({ groupBy, secondaryGroupBy, chartDim, drilled }) {
  return !drilled && !!secondaryGroupBy && secondaryGroupBy !== groupBy
    && groupBy !== 'day' && chartDim === groupBy;
}

// "Other" folds several values, so it is never a drill target.
export function isDrillable(key) {
  return typeof key === 'string' && key !== '' && key !== OTHER_SERIES_KEY;
}

const PLURAL = {
  agent: 'agents',
  team: 'teams',
  user: 'users',
  model: 'models',
  provider: 'providers',
  providerTier: 'provider tiers',
  day: 'days',
};

// "All models" — the breadcrumb's way back to the top level.
export function allValuesLabel(dim) {
  if (PLURAL[dim]) return `All ${PLURAL[dim]}`;
  const opt = GROUP_OPTIONS.find((g) => g.key === dim);
  return opt ? `All ${opt.label.toLowerCase()} values` : 'All values';
}

// The summary the table shows while drilled: only the drilled primary group
// (AC5). Totals are kept — the tiles are not part of the drill-down.
export function drilledTableSummary(summary, drillKey) {
  if (!summary || !drillKey) return summary;
  const groups = Array.isArray(summary.groups) ? summary.groups.filter((g) => g.key === drillKey) : [];
  return { ...summary, groups };
}

// Whether a loaded table summary no longer has the drilled value (it had no
// data in a new window) — the drill-down then ends by itself. A summary of a
// different grouping (a request still in flight) never ends it.
export function drillValueGone(summary, drillKey, groupBy) {
  if (!drillKey || !summary || summary.groupBy !== groupBy || !Array.isArray(summary.groups)) return false;
  return !summary.groups.some((g) => g.key === drillKey);
}

// Enter and Space activate a focused segment, point or slice, like a button.
export function isActivationKey(key) {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}
