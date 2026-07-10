'use strict';

// Maintenance Mode (#501): a central, server-persisted on/off switch with a
// configurable grace period, so an admin can signal an upcoming platform
// restart and let in-flight agent sessions wind down before it happens.
//
// This module deliberately does NOT enforce anything (no chat lock, no
// trigger pause) — that is out of scope for #501 and belongs to follow-up
// issues under epic #508. It only owns the persisted state and exposes a
// read/computed view of it, mirroring the audit module's best-effort JSON
// file pattern so any other backend component on the shared /workspace
// volume (orchestrator, agent-entrypoint.py) can read the same state file
// directly without going through the admin-console API.

const fs = require('fs');
const path = require('path');

const MAINTENANCE_DIR = process.env.MAINTENANCE_STATE_DIR || '/workspace/maintenance';
const STATE_FILE = path.join(MAINTENANCE_DIR, 'state.json');

// Grace period bounds: must be a positive whole number of seconds, capped at
// 24h so a fat-fingered value (e.g. minutes typed into a seconds field)
// can't wedge the console in a maintenance state for an absurd duration.
const MAX_GRACE_PERIOD_SEC = 24 * 60 * 60;

function defaultState() {
  return { active: false, activatedAt: null, gracePeriodSec: null, graceEndsAt: null };
}

// Best-effort read: any missing/corrupt file falls back to inactive rather
// than throwing, so a fresh install or a manually-cleared file just reads
// as "not in maintenance".
function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return defaultState();
    return { ...defaultState(), ...raw };
  } catch {
    return defaultState();
  }
}

function writeState(state) {
  fs.mkdirSync(MAINTENANCE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// Returns { ok: true, value } or { ok: false, error }.
function validateGracePeriodSec(input) {
  const n = Number(input);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { ok: false, error: 'gracePeriodSec must be a positive integer number of seconds' };
  }
  if (n > MAX_GRACE_PERIOD_SEC) {
    return { ok: false, error: `gracePeriodSec must be at most ${MAX_GRACE_PERIOD_SEC} (24h)` };
  }
  return { ok: true, value: n };
}

function activate(gracePeriodSec) {
  const check = validateGracePeriodSec(gracePeriodSec);
  if (!check.ok) {
    const err = new Error(check.error);
    err.status = 400;
    throw err;
  }
  const activatedAt = new Date();
  const graceEndsAt = new Date(activatedAt.getTime() + check.value * 1000);
  const state = {
    active: true,
    activatedAt: activatedAt.toISOString(),
    gracePeriodSec: check.value,
    graceEndsAt: graceEndsAt.toISOString(),
  };
  writeState(state);
  return state;
}

function deactivate() {
  const state = defaultState();
  writeState(state);
  return state;
}

// The read view consumers actually want: persisted state plus a live
// remaining-seconds countdown (0 once the grace period has elapsed, even
// though the mode itself stays active until an admin explicitly ends it —
// per #501's scope, nothing auto-deactivates).
function getStatus() {
  const state = readState();
  if (!state.active || !state.graceEndsAt) {
    return { ...state, remainingSec: 0 };
  }
  const remainingSec = Math.max(0, Math.round((new Date(state.graceEndsAt).getTime() - Date.now()) / 1000));
  return { ...state, remainingSec };
}

module.exports = {
  MAX_GRACE_PERIOD_SEC,
  defaultState,
  readState,
  writeState,
  validateGracePeriodSec,
  activate,
  deactivate,
  getStatus,
};
