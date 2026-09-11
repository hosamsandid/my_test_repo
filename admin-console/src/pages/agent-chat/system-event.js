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
// and correlation plumbing. `tool_use_id` is an internal correlation id, same
// category as `uuid`/`session_id` (#2191).
const SYSTEM_EVENT_NOISE_KEYS = new Set([
  'type', 'subtype', 'session_id', 'sessionId', 'uuid', 'correlationId', 'tool_use_id',
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

// `task_updated`/`task_notification` (#2191): emitted by the runtime while
// tracking a launched sub-agent's progress/completion. Both carry a `task_id`;
// `task_updated` carries a `patch` object (e.g. `{status, end_time}`) and
// `task_notification` a full markdown `summary` plus an `output_file` path.
// Neither is special-cased upstream, so they otherwise fall through the
// generic scalar-only system_event handling above, which silently drops the
// nested `patch` and JSON-escapes the markdown `summary`.
const TASK_EVENT_SUBTYPES = new Set(['task_updated', 'task_notification']);

export function isTaskEvent(ev) {
  return !!ev && ev.type === 'system_event' && TASK_EVENT_SUBTYPES.has(ev.subtype);
}

function shortTaskId(id) {
  return typeof id === 'string' && id.length > 12 ? id.slice(0, 12) + '…' : (id || '');
}

// First non-blank line of a markdown report, truncated — a one-line hint for
// the collapsed row; the full report is only markdown-rendered on expand.
function summarySnippet(summary) {
  if (typeof summary !== 'string' || !summary) return '';
  const line = (summary.split('\n').find((l) => l.trim() !== '') || '').trim();
  return scalarText(line);
}

// Collapsed inline summary for a task_updated/task_notification row: the task
// id, its status (task_updated) or report snippet (task_notification) —
// ahead of the noisy generic scalar dump, and readable without expanding.
export function taskEventSummary(ev) {
  if (!isTaskEvent(ev)) return '';
  const raw = ev.raw || {};
  const parts = [];
  const id = shortTaskId(raw.task_id);
  if (id) parts.push(`task ${id}`);
  if (ev.subtype === 'task_updated') {
    const status = raw.patch && typeof raw.patch === 'object' ? raw.patch.status : undefined;
    if (status) parts.push(String(status));
  } else {
    const snippet = summarySnippet(raw.summary);
    if (snippet) parts.push(snippet);
  }
  return parts.join(' · ');
}

// Readable [key, value] rows for a task_updated event's `patch` object (e.g.
// status, end_time) — dropped silently by systemEventSummary (nested objects
// are skipped there) and otherwise visible only inside the raw JSON dump.
export function taskUpdatedPatchRows(ev) {
  if (!ev || ev.subtype !== 'task_updated') return [];
  const patch = ev.raw?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return [];
  return Object.entries(patch).filter(([, v]) => v !== null && v !== undefined && v !== '');
}

// The markdown report body of a task_notification event, or '' when absent /
// not a string.
export function taskNotificationSummary(ev) {
  if (!ev || ev.subtype !== 'task_notification') return '';
  const summary = ev.raw?.summary;
  return typeof summary === 'string' ? summary : '';
}

// Shorten a task_notification's absolute `output_file` path to a
// workspace-relative reference when it sits under the agent's own workspace,
// else the last two path segments — a raw absolute path is not a useful
// inline reference (#2191 item 4, nice-to-have).
const AGENT_WORKSPACE_ROOT_PREFIX = '/workspace/agents/';

export function formatOutputFileRef(ev) {
  if (!ev || ev.subtype !== 'task_notification') return '';
  const path = ev.raw?.output_file;
  if (typeof path !== 'string' || !path) return '';
  if (path.startsWith(AGENT_WORKSPACE_ROOT_PREFIX)) {
    const afterRoot = path.slice(AGENT_WORKSPACE_ROOT_PREFIX.length);
    const nextSlash = afterRoot.indexOf('/');
    if (nextSlash !== -1) return afterRoot.slice(nextSlash + 1);
  }
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 2 ? path : '…/' + parts.slice(-2).join('/');
}
