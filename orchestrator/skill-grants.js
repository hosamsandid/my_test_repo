'use strict';

const { isSupportedAgentRole } = require("./agent-role-support");

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
  // A config naming a RETIRED role is left byte-identical on disk (#1962, epic
  // #1961 decision R2 — a hard cut, not a migration). A leftover bp-instance
  // stub has no `skills` key but does carry `environmentId`, so without this it
  // passes both other early returns and gets rewritten by the startup
  // migration — contradicting the promise this removal publishes. Keyed on the
  // shared predicate rather than a role list, so it also covers `orchestrator`
  // and cannot drift from the startup gate.
  if (!isSupportedAgentRole(cfg.role)) return null;
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

// Diff a team's requested skill list against its current one for a bulk
// Skills-tab save (#2286): dedupe/trim the incoming list (order-preserving,
// first occurrence wins), then compute which names newly become active and
// which newly become inactive relative to the CURRENT list. Pure — the
// orchestrator persists the returned `skills` list once and fans `added`/
// `removed` out to members via the existing per-skill setTeamSkillActive
// (itself built on planSkillSync above), so a save with no effective change
// (`changed: false`) triggers no write and no per-member sync (AC8).
function planTeamSkillsUpdate(currentSkills, requestedSkills) {
  const newList = [];
  const seen = new Set();
  for (const s of (Array.isArray(requestedSkills) ? requestedSkills : [])) {
    if (typeof s !== "string" || !s.trim()) continue;
    const name = s.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    newList.push(name);
  }
  const oldList = Array.isArray(currentSkills) ? currentSkills : [];
  const oldSet = new Set(oldList);
  const added = newList.filter((s) => !oldSet.has(s));
  const removed = oldList.filter((s) => !seen.has(s));
  return { skills: newList, added, removed, changed: added.length > 0 || removed.length > 0 };
}

module.exports = {
  effectiveSkills, hasSkillGrant, migrateSkillGrant, planSkillSync, planAgentGrantEdit,
  planTeamSkillsUpdate,
};
