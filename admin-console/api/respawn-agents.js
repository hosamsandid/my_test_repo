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
// Returns: [{ id, displayName, role, teamId, teamName }] for every enabled,
//   materialized (has a Matrix token) agent whose effective endpoint matches.
function discoverBoundAgents(agentConfigs, endpointId, { loadEnvironment, effectiveEndpointId, loadTeamConfig }) {
  return agentConfigs
    .filter(cfg => {
      if (!cfg || cfg.enabled === false || !cfg.token) return false;
      const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
      return effectiveEndpointId(cfg, env) === endpointId;
    })
    .map(cfg => {
      const teamId = typeof cfg.parentTeamId === 'string' ? cfg.parentTeamId : null;
      const teamCfg = teamId ? loadTeamConfig(teamId) : null;
      return {
        id: cfg.id,
        displayName: cfg.displayName || cfg.id,
        role: cfg.role || 'agent',
        teamId,
        teamName: teamCfg ? (teamCfg.displayName || teamId) : null,
      };
    });
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

module.exports = { discoverBoundAgents, respawnWithConcurrency };
