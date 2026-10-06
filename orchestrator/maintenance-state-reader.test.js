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

// #569: the memo behind GET /internal/maintenance-mode.
const { createMaintenanceStateCache, readMaintenanceStateCached } = require('./maintenance-state-reader');

test('createMaintenanceStateCache reads once per TTL window and again once it lapses', () => {
  let t = 1000;
  let reads = 0;
  let active = false;
  const read = () => { reads++; return { active }; };
  const cached = createMaintenanceStateCache({ read, ttlMs: 2000, now: () => t });
  assert.equal(cached().active, false);
  active = true;
  t += 1999;
  assert.equal(cached().active, false, 'inside the window the memo answers');
  assert.equal(reads, 1);
  t += 1;
  assert.equal(cached().active, true, 'at the TTL the file is read again');
  assert.equal(reads, 2);
});

test('createMaintenanceStateCache with ttlMs 0 never memoizes', () => {
  let reads = 0;
  const cached = createMaintenanceStateCache({ read: () => { reads++; return { active: false }; }, ttlMs: 0, now: () => 5 });
  cached(); cached(); cached();
  assert.equal(reads, 3);
});

test('createMaintenanceStateCache re-reads when the clock steps backwards', () => {
  let t = 10_000;
  let reads = 0;
  const cached = createMaintenanceStateCache({ read: () => { reads++; return { active: false }; }, ttlMs: 2000, now: () => t });
  cached();
  t = 5_000;
  cached();
  assert.equal(reads, 2);
});

test('the memo over the real reader sees the state file the console wrote', () => {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ active: true }));
  // A fresh instance over the real reader: the module-level one may hold a
  // value from an earlier test in this file.
  const cached = createMaintenanceStateCache({ ttlMs: 2000 });
  assert.equal(cached().active, true);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ active: false }));
  assert.equal(cached().active, true, 'inside the TTL the memo still answers');
  assert.equal(createMaintenanceStateCache({ ttlMs: 0 })().active, false);
  assert.equal(typeof readMaintenanceStateCached, 'function');
});
