'use strict';

// Read-only counterpart to admin-console/api/maintenance-mode.js (#501).
// Both processes read the same state file from the shared /workspace volume
// (only the admin console writes it), but the two packages don't
// cross-require — so this is a small, independent reader rather than an
// import across the package boundary, mirroring the split already used for
// github-event-log.js / admin-console/api/github-event-log.js.
//
// Exposed to agent containers via GET /internal/maintenance-mode (#504):
// the default SubPath / per-agent-volume isolation (Seam #3) does not mount
// anything outside an agent's own `/workspace/agents/<id>` subtree, so an
// agent can't read this file directly and must ask the orchestrator, which
// always mounts the full pool volume.

const fs = require('fs');
const path = require('path');

const MAINTENANCE_DIR = process.env.MAINTENANCE_STATE_DIR || '/workspace/maintenance';
const STATE_FILE = path.join(MAINTENANCE_DIR, 'state.json');

function defaultState() {
  return { active: false, activatedAt: null, gracePeriodSec: null, graceEndsAt: null };
}

// Best-effort read: any missing/corrupt file falls back to inactive rather
// than throwing, matching admin-console's own module (a fresh install or a
// manually-cleared file just reads as "not in maintenance").
function readMaintenanceState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return defaultState();
    return { ...defaultState(), ...raw };
  } catch {
    return defaultState();
  }
}

// A short-TTL memo of `read()` for the hot agent pull (#569): every agent
// asks GET /internal/maintenance-mode several times a minute, each a read of
// the shared state file. The only writer is the admin console, in another
// process (possibly another pod), so this can't be invalidated by a
// watch — a toggle reaches the agents at most `ttlMs` later, well inside the
// agents' own poll interval. Every other caller keeps the uncached read.
function createMaintenanceStateCache({ read = readMaintenanceState, ttlMs = 2000, now = Date.now } = {}) {
  let value = null;
  let readAt = 0;
  return function readCached() {
    const t = now();
    if (value === null || !(ttlMs > 0) || t - readAt >= ttlMs || t < readAt) {
      value = read();
      readAt = t;
    }
    return value;
  };
}

const CACHE_TTL_MS = (() => {
  const n = Number.parseInt(process.env.AEE_MAINTENANCE_CACHE_MS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
})();

const readMaintenanceStateCached = createMaintenanceStateCache({ ttlMs: CACHE_TTL_MS });

module.exports = {
  readMaintenanceState, readMaintenanceStateCached, createMaintenanceStateCache, defaultState, STATE_FILE,
};
