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
