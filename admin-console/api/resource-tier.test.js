'use strict';

// Run: node --test admin-console/api/resource-tier.test.js
//
// The console side of the two-sided mirror guard (#2083). The behavioural cases
// live in orchestrator/resource-tier.test.js; this file exists so the guard
// fires whichever suite a change is run against — the same arrangement as
// agent-team.test.js / toolchain-registry.test.js / plugin-manifest.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { normalizeTier, isSharedTier, tierUsableByTeam, isRetier, TIER_SYSTEM } = require('./resource-tier');

test('two-sided guard: admin-console copy is byte-identical to orchestrator copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'resource-tier.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'resource-tier.js'));
  assert.ok(here.equals(there), 'resource-tier.js copies differ — change both in one commit');
});

test('the console copy is the same module, not just the same bytes', () => {
  // Cheap smoke test so a require-path or export-name regression in THIS image
  // fails here rather than at the first wrong 403 in production.
  assert.equal(normalizeTier({ teamId: 'default' }).scope, 'team');
  assert.equal(normalizeTier({ scope: TIER_SYSTEM }).teamId, null);
  assert.equal(isSharedTier({ scope: TIER_SYSTEM }), true);
  assert.equal(tierUsableByTeam({ scope: TIER_SYSTEM, assignedTeamIds: ['sdlc'] }, 'sdlc'), true);
  assert.equal(isRetier({ teamId: 'a' }, { teamId: 'b' }), true);
});
