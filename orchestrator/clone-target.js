"use strict";

// clone-target.js — pure decision logic for POST /internal/agents/:id/clone.
//
// Cloning an agent onto a target team is the same role/environment resolution
// importAgent() already does for the import flow (orchestrator.js): resolved
// here as a standalone, unit-testable function so cloneAgent() stays a thin
// fs/Matrix orchestration wrapper around it.

function resolveCloneTarget(sourceCfg, opts, teamCfg) {
  const parentTeamId = opts && opts.parentTeamId ? opts.parentTeamId : null;
  if (parentTeamId) {
    if (!teamCfg) throw new Error(`Team '${parentTeamId}' not found`);
    if (teamCfg.role !== "team") {
      throw new Error(`Agent '${parentTeamId}' is not a team (role=${teamCfg.role})`);
    }
    return { role: "team-member", parentTeamId, environmentId: teamCfg.environmentId };
  }
  return { role: "agent", parentTeamId: null, environmentId: sourceCfg.environmentId };
}

module.exports = { resolveCloneTarget };
