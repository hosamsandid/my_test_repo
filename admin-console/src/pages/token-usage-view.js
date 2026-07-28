// React-free view helpers for the Token Usage page (#654) — extracted so the
// number-crunching (chart series, formatting, class split) is unit-testable
// under `node --test` without a DOM. The page (TokenUsage.jsx) is a thin
// presentational shell over these.

// The four canonical token classes, in a fixed display order. Kept in step
// with TOKEN_CLASSES in admin-console/api/usage-summary.js — the summary's
// `tokens` object always carries exactly these plus `total`.
export const TOKEN_CLASSES = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheCreationInput', label: 'Cache write' },
  { key: 'cacheReadInput', label: 'Cache read' },
];

// Groupings offered by GET /api/usage/summary. `day` is the time-series axis
// and also a valid table grouping.
export const GROUP_OPTIONS = [
  { key: 'agent', label: 'Agent' },
  { key: 'team', label: 'Team' },
  { key: 'model', label: 'Model' },
  { key: 'provider', label: 'Provider' },
  { key: 'day', label: 'Day' },
];

// Compact integer formatting with thousands separators. Non-finite → '0'.
export function formatInt(n) {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return v.toLocaleString('en-US');
}

// A 0..1 fraction as a whole-number percent (attribution coverage, #655).
// Non-finite / out-of-range → '0%'.
export function formatPct(f) {
  const v = typeof f === 'number' && Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0;
  return `${Math.round(v * 100)}%`;
}

// Abbreviated token count for chart axis ticks (#699): thousands as `k`,
// millions as `M`, billions as `B`, with at most one decimal (dropped when it
// adds nothing, e.g. `156M` not `156.0M`); values under 1,000 are plain
// integers. Non-finite → '0'.
export function formatCompact(n) {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  const abs = Math.abs(v);
  if (abs < 1000) return String(Math.round(v));
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  for (const [factor, suffix] of units) {
    if (abs >= factor) {
      const scaled = Math.round((v / factor) * 10) / 10;
      const str = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1);
      return `${str}${suffix}`;
    }
  }
  return String(Math.round(v));
}

// Round `x` up to a "nice" 1/2/2.5/5/10 × 10ⁿ number (used for the axis step).
function niceCeil(x) {
  if (!(x > 0)) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  const frac = x / mag; // in [1, 10)
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return niceFrac * mag;
}

// Build a dynamically-scaled y-axis for the "Tokens per day" chart (#699).
// Returns the "nice" round `top` tick (always ≥ `max`, so a bar can never
// overflow the plot) and an ascending `ticks` array (0 … top) of ~3–5 evenly
// spaced values. A zero/negative/non-finite max yields a flat 0-baseline axis
// (no divide-by-zero, no collapse).
export function niceScale(max, tickCount = 4) {
  const m = typeof max === 'number' && Number.isFinite(max) ? max : 0;
  if (!(m > 0)) return { top: 0, ticks: [0] };
  // Token counts are integers, so never let the step fall below 1 (which would
  // produce fractional, duplicate-after-rounding ticks for a tiny max).
  const step = Math.max(1, niceCeil(m / tickCount));
  const top = step * Math.ceil(m / step);
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v));
  return { top, ticks };
}

