// Pure view-logic for the team-wide disable/enable result dialogs in
// Agents.jsx — turns the { disabled|enabled, skipped, failed } response
// from POST /api/teams/:id/{disable,enable} into what the UI renders,
// resolving failed member ids to their displayName from the preview list.

export function summarizeTeamAction(result, members) {
  const successIds = Array.isArray(result.disabled)
    ? result.disabled
    : Array.isArray(result.enabled)
    ? result.enabled
    : [];

  const byId = new Map((members || []).map((m) => [m.id, m]));
  const failedMembers = (Array.isArray(result.failed) ? result.failed : []).map((f) => ({
    id: f.id,
    displayName: byId.get(f.id)?.displayName || f.id,
    error: f.error,
  }));

  return { successIds, failedMembers };
}
