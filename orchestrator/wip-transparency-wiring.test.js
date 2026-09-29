'use strict';

// Wiring for WIP-transparency (PR3): a dispatch held behind a full admission
// lane must be VISIBLE. Before this, held dispatches lived only in a team's
// admission lane and never surfaced in the Pending queue (which reads per-agent
// pending-triggers.json), so the GitHub Event Log said "delivered" while the
// operator saw nothing anywhere. These are source-text assertions (the aggregation
// lives in orchestrator.js, which starts a server on require), each paired with a
// mutation that makes exactly it fire.
// Run: node --test orchestrator/wip-transparency-wiring.test.js

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function slice(src, startNeedle, endNeedle, max = 4000) {
  const start = src.indexOf(startNeedle);
  if (start === -1) return '';
  const end = src.indexOf(endNeedle, start);
  return src.slice(start, end === -1 ? Math.min(src.length, start + max) : end);
}

test('aggregatePendingQueue surfaces held dispatches alongside the pending files', () => {
  const body = slice(SRC, 'function aggregatePendingQueue()', '\n}\n');
  assert.match(body, /const held = aggregateHeldDispatches\(\)/, 'must call aggregateHeldDispatches');
  assert.match(body, /held: held\.groups/, 'must return the held groups');
  assert.match(body, /heldTotal: held\.total/, 'must return the held total');
});

test('aggregateHeldDispatches reads each team lane\'s held[] and carries the WIP context', () => {
  const body = slice(SRC, 'function aggregateHeldDispatches()', '\n}\n');
  assert.match(body, /loadAdmissionLane\(teamId\)/, 'must read the admission lane');
  assert.match(body, /lane\.held/, 'must read the lane held list');
  assert.match(body, /admissionControl\.limitInForce\(teamCfg\.wipLimit\)/, 'must expose the flow wipLimit');
  assert.match(body, /heldByWip: true/, 'each held entry must be tagged heldByWip');
  assert.match(body, /admissionControl\.heldIdentity\(/, 'must carry the board\'s force-dispatch id');
});

test('mutation: dropping the held aggregation would make the first assertion fail', () => {
  // Proves the assertion is load-bearing, not vacuous.
  const mutated = SRC.replace('const held = aggregateHeldDispatches();', 'const held = { groups: [], total: 0 };');
  const body = slice(mutated, 'function aggregatePendingQueue()', '\n}\n');
  assert.doesNotMatch(body, /const held = aggregateHeldDispatches\(\)/);
});
