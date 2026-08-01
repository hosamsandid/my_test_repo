// Counts platform-wide "busy" agent sessions from the same /api/agents/statuses
// payload Shell.jsx already polls for its nav badge (#503) — no new backend
// mechanism, just a shared read of activityState === 'busy' across every
// agent dir, regardless of team/user.
export function countActiveSessions(statuses) {
  if (!Array.isArray(statuses)) return 0;
  return statuses.filter((s) => s && s.activityState === 'busy').length;
}
