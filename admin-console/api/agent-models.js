'use strict';

// Agent → model inventory (#2439). Pure aggregation over the same canonical
// usage records the summary/work-item views read (usage-log reader → this).
//
// No per-agent model pin exists yet (#1485): the model is not stored in
// config.json, it is set per agent/role at runtime. So the ONLY reliable answer
// to "which model does this agent run?" today is OBSERVED usage — the
// `modelUsage` keys the store already carries on every invocation. This view
// derives, per `agentId`, every model seen in the window and flags the
// most-recently-used one(s) as the current model. It reports the *Ist* (observed
// usage) only; the *Soll* (configured pin) side arrives with #1485.
//
// Tokens are never read here — this view answers "which model", not "how much".
// Half-open [since, until) window, identical semantics to usage-summary.inRange
// so the two views agree on which records are in range (own copy by the same
// convention work-items.js follows).

const UNKNOWN = 'unknown';

function inRange(ts, since, until) {
  if (typeof ts !== 'string' || !ts) return false;
  if (since && ts < since) return false;
  if (until && ts >= until) return false;
  return true;
}

// Null-safe ascending string compare (nulls sort as '').
function cmp(a, b) {
  const av = a == null ? '' : String(a);
  const bv = b == null ? '' : String(b);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

// buildAgentModels(records, { since, until }) ->
//   { since, until, agents: [ { agentId, teamId, roleId, lastUsed,
//       currentModels: [name…], models: [ { model, lastUsed, invocations } ] } ],
//     models: [ distinct model name… ] }
//
// `currentModels` are the model(s) used in the agent's most recent invocation
// that carried model telemetry (all of them when a single run used several).
// `models` lists EVERY model the agent used in the window (AC: a multi-model
// agent shows all, not just one), newest first. An agent that ran but emitted no
// `modelUsage` still appears, with empty models — the run is real, the telemetry
// just isn't there to name a model.
function buildAgentModels(records, query = {}) {
  const since = query.since || null;
  const until = query.until || null;

  // agentId -> { teamId, roleId, lastUsed, models: Map(model -> {lastUsed, invocations}) }
  const byAgent = new Map();

  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || !inRange(rec.ts, since, until)) continue;
    const agentId = rec.agentId || UNKNOWN;
    let a = byAgent.get(agentId);
    if (!a) {
      a = { agentId, teamId: null, roleId: null, lastUsed: null, models: new Map() };
      byAgent.set(agentId, a);
    }
    // team/role reflect the agent's MOST RECENT record — the current identity,
    // not whatever it happened to be at the start of the window.
    if (!a.lastUsed || rec.ts > a.lastUsed) {
      a.lastUsed = rec.ts;
      a.teamId = rec.teamId || null;
      a.roleId = rec.roleId || null;
    }
    const mu = rec.modelUsage && typeof rec.modelUsage === 'object' ? rec.modelUsage : {};
    for (const model of Object.keys(mu)) {
      let m = a.models.get(model);
      if (!m) { m = { lastUsed: null, invocations: 0 }; a.models.set(model, m); }
      m.invocations += 1;
      if (!m.lastUsed || rec.ts > m.lastUsed) m.lastUsed = rec.ts;
    }
  }

  const modelSet = new Set();
  const agents = [...byAgent.values()].map((a) => {
    const models = [...a.models.entries()]
      .map(([model, m]) => ({ model, lastUsed: m.lastUsed, invocations: m.invocations }))
      // newest first, then model name for a stable tie-break.
      .sort((x, y) => cmp(y.lastUsed, x.lastUsed) || cmp(x.model, y.model));
    for (const m of models) modelSet.add(m.model);
    // Current = the model(s) sharing the newest use timestamp (models[0] after
    // the sort above; several when one run used several).
    const newest = models.length ? models[0].lastUsed : null;
    const currentModels = models
      .filter((m) => m.lastUsed && m.lastUsed === newest)
      .map((m) => m.model)
      .sort();
    return {
      agentId: a.agentId,
      teamId: a.teamId,
      roleId: a.roleId,
      lastUsed: a.lastUsed,
      currentModels,
      models,
    };
  });

  // Stable inventory order: team, then role, then agent id.
  agents.sort((x, y) => cmp(x.teamId, y.teamId) || cmp(x.roleId, y.roleId) || cmp(x.agentId, y.agentId));

  return { since, until, agents, models: [...modelSet].sort() };
}

module.exports = { buildAgentModels };
