'use strict';

/*
 * One read of every agent config for a knowledge request (#571).
 *
 * `GET /api/knowledge/graph` used to sweep `/workspace/agents/*` once per helper
 * per team — `resolveTeamStorePath`, `teamAgentIds`, `knowledgeTeamByAgent`,
 * `teamEnvironment` inside `gatherTeamEntries` (per team), `knowledgeTeamVisible`
 * per team for a non-admin global scope (quadratic), `gatherKnowledgeAgents` and
 * the member walk in `augmentSkillActivation`. With ~110 agents that was the
 * worst console route in a measured deployment (p50 7 s, max 15.7 s).
 *
 * The route now builds this fleet once and answers every one of those lookups
 * from it. The functions below are the helpers re-expressed over the fleet;
 * `knowledge-fleet.test.js` runs them against verbatim copies of the
 * pre-#571 helpers over a fixture agents dir and asserts identical output.
 *
 * Slim entries only: the fields the helpers read, plus `provisioned` in place
 * of the Matrix token (the token itself is never kept). Pure — every fs read,
 * `agentKnowledgeTeam` and `agentMetaForScope` are injected (#651 convention).
 */

// `agentIds` — `listAgentDirs()` (dirs holding a config.json, disk order).
// `readConfig(id)` returns the parsed config or null. A config that throws or
// reads as null is kept as an EMPTY config, never dropped: that is exactly how
// the old sweeps saw it (`readJsonFile(…, {})`), so a malformed agent still
// counts toward the 'default' knowledge team as before. It is reported once
// through `onEntryError(id, err)` and can never poison the other entries; a
// config that reads cleanly is reported through `onEntryOk(id)`, so a caller
// deduping its warnings can re-arm them once the config is fixed.
function buildKnowledgeFleet(agentIds, { readConfig, onEntryError = () => {}, onEntryOk = () => {}, agentKnowledgeTeam, agentMetaForScope } = {}) {
  const entries = [];
  const byId = new Map();
  for (const agentId of Array.isArray(agentIds) ? agentIds : []) {
    let cfg = null;
    try {
      cfg = readConfig(agentId);
      if (!cfg || typeof cfg !== 'object') {
        onEntryError(agentId, new Error('config.json unreadable'));
        cfg = {};
      } else {
        onEntryOk(agentId);
      }
    } catch (err) {
      onEntryError(agentId, err);
      cfg = {};
    }
    const entry = Object.freeze({
      agentId,
      role: cfg.role,
      parentTeamId: cfg.parentTeamId,
      teamId: cfg.teamId,
      environmentId: cfg.environmentId,
      displayName: cfg.displayName,
      skills: Array.isArray(cfg.skills) ? Object.freeze(cfg.skills.slice()) : cfg.skills,
      skillsOverride: Array.isArray(cfg.skillsOverride) ? Object.freeze(cfg.skillsOverride.slice()) : cfg.skillsOverride,
      provisioned: !!cfg.token,
      // The old helpers resolved the knowledge team two ways: with the dir name
      // as the id fallback (`{ ...cfg, id: cfg.id || id }`) and on the bare
      // config. They differ only for a `role: 'team'` config without an `id`.
      knowledgeTeam: agentKnowledgeTeam({ ...cfg, id: cfg.id || agentId }),
      knowledgeTeamBare: agentKnowledgeTeam(cfg),
      meta: Object.freeze(agentMetaForScope(cfg)),
    });
    entries.push(entry);
    byId.set(agentId, entry);
  }
  return Object.freeze({ entries: Object.freeze(entries), byId });
}

// The fleet is rebuilt on every uncached knowledge request, so a broken config
// must not warn on every build. Warn once per broken streak — again only when
// its cause changes — and re-arm once the config reads cleanly, so a later
// re-break is logged. `shouldWarn(id, err)` feeds onEntryError, `ok(id)`
// onEntryOk. Bounded by the number of currently broken agents.
function createEntryWarnings() {
  const warned = new Map(); // agentId → last warned cause
  return {
    shouldWarn(agentId, err) {
      const cause = err && err.message ? err.message : String(err);
      if (warned.get(agentId) === cause) return false;
      warned.set(agentId, cause);
      return true;
    },
    ok(agentId) { warned.delete(agentId); },
    get size() { return warned.size; },
  };
}

// Knowledge-team visibility: the caller sees a knowledge team when it sees the
// human team any of its agents belongs to (admin scopes short-circuit).
// `fleet` may be a thunk returning one: it is only called once the cheap
// checks (no scope, admin, a direct membership) have not decided.
function knowledgeTeamVisible(fleet, scope, knowledgeTeamId, { visibleTeam }) {
  if (!scope) return false;
  if (scope.all) return true;
  if (visibleTeam(scope, knowledgeTeamId)) return true;
  const f = typeof fleet === 'function' ? fleet() : fleet;
  for (const e of f.entries) {
    if (e.knowledgeTeamBare !== knowledgeTeamId) continue;
    if (visibleTeam(scope, e.teamId)) return true;
  }
  return false;
}

