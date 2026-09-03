// Team-owned skill grants (docs/knowledge-skill-activation-concept.md).
//
// The skill GRANT (which skill names are active for an agent) lives on the
// agent construct, never on the Working Environment:
//
//   - team agents (`role: "team"`) carry `skills[]` — the team's active set
//   - standalone agents carry their own `skills[]`
//   - team-members inherit the parent team's list unless `skillsOverride` is set
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
  // Inherit from the parent construct. `team-member` is the only inheriting
  // role — `bp-instance` (which inherited from its parent orchestrator) went
  // with the BriefingPack model in #1962.
  const parentId = cfg.role === "team-member" ? cfg.parentTeamId : null;
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
// the inherit/override model and are never touched.
function migrateSkillGrant(cfg, env) {
  if (!cfg) return null;
  if (cfg.role === "team-member") return null;
  if (Array.isArray(cfg.skills)) return null;
  const inherited = env && Array.isArray(env.skills) ? [...env.skills] : [];
  return { ...cfg, skills: inherited };
}

// Plan the per-member fan-out of a team skill (de)activation. Pure: takes the
// member configs, returns one action per member — the orchestrator executes.
//
//   sync           — copy/remove the skill in this member's workspace
//   sync-override  — member has a skillsOverride but was explicitly opted in
//                    (activate: also append to the override; deactivate: remove)
//   skip-override  — member keeps its own list; surfaced to the UI, opt-in later
//   stub           — not materialized; consistent by construction (the team
//                    list already carries the name, the normal seed path
//                    delivers it at enable)
function planSkillSync({ members = [], skillName, includeMembers = [] } = {}) {
  const optIn = new Set(includeMembers);
  return members
    .filter((m) => m && m.id)
    .map((m) => {
      if (!m.token) return { agentId: m.id, action: "stub" };
      if (Array.isArray(m.skillsOverride)) {
        // An override member already carrying the name is treated like an
        // inheriting member (its grant contains the skill either way).
        if (m.skillsOverride.includes(skillName)) return { agentId: m.id, action: "sync" };
        if (optIn.has(m.id)) return { agentId: m.id, action: "sync-override" };
        return { agentId: m.id, action: "skip-override" };
      }
      return { agentId: m.id, action: "sync" };
    });
}

// Plan the grant edit for a single-agent (de)activation (#630, install/activate
// on one agent). Pure: returns the config field to write and its new value —
// the orchestrator persists it. A team-member writes its own `skillsOverride`
// (which REPLACES the inherited team set, so the current effective grant is
// materialized first to preserve inherited skills); any other construct
// (standalone agent / team) writes its own `skills[]`.
// Idempotent set insert (activate) / remove (deactivate). This is what makes
// `install` a true activation-equivalent: the grant now survives a full re-seed.
function planAgentGrantEdit(cfg, skillName, active, loadCfg = null) {
  const name = String(skillName == null ? "" : skillName).trim();
  const field = cfg && cfg.role === "team-member" ? "skillsOverride" : "skills";
  const base = field === "skillsOverride"
    ? (Array.isArray(cfg.skillsOverride) ? cfg.skillsOverride : effectiveSkills(cfg, loadCfg))
    : (cfg && Array.isArray(cfg.skills) ? cfg.skills : []);
  const list = active
    ? (base.includes(name) ? [...base] : [...base, name])
    : base.filter((s) => s !== name);
  return { field, list };
}

module.exports = { effectiveSkills, hasSkillGrant, migrateSkillGrant, planSkillSync, planAgentGrantEdit };
