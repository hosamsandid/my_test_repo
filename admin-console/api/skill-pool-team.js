'use strict';

// ---------------------------------------------------------------------------
// Which team skill pool an agent construct reads (#2689).
//
// The team pool lives at /workspace/teams/<poolTeamId>/skills. Seeding
// (orchestrator.js agentKnowledgeTeamId) keys it by the AGENT TEAM: a member's
// `parentTeamId`, a `team` agent's own id, and only a standalone agent falls
// back to its legacy human `teamId`. Every team agent still carries the legacy
// `teamId: "default"`, so a skill path that keys on `cfg.teamId` lands in a
// pool no agent team reads. These helpers are the one admin-console answer —
// create/import target check, adopt activation, the delete and move guards —
// so they agree with seeding.
//
// Pure (no fs): the api.js callers read configs and pass them in.
// ---------------------------------------------------------------------------

const DEFAULT_TEAM_ID = 'default';

// The pool team id an agent construct's skill grants resolve against. Must stay
// in step with orchestrator.js agentKnowledgeTeamId.
function agentPoolTeamId(cfg) {
  if (!cfg) return DEFAULT_TEAM_ID;
  if (typeof cfg.parentTeamId === 'string' && cfg.parentTeamId.trim()) return cfg.parentTeamId;
  if (cfg.role === 'team' && typeof cfg.id === 'string' && cfg.id.trim()) return cfg.id;
  return cfg.teamId || DEFAULT_TEAM_ID;
}

// Is `teamId` a valid team-pool target? An Agent Team (the `team` agent with
// that id — what the Skills page pickers offer since #2393), or a legacy human
// team from teams/index.json (still read by standalone agents).
function poolTeamExists(teamId, { agentConfig = null, legacyTeams = [] } = {}) {
  if (typeof teamId !== 'string' || !teamId) return false;
  if (agentConfig && agentConfig.role === 'team' && agentPoolTeamId(agentConfig) === teamId) return true;
  return Array.isArray(legacyTeams) && legacyTeams.some((t) => t && t.id === teamId);
}

// The Agent Teams that seed from `poolTeamId`'s pool — the constructs a freshly
// adopted team skill is activated on.
function squadsForPoolTeam(configs, poolTeamId) {
  return (configs || [])
    .filter((c) => c && c.role === 'team' && agentPoolTeamId(c) === poolTeamId)
    .map((c) => c.id);
}

module.exports = { DEFAULT_TEAM_ID, agentPoolTeamId, poolTeamExists, squadsForPoolTeam };
