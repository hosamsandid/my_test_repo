// Pure, React-free helpers for rendering `rate_limit_event` rows in the
// Session Log (see LogEvent.jsx). The runtime forwards the Claude CLI's own
// `rate_limit_event` stream-json line (agent-entrypoint.py
// `_map_stream_json_line`) as
//   { type: 'rate_limit_event', info: <rate_limit_info>, raw: <full parsed CLI object> }
// — before #2202 this had no dedicated branch and fell through to the generic
// `unknown` bucket, rendering as an escaped JSON dump of the whole payload.

export function isRateLimitEvent(ev) {
  return !!ev && ev.type === 'rate_limit_event';
}

// Unix epoch SECONDS (as the CLI reports `resetsAt`/`overageResetsAt`) → a
// readable local date/time string, or '' for a missing/invalid value.
export function formatEpochSeconds(epochSeconds) {
  const n = Number(epochSeconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    return new Date(n * 1000).toLocaleString();
  } catch {
    return '';
  }
}

// The collapsed, plain-language summary line, e.g.
// "Rate limit: allowed · Overage: allowed (in use) · resets 9/30/2026, 8:00:00 AM"
// instead of the raw nested `rate_limit_info` object.
export function rateLimitEventSummary(ev) {
  const info = ev?.info || {};
  const parts = [];
  if (info.status) parts.push(`Rate limit: ${info.status}`);
  if (info.overageStatus) {
    parts.push(`Overage: ${info.overageStatus}${info.overageInUse ? ' (in use)' : ''}`);
  }
  const resets = formatEpochSeconds(info.resetsAt);
  if (resets) parts.push(`resets ${resets}`);
  return parts.join(' · ');
}

// Expanded detail rows — every informative field of `info`, plain-labelled
// rather than compressed into the summary line. `isUsingOverage` and
// `overageInUse` are surfaced verbatim, side by side, rather than folded into
// one inferred meaning: a sample has been observed where they disagree
// (`isUsingOverage: false` alongside `overageInUse: true`), and whether that
// is expected or a bug is still unconfirmed (#2202) — showing both raw values
// lets a reader who does know the CLI's semantics judge it themselves instead
// of trusting a guessed relationship baked into the summary line.
export function rateLimitEventDetailRows(ev) {
  const info = ev?.info || {};
  const rows = [];
  if (info.status !== undefined) rows.push(['status', String(info.status)]);
  if (info.rateLimitType !== undefined) rows.push(['rateLimitType', String(info.rateLimitType)]);
  if (info.overageStatus !== undefined) rows.push(['overageStatus', String(info.overageStatus)]);
  if (info.isUsingOverage !== undefined) rows.push(['isUsingOverage', String(info.isUsingOverage)]);
  if (info.overageInUse !== undefined) rows.push(['overageInUse', String(info.overageInUse)]);
  const resets = formatEpochSeconds(info.resetsAt);
  if (resets) rows.push(['resetsAt', resets]);
  const overageResets = formatEpochSeconds(info.overageResetsAt);
  if (overageResets) rows.push(['overageResetsAt', overageResets]);
  return rows;
}
