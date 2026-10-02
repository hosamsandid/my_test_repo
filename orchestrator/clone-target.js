"use strict";

// clone-target.js — pure decision logic for POST /internal/agents/:id/clone.
//
// Cloning an agent onto a target team is the same role/environment resolution
// importAgent() already does for the import flow (orchestrator.js): resolved
// here as a standalone, unit-testable function so cloneAgent() stays a thin
// fs/Matrix orchestration wrapper around it.

const { deriveTeamId } = require("./team-conversion");

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

// A clone or import with no target team is not left as a bare `role: 'agent'`
// (the rail never lists one, #2234) — it is folded into a team of one right
// after it is written (#2684), and that team takes the derived `<id>-team` id.
// Checked BEFORE anything is provisioned so a collision is refused up front
// rather than discovered after the Matrix user and workspace already exist.
// Returns the clashing team id, or null when the fold can go ahead.
function teamOfOneIdConflict(newId, isTaken) {
  const teamId = deriveTeamId(newId);
  return isTaken(teamId) ? teamId : null;
}

module.exports = { resolveCloneTarget, teamOfOneIdConflict };