// Build a chronological time series from a groupBy=day summary. The API sorts
// groups by total desc; the chart needs them by day ascending. Returns the
// ordered points plus the largest per-day total, so the caller can scale bar
// heights (0 when there's no data — avoids a divide-by-zero).
export function buildDaySeries(summary) {
  const groups = summary && Array.isArray(summary.groups) ? summary.groups : [];
  const points = groups
    .map((g) => ({
      day: g.key,
      tokens: g.tokens || {},
      invocations: g.invocations || 0,
    }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const maxTotal = points.reduce((m, p) => Math.max(m, (p.tokens && p.tokens.total) || 0), 0);
  return { points, maxTotal };
}

// Average tokens per attributed work item (#795), broken out as total / input
// / output. The denominator is the attributed work-item count (`workItems`
// length — every entry is one issue↔PR chain with runs > 0), deliberately NOT
// total runs or the unattributed remainder: unattributed tokens have no work
// item to divide by, so mixing them in would distort the per-work-item figure.
// Each average is a rounded integer. With zero work items the averages are
// `null` (caller renders a placeholder) so there is never a NaN / Infinity /
// divide-by-zero artifact. Pure derivation of the already-fetched
// /api/usage/work-items response — recomputed by the caller on range change /
// refresh, no backend involvement.
export function workItemAverages(data) {
  const items = data && Array.isArray(data.workItems) ? data.workItems : [];
  const count = items.length;
  if (count === 0) return { count: 0, total: null, input: null, output: null };
  const sum = (key) => items.reduce((acc, w) => {
    const v = w && w.tokens && Number.isFinite(w.tokens[key]) ? w.tokens[key] : 0;
    return acc + v;
  }, 0);
  return {
    count,
    total: Math.round(sum('total') / count),
    input: Math.round(sum('input') / count),
    output: Math.round(sum('output') / count),
  };
}

// Help copy for the eight Work-items summary tiles (#832). Kept here — pure,
// React-free — so the wording is unit-testable and so the tiles stay a thin
// presentational shell. Keyed by a stable tile id; the value is the plain
// English explanation shown on hover / focus / tap (see StatCard + InfoTip).
// Copy is the source of truth in "What the numbers mean" (work-items.js /
// workItemAverages above): a work item is one issue↔PR chain, an attributed
// run is one tied to such a chain, and the Ø…/work item averages are per
// ATTRIBUTED work item with unattributed tokens excluded.
export const WORK_ITEM_TILE_HELP = {
  attributed:
    'Share of token spend in this period that could be tied to a specific work item — a GitHub issue and the pull request(s) that resolve it. The remainder is reported under “Unattributed tokens”.',
  attributedTokens:
    'Total tokens used by agent runs that could be linked to a work item (a GitHub issue ↔ PR chain).',
  unattributedTokens:
    'Tokens used by runs that could not be tied to any single work item — e.g. direct chats, scheduled self-maintenance, or triggers not linked to an issue/PR. Always shown so the totals add up.',
  unattributedRuns:
    'Number of agent runs in this period whose tokens could not be attributed to a work item.',
  totalRuns:
    'All agent runs in this period (attributed plus unattributed).',
  avgTotal:
    'Average total tokens (input + output) per attributed work item. Unattributed tokens are excluded, so this reflects the typical cost of resolving one issue ↔ PR chain.',
  avgInput:
    'Average input (prompt) tokens per attributed work item. Unattributed tokens are excluded.',
  avgOutput:
    'Average output (generated) tokens per attributed work item. Unattributed tokens are excluded.',
};

// Build the flat-export download URL (#656) for a view. `kind` is
// 'summary' | 'work-items', `format` is 'csv' | 'json'. Carries the current
// time window (`since`) so the export matches what's on screen; the server
// applies the same team scope as the view endpoints.
export function buildExportUrl(kind, { since, format, team } = {}) {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  // `team` narrows the export to a single team (#801); a blank/absent value
  // means "all teams" and is simply omitted so the export stays unfiltered.
  if (team) params.set('team', team);
  params.set('format', format === 'json' ? 'json' : 'csv');
  return `/api/usage/${kind}/export?${params.toString()}`;
}

// Stacked-bar segments (one per token class) for a single point, as height
// percentages of `maxTotal`. Skips zero-height classes so the DOM stays lean.
export function stackSegments(tokens, maxTotal) {
  if (!(maxTotal > 0)) return [];
  return TOKEN_CLASSES
    .map(({ key, label }) => ({ key, label, value: (tokens && tokens[key]) || 0 }))
    .filter((s) => s.value > 0)
    .map((s) => ({ ...s, heightPct: (s.value / maxTotal) * 100 }));
}
