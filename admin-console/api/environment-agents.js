'use strict';

// One pass over the agent configs, indexed by `environmentId` (#570).
//
// `GET /api/environments` used to call `agentsUsingEnvironment` once per
// environment, and each call re-read every agent config: environments × agents
// synchronous reads per request. Every agent is a team of one with its own
// environment, so on a ~110-agent fleet that one request held the console's
// event loop for 11–12 s. The route now builds this index once and answers each
// environment from it.
//
// `entries` — `[{ id, cfg }]` in disk order. A config without a string
// `environmentId` (unbound, or corrupt and read as `{}`) is in no bucket,
// exactly as the old `cfg.environmentId === envId` test excluded it.
function indexAgentsByEnvironment(entries) {
  const byEnv = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const envId = entry && entry.cfg ? entry.cfg.environmentId : undefined;
    if (typeof envId !== 'string' || !envId) continue;
    if (!byEnv.has(envId)) byEnv.set(envId, []);
    byEnv.get(envId).push(entry);
  }
  return byEnv;
}

// The `{ id, displayName }` rows of `envId`'s agents the caller may see
// (`isVisible(cfg)`), in disk order — the `agentsUsingEnvironment` shape.
function environmentAgentRows(byEnv, envId, isVisible) {
  return (byEnv.get(envId) || [])
    .filter(({ cfg }) => isVisible(cfg))
    .map(({ id, cfg }) => ({ id, displayName: cfg.displayName || id }));
}

// The id of `envId`'s first agent in disk order, unscoped, or null — the
// environment delete guard (`environmentInUse`), from the same index so "an
// agent uses this environment" has one definition.
function firstAgentIdUsingEnvironment(byEnv, envId) {
  const [first] = byEnv.get(envId) || [];
  return first ? first.id : null;
}

module.exports = { indexAgentsByEnvironment, environmentAgentRows, firstAgentIdUsingEnvironment };
