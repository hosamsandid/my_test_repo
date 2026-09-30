// Pure time-zone and run-status helpers for the Triggers panel (#2628).
//
// The agent's scheduler evaluates cron expressions (and naive `once` times)
// in one fixed zone — `_TRIGGER_TZ` in agent-entrypoint.py — and reports it
// back as `timeZone` in its trigger-status.json. The console states that zone
// next to every schedule and, when the viewer's browser runs in a different
// zone, the local equivalent, so "Daily at 09:00" is never read in the wrong
// zone. The per-trigger next/last run and "cannot be scheduled" state come
// from the same status file; this module only formats them.
//
// Kept free of React so node:test can cover it (#651).

/** The zone the agent scheduler runs in when the agent hasn't reported one yet. */
export const TRIGGER_TIME_ZONE = 'Europe/Berlin';

/** The viewer's IANA time zone ('UTC' if the runtime can't tell). */
export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The scheduler zone from a trigger-status payload, else the default. */
export function schedulerTimeZone(status) {
  const tz = status && typeof status.timeZone === 'string' ? status.timeZone.trim() : '';
  return tz || TRIGGER_TIME_ZONE;
}

// Wall-clock parts of `date` in `timeZone`, as numbers.
function wallParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const out = {};
  for (const p of parts) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** Minutes `timeZone` is ahead of UTC at instant `date` (Berlin summer → 120). */
export function zoneOffsetMinutes(timeZone, date = new Date()) {
  const p = wallParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const whole = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - whole) / 60000);
}

/** True when the two zones are at the same UTC offset at `date`. */
export function sameOffset(zoneA, zoneB, date = new Date()) {
  return zoneOffsetMinutes(zoneA, date) === zoneOffsetMinutes(zoneB, date);
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 'HH:MM' when a cron expression fires at one fixed wall-clock time per day
 * (single numeric minute and hour fields), else null — "every 15 minutes" or
 * "hourly at :05" read the same in every zone that differs by whole hours.
 */
export function cronWallTime(cron) {
  if (typeof cron !== 'string') return null;
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  if (!/^\d{1,2}$/.test(f[0]) || !/^\d{1,2}$/.test(f[1])) return null;
  const m = Number(f[0]); const h = Number(f[1]);
  if (m > 59 || h > 23) return null;
  return `${pad2(h)}:${pad2(m)}`;
}

/**
 * The viewer-local equivalent of wall time `hhmm` in `fromZone`, on the day of
 * `date` — e.g. ('09:00', 'Europe/Berlin', 'America/New_York') → '03:00'.
 * A day shift is appended (' (+1 day)' / ' (−1 day)'). Null when the zones
 * share the offset at that moment (nothing to convert) or the input is bad.
 */
export function localEquivalent(hhmm, fromZone, toZone, date = new Date()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m || !fromZone || !toZone) return null;
  const day = wallParts(date, fromZone);
  // First guess: treat the wall time as UTC, then correct by the zone offset
  // at that instant (twice, so a DST edge between guess and answer settles).
  let t = Date.UTC(day.year, day.month - 1, day.day, Number(m[1]), Number(m[2]));
  for (let i = 0; i < 2; i++) {
    t = Date.UTC(day.year, day.month - 1, day.day, Number(m[1]), Number(m[2]))
      - zoneOffsetMinutes(fromZone, new Date(t)) * 60000;
  }
  const instant = new Date(t);
  if (sameOffset(fromZone, toZone, instant)) return null;
  const local = wallParts(instant, toZone);
  const dayDiff = Math.round(
    (Date.UTC(local.year, local.month - 1, local.day) - Date.UTC(day.year, day.month - 1, day.day)) / 86400000,
  );
  const shift = dayDiff > 0 ? ' (+1 day)' : dayDiff < 0 ? ' (−1 day)' : '';
  return `${pad2(local.hour)}:${pad2(local.minute)}${shift}`;
}

/**
 * One line stating the zone a cron schedule runs in, plus the viewer's local
 * time when their browser zone differs:
 *   "Europe/Berlin"                          (same offset, or no fixed time)
 *   "Europe/Berlin · 03:00 your time"         (fixed daily time, other zone)
 *   "Europe/Berlin · your zone: America/New_York" (no fixed time, other zone)
 */
