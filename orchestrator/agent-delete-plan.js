'use strict';

// Pure decision helpers for the fast/background split of agent deletion (#1791).
//
// The DELETE handler is split into a fast synchronous phase (stop the process,
// reap plugin scopes while configs are still on disk, delete config.json so the
// agent leaves the UI) and a background phase for the slow container/network/
// Matrix reaping. This module holds the two pieces of that split that carry real
// logic and are worth unit-testing on their own; orchestrator.js is a monolith
// with no exports, so a pure sibling like this is the only test surface.

// The graceful "SIGTERM → poll up to ~8s for the container to exit and
// autoremove" window used to earn its cost for exactly one role, `bp-instance`:
// its agent-entrypoint.py SIGTERM handler committed partial work on the bound
// /repo before exiting (the `bp_hash` branch). Every other role — standalone
// `agent`, `team-member`, `team` — is a DM listener with no bound repo and
// nothing to flush, so its container is force-removed immediately.
//
// #1962 removed the BriefingPack model, and with it `bp-instance`. **No
// supported role was graceful for a long stretch**, so this predicate stayed
// constantly false — until #2246 (Agent Pools epic #2251 Phase 1) became "the
// next role that needs a flush window" the comment below always expected: a
// pooled instance is graceful again, precisely because it exists to run
// exactly one ticket and then die, and losing its partial work on teardown
// would be worse than a noisy, best-effort commit+push (D8, design of record
// `docs/parallel-workers-concept.md` §4/§8). `cfg` (not `role`) is what
// carries the marker, since a pool instance is an ordinary `team-member` by
// role — only `cfg.poolInstance` distinguishes it from one.
function isGracefulDeleteRole(_role, cfg) {
  return !!(cfg && cfg.poolInstance === true);
}

// In-memory registry of agent ids whose background teardown is still running.
//
// The fast phase deletes config.json before the slow network/volume/Matrix
// reaping finishes, so loadAgentConfig() alone no longer guards a same-id
// re-create against an in-flight teardown (#1525): the config is already gone
// while removePerAgentNetwork/removePerAgentVolume are still racing. Every
// create/clone/import/materialise path consults this registry in addition to
// loadAgentConfig(), and rejects a colliding id until its background teardown
// has finished.
class TeardownRegistry {
  constructor() {
    this._ids = new Set();
  }

  // Arm the guard for an id entering teardown.
  begin(id) {
    this._ids.add(id);
    return this;
  }

  // Clear the guard once the id's background teardown has fully completed
  // (idempotent — finishing an unknown/already-finished id is a no-op).
  finish(id) {
    this._ids.delete(id);
    return this;
  }

  // Is a teardown for this id still in flight?
  has(id) {
    return this._ids.has(id);
  }

  get size() {
    return this._ids.size;
  }
}

// Which agents must be torn down together with `parentId` (#1960).
//
// The cascade exists so that deleting a team never leaves an **orphan** behind:
// a `team-member` whose `parentTeamId` points at an agent that is gone. An
// orphan is not a working agent — its prompt, skills and plugin grant are all
// defined by inheritance from a team that no longer exists — and it also blocks
// the deterministic member ids a same-name team would want to reuse.
//
// `configs` is an iterable of `{ id, cfg }` for every agent currently on disk
// (a `cfg` of null = a config-less residue dir). Returns the child ids sorted,
// so a cascade is deterministic and a test can assert the whole list.
//
// Two rules, and the second one is the reason this is a named function rather
// than an inline filter:
//
//  1. `role: "team"` → every team-member naming it. Materialized members and
//     **stubs** alike (#1955 members are config + triggers.json only, no Matrix
//     user and no container) — a stub is exactly as orphaned as a materialized
//     member once its parent is gone, and exactly as invisible afterwards,
//     since `GET /api/matrix/agents` filters tokenless agents unless a caller
//     opts in.
//  2. An **unreadable/absent parent config** cascades the same set. That is the
//     interrupted-delete case: `deleteAgentFiles` removes the whole agent dir,
//     but a failed rmSync can leave a config-less residue dir (#1525 B2) that
//     the DELETE route still admits (it 404s on the *dir*, not the config). Its
//     members are already orphans in every practical sense, so re-issuing the
//     delete must finish the job instead of walking away from them — this is
//     what makes an interrupted team deletion safely repeatable.
//
// Any other role (a standalone `agent`, a `team-member`, an unknown legacy
// role) cascades nothing: a member naming a non-team parent is a config error
// to be *reported* by the orphan scan, not a licence to delete siblings.
function cascadeChildIds(parentId, parentCfg, configs) {
  if (!parentId) return [];
  const role = parentCfg ? parentCfg.role : null;
  if (parentCfg && role !== 'team') return [];
  const ids = [];
  for (const entry of configs || []) {
    if (!entry) continue;
    const { id, cfg } = entry;
    if (!id || id === parentId || !cfg) continue;
    if (cfg.role !== 'team-member') continue;
    if (cfg.parentTeamId !== parentId) continue;
    ids.push(id);
  }
  return ids.sort();
}

module.exports = { isGracefulDeleteRole, TeardownRegistry, cascadeChildIds };
