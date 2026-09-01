/**
 * Pure helpers for the shared "active sessions" state (#1678).
 *
 * `GET /api/agents/:id/sessions/active` used to be polled by three separate
 * Agent-Chat surfaces at once (the RightRail "Sessions" badge, the SessionsPanel
 * list, and the DiffView running-probe). They now share one poller
 * (`SessionsActiveContext`); these dependency-free helpers shape that single
 * response so every consumer derives its view from the same data and can be
 * unit-tested without a DOM (per the #651 convention — the JSX provider stays a
 * thin adapter over these).
 */

/**
 * Normalise a `sessions/active` response body to a plain array. The endpoint
 * returns `{ sessions: [...] }`; anything else (error shape, null, a bad body)
 * collapses to an empty list so a consumer never has to null-check.
 */
export function sessionsFromResponse(data) {
  return Array.isArray(data?.sessions) ? data.sessions : [];
}

/** The badge count — the number of active sessions. */
export function activeSessionCount(sessions) {
  return Array.isArray(sessions) ? sessions.length : 0;
}

/**
 * Whether the agent currently has at least one running session (the DiffView
 * "git actions paused" affordance, AC7). Mirrors the old `fetchRunning`
 * predicate.
 */
export function isAgentRunning(sessions) {
  return activeSessionCount(sessions) > 0;
}

/**
 * Optimistic removal of one session by id — used when the user clicks Stop, so
 * the tab and the badge drop it immediately without waiting for the next poll
 * to confirm. Returns a new array (never mutates the input); a no-op when the
 * id is absent.
 */
export function removeSession(sessions, id) {
  if (!Array.isArray(sessions)) return [];
  return sessions.filter((s) => s.id !== id);
}

/**
 * True when there is at least one active trigger-initiated session for the
 * given room. Used by ChatPanel to show the "working…" indicator during
 * trigger runs (AC1–3 of #1852): the last Matrix transcript entry for a
 * trigger run is a notice posted by the agent itself, so the usual
 * "last-message-is-human" heuristic never fires — this predicate provides
 * the supplementary signal driven by the runtime's running-sessions state.
 */
export function hasActiveTriggerSessionForRoom(sessions, roomId) {
  if (!Array.isArray(sessions) || !roomId) return false;
  return sessions.some((s) => s.type === 'trigger' && s.roomId === roomId);
}
