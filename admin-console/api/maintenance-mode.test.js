'use strict';

// Unit tests for the maintenance-mode module (#501).
// Run: node --test admin-console/api/maintenance-mode.test.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the state file at a throwaway dir before requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-mode-test-'));
process.env.MAINTENANCE_STATE_DIR = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const maintenanceMode = require('./maintenance-mode');

test('readState defaults to inactive when no state file exists', () => {
  const state = maintenanceMode.readState();
  assert.deepEqual(state, { active: false, activatedAt: null, gracePeriodSec: null, graceEndsAt: null });
});

test('getStatus on a fresh install reports inactive with zero remaining time', () => {
  const status = maintenanceMode.getStatus();
  assert.equal(status.active, false);
  assert.equal(status.remainingSec, 0);
});

test('validateGracePeriodSec rejects non-positive, non-integer and oversized values', () => {
  assert.equal(maintenanceMode.validateGracePeriodSec(0).ok, false);
  assert.equal(maintenanceMode.validateGracePeriodSec(-5).ok, false);
  assert.equal(maintenanceMode.validateGracePeriodSec(1.5).ok, false);
  assert.equal(maintenanceMode.validateGracePeriodSec('not-a-number').ok, false);
  assert.equal(maintenanceMode.validateGracePeriodSec(maintenanceMode.MAX_GRACE_PERIOD_SEC + 1).ok, false);
  assert.equal(maintenanceMode.validateGracePeriodSec(300).ok, true);
});

test('activate persists active state with computed graceEndsAt and survives a fresh read', () => {
  const before = Date.now();
  const state = maintenanceMode.activate(120);
  assert.equal(state.active, true);
  assert.equal(state.gracePeriodSec, 120);
  const activatedAtMs = new Date(state.activatedAt).getTime();
  const graceEndsAtMs = new Date(state.graceEndsAt).getTime();
  assert.ok(activatedAtMs >= before);
  assert.equal(graceEndsAtMs - activatedAtMs, 120 * 1000);

  // Persisted, not just returned — a fresh read (simulating another process
  // on the shared volume) sees the same state.
  const reread = maintenanceMode.readState();
  assert.deepEqual(reread, state);
});

test('activate throws a 400-tagged error on an invalid grace period and does not persist', () => {
  maintenanceMode.deactivate();
  assert.throws(() => maintenanceMode.activate(-1), (err) => err.status === 400);
  assert.equal(maintenanceMode.readState().active, false);
});

test('getStatus counts down remainingSec while active and clamps at zero after grace end', () => {
  maintenanceMode.activate(1000);
  const status = maintenanceMode.getStatus();
  assert.equal(status.active, true);
  assert.ok(status.remainingSec > 0 && status.remainingSec <= 1000);

  // Simulate the grace period having already elapsed.
  const state = maintenanceMode.readState();
  maintenanceMode.writeState({ ...state, graceEndsAt: new Date(Date.now() - 5000).toISOString() });
  const expired = maintenanceMode.getStatus();
  assert.equal(expired.active, true); // still active — nothing auto-deactivates (#501 scope)
  assert.equal(expired.remainingSec, 0);
});

test('deactivate resets to the default inactive state immediately', () => {
  maintenanceMode.activate(60);
  const state = maintenanceMode.deactivate();
  assert.deepEqual(state, { active: false, activatedAt: null, gracePeriodSec: null, graceEndsAt: null });
  assert.deepEqual(maintenanceMode.readState(), state);
  assert.equal(maintenanceMode.getStatus().remainingSec, 0);
});

test('readState tolerates a corrupt state file by falling back to defaults', () => {
  fs.writeFileSync(path.join(TMP, 'state.json'), 'not json{{{');
  assert.deepEqual(maintenanceMode.readState(), maintenanceMode.defaultState());
});
