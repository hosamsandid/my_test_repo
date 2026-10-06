'use strict';

// One read of every agent config, shared by a single 60 s sweep tick (#569).
//
// Every agent is a team of one since #2229, so the per-team sweeps that each
// re-scanned the whole fleet (`_teamPooledRoles` → `listAgentIds()` +
// `loadAgentConfig` per agent) cost (5 + 2–3·teams) full scans a minute — the
// multi-second event-loop stall a large fleet showed once a minute. A tick now builds
// this snapshot once and answers its team enumeration and pooled-role lookups
// from it.
//
// No cross-tick cache: the snapshot lives for one tick and is then dropped, so
// a config edit is seen by the next tick exactly as before. Candidates a sweep
// picks from the snapshot are re-read from disk before it acts on them, and the
// `maxInstances` cap checks never read the snapshot at all.
//
// Configs are deep-frozen: the snapshot is shared by every team's sweep in the
// tick, so a sweep that mutated one would leak into the next team's decisions.
// (The orchestrator is strict mode — a write throws instead of vanishing.)

// Pure siblings only — the pre-filters below reuse the sweeps' own tests.
const { isPooledRole, normalizePoolConfig } = require('./agent-pool');
const { limitInForce } = require('./admission-control');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// `ids` — the agent ids on disk (`listAgentIds()`), in the order the old
// scans walked them. `loadConfig(id)` returns the config or null; a throw
// (a torn or corrupt config.json) skips that one agent — it reads as `null`,
// the way every per-agent try/catch in the old scans treated it — and is
// reported through `onEntryError(id, err)` and kept in `unreadable`
// (id → error), so one bad agent never poisons the sweep.
function buildFleetSnapshot(ids, { loadConfig, onEntryError = () => {} } = {}) {
  const list = Array.isArray(ids) ? [...ids] : [];
  const configById = new Map();
  const teamIds = [];
  const childrenByParentTeam = new Map();
  const unreadable = new Map();
  for (const id of list) {
    let cfg = null;
    try {
      cfg = loadConfig(id);
    } catch (err) {
      unreadable.set(id, err);
      onEntryError(id, err);
      cfg = null;
    }
    cfg = cfg && typeof cfg === 'object' ? deepFreeze(cfg) : null;
    configById.set(id, cfg);
    if (!cfg) continue;
    if (cfg.role === 'team') teamIds.push(id);
    const parent = cfg.parentTeamId || null;
    if (parent) {
      if (!childrenByParentTeam.has(parent)) childrenByParentTeam.set(parent, []);
      childrenByParentTeam.get(parent).push({ id, cfg });
    }
  }
  for (const children of childrenByParentTeam.values()) Object.freeze(children);
  return Object.freeze({
    ids: Object.freeze(list),
    configById,
    teamIds: Object.freeze(teamIds),
    childrenByParentTeam,
    unreadable,
  });
}

// `(fleet, tick) => void`, shared by every sweep tick: warns ONCE per agent
// whose config would not read, and again only after it has read cleanly (or
// vanished) in between. Five ticks a minute each warning about the same torn
// config.json would be ~5 identical lines a minute for as long as it stays
// broken (#569 review).
function createUnreadableConfigReporter({ warn = () => {} } = {}) {
  const warned = new Set();
  return (fleet, tick) => {
    const unreadable = (fleet && fleet.unreadable) || new Map();
    for (const [id, err] of unreadable) {
      if (warned.has(id)) continue;
      warned.add(id);
      warn(`[Orchestrator] ${tick} tick: config of ${id} unreadable, skipped: ${err && err.message ? err.message : err}`);
    }
    for (const id of warned) if (!unreadable.has(id)) warned.delete(id);
  };
}

// The children of `teamId` in disk order — `[]` for a team with none.
function childrenOf(fleet, teamId) {
  return (fleet && fleet.childrenByParentTeam.get(teamId)) || [];
}

// The snapshot's ids that start with `prefix` (a pooled role's `<role>-i`
// instance prefix), each with its snapshot config (null when unreadable).
function idsWithPrefix(fleet, prefix) {
  if (!fleet) return [];
  return fleet.ids.filter((id) => id.startsWith(prefix)).map((id) => ({ id, cfg: fleet.configById.get(id) || null }));
}

// ---------------------------------------------------------------------------
// Tick pre-filters (#569 review). Each opt-in sweep returns before its first
// request for most teams; the tick answers that question from the snapshot so
// it never calls the sweep at all for them. Each predicate is a SUPERSET of
// the sweep's own "does anything" set — every condition below mirrors one of
// the sweep's early returns, and the sweep still re-reads the team's config
// itself, so a pre-filter can only ever skip a team the sweep would also
// have skipped (as of the snapshot), never act on one.
// ---------------------------------------------------------------------------

// The team's pooled-role templates as the snapshot saw them — the same test
// as `_teamPooledRoles` in orchestrator.js (a child of the team, pooled, not
// an instance), in `{ id, cfg, pool }` shape.
function pooledRolesOf(fleet, teamId) {
  const out = [];
  for (const { id, cfg } of childrenOf(fleet, teamId)) {
    if (!cfg || (cfg.parentTeamId || null) !== teamId || !isPooledRole(cfg)) continue;
    out.push({ id, cfg, pool: normalizePoolConfig(cfg.pool) });
  }
  return out;
}

function teamCfgOf(fleet, teamId) {
  return (fleet && fleet.configById.get(teamId)) || null;
}

// `admissionSweepTeam`: returns null unless the team's wipLimit is in force.
function wantsAdmissionSweep(fleet, teamId) {
  const cfg = teamCfgOf(fleet, teamId);
  return !!cfg && limitInForce(cfg.wipLimit) !== null;
}

// `flowSupervisorSweepTeam`: returns null unless `autoDispatch.enabled ===
// true` AND a wipLimit is in force AND the team holds a pooled role. (Its
// paused/drained-role check reads pool-control.json, which the snapshot does
// not carry — the sweep still applies it.)
function wantsFlowSupervisorSweep(fleet, teamId) {
  const cfg = teamCfgOf(fleet, teamId);
  if (!cfg) return false;
  const autoDispatch = cfg.autoDispatch && typeof cfg.autoDispatch === 'object' ? cfg.autoDispatch : null;
  if (!autoDispatch || autoDispatch.enabled !== true) return false;
  if (limitInForce(cfg.wipLimit) === null) return false;
  return pooledRolesOf(fleet, teamId).length > 0;
}

// `recurringPoolSweepTeam`: touches nothing unless a pooled role of the team
// configured a `workSource`.
function wantsRecurringPoolSweep(fleet, teamId) {
  if (!teamCfgOf(fleet, teamId)) return false;
  return pooledRolesOf(fleet, teamId).some((r) => r.pool && r.pool.workSource);
}

module.exports = {
  buildFleetSnapshot,
  childrenOf,
  idsWithPrefix,
  deepFreeze,
  createUnreadableConfigReporter,
  pooledRolesOf,
  wantsAdmissionSweep,
  wantsFlowSupervisorSweep,
  wantsRecurringPoolSweep,
};
