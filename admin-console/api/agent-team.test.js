'use strict';

// Run: node --test admin-console/api/agent-team.test.js
//
// The console side of the two-sided mirror guard (#2078 AC4). The behavioural
// cases live in orchestrator/agent-team.test.js; this file exists so the guard
// fires whichever suite a change is run against — the same arrangement as
// toolchain-registry.test.js / plugin-manifest.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { resolveAgentTeam } = require('./agent-team');

test('two-sided guard: admin-console copy is byte-identical to orchestrator copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'agent-team.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'agent-team.js'));
  assert.ok(here.equals(there), 'agent-team.js copies differ — change both in one commit');
});

test('the console copy is the same function, not just the same bytes', () => {
  // Cheap smoke test so a require-path or export-name regression in this image
  // fails here rather than at the first 403 in production.
  assert.equal(resolveAgentTeam({ id: 't', role: 'team' }), 't');
  assert.equal(resolveAgentTeam({ id: 'm', role: 'team-member', parentTeamId: 't' }), 't');
  assert.equal(resolveAgentTeam({ id: 's', role: 'agent', teamId: 'default' }), null);
});
