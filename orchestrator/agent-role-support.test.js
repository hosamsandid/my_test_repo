'use strict';

// Unit tests for the supported-role predicate (#1962, epic #1961 AC3).
// Run: node --test orchestrator/agent-role-support.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SUPPORTED_AGENT_ROLES,
  RETIRED_AGENT_ROLES,
  isSupportedAgentRole,
  unsupportedRoleNote,
} = require('./agent-role-support');

test('the supported set is exactly the four live roles', () => {
  assert.deepEqual([...SUPPORTED_AGENT_ROLES].sort(), ['agent', 'ephemeral', 'team', 'team-member']);
  for (const role of SUPPORTED_AGENT_ROLES) {
    assert.equal(isSupportedAgentRole(role), true, `${role} should be supported`);
  }
});

test('the two BriefingPack roles are unsupported', () => {
  assert.equal(isSupportedAgentRole('orchestrator'), false);
  assert.equal(isSupportedAgentRole('bp-instance'), false);
  // …and they are named as *retired* rather than merely unknown, so the log
  // line can say why.
  assert.ok(RETIRED_AGENT_ROLES['orchestrator']);
  assert.ok(RETIRED_AGENT_ROLES['bp-instance']);
});

test('an absent, empty or garbage role is unsupported — never defaulted to agent', () => {
  for (const role of [undefined, null, '', 'nonsense', 'Agent', 'expert']) {
    assert.equal(isSupportedAgentRole(role), false, `${JSON.stringify(role)} should not be supported`);
  }
});

// `expert`/`expert-group`/`expert-instance` are handled upstream by
// normalizeAgentConfig, which rewrites them before any consumer sees them —
// this predicate deliberately does not re-implement that mapping.
test('legacy expert names are not silently accepted here (normalizeAgentConfig maps them first)', () => {
  assert.equal(isSupportedAgentRole('expert'), false);
  assert.equal(isSupportedAgentRole('expert-group'), false);
  assert.equal(isSupportedAgentRole('expert-instance'), false);
});

// ---- unsupportedRoleNote ----------------------------------------------------

test('a supported role earns no log line at all (AC4: no noise)', () => {
  for (const role of SUPPORTED_AGENT_ROLES) {
    assert.equal(unsupportedRoleNote('a1', role), null);
  }
});

test('a retired role gets one line naming the role, the reason and the ticket', () => {
  const note = unsupportedRoleNote('legacy-orch', 'orchestrator');
  assert.match(note, /legacy-orch/);
  assert.match(note, /orchestrator/);
  assert.match(note, /no longer supported/);
  assert.match(note, /#1961/);
  // AC3/R2: the config is left in place — the operator is told so explicitly
  // rather than being left to wonder whether the platform deleted it.
  assert.match(note, /left on disk/);
});

test('an unknown role gets a line too, without inventing a reason', () => {
  const note = unsupportedRoleNote('weird', 'wat');
  assert.match(note, /unknown role 'wat'/);
  assert.doesNotMatch(note, /#1961/);
});

test('a missing role renders readably rather than as undefined', () => {
  assert.match(unsupportedRoleNote('x', undefined), /role '\(none\)'/);
  assert.match(unsupportedRoleNote('x', null), /role '\(none\)'/);
  assert.match(unsupportedRoleNote('x', ''), /role '\(none\)'/);
});
