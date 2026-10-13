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

// One stable colour per token class (shared by cards, chart, legend). Uses
// design tokens so it tracks the light/dark/high-contrast theme. Every value
// must be a token defined in theme/tokens.css — an undefined token silently
// falls back and can collapse two stacked series into one block (#2618).
export const CLASS_COLOR = {
  input: 'var(--eb-status-info)',
  output: 'var(--eb-status-success)',
  cacheCreationInput: 'var(--eb-status-warning)',
  cacheReadInput: 'var(--eb-accent-primary)',
};

// Groupings offered by GET /api/usage/summary. `day` is the time-series axis
// and also a valid table grouping. Kept in step with GROUP_BY in
// admin-console/api/usage-summary.js — a key the server does not know silently
// falls back to `agent`, which reads as a broken control rather than an error.
//
// `user` and `providerTier` (#2137) exist because a GLOBAL model provider
// (#2136) has no team, so `team` stopped being a sufficient accounting key.
export const GROUP_OPTIONS = [
  { key: 'agent', label: 'Agent' },
  { key: 'team', label: 'Team' },
  { key: 'user', label: 'User' },
  { key: 'model', label: 'Model' },
  { key: 'provider', label: 'Provider' },
  { key: 'providerTier', label: 'Provider tier' },
  { key: 'day', label: 'Day' },
];

// The `unknown` key the aggregator uses for a record whose group value could not
// be resolved. Written down once so the label rules below and the table cell
// cannot disagree about which key means "no answer".
// Time keys the summary endpoint also groups by that are NOT offered as a
// table Group by: `hour` (#2974) exists only for the chart's hourly bars.
export const CHART_ONLY_GROUPINGS = ['hour'];

export const UNKNOWN_GROUP_KEY = 'unknown';

// How each provider tier reads in the table (#2137 AC2), and what it means.
// A tier the server may report but this table does not know is rendered as the
// raw key rather than dropped — an unlabelled row is still a real number.
const PROVIDER_TIER_LABELS = {
  global: {
    label: 'Global',
    hint: 'A provider published to the whole installation — reachable by every user and every agent, with no team as the accounting anchor.',
  },
  system: {
    label: 'System',
    hint: 'A system-scoped provider, reachable by the teams it is explicitly assigned to.',
  },
  team: {
    label: 'Team',
    hint: 'A provider owned by one team — usage here is already anchored on that team.',
  },
  [UNKNOWN_GROUP_KEY]: {
    label: 'Unknown',
    hint: 'The provider that paid for these runs is no longer registered, or the runs predate provider-tier recording. Reported rather than guessed.',
  },
};

export function providerTierCell(key) {
  const known = PROVIDER_TIER_LABELS[key];
  if (known) return known;
  return { label: key || '—', hint: '' };
}

// Build a `userId -> display name` lookup from GET /api/users/directory.
// The usage store deliberately keeps only the stable account id (a display name
// copied into a billing-adjacent record would go stale), so the name is resolved
// at read time — and an id with no user record is labelled rather than dropped,
// exactly as the draft Share dialog labels a departed colleague.
export function userLabelIndex(directory) {
  const byId = new Map();
  for (const u of Array.isArray(directory) ? directory : []) {
    if (u && typeof u.id === 'string' && u.id) {
      byId.set(u.id, typeof u.displayName === 'string' && u.displayName ? u.displayName : u.id);
    }
  }
  return byId;
}

// Options for the page-level Team filter (#2694). Usage records carry the
// AGENT TEAM id (a role:'team' agent from GET /api/agents) as `teamId`, so the
// filter lists Agent Teams — not the legacy human access-scope "Team" collection
// (GET /api/admin/teams, only `default`), whose ids never match a record and
// therefore always narrowed to 0. Same re-key as the Skills Registry pickers
// (#2393/#2360). Label shows display name + id so two teams with the same name
// stay distinguishable; sorted by label, case-insensitively.
export function agentTeamFilterOptions(agents) {
  const byId = new Map();
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || a.role !== 'team' || typeof a.id !== 'string' || !a.id) continue;
    const name = typeof a.displayName === 'string' ? a.displayName.trim() : '';
    byId.set(a.id, { id: a.id, label: name && name !== a.id ? `${name} (${a.id})` : a.id });
  }
  return [...byId.values()].sort((x, y) => x.label.localeCompare(y.label, undefined, { sensitivity: 'base' }));
}

