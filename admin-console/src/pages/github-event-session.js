// Pure helpers for the "jump from a delivered GitHub-event chip to the agent
// session it triggered" affordance (#642).
//
// A github-event-triggered run stamps its session-log rows with a deterministic
// correlationId `trigger:<triggerId>:gh:<eventId>` (agent-entrypoint.py,
// _execute_inner). Both halves are already present in an event-log row — the
// `triggerId` on the outcome and the `eventId` on the entry — so the target
// session's correlationId is reconstructed read-side, with no new persistence.
//
// Only `delivered` outcomes map to a Claude session; `dropped`/`digest` never
// run one. The matching against active vs. finished sessions is pure here so it
// is unit-testable without the JSX; the pages/panels do the IO + navigation.

// Reconstruct the session correlationId for a triggered run. Returns null when
// either half is missing (so callers can treat it as "not linkable").
export function buildTriggerCorrelationId(triggerId, eventId) {
  if (!triggerId || !eventId) return null;
  return `trigger:${triggerId}:gh:${eventId}`;
}

// Only `delivered` outcomes actually woke an agent and ran a session, so only
// they are clickable (AC1/AC2). A missing triggerId means the correlationId
// can't be reconstructed, so such an outcome is not linkable either.
export function isSessionOutcome(outcome) {
  return !!(outcome && outcome.status === 'delivered' && outcome.triggerId);
}

// Match against the active-sessions list: each active session carries a single
// `correlationId`. Returns the matching session or null.
export function findActiveSessionMatch(sessions, correlationId) {
  if (!correlationId || !Array.isArray(sessions)) return null;
  return sessions.find(s => s && s.correlationId === correlationId) || null;
}

// Match against the finished-session groups (#555): each group carries a
// `correlationIds[]` set spanning the runs it bundles. Returns the matching
// group or null.
export function findFinishedSessionMatch(history, correlationId) {
  if (!correlationId || !Array.isArray(history)) return null;
  return history.find(
    s => s && Array.isArray(s.correlationIds) && s.correlationIds.includes(correlationId),
  ) || null;
}