export function cronZoneNote(cron, { schedulerZone = TRIGGER_TIME_ZONE, viewerZone = browserTimeZone(), now = new Date() } = {}) {
  if (sameOffset(schedulerZone, viewerZone, now)) return schedulerZone;
  const wall = cronWallTime(cron);
  const local = wall ? localEquivalent(wall, schedulerZone, viewerZone, now) : null;
  if (local) return `${schedulerZone} · ${local} your time`;
  return `${schedulerZone} · your zone: ${viewerZone}`;
}

/**
 * A short viewer-local label for an instant: "today 18:26", "tomorrow 09:00",
 * "yesterday 23:10" or "3 Oct 09:00". Null for a missing/unparsable value.
 */
export function formatRunTime(iso, { now = new Date(), timeZone = browserTimeZone() } = {}) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = wallParts(d, timeZone);
  const n = wallParts(now, timeZone);
  const hm = `${pad2(p.hour)}:${pad2(p.minute)}`;
  const dayDiff = Math.round(
    (Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(n.year, n.month - 1, n.day)) / 86400000,
  );
  if (dayDiff === 0) return `today ${hm}`;
  if (dayDiff === 1) return `tomorrow ${hm}`;
  if (dayDiff === -1) return `yesterday ${hm}`;
  const month = new Intl.DateTimeFormat('en-GB', { timeZone, month: 'short' }).format(d);
  const year = p.year !== n.year ? ` ${p.year}` : '';
  return `${p.day} ${month}${year} ${hm}`;
}

/** Display copy + tone for the scheduler's `lastResult` values. */
export const RESULT_LABELS = Object.freeze({
  ok: { text: '✓ ok', tone: 'success' },
  error: { text: '✗ error', tone: 'error' },
  skipped: { text: 'skipped', tone: 'muted' },
  'skipped-maintenance': { text: 'skipped (maintenance)', tone: 'muted' },
  running: { text: 'running…', tone: 'muted' },
  interrupted: { text: 'interrupted', tone: 'error' },
});

/** Label for a `lastResult` value; unknown values pass through unchanged. */
export function resultLabel(result) {
  if (!result) return null;
  return RESULT_LABELS[result] || { text: String(result), tone: 'muted' };
}

/**
 * The status line for one trigger row. Only cron/once triggers are scheduled
 * by time, so every other type yields null.
 *
 * Returns { invalid, next, last, lastResult } where
 *   invalid    — the scheduler's reason it cannot schedule the trigger, or null
 *   next       — "today 18:26" etc. (viewer-local), "… (overdue)" once past,
 *                null when none is armed
 *   last       — viewer-local label of the last fire, null if it never fired
 *   lastResult — resultLabel() of the last fire, or null
 */
export function triggerTiming(trigger, status, { now = new Date(), viewerZone = browserTimeZone() } = {}) {
  if (!trigger || (trigger.type !== 'cron' && trigger.type !== 'once')) return null;
  const entry = (status && status.triggers && status.triggers[trigger.id]) || {};
  const enabled = trigger.enabled !== false;
  const invalid = enabled && typeof entry.invalid === 'string' && entry.invalid ? entry.invalid : null;
  const opts = { now, timeZone: viewerZone };
  let next = enabled && !invalid ? formatRunTime(entry.nextFireAt, opts) : null;
  // A once trigger held back (e.g. by Maintenance Mode) keeps a past fire time.
  if (next && new Date(entry.nextFireAt) < now) next += ' (overdue)';
  return {
    invalid,
    next,
    last: formatRunTime(entry.lastFiredAt, opts),
    lastResult: entry.lastFiredAt ? resultLabel(entry.lastResult) : null,
  };
}

/**
 * The schedule label for a `once` trigger. The form stores an absolute UTC
 * instant, shown in the viewer's zone ("3 Oct 09:00 (your time)"); a naive
 * value (hand-written triggers.json) is read by the scheduler in its own zone,
 * so it is shown verbatim with that zone named.
 */
export function onceScheduleLabel(at, { schedulerZone = TRIGGER_TIME_ZONE, viewerZone = browserTimeZone(), now = new Date() } = {}) {
  if (typeof at !== 'string' || !at.trim()) return '—';
  const raw = at.trim();
  const absolute = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (!absolute) return `${raw.replace('T', ' ')} (${schedulerZone})`;
  const label = formatRunTime(raw, { now, timeZone: viewerZone });
  return label ? `${label} (your time, ${viewerZone})` : raw;
}
