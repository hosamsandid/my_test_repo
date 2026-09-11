'use strict';

// Run: node --test admin-console/api/human-matrix-store.test.js
//
// The console side of the two-sided mirror guard (#2173). The behavioural
// cases live in orchestrator/human-matrix-store.test.js; this file exists so
// the guard fires whichever suite a change is run against — the same
// arrangement as agent-team.test.js / resource-tier.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createHumanMatrixStore } = require('./human-matrix-store');

test('two-sided guard: admin-console copy is byte-identical to orchestrator copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'human-matrix-store.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'human-matrix-store.js'));
  assert.ok(here.equals(there), 'human-matrix-store.js copies differ — change both in one commit');
});

test('the console copy is the same function, not just the same bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-matrix-store-console-'));
  const store = createHumanMatrixStore({ root });
  const userId = '11111111-2222-4333-8444-555555555555';
  assert.equal(store.readIdentity(userId), null);
  const written = store.writeIdentity(userId, {
    matrixUserId: '@u-0123456789abcdef:local',
    accessToken: 'syt_secret',
  });
  assert.deepEqual(store.readIdentity(userId), written);
});
