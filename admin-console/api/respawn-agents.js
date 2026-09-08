'use strict';

// Pure logic for the respawn-on-credential-rotation feature (PR #1049):
// which agents are bound to a given LLM provider, and how to respawn a
// batch of them without overwhelming the orchestrator/Podman host. No
// filesystem or network I/O of its own — the caller (api.js) injects
// already-loaded data and small lookup functions, so this module is
// fully unit-testable in isolation. See respawn-agents.test.js.

// agentConfigs: array of already-loaded config.json contents (null entries
//   allowed and skipped, e.g. a corrupt or unreadable file).
// endpointId: the LLM provider id to filter on.
// deps.loadEnvironment(environmentId): => environment object or null.
// deps.effectiveEndpointId(cfg, env): => resolved endpoint id or null.
// deps.loadTeamConfig(teamId): => that team agent's config.json contents or null.
// deps.isVisible(cfg): => may the CALLER see this agent? (#1501)
// Returns: { visible, hidden } — two arrays of the same projected shape
//   `{ id, displayName, role, teamId, teamName }`, together covering every
//   enabled, materialized (has a Matrix token) agent whose effective endpoint
//   matches, partitioned by `isVisible`.
//
// The split exists because the two consumers need different sets and neither is
// "all" (#1501): the bound-agents LIST may only disclose agents the caller could
// already see elsewhere in the console, while the RESPAWN must reach every
// consumer of the rotated credential — hiding an agent from the respawn would
// leave it running on a stale credential, which is worse than the metadata leak.
// `isVisible` is deliberately REQUIRED rather than defaulting to "everything is
// visible": a fail-open default is exactly the shape of the bug this closes, and
// a future third call site must state its own answer instead of inheriting one.
function discoverBoundAgents(agentConfigs, endpointId, { loadEnvironment, effectiveEndpointId, loadTeamConfig, isVisible }) {
  if (typeof isVisible !== 'function') {
    throw new TypeError('discoverBoundAgents: deps.isVisible(cfg) is required');
  }
  const visible = [];
  const hidden = [];
  for (const cfg of agentConfigs) {
    if (!cfg || cfg.enabled === false || !cfg.token) continue;
    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    if (effectiveEndpointId(cfg, env) !== endpointId) continue;
    const teamId = typeof cfg.parentTeamId === 'string' ? cfg.parentTeamId : null;
    const teamCfg = teamId ? loadTeamConfig(teamId) : null;
    const entry = {
      id: cfg.id,
      displayName: cfg.displayName || cfg.id,
      role: cfg.role || 'agent',
      teamId,
      teamName: teamCfg ? (teamCfg.displayName || teamId) : null,
    };
    (isVisible(cfg) ? visible : hidden).push(entry);
  }
  return { visible, hidden };
}

// The blast-radius signal an operator needs even when they may not see who is in
// it (#1501): how many bound agents are hidden from this caller, and across how
// many distinct teams — never an id, a display name or a team name.
//
// `teamCount` counts distinct team boundaries only. A hidden agent outside every
// team (no `parentTeamId` — someone else's standalone agent) is counted in
// `count` and reported separately in `standalone`, because folding it into
// `teamCount` would claim a team that does not exist.
function hiddenBlastRadius(hidden) {
  const teamIds = new Set();
  let standalone = 0;
  for (const a of hidden) {
    if (a.teamId) teamIds.add(a.teamId);
    else standalone++;
  }
  return { count: hidden.length, teamCount: teamIds.size, standalone };
}

// Project a respawn outcome onto what the caller may be told (#1501). Ids are
// disclosed only for agents the caller can already see; everything else survives
// as a count, so the response never becomes a way to enumerate another team's
// agent ids while still telling the operator the rotation's true reach.
//
// outcome: { respawned: string[], skipped: string[] } from respawnWithConcurrency.
// visibleIds: Set<string> of the ids the caller may see.
function projectRespawnOutcome({ respawned, skipped }, visibleIds) {
  return {
    respawned: respawned.filter(id => visibleIds.has(id)),
    skipped: skipped.filter(id => visibleIds.has(id)),
    hiddenRespawned: respawned.filter(id => !visibleIds.has(id)).length,
    hiddenSkipped: skipped.filter(id => !visibleIds.has(id)).length,
  };
}

// ids: string[] of agent ids to respawn.
// concurrency: requested max simultaneous respawnFn calls. Floored to a
//   minimum of 1 here (algorithm-level safety invariant) regardless of what
//   the caller passes in — a bad value must never spawn zero workers and
//   hang forever. The caller (api.js) separately decides what number to
//   request (its own "default to 5 when unset" policy) before calling this.
// respawnFn: async (id) => boolean — true if that agent was respawned.
// Returns: { respawned: string[], skipped: string[] }, ids partitioned by
//   respawnFn's result, in no particular order (concurrent completion order).
async function respawnWithConcurrency(ids, concurrency, respawnFn) {
  // Floor to 1 whenever the requested value isn't a usable positive number
  // (covers 0, negative numbers, and NaN in one check — Number.isFinite(NaN)
  // is false, so NaN never reaches the >= 1 comparison at all).
  const safeConcurrency = Number.isFinite(concurrency) && concurrency >= 1 ? concurrency : 1;
  const workerCount = Math.min(safeConcurrency, ids.length);
  const results = new Array(ids.length);
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const i = next++;
      results[i] = await respawnFn(ids[i]);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  const respawned = ids.filter((_, i) => results[i]);
  const skipped = ids.filter((_, i) => !results[i]);
  return { respawned, skipped };
}

module.exports = {
  discoverBoundAgents,
  hiddenBlastRadius,
  projectRespawnOutcome,
  respawnWithConcurrency,
};
