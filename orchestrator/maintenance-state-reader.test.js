'use strict';

// Unit tests for the orchestrator-side Maintenance Mode reader (#504).
// Run: node --test orchestrator/maintenance-state-reader.test.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the reader at a throwaway dir before requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-state-reader-test-'));
process.env.MAINTENANCE_STATE_DIR = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const { readMaintenanceState, defaultState, STATE_FILE } = require('./maintenance-state-reader');

test('readMaintenanceState defaults to inactive when the state file is missing', () => {
  assert.deepEqual(readMaintenanceState(), defaultState());
});

test('readMaintenanceState defaults to inactive when the state file is corrupt', () => {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(STATE_FILE, 'not json');
  assert.deepEqual(readMaintenanceState(), defaultState());
});

test('readMaintenanceState reflects an active state written by the admin console', () => {
  const state = {
    active: true,
    activatedAt: '2026-07-10T09:00:00.000Z',
    gracePeriodSec: 300,
    graceEndsAt: '2026-07-10T09:05:00.000Z',
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  assert.deepEqual(readMaintenanceState(), state);
});
