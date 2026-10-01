'use strict';

// ─── plugin grants (plugin system Phase 2, #1518) ────────────────────────────
//
// The plugin GRANT (which plugins are active for an agent, and at which scope
// granularity) lives on the agent construct — the sibling of the skill grant in
// skill-grants.js, and for the same reason: the Working Environment is a pure
// infrastructure template and never carries a grant (docs/plugin-system-concept
// .md §4.4, "skill-grant doctrine").
//
//   - team agents (`role: "team"`) carry `plugins[]` — the team's active set,
//     inherited by every member without a `pluginsOverride`
//   - standalone agents carry their own `plugins[]`
//   - team-members inherit the parent team's list unless `pluginsOverride` is set
//
// A grant is richer than a skill grant: it carries a per-grant scope
// granularity (§4.4/§4.6). Each entry normalises to `{ id, scopeGranularity }`
// where `scopeGranularity` is "team" (default) or "agent". Granularity is a
// property of the *grant*, not of the plugin — the same plugin is shared
// infrastructure for one team and per-agent infrastructure for the next. A bare
// string entry (`"dummy-echo"`) is the shorthand for `{ id, scopeGranularity:
// "team" }`, so an existing all-team config needs no rewrite.
//
// Whether the chosen granularity is one the plugin's broker actually honours is
// bounded by the manifest's `scopes` and enforced by `assertGranularityGrantable`
// in plugin-manifest.js — a concern of the grant path, not of resolution.
//
// Pure module, unit-tested in plugin-grants.test.js.

const DEFAULT_GRANULARITY = 'team';
const GRANULARITIES = Object.freeze(['team', 'agent']);

// Normalise one raw grant entry (string shorthand or object) into the canonical
// `{ id, scopeGranularity }` shape. Returns null for anything unusable so a
// malformed entry is dropped rather than crashing resolution (fail-soft).
function normalizeGrant(entry) {
  if (typeof entry === 'string') {
    const id = entry.trim();
    return id ? { id, scopeGranularity: DEFAULT_GRANULARITY } : null;
  }
  if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.trim()) {
    const g = GRANULARITIES.includes(entry.scopeGranularity) ? entry.scopeGranularity : DEFAULT_GRANULARITY;
    return { id: entry.id.trim(), scopeGranularity: g };
  }
  return null;
}

// Normalise + de-duplicate a raw grant list (last entry for an id wins, so a
// granularity flip written by appending resolves to the new value).
function normalizeGrantList(list) {
  if (!Array.isArray(list)) return [];
  const byId = new Map();
  for (const raw of list) {
    const g = normalizeGrant(raw);
    if (g) byId.set(g.id, g);
  }
  return [...byId.values()];
}

// Resolve the effective plugin grant for an agent config, mirroring
// `effectiveSkills` exactly (override wins → own grant → inherit from parent).
// `loadCfg(id)` looks up the parent construct when the agent inherits.
// Returns a normalised `{ id, scopeGranularity }[]`.
function effectivePlugins(cfg, loadCfg = null) {
  if (!cfg) return [];
  // An explicit override always wins (team-member semantics).
  if (Array.isArray(cfg.pluginsOverride)) return normalizeGrantList(cfg.pluginsOverride);
  // The construct's own grant.
  if (Array.isArray(cfg.plugins)) return normalizeGrantList(cfg.plugins);
  // Inherit from the parent construct. `team-member` is the only inheriting
  // role — `bp-instance` (which inherited from its parent orchestrator) went
  // with the BriefingPack model in #1962.
  const parentId = cfg.role === 'team-member' ? cfg.parentTeamId : null;
  if (parentId && typeof loadCfg === 'function') {
    const parent = loadCfg(parentId);
    if (parent && Array.isArray(parent.plugins)) return normalizeGrantList(parent.plugins);
  }
  return [];
}

// Does this agent's resolved grant contain any plugins? Drives the CLAUDE.md
// "Plugin Capabilities" section gate (sibling of hasSkillGrant).
function hasPluginGrant(plugins) {
  return Array.isArray(plugins) && plugins.length > 0;
}

// The resolved grant entry for a plugin id, or null when not granted.
function pluginGrantFor(plugins, pluginId) {
  return normalizeGrantList(plugins).find((g) => g.id === pluginId) || null;
}

