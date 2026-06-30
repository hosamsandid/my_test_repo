'use strict';

// Two-tier skill resolution (#306).
//
// A skill name can be served from two pools:
//   - the owning team's pool   — <workspace>/teams/<teamId>/skills/<name>
//   - the global pool          — <templateWorkspace>/skills/<name>
//
// At agent seeding the owning team's copy wins over the global one, so a team
// can shadow or add private domain skills without leaking them to other teams.
// When a team has no skill of that name, resolution falls back to global — so
// the pre-#306 global-only behaviour is unchanged for teams with no own pool.
//
// Pure (apart from the injected fs.existsSync), so it is unit-testable without
// booting the orchestrator service.

const fs = require('fs');
const path = require('path');

function makeSkillSourceResolver({ workspace, templateWorkspace, defaultTeamId = 'default' } = {}) {
  if (!workspace || !templateWorkspace) {
    throw new Error('makeSkillSourceResolver: { workspace, templateWorkspace } are required');
  }

  function teamSkillsDir(teamId) {
    return path.join(workspace, 'teams', teamId || defaultTeamId, 'skills');
  }

  function globalSkillsDir() {
    return path.join(templateWorkspace, 'skills');
  }

  // Returns the absolute source dir for a skill name, team-first then global,
  // or null when neither pool has it.
  function resolveSkillSourceDir(skillName, teamId, { existsSync = fs.existsSync } = {}) {
    const teamSrc = path.join(teamSkillsDir(teamId), skillName);
    if (existsSync(teamSrc)) return teamSrc;
    const globalSrc = path.join(globalSkillsDir(), skillName);
    if (existsSync(globalSrc)) return globalSrc;
    return null;
  }

  return { teamSkillsDir, globalSkillsDir, resolveSkillSourceDir };
}

module.exports = { makeSkillSourceResolver };