// A team's KB store-relative path from the first of its agents' environments
// that names one; else `defaultStorePath`.
function resolveTeamStorePath(fleet, teamId, { loadEnvironment, loadTeamKnowledgeOverrides, mergeTeamKnowledgeConfig, defaultStorePath }) {
  for (const e of fleet.entries) {
    if (e.knowledgeTeamBare !== teamId || !e.environmentId) continue;
    const env = mergeTeamKnowledgeConfig(loadEnvironment(e.environmentId), loadTeamKnowledgeOverrides(teamId));
    const p = env && env.knowledgeStore && typeof env.knowledgeStore.path === 'string'
      ? env.knowledgeStore.path : null;
    if (p) return p.replace(/^\/+|\/+$/g, '') + '/';
  }
  return defaultStorePath;
}

// A team's KB repo web URL for provenance links (sourceRefs → PR/issue): the
// first of its agents' environments with a KB repoRef or a repository wins.
function resolveTeamRepoUrl(fleet, teamId, { loadEnvironment, loadTeamKnowledgeOverrides, mergeTeamKnowledgeConfig }) {
  for (const e of fleet.entries) {
    if (e.knowledgeTeamBare !== teamId || !e.environmentId) continue;
    const env = mergeTeamKnowledgeConfig(loadEnvironment(e.environmentId), loadTeamKnowledgeOverrides(teamId));
    const ref = env && env.knowledgeStore && env.knowledgeStore.repoRef;
    if (ref && ref.url) return ref.url;
    const repos = (env && env.repositories) || [];
    if (repos[0] && repos[0].url) return repos[0].url;
  }
  return null;
}

function teamAgentIds(fleet, teamId) {
  return fleet.entries.filter((e) => e.knowledgeTeamBare === teamId).map((e) => e.agentId);
}

// originAgent → knowledge team, for re-homing entries at read time.
function knowledgeTeamByAgent(fleet) {
  const map = new Map();
  for (const e of fleet.entries) map.set(e.agentId, e.knowledgeTeam);
  return map;
}

// The environment a team shares: the first of its agents' environments that loads.
function teamEnvironment(fleet, teamId, { loadEnvironment }) {
  for (const e of fleet.entries) {
    if (e.knowledgeTeam === teamId && e.environmentId) {
      const env = loadEnvironment(e.environmentId);
      if (env) return env;
    }
  }
  return null;
}

// Which knowledge teams a scope resolves to. `team:`/`agent:` scopes return the
// one team as-is (no visibility filter — unchanged here); `global` is every
// team that has agents, narrowed by `isVisible(team)`.
function knowledgeScopeTeams(fleet, parsed, { agentKnowledgeTeam, isVisible }) {
  if (parsed.kind === 'team') return [parsed.id];
  if (parsed.kind === 'agent') {
    const e = fleet.byId.get(parsed.id);
    return [e ? e.knowledgeTeam : agentKnowledgeTeam({ id: parsed.id })];
  }
  const teams = new Set();
  for (const e of fleet.entries) teams.add(e.knowledgeTeam);
  return [...teams].filter((t) => isVisible(t));
}

// The contributor agents of `teamIds` the caller may see (team template holders excluded).
function gatherKnowledgeAgents(fleet, scope, teamIds, { visibleAgent }) {
  const set = new Set(teamIds);
  const agents = [];
  for (const e of fleet.entries) {
    if (e.role === 'team') continue;
    if (!set.has(e.knowledgeTeam)) continue;
    if (!visibleAgent(scope, e.meta)) continue;
    agents.push({ id: e.agentId, parentTeamId: e.knowledgeTeam, environmentId: e.environmentId || null, displayName: e.displayName || e.agentId });
  }
  return agents;
}

// The team agent's own grant list, or null when `teamId` is not a team agent.
function teamSkillGrant(fleet, teamId) {
  const e = fleet.byId.get(teamId);
  if (!e || e.role !== 'team') return null;
  return { skills: Array.isArray(e.skills) ? e.skills : [] };
}

// A team's members in the shape `augmentSkillActivation` reads. `id` is the
// agent's DIRECTORY name, never `cfg.id`: the caller joins it onto
// `AGENTS_DIR` to read the member's manifests, so a config without an `id`
// (path.join(…, undefined) throws) or with one that differs from its dir must
// still address the directory the config was read from.
function teamMembers(fleet, teamId) {
  return fleet.entries
    .filter((e) => e.role === 'team-member' && e.parentTeamId === teamId)
    .map((e) => ({
      id: e.agentId,
      displayName: e.displayName,
      parentTeamId: e.parentTeamId,
      teamId: e.teamId,
      skillsOverride: e.skillsOverride,
      provisioned: e.provisioned,
    }));
}

module.exports = {
  buildKnowledgeFleet,
  createEntryWarnings,
  knowledgeTeamVisible,
  resolveTeamStorePath,
  resolveTeamRepoUrl,
  teamAgentIds,
  knowledgeTeamByAgent,
  teamEnvironment,
  knowledgeScopeTeams,
  gatherKnowledgeAgents,
  teamSkillGrant,
  teamMembers,
};
