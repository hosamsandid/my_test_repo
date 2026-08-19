// Pure, framework-free helpers that turn a trigger's stored schedule into a
// plain-language sentence a non-expert can read at a glance — a raw 5-field
// cron expression ("0 9 * * 1-5" → "At 09:00, Monday to Friday") via
// `humanizeCron`, or a one-shot `once` trigger's ISO timestamp
// ("2026-05-01T09:00:00Z" → "1 May 2026 at 09:00 UTC") via `humanizeOnce`.
//
// Why a second cron helper next to agent-chat/cron-format.js: that module's
// `describeCron` describes the chat builder's *own* limited UI state (daily /
// weekly / hourly / …) and returns '' for anything it can't round-trip through
// its builder — including ranges (1-5) and lists (1,3,5), i.e. most real
// hand-written crons, and even its own placeholder `0 9 * * 1-5`. The Triggers
// page (ScheduledJobs.jsx) shows arbitrary already-stored crons, so it needs a
// describer that reads a raw string directly and covers ranges/lists/steps.
//
// Contract: humanizeCron(raw) → a human sentence, or '' when the expression is
// too complex to describe confidently (the caller then just shows the raw cron,
// never a wrong description). Unit-tested without a React/DOM runtime.

export const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Join a list of labels into "a", "a and b", "a, b and c".
function joinList(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// Parse one cron field into a normalized descriptor, or null when the shape is
// not one we describe. `min`/`max` bound the numeric range. For day-of-week
// (`wrap: true`) cron additionally accepts 7 as Sunday, so the valid raw range
// is 0–7 and 7 is normalized to 0 *after* validation (9 must still be rejected).
function parseField(field, min, max, wrap = false) {
  if (field === '*') return { kind: 'every' };

  const rawMax = wrap ? 7 : max;
  const norm = n => (wrap && n === 7 ? 0 : n);
  const inRange = n => n >= min && n <= rawMax;

  const step = field.match(/^\*\/(\d+)$/);
  if (step) {
    const n = parseInt(step[1], 10);
    if (n >= 1) return { kind: 'step', step: n };
    return null;
  }

  const range = field.match(/^(\d+)-(\d+)$/);
  if (range) {
    const from = parseInt(range[1], 10);
    const to = parseInt(range[2], 10);
    if (!inRange(from) || !inRange(to) || from > to) return null;
    return { kind: 'range', from: norm(from), to: norm(to) };
  }

  if (/^\d+(,\d+)*$/.test(field)) {
    const rawValues = field.split(',').map(v => parseInt(v, 10));
    if (rawValues.some(n => !inRange(n))) return null;
    // Normalize (7 → Sunday) and de-duplicate while keeping order.
    const seen = new Set();
    const uniq = rawValues.map(norm).filter(n => (seen.has(n) ? false : seen.add(n)));
    if (uniq.length === 1) return { kind: 'single', value: uniq[0] };
    return { kind: 'list', values: uniq };
  }

  return null;
}

const pad = n => String(n).padStart(2, '0');

// Describe the day-of-week / day-of-month / month portion. Returns a clause like
// "Monday to Friday", "on day 1 of the month", or '' when all three are '*'.
// Returns null when a field is present but not describable.
function describeDayPart(domF, monF, dowF) {
  const clauses = [];

  // Day-of-week
  if (dowF.kind !== 'every') {
    if (dowF.kind === 'single') clauses.push(`on ${DOW_LABELS[dowF.value]}`);
    else if (dowF.kind === 'range') clauses.push(`on ${DOW_LABELS[dowF.from]} to ${DOW_LABELS[dowF.to]}`);
    else if (dowF.kind === 'list') clauses.push(`on ${joinList(dowF.values.map(v => DOW_LABELS[v]))}`);
    else return null; // a step on day-of-week is unusual — fall back to raw
  }

  // Day-of-month
  if (domF.kind !== 'every') {
    if (domF.kind === 'single') clauses.push(`on day ${domF.value} of the month`);
    else if (domF.kind === 'list') clauses.push(`on day ${joinList(domF.values.map(String))} of the month`);
    else if (domF.kind === 'range') clauses.push(`on day ${domF.from} to ${domF.to} of the month`);
    else return null;
  }

  // Month
  if (monF.kind !== 'every') {
    if (monF.kind === 'single') clauses.push(`in ${MONTH_LABELS[monF.value - 1]}`);
    else if (monF.kind === 'list') clauses.push(`in ${joinList(monF.values.map(v => MONTH_LABELS[v - 1]))}`);
    else if (monF.kind === 'range') clauses.push(`from ${MONTH_LABELS[monF.from - 1]} to ${MONTH_LABELS[monF.to - 1]}`);
    else return null;
  }

  return clauses.join(', ');
}

export function humanizeCron(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 5) return '';

  const minF = parseField(parts[0], 0, 59);
  const hrF = parseField(parts[1], 0, 23);
  const domF = parseField(parts[2], 1, 31);
  const monF = parseField(parts[3], 1, 12);
  const dowF = parseField(parts[4], 0, 6, true);
  if (!minF || !hrF || !domF || !monF || !dowF) return '';

  const dayPart = describeDayPart(domF, monF, dowF);
  if (dayPart === null) return '';
  const hasDay = dayPart !== '';

  // ── High-frequency shapes: "every N minutes" / "every N hours" ──
  // Only when there is no day/month constraint (those combos read awkwardly and
  // are better shown raw).
  if (!hasDay) {
    if (minF.kind === 'step' && hrF.kind === 'every')
      return minF.step === 1 ? 'Every minute' : `Every ${minF.step} minutes`;
    if (minF.kind === 'single' && minF.value === 0 && hrF.kind === 'every')
      return 'Every hour, on the hour';
    if (minF.kind === 'single' && hrF.kind === 'every')
      return `Every hour at :${pad(minF.value)}`;
    if (minF.kind === 'single' && minF.value === 0 && hrF.kind === 'step')
      return hrF.step === 1 ? 'Every hour, on the hour' : `Every ${hrF.step} hours`;
  }

  // ── Fixed time-of-day: both minute and hour are single values ──
  if (minF.kind === 'single' && hrF.kind === 'single') {
    const time = `At ${pad(hrF.value)}:${pad(minF.value)}`;
    if (!hasDay) return `${time}, every day`;
    return `${time}, ${dayPart}`;
  }

  // Anything else (e.g. a minute list at a fixed hour) — not worth a clumsy
  // sentence; the caller shows the raw cron.
  return '';
}

