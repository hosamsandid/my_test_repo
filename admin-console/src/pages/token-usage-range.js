// React-free time-range and time-bucket helpers for the Token Usage page
// (#2974, Phase 2 of the chart rework). Everything here is UTC — calendar
// boundaries (Today, This week, This month, custom dates) and every bucket —
// matching the server's `day` / `hour` keys (the first 10 / 13 characters of a
// record's ISO `ts`) and the export. Pure so the window and bucket arithmetic
// is unit-testable under `node --test`; TokenUsage.jsx is a thin shell over it.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The range presets shared by the Statistics, Work items and Agent → model
// tabs, in display order. `custom` is the from–to date picker.
export const RANGE_PRESETS = [
  { key: '24h', label: 'Last 24 hours' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: 'thisWeek', label: 'This week' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom range…' },
];

export const DEFAULT_RANGE = { key: '7d' };

// Bucket sizes offered for the Statistics chart. `auto` resolves via autoBucket.
export const BUCKET_OPTIONS = [
  { key: 'auto', label: 'Auto' },
  { key: 'hour', label: 'Hour' },
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
];

// Hour bars are offered only up to this span, so the chart never draws more
// than ~170 bars (7 × 24 = 168, plus a partial one).
export const HOUR_BUCKET_MAX_MS = 7 * DAY_MS;

const pad2 = (n) => String(n).padStart(2, '0');

// UTC midnight of the day containing `ms`.
function startOfDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Monday 00:00 UTC of the week containing `ms` (ISO weeks start on Monday).
function startOfWeek(ms) {
  const day = startOfDay(ms);
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0 … Sunday = 6
  return day - dow * DAY_MS;
}

// The 1st of the month (00:00 UTC) containing `ms`, shifted by `offset` months.
function startOfMonth(ms, offset = 0) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1);
}

