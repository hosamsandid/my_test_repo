'use strict';

// Three-tier skill resolution (#306 two-tier; agent tier added by the
// Shared Agent Learning & Knowledge Flow, Phase 0).
//
// A skill name can be served from three pools, most specific first:
//   - the agent's own pool     — <workspace>/agents/<id>/skills/<name>   (that agent only)
//   - the owning team's pool    — <workspace>/teams/<teamId>/skills/<name> (the team)
//   - the global pool           — <templateWorkspace>/skills/<name>        (all teams)
//
// At agent seeding the most specific copy wins: an agent's private skill shadows
// the team's, and the team's shadows the global one — so a team (or an agent) can
// add or override skills without leaking them upward. When a tier has no skill of
// that name, resolution falls through to the next, so:
//   - a team with no own pool behaves exactly as the global-only pre-#306 setup;
//   - callers that pass no agentId get the identical two-tier behaviour as before.
//
// The agent tier mirrors T0 memory (already agent-private) and is the bottom rung
// of the Agent -> Team -> Global skill pool. In Phase 0 the on-disk agent pool is
// not materialised (no agent has that directory yet), so resolution falls through
// to team/global exactly as today; the tier is wired for Phase 3 promotion.
//
// Pure (apart from the injected fs.existsSync), so it is unit-testable without
// booting the orchestrator service.

const fs = require('fs');
const path = require('path');

function makeSkillSourceResolver({ workspace, templateWorkspace, defaultTeamId = 'default' } = {}) {
  if (!workspace || !templateWorkspace) {
    throw new Error('makeSkillSourceResolver: { workspace, templateWorkspace } are required');
  }

  function agentSkillsDir(agentId) {
    return path.join(workspace, 'agents', agentId, 'skills');
  }

  function teamSkillsDir(teamId) {
    return path.join(workspace, 'teams', teamId || defaultTeamId, 'skills');
  }

  function globalSkillsDir() {
    return path.join(templateWorkspace, 'skills');
  }

  // Returns the absolute source dir for a skill name, resolving agent-first (when
  // an agentId is given), then team, then global — or null when no tier has it.
  function resolveSkillSourceDir(skillName, teamId, { agentId = null, existsSync = fs.existsSync } = {}) {
    if (agentId) {
      const agentSrc = path.join(agentSkillsDir(agentId), skillName);
      if (existsSync(agentSrc)) return agentSrc;
    }
    const teamSrc = path.join(teamSkillsDir(teamId), skillName);
    if (existsSync(teamSrc)) return teamSrc;
    const globalSrc = path.join(globalSkillsDir(), skillName);
    if (existsSync(globalSrc)) return globalSrc;
    return null;
  }

  return { agentSkillsDir, teamSkillsDir, globalSkillsDir, resolveSkillSourceDir };
}

module.exports = { makeSkillSourceResolver };
