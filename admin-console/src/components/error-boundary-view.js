/**
 * Pure core of the console's error-containment layer (#1974).
 *
 * A blank white page in this SPA has always been the same failure: an uncaught
 * throw during render unmounts everything up to `#root`. We shipped point-fixes
 * for individual triggers (#1857, #506, #481) and the white screen kept coming
 * back with a new trigger, because the *containment* layer was missing. The
 * boundaries in `ErrorBoundary.js` are that layer; this module holds every
 * deterministic decision they make so it is unit-testable without a DOM (the
 * #651 convention — the React classes stay thin adapters over these).
 *
 * Deliberately dependency-free: no React, no fetch, injectable clock.
 */

/** Copy for the app-level fallback card (AC1). */
export const APP_FALLBACK_COPY = {
  title: 'Something went wrong',
  body: 'This page hit an unexpected error. The navigation still works, so you can move on — or try this page again.',
  retry: 'Try again',
  back: 'Go back',
  reload: 'Reload page',
};

/** Copy for the inline per-event placeholder row (AC4). */
export const EVENT_FALLBACK_TEXT = 'This message could not be displayed.';

/** Endpoint the boundaries post their reports to (AC5). */
export const CLIENT_ERROR_ENDPOINT = '/api/client-errors';

const MAX_MESSAGE_LEN = 300;
const MAX_STACK_FRAMES = 12;
const MAX_STACK_LEN = 2000;

// Redaction patterns. Both are linear (no nested quantifiers) — this codebase
// has already paid for a ReDoS in the chat render path (#481/#161), and a
// crash reporter that hangs on a hostile string is worse than no reporter.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;

/**
 * Strip the two things an error string plausibly carries that we must not ship
 * to the server: an address and a secret-shaped blob.
 *
 * This is a narrow scrubber, NOT a general PII filter — the real PII-safety
 * comes from what `buildErrorReport` chooses to include (see below).
 */
export function redact(text) {
  if (typeof text !== 'string' || !text) return '';
  return text.replace(EMAIL_RE, '<redacted-email>').replace(LONG_TOKEN_RE, '<redacted-token>');
}

/** Truncate with an explicit marker, so a reader never mistakes a cut for the whole message. */
export function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated]`;
}

/**
 * Best-effort message for an arbitrary thrown value. A throw is not guaranteed
 * to be an Error — `throw undefined` is legal — so every branch has a fallback
 * and this never throws itself.
 */
export function errorMessage(error) {
  let raw = '';
  if (error && typeof error.message === 'string') raw = error.message;
  else if (typeof error === 'string') raw = error;
  else if (error != null) {
    try { raw = String(error); } catch { raw = ''; }
  }
  return truncate(redact(raw.trim()), MAX_MESSAGE_LEN) || 'Unknown error';
}

/** Error constructor name, when there is one — cheap triage signal, no payload. */
export function errorName(error) {
  const n = error && typeof error.name === 'string' ? error.name : '';
  return truncate(redact(n), 60);
}

/**
 * Normalize a React component stack: keep the innermost frames (that is where
 * the culprit component is) and cap the total. A component stack holds
 * component names and bundle paths only — no user or agent data — so it is
 * safe to report in full; the cap exists to bound the request, not to redact.
 */
export function normalizeComponentStack(stack) {
  if (typeof stack !== 'string' || !stack.trim()) return '';
  const frames = stack.split('\n').map(l => l.trim()).filter(Boolean).slice(0, MAX_STACK_FRAMES);
  return truncate(frames.join('\n'), MAX_STACK_LEN);
}

/**
 * Stable dedupe key for "the same crash again".
 *
 * Keyed on the error name + message + the innermost component-stack frame: a
 * re-render loop re-throws from the same component with the same message, so
 * every repetition collapses onto one fingerprint and the gate below drops it.
 * The full stack is deliberately NOT part of the key — frames above the
 * culprit shift as the tree re-renders and would defeat the dedupe.
 */
export function fingerprintError(error, componentStack) {
  const top = normalizeComponentStack(componentStack).split('\n')[0] || '';
  return `${errorName(error)}|${errorMessage(error)}|${top}`;
}

/**
 * Build the PII-safe report body (AC5).
 *
 * What goes in: the error name/message (redacted + capped), the component
 * stack, the route, and the agent/session identifiers.
 *
 * What deliberately stays out: the chat message body, any agent output, the
 * URL query string and hash, cookies, and the user's identity. `route` is
 * expected to be `location.pathname` only — the caller must not pass a full
 * URL. That choice is the actual PII boundary; `redact()` is only a backstop
 * for a message that inlined something it shouldn't have.
 */
export function buildErrorReport({
  error,
  componentStack = '',
  scope = 'app',
  route = '',
  agentId = '',
  sessionId = '',
  eventId = '',
  now = Date.now,
} = {}) {
  const ts = new Date(typeof now === 'function' ? now() : now).toISOString();
  const report = {
    ts,
    scope: scope === 'event' ? 'event' : 'app',
    name: errorName(error),
    message: errorMessage(error),
    componentStack: normalizeComponentStack(componentStack),
    fingerprint: fingerprintError(error, componentStack),
  };
  // Only attach identifiers that are actually present, so a report is never
  // padded with empty keys the server then has to interpret.
  if (route) report.route = truncate(String(route).split('?')[0].split('#')[0], 200);
  if (agentId) report.agentId = truncate(String(agentId), 120);
  if (sessionId) report.sessionId = truncate(String(sessionId), 120);
  if (eventId) report.eventId = truncate(String(eventId), 120);
  return report;
}

/**
 * Rate-limit / dedupe gate (AC5).
 *
 * Two independent brakes, because the two failure modes are different:
 *  - `maxPerFingerprint` stops ONE error repeating (the re-render loop of
 *    #1857 would otherwise post on every frame);
 *  - `maxPerWindow` stops MANY distinct errors flooding (a malformed stream
 *    where every row throws a slightly different message).
 *
 * The fingerprint map is bounded and cleared whenever the window rolls, so a
 * long-lived tab cannot grow it without limit.
 */
export function createReportGate({
  windowMs = 60_000,
  maxPerWindow = 5,
  maxPerFingerprint = 1,
  maxTrackedFingerprints = 50,
  now = Date.now,
} = {}) {
  let windowStart = -Infinity;
  let sentInWindow = 0;
  let seen = new Map();

  function allow(fingerprint) {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      sentInWindow = 0;
      seen = new Map();
    }
    const key = String(fingerprint == null ? '' : fingerprint);
    const count = seen.get(key) || 0;
    if (count >= maxPerFingerprint) return false;
    if (sentInWindow >= maxPerWindow) return false;
    // Only remember a fingerprint we actually let through; the cap protects the
    // map, and dropping the oldest is fine because the window will clear anyway.
    if (seen.size >= maxTrackedFingerprints) {
      const oldest = seen.keys().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    seen.set(key, count + 1);
    sentInWindow += 1;
    return true;
  }

  return { allow };
}

/**
 * Reset-on-route-change decision (AC3).
 *
 * Returns true only when the boundary is currently showing a fallback AND the
 * reset key changed. Keeping this a predicate rather than a `key` on the
 * boundary element is the whole point: a `key={pathname}` would remount the
 * page subtree on EVERY navigation, which would throw away Agent Chat's state
 * each time the `/chats/:agentId` param changed. This clears the error without
 * touching the healthy tree.
 */
export function shouldResetOnKeyChange(prevKey, nextKey, hasError) {
  return !!hasError && prevKey !== nextKey;
}
