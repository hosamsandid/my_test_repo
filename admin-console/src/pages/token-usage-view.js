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

// Build the flat-export download URL (#656) for a view. `kind` is
// 'summary' | 'work-items', `format` is 'csv' | 'json'. Carries the current
// time window (`since`) so the export matches what's on screen; the server
// applies the same team scope as the view endpoints.
export function buildExportUrl(kind, { since, format } = {}) {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
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
