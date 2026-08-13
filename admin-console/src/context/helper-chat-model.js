// Pure, React-free core for the Helper Chat context (#1735, Phase 1.3).
// Everything that can be decided without the browser lives here so it is
// node:test-covered (admin-console-src CI job) while HelperChatContext.jsx
// stays a thin adapter over it (per the #651 convention). The provider owns the
// `fetch` + stream reader; this module owns the message-list transitions, the
// request-body shape, the NDJSON line framing and the static suggested prompts.

// Only the newest N turns are sent to the endpoint. The server (#1734) trims to
// the same ceiling defensively; trimming client-side keeps the request small.
export const MAX_TURNS = 20;

// Shown by the panel's empty state as clickable chips (data-only, no API).
export const SUGGESTED_PROMPTS = [
  'How do I create my first agent team?',
  'What is the difference between a Trigger and a Flow?',
  'My agent is not responding — help me troubleshoot.',
];

// User-visible copy when a stream fails (network drop, terminal error event, or
// a stream that ends without `done`).
export const STREAM_ERROR_TEXT = 'Something went wrong — please try again.';

// Monotonic-ish id for a message row. crypto.randomUUID when available, else a
// timestamp+counter fallback so ids stay unique in a jsdom/node test too.
let idCounter = 0;
export function newMessageId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* fall through */ }
  idCounter += 1;
  return `hc-${Date.now()}-${idCounter}`;
}

// ── Message-list transitions (immutable — never mutate the input array) ──────

// Append a user turn.
export function appendUserMessage(messages, text) {
  return [...messages, { id: newMessageId(), role: 'user', content: String(text) }];
}

// Append the streaming assistant placeholder that deltas accumulate into.
// Returns { messages, id } so the caller can target that row while streaming.
export function appendAssistantPlaceholder(messages) {
  const id = newMessageId();
  return {
    id,
    messages: [...messages, { id, role: 'assistant', content: '', streaming: true }],
  };
}

// Accumulate one delta onto the streaming placeholder.
export function applyDelta(messages, id, text) {
  if (!text) return messages;
  return messages.map(m => (m.id === id ? { ...m, content: m.content + text } : m));
}

// Mark the streaming placeholder finished (drops the streaming flag).
export function finishStreaming(messages, id) {
  return messages.map(m => (m.id === id ? { ...m, content: m.content, streaming: false } : m));
}

// Replace the streaming placeholder with a user-visible error message. Uses the
// accumulated partial only if nothing streamed — a failure always surfaces the
// canned error so the user knows to retry.
export function failStreaming(messages, id, text = STREAM_ERROR_TEXT) {
  return messages.map(m => (m.id === id
    ? { ...m, role: 'assistant', content: text, streaming: false, error: true }
    : m));
}

// ── Request shaping ──────────────────────────────────────────────────────────

// The role/content pairs the endpoint expects, trimmed to the newest MAX_TURNS.
// Streaming/placeholder rows carry no content worth sending, so an in-flight
// empty assistant row is dropped before trimming.
export function toRequestMessages(messages, max = MAX_TURNS) {
  const clean = messages
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && !m.streaming)
    .map(m => ({ role: m.role, content: m.content }));
  return clean.length > max ? clean.slice(-max) : clean;
}

// The full POST body for /api/helper/chat.
export function buildRequestBody({ messages, currentRoute, currentRouteLabel }) {
  const body = { messages: toRequestMessages(messages) };
  if (typeof currentRoute === 'string' && currentRoute) body.currentRoute = currentRoute;
  if (typeof currentRouteLabel === 'string' && currentRouteLabel) body.currentRouteLabel = currentRouteLabel;
  return body;
}

// ── NDJSON framing ───────────────────────────────────────────────────────────

// Split a decoded buffer into whole JSON lines, returning the parsed events and
// the trailing partial line still to be completed by the next chunk. Corrupt
// lines are skipped (defensive, mirrors consumeCopilotStream).
export function splitNdjson(buf) {
  const events = [];
  let rest = buf;
  let nl;
  while ((nl = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip a corrupt line */ }
  }
  return { events, rest };
}
