'use strict';

// Client-side crash telemetry (#1974).
//
// The console's error boundaries post one structured report per contained
// render error. Before this, a white-screen trigger only ever landed in the
// reporting user's browser console, which is why the same bug kept coming back
// under a new trigger — nobody could see it centrally.
//
// Shape follows `audit.js`: a pure `buildClientErrorEvent` (validate +
// normalize + truncate — unit-testable without an HTTP harness, the #651
// convention) and a tiny impure `record` fs sink that swallows every failure.
//
// Safety contract: strictly best-effort and strictly untrusted input. The body
// comes from a browser, so every field is length-capped and coerced here — the
// server never stores a client string verbatim. A write failure must never
// affect the response.

const fs = require('fs');
const path = require('path');

// Persistent location on the shared workspace volume. Overridable for tests.
const CLIENT_ERROR_DIR = process.env.CLIENT_ERROR_DIR || '/workspace/client-errors';

// Caps mirror the client-side ones in `error-boundary-view.js`, but are
// re-applied here because the client is not the authority on its own limits.
const LIMITS = {
  message: 300,
  name: 60,
  componentStack: 2000,
  fingerprint: 400,
  route: 200,
  id: 120,
};

function str(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Normalize one posted report into the stored event.
 *
 * Returns `{ ok: true, event }` or `{ ok: false, error }`. The only hard
 * requirement is a non-empty `message` — a report without one carries no
 * triage value, and accepting it would let a broken client fill the log with
 * blanks.
 */
function buildClientErrorEvent(body, meta = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const message = str(b.message, LIMITS.message);
  if (!message) return { ok: false, error: 'message is required' };

  const scope = b.scope === 'event' ? 'event' : 'app';
  const event = {
    // Server clock, not the client's: a skewed browser clock must not decide
    // which day file the report lands in (and the reader sorts by day).
    ts: new Date(typeof meta.now === 'function' ? meta.now() : Date.now()).toISOString(),
    scope,
    message,
    name: str(b.name, LIMITS.name),
    componentStack: str(b.componentStack, LIMITS.componentStack),
    fingerprint: str(b.fingerprint, LIMITS.fingerprint),
    route: str(b.route, LIMITS.route),
    agentId: str(b.agentId, LIMITS.id),
    sessionId: str(b.sessionId, LIMITS.id),
    eventId: str(b.eventId, LIMITS.id),
    // Who was looking at it, from the server session — never from the body,
    // which a client could claim anything in.
    actor: str(meta.actor, LIMITS.id),
    // The client's own timestamp is kept alongside (not instead of) ours, so a
    // clock-skew case is diagnosable rather than invisible.
    clientTs: str(b.ts, 40),
  };
  // Drop the empty optional keys so a stored line stays readable and a reader
  // never has to distinguish "absent" from "empty string".
  for (const key of ['name', 'componentStack', 'fingerprint', 'route', 'agentId', 'sessionId', 'eventId', 'actor', 'clientTs']) {
    if (!event[key]) delete event[key];
  }
  return { ok: true, event };
}

// Append one event as a JSONL line to the current day's file. Never throws.
function record(event) {
  try {
    fs.mkdirSync(CLIENT_ERROR_DIR, { recursive: true });
    const day = String(event.ts).slice(0, 10); // YYYY-MM-DD
    fs.appendFileSync(path.join(CLIENT_ERROR_DIR, `client-errors-${day}.jsonl`), JSON.stringify(event) + '\n');
  } catch {
    // Swallow: telemetry must never break or block the request path.
  }
}

/** One-line container-log summary — this is what makes a report visible on the Logs page. */
function logLine(event) {
  const where = event.route ? ` route=${event.route}` : '';
  const who = event.agentId ? ` agent=${event.agentId}` : '';
  return `[client-error] ${event.scope}${where}${who}: ${event.message}`;
}

module.exports = { buildClientErrorEvent, record, logLine, CLIENT_ERROR_DIR, LIMITS };
