// Team-owned skill grants (docs/knowledge-skill-activation-concept.md).
//
// The skill GRANT (which skill names are active for an agent) lives on the
// agent construct, never on the Working Environment:
//
//   - team agents (`role: "team"`) carry `skills[]` — the team's active set
//   - standalone agents / orchestrators carry their own `skills[]`
//   - team-members inherit the parent team's list unless `skillsOverride` is set
//   - bp-instances inherit the parent orchestrator's list the same way
//
// The Working Environment is a pure infrastructure template (repo, credentials,
// MCP, additionalContext); its legacy `skills[]` field is migrated onto the
// agent configs once at orchestrator startup and ignored afterwards. The
// two-tier skill POOL (team pool / global pool, team-first resolution in
// skill-source.js) is unchanged — only the grant moved.
//
// Pure module, unit-tested in skill-grants.test.js.

"use strict";

// Resolve the effective skill list for an agent config.
// `loadCfg(id)` is used to look up the parent construct (team / orchestrator)
// when the agent inherits; pass the orchestrator's loadAgentConfig.
function effectiveSkills(cfg, loadCfg = null) {
  if (!cfg) return [];
  // An explicit override always wins (team-member semantics, unchanged).
  if (Array.isArray(cfg.skillsOverride)) return cfg.skillsOverride;
  // The construct's own grant.
  if (Array.isArray(cfg.skills)) return cfg.skills;
  // Inherit from the parent construct.
  const parentId =
    cfg.role === "team-member" ? cfg.parentTeamId :
    cfg.role === "bp-instance" ? cfg.parentOrchestratorId :
    null;
  if (parentId && typeof loadCfg === "function") {
    const parent = loadCfg(parentId);
    if (parent && Array.isArray(parent.skills)) return parent.skills;
  }
  return [];
}

// Does this agent's resolved grant contain any skills? Drives the CLAUDE.md
// Skills-section gate (successor of the env-based `envHasSkills`).
function hasSkillGrant(skills) {
  return Array.isArray(skills) && skills.length > 0;
}

// One-time grant migration: copy the legacy env grant onto a config that does
// not carry `skills` yet. Returns the migrated config, or null when nothing to
// do. Idempotent — an existing `skills` field always wins; team-members keep
// the inherit/override model and are never touched; bp-instances inherit from
// their parent orchestrator (which is itself migrated), so they are skipped too.
function migrateSkillGrant(cfg, env) {
  if (!cfg) return null;
  if (cfg.role === "team-member" || cfg.role === "bp-instance") return null;
  if (Array.isArray(cfg.skills)) return null;
  const inherited = env && Array.isArray(env.skills) ? [...env.skills] : [];
  return { ...cfg, skills: inherited };
}

module.exports = { effectiveSkills, hasSkillGrant, migrateSkillGrant };