// How one `groupBy=user` key reads. `unknown` is NOT a person: it is the
// aggregator's bucket for a run with no resolvable charge (an autonomous run
// whose agent has no owner, or a record written before attribution existed), so
// it is named as a gap instead of being shown as an account.
export function userGroupCell(key, byId) {
  if (!key || key === UNKNOWN_GROUP_KEY) {
    return {
      label: 'Unattributed',
      hint: 'These runs could not be charged to a person — no requesting user and no agent owner, or they predate cost attribution.',
    };
  }
  const name = byId && byId.get ? byId.get(key) : null;
  if (name) return { label: name, hint: key };
  return { label: 'Deleted user', hint: key };
}

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

// Shared core for abbreviated token notation (#699, #1656). Rounds `n / factor`
// to at most `decimals` places with trailing zeros trimmed (so `1.20B` → `1.2B`,
// `156.00M` → `156M`) over an ordered unit table (largest factor first). Values
// under the smallest unit (1,000) are plain rounded integers, and a negative
// value still yields a clean string rather than a broken one. Non-finite → '0'.
function abbreviate(n, decimals, units) {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  const abs = Math.abs(v);
  if (abs < 1000) return String(Math.round(v));
  const pow = Math.pow(10, decimals);
  for (const [factor, suffix] of units) {
    if (abs >= factor) {
      // Number → String trims trailing zeros for us (1.2, not 1.20).
      const scaled = Math.round((v / factor) * pow) / pow;
      return `${scaled}${suffix}`;
    }
  }
  return String(Math.round(v));
}

// Abbreviated token count for chart axis ticks (#699): thousands as `k`,
// millions as `M`, billions as `B`, with at most one decimal (dropped when it
// adds nothing, e.g. `156M` not `156.0M`); values under 1,000 are plain
// integers. Non-finite → '0'. `B` carries values ≥ 10⁹ arbitrarily far.
const COMPACT_UNITS = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
export function formatCompact(n) {
  return abbreviate(n, 1, COMPACT_UNITS);
}

// Abbreviated token count for the summary KPI tiles (#1656). Same scheme as
// `formatCompact` but with up to *two* decimals (trailing zeros trimmed, so
// `1.21B`, `958.72M`, `301.72k`, but `1k`/`1M`/`1B` at exact boundaries) and an
// extra `T` (trillion) unit so very large totals still fit a 120px tile. Values
// under 1,000 stay plain integers (`385`); `0`, missing or non-finite → '0'.
// The detailed table and CSV/JSON exports keep full-precision `formatInt`.
const TILE_UNITS = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
export function formatTileCount(n) {
  return abbreviate(n, 2, TILE_UNITS);
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
  if (count === 0) {
    return { count: 0, total: null, input: null, output: null, cacheCreationInput: null, cacheReadInput: null };
  }
  const sum = (key) => items.reduce((acc, w) => {
    const v = w && w.tokens && Number.isFinite(w.tokens[key]) ? w.tokens[key] : 0;
    return acc + v;
  }, 0);
  return {
    count,
    total: Math.round(sum('total') / count),
    input: Math.round(sum('input') / count),
    output: Math.round(sum('output') / count),
    cacheCreationInput: Math.round(sum('cacheCreationInput') / count),
    cacheReadInput: Math.round(sum('cacheReadInput') / count),
  };
}

// Help copy for the ten Work-items summary tiles (#832, #1626). Kept here — pure,
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
    'Average total tokens (input, output, cache write and cache read) per attributed work item. Unattributed tokens are excluded, so this reflects the typical cost of resolving one issue ↔ PR chain.',
  avgInput:
    'Average input (prompt) tokens per attributed work item. Unattributed tokens are excluded.',
  avgOutput:
    'Average output (generated) tokens per attributed work item. Unattributed tokens are excluded.',
  avgCacheCreationInput:
    'Average cache write tokens (input tokens written into the provider prompt cache) per attributed work item. Unattributed tokens are excluded.',
  avgCacheReadInput:
    'Average cache read tokens (input tokens served from the provider prompt cache) per attributed work item. Unattributed tokens are excluded.',
};

