// React-free helpers for the stat-tile comparison with the previous period
// (#2976). Each Statistics tile shows how its figure changed against the window
// of the same length directly before the current one, e.g. "▲ +12% vs previous
// 7 days". Pure so the window and the percentage are covered by `node --test`.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The window of the same length ending where `[start, end)` begins, or null
// when there is none to compare against (All time has no start).
//   -> { start, end, since, until } (ms and the matching ISO query values)
export function previousWindow({ start, end } = {}) {
  if (typeof start !== 'number' || typeof end !== 'number' || !(end > start)) return null;
  const prevStart = start - (end - start);
  return { start: prevStart, end: start, since: new Date(prevStart).toISOString(), until: new Date(start).toISOString() };
}

// The summary request for the previous window. Only `totals` is read, so the
// cheapest grouping (Day) is asked for. `team` narrows like every usage view.
export function previousSummaryUrl(prev, team) {
  if (!prev) return null;
  const params = new URLSearchParams();
  params.set('since', prev.since);
  params.set('until', prev.until);
  if (team) params.set('team', team);
  params.set('groupBy', 'day');
  return `/api/usage/summary?${params.toString()}`;
}

const trim = (n) => String(Math.round(n * 10) / 10);
const plural = (n, word) => `${trim(n)} ${word}${trim(n) === '1' ? '' : 's'}`;

// How the previous window reads: "previous 7 days", "previous 24 hours",
// "previous 2.5 days". Under two days it counts hours, else days.
export function previousPeriodLabel(lengthMs) {
  if (!(lengthMs > 0)) return 'previous period';
  if (lengthMs < 2 * DAY_MS) {
    const hours = lengthMs / HOUR_MS;
    return hours < 1 ? `previous ${plural(lengthMs / 60000, 'minute')}` : `previous ${plural(hours, 'hour')}`;
  }
  return `previous ${plural(lengthMs / DAY_MS, 'day')}`;
}

// The change of one figure (AC8): (current − previous) / previous, as
//   { kind: 'up' | 'down' | 'same' | 'new', pct, text }
// `text` carries an arrow AND a sign, so the direction never depends on colour
// (AC9). A previous value of 0 reads "new" (or "same" when both are 0); a
// change that rounds to 0% still says which way it went ("<1%").
export function periodChange(current, previous) {
  const cur = Number.isFinite(current) ? current : 0;
  const prev = Number.isFinite(previous) ? previous : 0;
  if (prev === 0) {
    return cur > 0 ? { kind: 'new', pct: null, text: '▲ new' } : { kind: 'same', pct: 0, text: '±0%' };
  }
  const pct = ((cur - prev) / prev) * 100;
  if (cur === prev) return { kind: 'same', pct: 0, text: '±0%' };
  const abs = Math.abs(pct);
  const shown = Math.round(abs) === 0 ? '<1%' : `${Math.round(abs)}%`;
  return pct > 0
    ? { kind: 'up', pct, text: `▲ +${shown}` }
    : { kind: 'down', pct, text: `▼ −${shown}` };
}

// Text colours per direction. The `-text` status tokens are the ones tuned for
// text on the card surface in every theme (#2933), so they clear WCAG AA where
// the plain status fills do not. More usage is flagged as a warning, less as a
// success; no change and "new" stay neutral beyond the arrow.
export const CHANGE_COLOR = {
  up: 'var(--eb-status-warning-text)',
  down: 'var(--eb-status-success-text)',
  same: 'var(--eb-text-secondary)',
  new: 'var(--eb-status-warning-text)',
};

// The tile line, e.g. "▲ +12% vs previous 7 days", with its colour and a
// hover text naming the previous figure. Null when there is nothing to compare
// against (All time, or the previous summary not loaded yet).
export function tileComparison(current, previous, lengthMs, formatPrevious = String) {
  if (previous == null) return null;
  const change = periodChange(current, previous);
  const period = previousPeriodLabel(lengthMs);
  return {
    ...change,
    color: CHANGE_COLOR[change.kind],
    text: `${change.text} vs ${period}`,
    title: `${period[0].toUpperCase()}${period.slice(1)}: ${formatPrevious(previous)}`,
  };
}

// Whether a previous-period response is for `prev` — the hook keeps the last
// response while a new window loads, and a stale one must not be compared.
export function isPreviousSummaryFor(summary, prev) {
  return !!(summary && prev && summary.since === prev.since && summary.until === prev.until && summary.totals);
}
