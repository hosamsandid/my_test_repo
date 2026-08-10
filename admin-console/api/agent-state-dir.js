'use strict';

// ─── per-agent workspace state directory (#1549) ─────────────────────────────
//
// The per-agent state directory (agent CLIs under `bin/`, plugin grants under
// `plugins/`, `seeded-skills.json`, `skill-reconcile.json`, `prompt-history.json`,
// artifacts) was historically named **`.aee`** — short for "Agent Execution
// Environment", the retired name of the product now called **Agent Studio**.
// The opaque legacy abbreviation is renamed to **`.agent-studio`** so the folder
// a user sees in every agent's file tree is self-explanatory.
//
// `resolveAgentStateDir(baseDir)` is the single choke-point every reader/writer
// goes through. It performs a one-time, ATOMIC, IDEMPOTENT migration: the first
// process to touch an upgraded agent renames the legacy `.aee/` to
// `.agent-studio/` (a single `fs.rename`, so all state — history, artifacts,
// seeded-skills, skill-reconcile, plugin grants — moves together with no data
// loss and nothing to fix up per agent). Once migrated, everyone resolves the
// new dir. Race-safe: two processes racing the rename either both end up on the
// new dir, or the loser catches the error and re-reads whichever dir now exists.
// It NEVER drops the legacy contents — if the rename cannot complete and the new
// dir is absent, it keeps returning the legacy dir so reads still succeed.
//
// Deliberately duplicated (byte-identical) in `admin-console/api/agent-state-dir.js`
// because the admin-console image copies only `api/*.js` and cannot require an
// orchestrator sibling — the same two-copy discipline as the knowledge digest.

const fs = require('fs');
const path = require('path');

// Current (user-visible) name and the retired legacy name.
const STATE_DIR = '.agent-studio';
const LEGACY_STATE_DIR = '.aee';

// Resolve the ABSOLUTE path to an agent's state directory under `baseDir`,
// migrating a legacy `.aee/` to `.agent-studio/` exactly once on first touch.
// `io` optionally injects `{ fs, path }` for tests.
function resolveAgentStateDir(baseDir, io = {}) {
  const fsImpl = io.fs || fs;
  const pathImpl = io.path || path;
  const dir = pathImpl.join(baseDir, STATE_DIR);
  const legacy = pathImpl.join(baseDir, LEGACY_STATE_DIR);

  // Already migrated (or a fresh agent already on the new name) → done.
  if (fsImpl.existsSync(dir)) return dir;

  // A legacy dir with no new dir → migrate it atomically.
  if (fsImpl.existsSync(legacy)) {
    try {
      fsImpl.renameSync(legacy, dir);
    } catch {
      // Lost a race with another migrator, or a partial state — fall through
      // and prefer whichever dir now exists, never dropping legacy contents.
    }
    if (fsImpl.existsSync(dir)) return dir;
    if (fsImpl.existsSync(legacy)) return legacy;
    return dir;
  }

  // Fresh agent: the new name, created lazily by the caller's mkdir.
  return dir;
}

module.exports = { STATE_DIR, LEGACY_STATE_DIR, resolveAgentStateDir };