// Plain-language help for the Statistics-tab summary tiles (#1151). The tiles
// otherwise show a bare number and a class name ("Cache write"/"Cache read")
// that only means something if you already know the provider's prompt-cache
// model. Keys mirror the tile ids: the two totals plus the four TOKEN_CLASSES.
export const STAT_TILE_HELP = {
  total:
    'Sum of all token classes (input, output, cache write and cache read) across every agent run in this period. '
    + 'Grouped by model, each run\'s tokens are split across the models it used, so the model rows add up to this total; '
    + 'runs that recorded no model are listed as "unknown".',
  invocations:
    'Number of model calls (agent runs) that produced these tokens in this period.',
  input:
    'Prompt tokens sent to the model — the conversation, instructions and context the agent reads in.',
  output:
    'Tokens the model generated in its replies.',
  cacheCreationInput:
    'Cache write — input tokens written into the provider prompt cache on first use. Charged once, then cheap to re-read on later runs.',
  cacheReadInput:
    'Cache read — input tokens served from the provider prompt cache instead of being re-sent in full, so a repeated context costs less than the first time.',
};

// Short label for the work-item attribution signal shown as "Signals" (table
// column) and "Tier" (per-run detail) — the raw labels flow/created/event/branch
// (TIER_LABEL) carry no meaning on their own (#1151). One string serves both
// surfaces so the definition never drifts between them. What each signal
// actually means (and how the strongest-signal-wins rule works) lives in the
// Token Usage help topic — help-topics/token-usage.md, #1885.
export const TIER_SIGNAL_HELP =
  'Attribution confidence — how strongly a run could be tied to this work item, strongest signal first: flow, created, event, branch.';

// Page-wide reminder that every figure on this page is a raw token count, not
// money (#1151). It sits directly above the figures it guards, so the RULE
// stays on the page; the reasoning (why nothing is priced here, and how to apply
// your own prices via the exports) moved to the help topic in #1885.
export const COST_NOTE =
  'Figures are token counts, not costs — apply your own per-model pricing.';

// Plain-language one-line page description (below the H1, next to the
// PageHelpButton). Everything the removed intro banner said beyond this line —
// what the page shows, how the two tabs differ, the attribution tiers, why
// nothing is priced — now lives in help-topics/token-usage.md (#1885, epic
// #1870). Single-sourced here so the copy stays unit-testable and never drifts
// from the JSX (the token-usage-view.js convention, #651).
export const PAGE_DESCRIPTION =
  'How many tokens your agents used against the model provider — the raw usage behind every agent run, so you can tell where the spend goes.';

// Build the flat-export download URL (#656) for a view. `kind` is
// 'summary' | 'work-items', `format` is 'csv' | 'json'. Carries the current
// time window (`since`, and `until` for a closed range, #2974) so the export
// matches what's on screen; the server applies the same team scope as the view
// endpoints.
export function buildExportUrl(kind, { since, until, format, team, groupBy, secondaryGroupBy } = {}) {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (until) params.set('until', until);
  // `team` narrows the export to a single team (#801); a blank/absent value
  // means "all teams" and is simply omitted so the export stays unfiltered.
  if (team) params.set('team', team);
  // #2440: carry the on-screen grouping so the summary export follows the view
  // (an aggregated pivot) instead of the raw dump. Both are omitted when absent,
  // so an export URL without a grouping is byte-identical to before.
  if (groupBy) params.set('groupBy', groupBy);
  if (secondaryGroupBy) params.set('secondaryGroupBy', secondaryGroupBy);
  params.set('format', format === 'json' ? 'json' : 'csv');
  return `/api/usage/${kind}/export?${params.toString()}`;
}

// #2440: the choices offered by the SECONDARY group-by dropdown for a given
// primary — every dimension except the primary itself, so a nonsensical
// self-cross (agent × agent) can never be selected. Empty selection ("None")
// is handled by the caller, restoring the single-dimension view.
export function secondaryGroupOptions(primary) {
  return GROUP_OPTIONS.filter((g) => g.key !== primary);
}

// #2440: how one group/subgroup key reads for ANY dimension, so the primary and
// secondary axes label their keys identically. `user` and `providerTier` keys
// are machine values named via the helpers above (and the `unknown` bucket is
// named as a gap, never a person/tier); every other dimension shows its raw key.
export function groupValueCell(dim, key, userNames) {
  if (dim === 'user') return userGroupCell(key, userNames);
  if (dim === 'providerTier') return providerTierCell(key);
  return { label: key || '—', hint: '' };
}

