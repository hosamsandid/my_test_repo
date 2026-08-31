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
// autoremove" window only earns its cost for a `bp-instance`: its
// agent-entrypoint.py SIGTERM handler commits partial work on the bound /repo
// before exiting (the `bp_hash` branch). Every other role — standalone `agent`,
// `team-member`, `team`, pure-config `orchestrator` — is a DM listener with no
// bound repo and nothing to flush, so its container is force-removed
// immediately instead of waiting out the grace window.
function isGracefulDeleteRole(role) {
  return role === 'bp-instance';
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

module.exports = { isGracefulDeleteRole, TeardownRegistry };