// Days per month for a light validity check (Feb allows 29 so leap years pass;
// we never claim precision beyond "is this a plausible calendar date").
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Turn a one-shot `once` trigger's ISO timestamp into a plain-language moment —
// "2026-05-01T09:00:00Z" → "1 May 2026 at 09:00 UTC". Same fail-safe contract as
// humanizeCron: return '' for any shape we can't describe confidently (an
// out-of-range field, a numeric offset we won't mislabel, or junk), so the
// caller just shows the raw timestamp and never a wrong description.
//
// Parses the string's own fields directly (no Date construction) so the result
// is deterministic and never shifted by the runtime's local timezone.
export function humanizeOnce(raw) {
  if (!raw || typeof raw !== 'string') return '';

  // date [ (T|space) HH:MM (:SS)? (.fraction)? ] [ Z ]
  const m = raw.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(Z)?)?$/
  );
  if (!m) return '';

  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10); // 1–12
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12) return '';
  if (day < 1 || day > DAYS_IN_MONTH[month - 1]) return '';

  const date = `${day} ${MONTH_LABELS[month - 1]} ${year}`;

  // Date only — no time component.
  if (m[4] === undefined) return date;

  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  if (hour > 23 || minute > 59) return '';

  const zone = m[6] ? ' UTC' : '';
  return `${date} at ${pad(hour)}:${pad(minute)}${zone}`;
}