// Plan the grant edit for a single agent (de)activation, mirroring
// `planAgentGrantEdit`. Pure: returns the config field to write and its new
// value — the orchestrator persists it. A team-member writes its own
// `pluginsOverride` (which REPLACES the inherited team set, so the current
// effective grant is materialised first to preserve inherited plugins); any
// other construct writes its own `plugins[]`.
//
// Idempotent set upsert (activate) / remove (deactivate) keyed on plugin id.
// Because it is keyed on id, activating a plugin already granted at a DIFFERENT
// granularity is a **granularity flip**: the entry is replaced in place with the
// new granularity (see §4.6 — the flip re-mints the token and re-syncs config;
// resources created under the old scopeId keep their owner label and are reaped
// by TTL/teardown, so this is additive with no ownership migration).
function planAgentPluginGrantEdit(cfg, grant, active, loadCfg = null) {
  const g = normalizeGrant(grant);
  const field = cfg && cfg.role === 'team-member' ? 'pluginsOverride' : 'plugins';
  const base = field === 'pluginsOverride'
    ? (Array.isArray(cfg.pluginsOverride) ? normalizeGrantList(cfg.pluginsOverride) : effectivePlugins(cfg, loadCfg))
    : (cfg && Array.isArray(cfg.plugins) ? normalizeGrantList(cfg.plugins) : []);
  if (!g) return { field, list: base };
  const without = base.filter((e) => e.id !== g.id);
  const list = active ? [...without, g] : without;
  return { field, list };
}

// The grant a DEACTIVATE may still revoke once the plugin's manifest is gone
// (uninstalled, or its manifest no longer validates — #2651). Uninstalling
// deliberately keeps grants, so without this a leftover grant could only be
// revoked by re-installing the plugin first. Only an existing grant qualifies:
// `currentGrant` is the list the edit will act on, and an id it does not carry
// returns null so the caller keeps the "not installed" error. Activation never
// qualifies — nothing can be seeded without a manifest. The stored granularity
// is returned so the edit and the member fan-out match what is on the construct.
function uninstalledRevokeGrant(active, currentGrant, pluginId) {
  if (active) return null;
  const id = typeof pluginId === 'string' ? pluginId.trim() : '';
  if (!id) return null;
  return pluginGrantFor(currentGrant, id);
}

// Plan the per-member fan-out of a team plugin (de)activation, mirroring
// `planSkillSync`. Pure: takes the member configs, returns one action per
// member. The team-level grant carries the granularity, so `grant` is the full
// `{ id, scopeGranularity }` — at 'agent' granularity each member still resolves
// its OWN scopeId (plugin-scope.js), the fan-out shape is identical either way
// (reachability is per agent regardless — §4.3).
//
//   sync           — (de)activate the plugin in this member's workspace
//   sync-override  — member has a pluginsOverride but was explicitly opted in
//   skip-override  — member keeps its own list; surfaced to the UI, opt-in later
//   stub           — not materialised; consistent by construction
function planPluginSync({ members = [], grant, includeMembers = [] } = {}) {
  const g = normalizeGrant(grant);
  const pluginId = g ? g.id : (grant && grant.id) || grant;
  const optIn = new Set(includeMembers);
  return (Array.isArray(members) ? members : [])
    .filter((m) => m && m.id)
    .map((m) => {
      if (!m.token) return { agentId: m.id, action: 'stub' };
      if (Array.isArray(m.pluginsOverride)) {
        const has = normalizeGrantList(m.pluginsOverride).some((e) => e.id === pluginId);
        if (has) return { agentId: m.id, action: 'sync' };
        if (optIn.has(m.id)) return { agentId: m.id, action: 'sync-override' };
        return { agentId: m.id, action: 'skip-override' };
      }
      return { agentId: m.id, action: 'sync' };
    });
}

module.exports = {
  DEFAULT_GRANULARITY,
  GRANULARITIES,
  normalizeGrant,
  normalizeGrantList,
  effectivePlugins,
  hasPluginGrant,
  pluginGrantFor,
  planAgentPluginGrantEdit,
  planPluginSync,
  uninstalledRevokeGrant,
};
