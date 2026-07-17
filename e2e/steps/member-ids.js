// Shared helper for the step library (#705). A team's member agent ids follow
// `<teamId>-<roleId>`. Steps accept EITHER an explicit `memberIds` list (what the
// F1 spec passes) OR `{ teamId, roleIds }` to derive them (what the team-setup
// journey YAML passes, so it doesn't repeat the id list on every step). Single
// source so wizard.js and agents.js never diverge on the naming scheme.
function resolveMemberIds({ memberIds, teamId, roleIds } = {}) {
  if (Array.isArray(memberIds) && memberIds.length) return memberIds;
  if (teamId && Array.isArray(roleIds)) return roleIds.map((r) => `${teamId}-${r}`);
  throw new Error('resolveMemberIds: pass either { memberIds } or { teamId, roleIds }');
}

module.exports = { resolveMemberIds };
