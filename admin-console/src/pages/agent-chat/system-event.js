// Pure, React-free helpers for rendering `system_event` rows in the Session
// Log (see LogEvent.jsx). The runtime captures each Claude-CLI `system` message
// whose subtype isn't `init`/`task_progress` as
//   { type: 'system_event', subtype: <s>, raw: <full parsed CLI object> }
// (agent-entrypoint.py ~L1291-1304). The informative content lives in `raw`
// (e.g. the reported thinking-token count on a `thinking_tokens` event) — these
// helpers extract it so the row shows content instead of a bare label, while
// degrading gracefully when `raw` is missing or shaped differently.

// Structural / bookkeeping keys that carry no informative content to surface
// inline — they are noise the log already conveys via the type/subtype label
// and correlation plumbing.
const SYSTEM_EVENT_NOISE_KEYS = new Set([
  'type', 'subtype', 'session_id', 'sessionId', 'uuid', 'correlationId',
]);

// Truncate a scalar's string form so one very long value can't blow out the
// inline summary line. The full value is still available in the expanded raw
// JSON.
const MAX_VALUE_LEN = 200;
function scalarText(v) {
  const s = String(v);
  return s.length > MAX_VALUE_LEN ? s.slice(0, MAX_VALUE_LEN) + '…' : s;
}

// The "extra" entries of a system_event's `raw` payload — every field beyond
// the structural type/subtype/session bookkeeping, with empty/nullish values
// dropped. These are what make a row informative. Returns [] for a missing,
// non-object, or content-free payload (so the row degrades to a bare label and
// is treated as non-expandable).
export function systemEventExtras(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw).filter(([k, v]) =>
    !SYSTEM_EVENT_NOISE_KEYS.has(k) &&
    v !== null && v !== undefined && v !== '');
}

// A compact, single-line inline summary of the scalar extras, e.g.
// "thinking_tokens: 1234". Nested objects/arrays are omitted here (they'd read
// as `[object Object]`) — they still show in the expandable raw JSON. Returns
// '' when there's nothing scalar to surface.
export function systemEventSummary(raw) {
  return systemEventExtras(raw)
    .filter(([, v]) => typeof v !== 'object')
    .map(([k, v]) => `${k}: ${scalarText(v)}`)
    .join(' · ');
}

// True when a system_event row carries anything worth expanding — i.e. its
// `raw` holds content beyond the subtype label. Drives both the click-to-expand
// affordance and whether the raw JSON block is offered.
export function systemEventHasDetail(event) {
  return systemEventExtras(event?.raw).length > 0;
}

// A `thinking_tokens` system_event? The CLI emits these many times per run as a
// live running-count progress signal (#870).
export function isThinkingTokensEvent(ev) {
  return !!ev && ev.type === 'system_event' && ev.subtype === 'thinking_tokens';
}

function thinkingTokenCount(ev) {
  const n = Number(ev?.raw?.estimated_tokens);
  return Number.isFinite(n) ? n : null;
}

// Collapse a run's stream of `thinking_tokens` ticks into ONE row per run
// (per correlationId), matching how the runtime is now a live self-updating
// counter rather than a log of distinct events (#870, D2). Walks the event
// list once, preserving order:
//   * the first tick of a run anchors the single row at that position;
//   * every later tick for the same correlationId updates that row in place —
//     no new row is appended, and interleaved non-thinking events between ticks
//     still render normally in sequence;
//   * the row carries the raw payload of the tick with the HIGHEST
//     estimated_tokens seen, so the count is coherent and non-decreasing even
//     if the CLI's counter resets at the start of a new thinking phase.
// Applies identically to live SSE tails and backfilled/reloaded logs (including
// legacy logs already full of per-tick lines — AC5). Non-thinking events pass
// through untouched.
export function mergeThinkingTokens(events) {
  if (!Array.isArray(events)) return events;
  const out = [];
  const indexByCid = new Map();  // correlationId → index in `out` of its row
  for (const ev of events) {
    if (!isThinkingTokensEvent(ev)) {
      out.push(ev);
      continue;
    }
    const cid = ev.correlationId ?? '';
    if (!indexByCid.has(cid)) {
      indexByCid.set(cid, out.length);
      // Stable key so React reconciles the same DOM node and updates the count
      // in place across re-renders (AC4).
      out.push({ ...ev, _key: `tt-${cid}` });
      continue;
    }
    const i = indexByCid.get(cid);
    const prev = out[i];
    const prevCount = thinkingTokenCount(prev);
    const nextCount = thinkingTokenCount(ev);
    // Keep the payload with the greater count; on a tie or missing counts keep
    // the latest so the raw JSON reflects the most recent update (AC6).
    if (prevCount == null || (nextCount != null && nextCount >= prevCount)) {
      out[i] = { ...ev, _key: prev._key };
    }
  }
  return out;
}