// ── Per-series visibility for the "Tokens per day" chart (#1707) ──────
// The legend toggles which token classes are drawn. Because one class (Cache
// read) routinely dwarfs the rest, the y-axis is driven by it and the smaller
// series become unreadable; hiding a class lets the remaining ones fill the
// plot. Visibility is represented as the set of *hidden* class keys (absence =
// shown), so the default — nothing hidden — is "all four visible", matching the
// pre-#1707 chart (AC9). The toggles affect ONLY the chart: the summary tiles,
// the data table and the CSV/JSON exports always iterate the full
// TOKEN_CLASSES regardless of what is hidden here (AC6).

const CLASS_KEYS = TOKEN_CLASSES.map((c) => c.key);

// Normalise an arbitrary hidden-set input (array / Set / junk) to a clean array
// of valid class keys in canonical display order, de-duplicated. A stored value
// naming a class that no longer exists is silently dropped.
export function sanitizeHiddenClasses(hidden) {
  const arr = hidden instanceof Set ? [...hidden] : Array.isArray(hidden) ? hidden : [];
  const set = new Set(arr);
  return CLASS_KEYS.filter((k) => set.has(k));
}

// Whether a class should be drawn given the current hidden set.
export function isClassVisible(hidden, key) {
  return !sanitizeHiddenClasses(hidden).includes(key);
}

// Flip one class in the hidden set (immutably). Unknown keys are ignored.
export function toggleHiddenClass(hidden, key) {
  if (!CLASS_KEYS.includes(key)) return sanitizeHiddenClasses(hidden);
  const set = new Set(sanitizeHiddenClasses(hidden));
  if (set.has(key)) set.delete(key); else set.add(key);
  return sanitizeHiddenClasses(set);
}

// The TOKEN_CLASSES entries currently drawn, in display order (empty when every
// class is hidden — the "No series selected" state, Open Q3 / AC edge).
export function visibleClassList(hidden) {
  return TOKEN_CLASSES.filter((c) => isClassVisible(hidden, c.key));
}

// Sum of the currently-visible token classes for one day — the height driver
// for that day's column and, across days, the y-axis scale. When nothing is
// hidden this equals the day's own `tokens.total`.
export function visibleTotalTokens(tokens, hidden) {
  return TOKEN_CLASSES.reduce(
    (sum, c) => (isClassVisible(hidden, c.key) ? sum + ((tokens && tokens[c.key]) || 0) : sum),
    0,
  );
}

// Largest visible-class total across all days — feeds niceScale so hiding the
// dominant cache series rescales (zooms in) the whole axis (AC5). 0 when there
// is no data or every class is hidden (niceScale then yields a flat axis).
export function visibleMaxTotal(points, hidden) {
  return (points || []).reduce((m, p) => Math.max(m, visibleTotalTokens(p.tokens, hidden)), 0);
}

// Stacked-bar segments (one per *visible* token class) for a single point, as
// height percentages of `maxTotal`. Skips hidden classes (#1707) and
// zero-height classes so the DOM stays lean. `hidden` defaults to "nothing
// hidden" (all four drawn), so callers that pass no visibility set behave
// exactly as before.
export function stackSegments(tokens, maxTotal, hidden) {
  if (!(maxTotal > 0)) return [];
  return TOKEN_CLASSES
    .filter((c) => isClassVisible(hidden, c.key))
    .map(({ key, label }) => ({ key, label, value: (tokens && tokens[key]) || 0 }))
    .filter((s) => s.value > 0)
    .map((s) => ({ ...s, heightPct: (s.value / maxTotal) * 100 }));
}

// ── Cross-reload persistence of the hidden set (#1707 AC10 / Open Q2) ──
// Per-username localStorage, mirroring `assistModel.<username>` /
// `agentChat.fontSize.<username>` so two users on one shared browser never
// inherit each other's chart view. Session-only survival across Refresh /
// range / Group-by changes comes for free from React state; this adds the
// recommended cross-reload persistence on top.
export const HIDDEN_STORAGE_PREFIX = 'tokenUsage.hiddenSeries.';

export function hiddenStorageKey(username) {
  return HIDDEN_STORAGE_PREFIX + (username || 'anon');
}

