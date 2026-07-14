// Pure helper for the Agent-Team ↔ tenant-Team cascade (#568).
//
// An Agent Team (a `role: "team"` agent plus its `role: "team-member"` agents
// carrying `parentTeamId`) shares one per-tenant knowledge base and must never
// be split across tenant Teams. So reassigning the parent team agent's `teamId`
// has to cascade to every member. This module isolates the (pure) "who are the
// members of this Agent Team" decision so the cascade is unit-testable without
// touching the filesystem.

// Given every agent config (`{ id, role, parentTeamId, ... }`) and the id of a
// `role: "team"` agent, return the member configs that inherit that team's
// tenant assignment — i.e. the `team-member` agents whose `parentTeamId` points
// at it. Order follows the input. A non-team agent id yields no members.
function membersOfTeam(configs, teamAgentId) {
  if (!Array.isArray(configs) || !teamAgentId) return [];
  return configs.filter(
    c => c && c.role === 'team-member' && c.parentTeamId === teamAgentId,
  );
}

module.exports = { membersOfTeam };
