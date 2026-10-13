// React-free helpers for the Token Usage chart-type switch (#2975, Phase 3 of
// the chart rework). The Statistics chart can be drawn four ways: stacked bars
// or lines over time, a donut of each value's share of the range, or a ranking
// of the range totals. Everything that decides WHAT is drawn — which types a
// grouping offers, the default per grouping, the share percentages, the ranking
// order, the donut and line geometry — lives here so it is covered by
// `node --test`; TokenUsage.jsx only draws the result.

import { TOKEN_CLASSES, CLASS_COLOR, GROUP_OPTIONS, OTHER_SERIES_KEY, chartTitle, formatInt } from './token-usage-view.js';

// The four chart types, in the order the switch offers them (AC1).
export const CHART_TYPES = [
  { key: 'stacked', label: 'Stacked bars over time' },
  { key: 'lines', label: 'Lines over time' },
  { key: 'donut', label: 'Donut (share)' },
  { key: 'ranking', label: 'Ranking' },
];

const CHART_TYPE_KEYS = CHART_TYPES.map((t) => t.key);

// The type a grouping starts with while the user has made no choice (AC2):
// "how is it split?" questions (model, provider, tier) read best as a share,
// "who used the most?" questions (agent, team, user) as a ranking, and Day is a
// trend over time.
const DEFAULT_BY_DIM = {
  model: 'donut',
  provider: 'donut',
  providerTier: 'donut',
  agent: 'ranking',
  team: 'ranking',
  user: 'ranking',
  day: 'stacked',
};

export function defaultChartType(dim) {
  return DEFAULT_BY_DIM[dim] || 'stacked';
}

// The types a grouping offers. With Group by = Day every "value" is a time
// bucket, so a ranking of days is not offered; its donut splits the range by
// token class instead (AC9).
export function chartTypeOptions(dim) {
  return dim === 'day' ? CHART_TYPES.filter((t) => t.key !== 'ranking') : CHART_TYPES;
}

// The type to draw: the user's choice for this visit (null = none yet) when the
// grouping offers it, else that grouping's default (AC2/AC3). The choice itself
// is never overwritten, so switching Day → Agent brings a chosen Ranking back.
export function resolveChartType(choice, dim) {
  if (choice && chartTypeOptions(dim).some((t) => t.key === choice)) return choice;
  return defaultChartType(dim);
}

export function isOverTime(type) {
  return type === 'stacked' || type === 'lines';
}

// The chart heading. Over-time types keep the existing "Tokens per <bucket>
// [by <Dimension>]" title; the range-total types name what they show.
export function chartTypeTitle(type, dim, unit = 'day') {
  if (isOverTime(type)) return chartTitle(dim, unit);
  const opt = GROUP_OPTIONS.find((g) => g.key === dim);
  if (type === 'donut') return dim === 'day' || !opt ? 'Share of tokens by token class' : `Share of tokens by ${opt.label}`;
  return `Tokens by ${opt ? opt.label : 'group'}, ranked`;
}

// The Day donut's items: the range total per token class, coloured like the
// class tiles, so its slices match those tiles one for one (AC9).
export function classShareItems(totals) {
  return TOKEN_CLASSES.map((c) => ({
    key: c.key,
    label: c.label,
    color: CLASS_COLOR[c.key],
    value: (totals && totals[c.key]) || 0,
  }));
}

// Round shares to one decimal so they add up to exactly 100.0 (AC4): each
// value is floored to tenths and the leftover tenths go to the largest
// remainders (ties in item order).
function roundedPercents(values, total) {
  if (!(total > 0)) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 1000);
  const floors = raw.map((r) => Math.floor(r));
  let left = 1000 - floors.reduce((s, f) => s + f, 0);
  const order = raw.map((r, i) => ({ i, rem: r - floors[i] })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors.map((f) => f / 10);
}

// Donut slices over the VISIBLE items: hidden and empty items are dropped and
// the percentages are taken over what remains (AC8), in the items' own order
// (series order, "Other" last).
//   -> { slices: [{ key, label, color, value, pct }], total }
export function shareSlices(items, hidden) {
  const off = new Set(hidden || []);
  const visible = (items || []).filter((it) => !off.has(it.key) && it.value > 0);
  const total = visible.reduce((s, it) => s + it.value, 0);
  const pcts = roundedPercents(visible.map((it) => it.value), total);
  return { slices: visible.map((it, i) => ({ ...it, pct: pcts[i] })), total };
}