// Read + sanitize the stored hidden set. Returns [] (all visible) when unset,
// unreadable or corrupt. `store` defaults to window.localStorage, injectable
// for tests.
export function loadHiddenClasses(username, store) {
  const ls = store || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!ls) return [];
  try {
    const raw = ls.getItem(hiddenStorageKey(username));
    if (!raw) return [];
    return sanitizeHiddenClasses(JSON.parse(raw));
  } catch {
    return [];
  }
}

// Persist the hidden set (best-effort — a private-mode / quota failure is
// swallowed; the in-memory React state remains authoritative for the visit).
export function saveHiddenClasses(username, hidden, store) {
  const ls = store || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!ls) return;
  try {
    ls.setItem(hiddenStorageKey(username), JSON.stringify(sanitizeHiddenClasses(hidden)));
  } catch {
    /* ignore */
  }
}

// ── "Tokens per day" by the selected Group-by dimension (#2973) ──────
// With Group by = Day the chart keeps its token-class stacks (above). For every
// other dimension it stacks each day's bar by group value instead, fed by a
// `groupBy=<dim>&secondaryGroupBy=day` summary: every group carries one
// subgroup per day, and those cells are exactly the figures the table rows
// add up from (#2972 splits a multi-model turn across its models), so a day's
// stack sums to that day's share of the table.

// At most this many group values get their own series; the rest fold into one
// "Other" series so the legend and the palette stay readable (the issue's N≈8,
// one per categorical colour slot).
export const CHART_SERIES_LIMIT = 8;

// Key of the folded remainder. Not a value any dimension can produce (keys are
// agent/team/user ids, model/provider names, tiers or dates).
export const OTHER_SERIES_KEY = '__other__';

// One colour per series slot, in fixed order (#2973 AC10): theme tokens stepped
// per theme in tokens.css so every slot clears 3:1 on the chart surface. "Other"
// is a neutral grey so it never reads as one more group value.
export const SERIES_COLORS = [
  'var(--eb-chart-series-1)',
  'var(--eb-chart-series-2)',
  'var(--eb-chart-series-3)',
  'var(--eb-chart-series-4)',
  'var(--eb-chart-series-5)',
  'var(--eb-chart-series-6)',
  'var(--eb-chart-series-7)',
  'var(--eb-chart-series-8)',
];
export const OTHER_SERIES_COLOR = 'var(--eb-chart-series-other)';

const isTimeKey = (g) => g === 'day' || g === 'hour';

// The dimension a chart summary was computed for: the primary `groupBy` when
// the response is split by day or hour, else 'day'. Read from the response
// rather than the select so a still-loading request never draws one
// dimension's data under another dimension's labels.
export function chartDimension(summary) {
  return summary && isTimeKey(summary.secondaryGroupBy) && summary.groupBy && !isTimeKey(summary.groupBy)
    ? summary.groupBy
    : 'day';
}

// The time key a chart summary's points carry — 'hour' or 'day' (#2974). Read
// from the response for the same reason as chartDimension.
export function chartGranularity(summary) {
  return summary && (summary.groupBy === 'hour' || summary.secondaryGroupBy === 'hour') ? 'hour' : 'day';
}

// The chart request for the selected primary dimension. The secondary "then by"
// is deliberately not an input (#2973 AC11): it changes only the table.
// `granularity` (#2974) is the server time key the bars are built from:
// 'hour' for hourly bars, else 'day' (week / month are rolled up from days).
export function chartSummaryUrl({ since, until, team, groupBy, granularity } = {}) {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (until) params.set('until', until);
  if (team) params.set('team', team);
  const time = granularity === 'hour' ? 'hour' : 'day';
  const dim = GROUP_OPTIONS.some((g) => g.key === groupBy) && groupBy !== 'day' ? groupBy : null;
  params.set('groupBy', dim || time);
  if (dim) params.set('secondaryGroupBy', time);
  return `/api/usage/summary?${params.toString()}`;
}