// 'YYYY-MM-DD' → UTC midnight in ms, or null when it is not a real date.
export function parseDateInput(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  // Date.parse rolls 2026-02-31 over to March; reject it instead.
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

// ms → 'YYYY-MM-DD' (UTC), the value shape of an <input type="date">.
export function dateInputValue(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Why a custom from–to range cannot be applied, or null when it can (AC3).
export function customRangeError(from, to) {
  if (!from || !to) return 'Choose both a start and an end date.';
  const a = parseDateInput(from);
  const b = parseDateInput(to);
  if (a == null || b == null) return 'Enter dates as YYYY-MM-DD.';
  if (b < a) return 'The end date is before the start date.';
  return null;
}

// The UTC window a range selects, as ms: { start, end } — `start` null means
// "from the earliest record" (All time), and `end` is exclusive. Open-ended
// presets end at `now`; Yesterday, Last month and a custom range end at a
// calendar boundary.
export function rangeBounds(range, now = Date.now()) {
  const key = range && range.key;
  const today = startOfDay(now);
  switch (key) {
    case '24h': return { start: now - DAY_MS, end: now };
    case 'today': return { start: today, end: now };
    case 'yesterday': return { start: today - DAY_MS, end: today };
    case 'thisWeek': return { start: startOfWeek(now), end: now };
    case '30d': return { start: now - 30 * DAY_MS, end: now };
    case 'thisMonth': return { start: startOfMonth(now), end: now };
    case 'lastMonth': return { start: startOfMonth(now, -1), end: startOfMonth(now) };
    case '90d': return { start: now - 90 * DAY_MS, end: now };
    case 'all': return { start: null, end: now };
    case 'custom': {
      // Both dates inclusive: [from 00:00, to + 1 day 00:00) (AC2).
      if (customRangeError(range.from, range.to)) break;
      return { start: parseDateInput(range.from), end: parseDateInput(range.to) + DAY_MS };
    }
    default: break;
  }
  return { start: now - 7 * DAY_MS, end: now }; // '7d' and anything unknown
}

// The API query for a range: ISO `since` (inclusive) and `until` (exclusive),
// each null when unbounded. An open-ended preset sends no `until`, so a record
// that lands after the page loaded still counts.
export function rangeQuery(range, now = Date.now()) {
  const { start, end } = rangeBounds(range, now);
  const key = range && range.key;
  const closed = key === 'yesterday' || key === 'lastMonth'
    || (key === 'custom' && !customRangeError(range.from, range.to));
  return {
    since: start == null ? null : new Date(start).toISOString(),
    until: closed ? new Date(end).toISOString() : null,
  };
}

// A `since=…&until=…&` query fragment for concatenating into a usage URL.
export function rangeQueryString({ since, until } = {}) {
  return `${since ? `since=${encodeURIComponent(since)}&` : ''}${until ? `until=${encodeURIComponent(until)}&` : ''}`;
}

// Auto bucket thresholds (AC4): Hour ≤ 2 days, Day ≤ 60 days, Week ≤ 365 days,
// Month above.
export function autoBucket(spanMs) {
  if (!(spanMs > 0)) return 'day';
  if (spanMs <= 2 * DAY_MS) return 'hour';
  if (spanMs <= 60 * DAY_MS) return 'day';
  if (spanMs <= 365 * DAY_MS) return 'week';
  return 'month';
}

// Whether the Hour bucket may be chosen for a span (null = not yet known).
export function hourBucketAllowed(spanMs) {
  return typeof spanMs === 'number' && spanMs > 0 && spanMs <= HOUR_BUCKET_MAX_MS;
}

// The bucket actually drawn for a choice. Auto follows the thresholds; a
// manual Hour on a span too long for it falls back to Auto's choice. With the
// span not yet known (All time while loading) Auto draws days.
export function resolveBucket(choice, spanMs) {
  if (choice === 'hour') return spanMs == null || hourBucketAllowed(spanMs) ? 'hour' : autoBucket(spanMs);
  if (choice === 'day' || choice === 'week' || choice === 'month') return choice;
  return spanMs == null ? 'day' : autoBucket(spanMs);
}

// How the chosen bucket reads on screen, e.g. "Auto (Week)" (AC4).
export function bucketDisplay(choice, resolved) {
  const label = (k) => (BUCKET_OPTIONS.find((o) => o.key === k) || { label: k }).label;
  return choice === 'auto' || !BUCKET_OPTIONS.some((o) => o.key === choice)
    ? `Auto (${label(resolved)})`
    : label(choice);
}

// The server time key the chart must request for a bucket: hourly bars need
// `hour`, everything else is rolled up from `day`.
export function sourceGranularity(bucket) {
  return bucket === 'hour' ? 'hour' : 'day';
}

// A server time key ('YYYY-MM-DD' or 'YYYY-MM-DDTHH') → its UTC start in ms, or
// null for a missing / malformed key (the `unknown` bucket never makes a bar).
export function parseTimeKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}))?$/.exec(key);
  if (!m) return null;
  const day = parseDateInput(m[1]);
  if (day == null) return null;
  if (m[2] == null) return day;
  const h = Number(m[2]);
  return h < 24 ? day + h * HOUR_MS : null;
}

// Start (ms) of the bucket containing `ms`.
export function bucketStart(ms, bucket) {
  if (bucket === 'hour') return Math.floor(ms / HOUR_MS) * HOUR_MS;
  if (bucket === 'week') return startOfWeek(ms);
  if (bucket === 'month') return startOfMonth(ms);
  return startOfDay(ms);
}

// Start (ms) of the bucket after the one starting at `start`.
export function nextBucketStart(start, bucket) {
  if (bucket === 'hour') return start + HOUR_MS;
  if (bucket === 'week') return start + 7 * DAY_MS;
  if (bucket === 'month') return startOfMonth(start, 1);
  return start + DAY_MS;
}

// Stable key of the bucket starting at `start`.
export function bucketKey(start, bucket) {
  const iso = new Date(start).toISOString();
  if (bucket === 'hour') return iso.slice(0, 13);
  if (bucket === 'month') return iso.slice(0, 7);
  return iso.slice(0, 10);
}

// Earliest start among the parsable keys of a series, or null (All time: the
// range starts at the earliest record).
export function earliestKeyStart(points) {
  let min = null;
  for (const p of points || []) {
    const ms = parseTimeKey(p && p.day);
    if (ms != null && (min == null || ms < min)) min = ms;
  }
  return min;
}