// Ranking bars over the visible items: sorted by value, largest first, with
// "Other" always last whatever its size (AC5). `widthPct` is relative to the
// largest visible bar, `pct` is the share of the visible total.
export function rankingBars(items, hidden) {
  const { slices, total } = shareSlices(items, hidden);
  const named = slices.filter((s) => s.key !== OTHER_SERIES_KEY).sort((a, b) => b.value - a.value);
  const other = slices.filter((s) => s.key === OTHER_SERIES_KEY);
  const bars = [...named, ...other];
  const max = bars.reduce((m, b) => Math.max(m, b.value), 0);
  return { bars: bars.map((b) => ({ ...b, widthPct: max > 0 ? (b.value / max) * 100 : 0 })), total };
}

// One-line readout for a slice or bar (hover, focus and accessible name):
// label, the full number and the share.
export function shareText(item) {
  return `${item.label}: ${formatInt(item.value)} tokens (${item.pct.toFixed(1)}%)`;
}

// ── Donut geometry ─────────────────────────────────────────────────────────
// Every slice gets at least `minSweep` radians so a value under ~1% stays a
// visible, hoverable target (edge case); the extra is taken proportionally from
// the larger slices. Angles start at 12 o'clock and run clockwise.
export const MIN_SLICE_SWEEP = (2 * Math.PI) / 100;

export function donutAngles(slices, minSweep = MIN_SLICE_SWEEP) {
  const total = (slices || []).reduce((s, x) => s + x.value, 0);
  if (!(total > 0)) return [];
  const full = 2 * Math.PI;
  let sweeps = slices.map((s) => (s.value / total) * full);
  const small = sweeps.map((w) => w < minSweep);
  if (slices.length > 1 && small.some(Boolean) && minSweep * slices.length < full) {
    const fixed = small.filter(Boolean).length * minSweep;
    const bigSum = sweeps.reduce((s, w, i) => (small[i] ? s : s + w), 0);
    sweeps = sweeps.map((w, i) => (small[i] ? minSweep : (w / bigSum) * (full - fixed)));
  }
  let a = 0;
  return slices.map((s, i) => {
    const start = a;
    a += sweeps[i];
    return { key: s.key, start, end: i === slices.length - 1 ? full : a };
  });
}

const pt = (cx, cy, r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
const f = (n) => Number(n.toFixed(3));

// SVG path of a ring segment from angle `a0` to `a1`. A full ring (one value,
// 100%) is drawn as two half arcs, since one arc cannot start and end on the
// same point.
export function arcPath(cx, cy, rOuter, rInner, a0, a1) {
  if (a1 - a0 >= 2 * Math.PI - 1e-9) {
    return `${arcPath(cx, cy, rOuter, rInner, 0, Math.PI)} ${arcPath(cx, cy, rOuter, rInner, Math.PI, 2 * Math.PI)}`;
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = pt(cx, cy, rOuter, a0);
  const [x1, y1] = pt(cx, cy, rOuter, a1);
  const [x2, y2] = pt(cx, cy, rInner, a1);
  const [x3, y3] = pt(cx, cy, rInner, a0);
  return `M${f(x0)} ${f(y0)}A${rOuter} ${rOuter} 0 ${large} 1 ${f(x1)} ${f(y1)}`
    + `L${f(x2)} ${f(y2)}A${rInner} ${rInner} 0 ${large} 0 ${f(x3)} ${f(y3)}Z`;
}

// ── Lines over time ────────────────────────────────────────────────────────
// One polyline per visible series over the (rebucketed) points. `valueOf(p,
// key)` reads a series' value at a point — the same figure the stacked bar's
// segment shows (AC6). x is the centre of the point's column (0..1), y the
// value as a fraction of `top` measured from the bottom.
//   -> [{ key, color, coords: [[x, y]] }]
export function lineSeries(points, series, hidden, valueOf, top) {
  const off = new Set(hidden || []);
  const n = (points || []).length;
  return (series || [])
    .filter((s) => !off.has(s.key))
    .map((s) => ({
      key: s.key,
      color: s.color,
      coords: (points || []).map((p, i) => [(i + 0.5) / n, top > 0 ? (valueOf(p, s.key) || 0) / top : 0]),
    }));
}

// The largest single visible value across all points — the line chart's axis
// driver (lines are not stacked, so the stacked maximum would waste the plot).
export function lineVisibleMax(points, series, hidden, valueOf) {
  const keys = (series || []).map((s) => s.key).filter((k) => !(hidden || []).includes(k));
  return (points || []).reduce((m, p) => keys.reduce((mm, k) => Math.max(mm, valueOf(p, k) || 0), m), 0);
}