// Build the stacked-by-group series from a `secondaryGroupBy=day` summary.
//   -> { series: [{ key, total, color, members }], points: [{ day, values, total }] }
// `series` keeps the server's order (total desc, key asc): the largest `limit`
// group values each get a slot colour, and only when there are MORE than
// `limit` values the remainder is summed into one trailing "Other" series
// (`members` lists the folded keys). Colours follow the series, not the day, so
// a value that appears on only some days keeps one colour across the chart.
// `points` are chronological; `values` maps series key → that day's tokens and
// omits a series with nothing on that day.
export function buildGroupDaySeries(summary, limit = CHART_SERIES_LIMIT) {
  const groups = summary && Array.isArray(summary.groups) ? summary.groups : [];
  const fold = groups.length > limit;
  const named = fold ? groups.slice(0, limit) : groups;
  const seriesOf = new Map();
  const series = named.map((g, i) => {
    const s = { key: g.key, total: 0, color: SERIES_COLORS[i % SERIES_COLORS.length], members: [g.key] };
    seriesOf.set(g.key, s);
    return s;
  });
  if (fold) {
    const other = { key: OTHER_SERIES_KEY, total: 0, color: OTHER_SERIES_COLOR, members: [] };
    for (const g of groups.slice(limit)) {
      other.members.push(g.key);
      seriesOf.set(g.key, other);
    }
    series.push(other);
  }
  const byDay = new Map();
  for (const g of groups) {
    const s = seriesOf.get(g.key);
    for (const sub of Array.isArray(g.subgroups) ? g.subgroups : []) {
      const value = (sub.tokens && sub.tokens.total) || 0;
      if (!value) continue;
      let p = byDay.get(sub.key);
      if (!p) {
        p = { day: sub.key, values: {}, total: 0 };
        byDay.set(sub.key, p);
      }
      p.values[s.key] = (p.values[s.key] || 0) + value;
      p.total += value;
      s.total += value;
    }
  }
  const points = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return { series, points };
}

// How a series reads in the legend and tooltips: the table's own label for the
// group value (user names, provider-tier labels, the unknown bucket named the
// same way — groupValueCell), or "Other" for the folded remainder.
export function seriesLabel(dim, series, userNames) {
  if (series.key === OTHER_SERIES_KEY) {
    const n = series.members.length;
    return { label: 'Other', hint: `${n} more ${n === 1 ? 'value' : 'values'} combined` };
  }
  return groupValueCell(dim, series.key, userNames);
}

// Chart title for a dimension: "Tokens per day" for Day (unchanged), else
// "Tokens per day by <Dimension>". `unit` (#2974) names the bar size —
// hour / day / week / month.
export function chartTitle(dim, unit = 'day') {
  const opt = dim === 'day' ? null : GROUP_OPTIONS.find((g) => g.key === dim);
  return opt ? `Tokens per ${unit} by ${opt.label}` : `Tokens per ${unit}`;
}

// Legend visibility for group-value series. Unlike token classes, the keys are
// open-ended and belong to one dimension, so the hidden set is kept per
// dimension ({ [dim]: [seriesKey] }) — hiding a model never hides an agent of
// the same name, and each dimension's choice survives switching away and back,
// Refresh, range and team changes within the visit (#1707 / #2973 AC7).
export function hiddenSeriesFor(hiddenByDim, dim) {
  const list = hiddenByDim && Array.isArray(hiddenByDim[dim]) ? hiddenByDim[dim] : [];
  return list.filter((k) => typeof k === 'string');
}

export function toggleHiddenSeries(hiddenByDim, dim, key) {
  const cur = hiddenSeriesFor(hiddenByDim, dim);
  const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
  return { ...(hiddenByDim || {}), [dim]: next };
}

// Visible stack for one day: the drawn segments bottom-up in series order (so
// a series sits at the same place in every bar), skipping hidden and empty
// series, plus their sum — the bar height driver.
export function groupStack(point, series, hidden) {
  const off = new Set(hidden || []);
  const segments = (series || [])
    .filter((s) => !off.has(s.key))
    .map((s) => ({ key: s.key, color: s.color, value: (point && point.values && point.values[s.key]) || 0 }))
    .filter((s) => s.value > 0);
  return { segments, total: segments.reduce((sum, s) => sum + s.value, 0) };
}

// Largest visible stack across all days — feeds niceScale, so hiding the
// dominant series rescales the axis (#1707 AC5 / #2973 AC7).
export function groupVisibleMax(points, series, hidden) {
  return (points || []).reduce((m, p) => Math.max(m, groupStack(p, series, hidden).total), 0);
}
