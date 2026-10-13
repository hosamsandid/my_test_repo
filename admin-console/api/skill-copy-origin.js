'use strict';

// Where a seeded agent copy's SOURCE lives (#2971). A team-tier skill is seeded
// from the AGENT team's pool (/workspace/teams/<parentTeamId>/skills) — the key
// the orchestrator seed/sync and the knowledge-graph overlay (#750) use — not
// from the member's human access-scope `teamId` (e.g. `default`). Looking it up
// under `teamId` finds no SKILL.md, so every member copy read as `orphaned`.
// One helper shared by every Skills Registry path that anchors a copy's drift.

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

// The team whose skill pool a member's team-tier copies come from: the agent
// team (`parentTeamId`), falling back to `teamId` for a standalone agent. Also
// the key a team row's downstream drift is bucketed under (#2317).
function skillSourceTeamIdOf(cfg) {
  if (!cfg || typeof cfg !== 'object') return undefined;
  return nonEmpty(cfg.parentTeamId) || nonEmpty(cfg.teamId) || undefined;
}

// The synthetic drift origin of a seeded agent copy, built from its
// seeded-skills.json entry (agent-tier dirs carry no skill.json origin of their
// own). Null when the copy was not seeded (hand-authored → no drift block).
function seededCopyOrigin(cfg, seeded) {
  if (!seeded || !seeded.tier) return null;
  return {
    tier: seeded.tier,
    teamId: seeded.tier === 'team' ? skillSourceTeamIdOf(cfg) : undefined,
    sourceHash: seeded.contentHash,
  };
}

module.exports = { skillSourceTeamIdOf, seededCopyOrigin };