// Re-bucket a chronological per-day / per-hour series (`points[].day` holding
// the server key) into `bucket`-sized bars covering [start, end):
//   -> [{ key, start, end, ...combined }]
// Every bucket inside the range is emitted, empty ones as `empty()` (AC5); a
// source point outside the range still gets its bucket so the bars always add
// up to the totals (AC6), and an unparsable key makes no bar at all. `merge`
// folds a source point into a bucket's accumulator.
export function rebucket(points, { bucket, start, end, empty, merge }) {
  const byStart = new Map();
  const at = (s) => {
    let b = byStart.get(s);
    if (!b) {
      b = { key: bucketKey(s, bucket), start: s, end: nextBucketStart(s, bucket), ...empty() };
      byStart.set(s, b);
    }
    return b;
  };
  if (start != null && end != null && end > start) {
    for (let s = bucketStart(start, bucket); s < end; s = nextBucketStart(s, bucket)) at(s);
  }
  for (const p of points || []) {
    const ms = parseTimeKey(p && p.day);
    if (ms == null) continue;
    merge(at(bucketStart(ms, bucket)), p);
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

// Re-bucket the token-class series (buildDaySeries points).
export function rebucketClassPoints(points, opts) {
  return rebucket(points, {
    ...opts,
    empty: () => ({ tokens: { input: 0, output: 0, cacheCreationInput: 0, cacheReadInput: 0, total: 0 }, invocations: 0 }),
    merge: (b, p) => {
      for (const k of Object.keys(b.tokens)) b.tokens[k] += (p.tokens && p.tokens[k]) || 0;
      b.invocations += p.invocations || 0;
    },
  });
}

// Re-bucket the group-value series (buildGroupDaySeries points).
export function rebucketGroupPoints(points, opts) {
  return rebucket(points, {
    ...opts,
    empty: () => ({ values: {}, total: 0 }),
    merge: (b, p) => {
      for (const [k, v] of Object.entries(p.values || {})) b.values[k] = (b.values[k] || 0) + v;
      b.total += p.total || 0;
    },
  });
}

// The dates / hours a bar covers, clipped to the range so a partial first or
// last bucket says what it really holds (edge case: "This week" on a
// Wednesday shows Monday – Wednesday).
export function bucketRangeText(point, bucket, rangeStart, rangeEnd) {
  const from = rangeStart != null ? Math.max(point.start, rangeStart) : point.start;
  const to = rangeEnd != null ? Math.min(point.end, rangeEnd) : point.end;
  if (bucket === 'hour') {
    const d = new Date(point.start);
    return `${dateInputValue(point.start)} ${pad2(d.getUTCHours())}:00–${pad2((d.getUTCHours() + 1) % 24)}:00 UTC`;
  }
  const first = dateInputValue(from);
  const last = dateInputValue(Math.max(from, to - 1));
  return first === last ? `${first} (UTC)` : `${first} – ${last} (UTC)`;
}

// X-axis labels for a series, one per point (null = no label under that bar)
// (AC7): hour "HH:00" — with the date "MM-DD HH:00" on the first label and
// wherever the day changes — day "MM-DD", week "week of MM-DD", month
// "YYYY-MM". The #699 thinning is kept: at most ~12 labels, always the first.
export function axisLabels(points, bucket) {
  const list = points || [];
  const stride = Math.max(1, Math.ceil(list.length / 12));
  let lastDay = null;
  return list.map((p, i) => {
    if (i % stride !== 0) return null;
    const iso = new Date(p.start).toISOString();
    if (bucket === 'hour') {
      const day = iso.slice(0, 10);
      const hour = `${iso.slice(11, 13)}:00`;
      const label = day !== lastDay ? `${iso.slice(5, 10)} ${hour}` : hour;
      lastDay = day;
      return label;
    }
    if (bucket === 'week') return `week of ${iso.slice(5, 10)}`;
    if (bucket === 'month') return iso.slice(0, 7);
    return iso.slice(5, 10);
  });
}

// Column gap / minimum width for a bar count, so up to ~170 hourly bars still
// fit beside each other instead of overflowing the card.
export function barLayout(count) {
  if (count > 100) return { gap: 1, minWidth: 1 };
  if (count > 40) return { gap: 2, minWidth: 2 };
  return { gap: 'var(--eb-space-2)', minWidth: 8 };
}

// "Tokens per <unit>" for a resolved bucket.
export function bucketUnit(bucket) {
  return bucket === 'hour' || bucket === 'week' || bucket === 'month' ? bucket : 'day';
}
