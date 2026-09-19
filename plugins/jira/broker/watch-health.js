'use strict';

// ─── jira broker: watch health, derived from the poll cursor (pure) ─────────
//
// A watched project's health used to be a 10px grey footnote ("N seen · ⚠ N
// failures"). It is now the point of the `/` route's right column, so the raw
// cursor fields need folding into one of three legible states plus the detail a
// Team Admin acts on: the failure count, the next retry time, and a short log of
// the actual errors with timestamps.
//
// The poll cursor already carried `consecutiveFailures` and `skipUntil`; the
// per-error MESSAGE only ever reached the sidecar's stdout. This module adds a
// bounded `recentErrors` ring to the cursor (kept beside the seen-id set,
// round-tripped by watch-store's verbatim cursor read/write) and the pure
// derivation the `/watches` route and the UI share.
//
// Pure — no I/O, no clock of its own (`nowMs` is always injected).

const MAX_RECENT_ERRORS = 5;          // ring depth — newest first
const ERROR_RETAIN_MS = 24 * 3600 * 1000; // an error older than this is dropped
const DEGRADED_WINDOW_MS = 60 * 60 * 1000; // "recovered within the last hour" = degraded, not healthy

// Drop ring entries older than ERROR_RETAIN_MS relative to `nowMs`. Tolerates a
// missing / malformed array.
function pruneErrors(recentErrors, nowMs) {
  const cutoff = (Number.isFinite(nowMs) ? nowMs : Date.now()) - ERROR_RETAIN_MS;
  return (Array.isArray(recentErrors) ? recentErrors : [])
    .filter((e) => e && typeof e.message === 'string' && (Date.parse(e.at) || 0) >= cutoff)
    .slice(0, MAX_RECENT_ERRORS);
}

// Fold one poll failure into the cursor: prepend to the ring, stamp
// `lastErrorAt`. The caller still owns `consecutiveFailures` / `skipUntil`
// (they depend on the SDK backoff curve). Returns a NEW cursor object.
function recordPollError(cursor, { message, at }, nowMs) {
  const base = cursor && typeof cursor === 'object' ? cursor : {};
  const stamp = at || new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
  const entry = { at: stamp, message: String(message || 'poll failed').slice(0, 300) };
  return {
    ...base,
    lastErrorAt: stamp,
    recentErrors: pruneErrors([entry, ...(Array.isArray(base.recentErrors) ? base.recentErrors : [])], nowMs),
  };
}

// A poll succeeded: clear the active-failure fields but KEEP the error ring so
// the UI can show a "recovered recently" (degraded) state. Ring entries still
// age out via pruneErrors. Returns a NEW cursor object.
function clearPollFailure(cursor, nowMs) {
  const base = cursor && typeof cursor === 'object' ? cursor : {};
  const next = { ...base, consecutiveFailures: 0 };
  delete next.skipUntil;
  next.recentErrors = pruneErrors(base.recentErrors, nowMs);
  if (next.recentErrors.length === 0) delete next.lastErrorAt;
  return next;
}

// The three-state health for one watched project, from its cursor.
//   failing  — consecutiveFailures >= 1 (a backoff is in effect)
//   degraded — not failing, but it hit an error within the last hour (recovered,
//              worth a glance)
//   watching — healthy
// Plus the detail the failure panel renders.
function deriveWatchHealth(cursor, nowMs) {
  const c = cursor && typeof cursor === 'object' ? cursor : {};
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const consecutiveFailures = Number.isFinite(c.consecutiveFailures) ? c.consecutiveFailures : 0;
  const recentErrors = pruneErrors(c.recentErrors, now);
  const lastErrorMs = Date.parse(c.lastErrorAt) || 0;

  let status = 'watching';
  if (consecutiveFailures >= 1) status = 'failing';
  else if (recentErrors.length > 0 && now - lastErrorMs <= DEGRADED_WINDOW_MS) status = 'degraded';

  return {
    status,
    consecutiveFailures,
    skipUntil: c.skipUntil || null,
    lastPolledAt: c.lastPolledAt || null,
    lastErrorAt: c.lastErrorAt || null,
    seenCount: Array.isArray(c.seen) ? c.seen.length : 0,
    baselined: Array.isArray(c.seen),
    recentErrors,
  };
}

// Roll the per-project healths up for the panel header ("1 watch failing").
function summariseWatchHealth(healths) {
  const list = Array.isArray(healths) ? healths : [];
  const counts = { watching: 0, degraded: 0, failing: 0 };
  for (const h of list) {
    if (h && counts[h.status] !== undefined) counts[h.status] += 1;
  }
  const worst = counts.failing ? 'failing' : counts.degraded ? 'degraded' : 'watching';
  return { ...counts, total: list.length, worst };
}

module.exports = {
  MAX_RECENT_ERRORS,
  ERROR_RETAIN_MS,
  DEGRADED_WINDOW_MS,
  pruneErrors,
  recordPollError,
  clearPollFailure,
  deriveWatchHealth,
  summariseWatchHealth,
};
