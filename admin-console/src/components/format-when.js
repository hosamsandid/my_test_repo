/**
 * format-when.js — plain-language helpers for a stored "Added"/"Created"
 * timestamp.
 *
 * The credential/connection pages (GitHub Tokens, SSH Keys, MCP Servers,
 * Model Providers, My Credentials) each stored an ISO timestamp and showed it
 * as a raw machine string ("8/13/2026, 4:20:48 PM") — hard to scan and, worse,
 * reimplemented slightly differently on each page (some guarded an invalid
 * date, some didn't). This module is the single source of truth so every page
 * shows the same friendly value: a short relative phrase ("2 days ago") that
 * reads at a glance, with the exact local time kept on hover.
 *
 * Pure and React-free so it unit-tests without a DOM (per the #651 convention).
 * Everything "now"-relative takes an explicit `nowMs` so the output is
 * deterministic; callers pass Date.now() at the JSX layer.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Parse an ISO/date string to epoch ms, or NaN if it isn't a real date. */
export function parseWhen(iso) {
  if (typeof iso !== 'string' || iso === '') return NaN;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? NaN : ms;
}

/**
 * A short, human relative phrase for a PAST timestamp: "just now",
 * "5 minutes ago", "3 hours ago", "yesterday", "6 days ago", "3 weeks ago",
 * "2 months ago", "a year ago", "2 years ago".
 *
 * Returns '' for anything it can't confidently describe — an invalid input, a
 * missing/NaN `nowMs`, or a timestamp in the future — so the caller can fall
 * back to the exact value rather than showing a wrong guess.
 */
export function relativeWhen(iso, nowMs) {
  const ms = parseWhen(iso);
  if (Number.isNaN(ms) || typeof nowMs !== 'number' || Number.isNaN(nowMs)) return '';
  const delta = nowMs - ms;
  if (delta < 0) return '';                       // future — don't guess
  if (delta < 45 * SECOND) return 'just now';
  if (delta < 90 * SECOND) return 'a minute ago';
  if (delta < 45 * MINUTE) return `${Math.round(delta / MINUTE)} minutes ago`;
  if (delta < 90 * MINUTE) return 'an hour ago';
  if (delta < 22 * HOUR) return `${Math.round(delta / HOUR)} hours ago`;
  if (delta < 36 * HOUR) return 'yesterday';
  if (delta < 7 * DAY) return `${Math.round(delta / DAY)} days ago`;
  if (delta < 11 * DAY) return 'a week ago';
  if (delta < 45 * DAY) return `${Math.round(delta / (7 * DAY))} weeks ago`;
  if (delta < 60 * DAY) return 'a month ago';
  if (delta < 340 * DAY) return `${Math.round(delta / (30 * DAY))} months ago`;
  if (delta < 550 * DAY) return 'a year ago';
  return `${Math.round(delta / (365 * DAY))} years ago`;
}

/**
 * The exact local timestamp ("8/13/2026, 4:20:48 PM"), matching what these
 * pages showed before. Returns '' when the value isn't a real date. Used as
 * the hover title behind the relative phrase and as the fallback text when a
 * relative phrase can't be formed.
 */
export function absoluteWhen(iso) {
  const ms = parseWhen(iso);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleString();
}
