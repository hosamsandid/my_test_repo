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
// can't be reconstructed, so such an outcome is not linkable either. A burst
// digest is recorded as `delivered` + `digest: true` (#2693) but posts one
// summary wake, not a session per event, so it is not linkable.
export function isSessionOutcome(outcome) {
  return !!(outcome && outcome.status === 'delivered' && outcome.digest !== true && outcome.triggerId);
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

// Where the delivered chip of one outcome should take the user (#2596). A
// pooled role's delivery ran on its per-ticket instance (`instanceId`), so the
// session lives in the instance's chat, not the role's:
// - `{ kind: 'agent', agentId }` — open this agent's chat (the instance while it
//   still exists; the recorded agent for every non-pooled or pre-#2596 row);
// - `{ kind: 'archived', instanceName, poolRoleId, archiveKey }` — the instance
//   was removed but its archive is still readable (#2944): open it read-only;
// - `{ kind: 'reaped', instanceName, poolRoleId, poolRoleName }` — the instance
//   was removed and nothing is archived any more; the caller says so and offers
//   the pooled role's chat, labelled as such, instead of silently opening it.
// `instanceExists` is filled in by GET /api/github-events; a row without it is
// treated as existing, so a missing flag never hides a working link.
// Null when the outcome is not linkable at all (see isSessionOutcome).
export function sessionLinkTarget(outcome) {
  if (!isSessionOutcome(outcome)) return null;
  const instanceId = typeof outcome.instanceId === 'string' && outcome.instanceId ? outcome.instanceId : null;
  if (!instanceId) return outcome.agentId ? { kind: 'agent', agentId: outcome.agentId } : null;
  if (outcome.instanceExists !== false) return { kind: 'agent', agentId: instanceId };
  // #2944: the removed instance's chat + session log are still archived.
  if (outcome.instanceArchiveKey && outcome.agentId) {
    return {
      kind: 'archived',
      instanceName: outcome.instanceName || instanceId,
      poolRoleId: outcome.agentId,
      archiveKey: outcome.instanceArchiveKey,
    };
  }
  return {
    kind: 'reaped',
    instanceName: outcome.instanceName || instanceId,
    poolRoleId: outcome.agentId || null,
    poolRoleName: outcome.poolRoleName || outcome.agentId || null,
  };
}

// The notice shown instead of a link when the instance is gone (#2596 AC5).
export function reapedInstanceNotice(target) {
  if (!target || target.kind !== 'reaped') return null;
  return `${target.instanceName} no longer exists and no archive of it is readable any more — pool instances are removed after their ticket is done, so this session can no longer be opened.`;
}

// Where a removed instance's archive opens (#2944): its pooled role's chat page
// in read-only archive mode.
export function archiveChatPath(poolRoleId, archiveKey) {
  return `/chats/${encodeURIComponent(poolRoleId)}?archive=${encodeURIComponent(archiveKey)}`;
}
