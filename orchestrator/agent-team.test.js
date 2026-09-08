'use strict';

// Run: node --test orchestrator/agent-team.test.js
//
// The access-boundary accessor (#2078). Its twin lives in
// admin-console/api/agent-team.js and the guard below is what AC4 asks for:
// concept §1.3 records that the two pre-existing `resolveAgentTenant` copies
// were described as "byte-mirrored" but were neither byte-identical nor guarded.
// This module is guarded from both sides from the day it lands.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { resolveAgentTeam, isOwnerScopedAgent } = require('./agent-team');

test('two-sided guard: orchestrator copy is byte-identical to admin-console copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'agent-team.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', 'admin-console', 'api', 'agent-team.js'));
  assert.ok(here.equals(there), 'agent-team.js copies differ — change both in one commit');
});

// ── the collapse itself ─────────────────────────────────────────────────────

test('a team agent IS its own boundary', () => {
  assert.equal(resolveAgentTeam({ id: 'agent-studio-2-0', role: 'team', teamId: 'default' }), 'agent-studio-2-0');
  // The decisive regression: the pre-#2078 hop answered the access-scope stamp
  // ('default'), which is precisely the layer D1 collapses.
  assert.notEqual(resolveAgentTeam({ id: 'agent-studio-2-0', role: 'team', teamId: 'default' }), 'default');
});

test('a member resolves to its parent Agent Team — no parent read, no injection', () => {
  const member = { id: 'agent-studio-2-0-dev', role: 'team-member', teamId: 'default', parentTeamId: 'agent-studio-2-0' };
  assert.equal(resolveAgentTeam(member), 'agent-studio-2-0');
  // resolveAgentTeam takes ONE argument. A stray second argument (a leftover
  // `loadAgentConfig` from the collapsed twin) must not change the answer.
  assert.equal(resolveAgentTeam(member, () => ({ id: 'x', role: 'team' })), 'agent-studio-2-0');
  assert.equal(resolveAgentTeam.length, 1);
});

test('a drifted own stamp is unreachable — the parent id IS the value', () => {
  // planTenantBackfill exists to realign this state. After the collapse the
  // member's own `teamId` is never consulted, so it cannot drift at all.
  const drifted = { id: 'd', role: 'team-member', teamId: 'stale', parentTeamId: 'agent-studio-2-0' };
  assert.equal(resolveAgentTeam(drifted), 'agent-studio-2-0');
  assert.equal(resolveAgentTeam({ ...drifted, teamId: 'something-else' }), 'agent-studio-2-0');
});

test('the coinciding-id case is no longer a special case', () => {
  // An Agent Team whose id happened to equal a human team id is what hid the
  // original bug. With one namespace there is nothing left to coincide.
  assert.equal(resolveAgentTeam({ id: 'payments', role: 'team', teamId: 'payments' }), 'payments');
  assert.equal(resolveAgentTeam({ id: 'payments-dev', role: 'team-member', teamId: 'payments', parentTeamId: 'payments' }), 'payments');
});

// ── no boundary → ownership decides (D8) ────────────────────────────────────

test('a standalone agent has no team boundary, whatever it is stamped with', () => {
  assert.equal(resolveAgentTeam({ id: 'scratch', role: 'agent', teamId: 'risk' }), null);
  assert.equal(isOwnerScopedAgent({ id: 'scratch', role: 'agent', teamId: 'risk' }), true);
  // An ephemeral run is a `role: 'agent'` stamped with the default scope — same rule.
  assert.equal(resolveAgentTeam({ id: 'eph', role: 'agent', teamId: 'default', ephemeral: true }), null);
});

test('a team agent is never owner-scoped', () => {
  assert.equal(isOwnerScopedAgent({ id: 't', role: 'team' }), false);
  assert.equal(isOwnerScopedAgent({ id: 'm', role: 'team-member', parentTeamId: 't' }), false);
});

// ── fail-closed on every broken shape (§8.4) ────────────────────────────────

test('a broken config resolves to no team rather than to some team', () => {
  assert.equal(resolveAgentTeam(null), null);
  assert.equal(resolveAgentTeam(undefined), null);
  assert.equal(resolveAgentTeam('agent-studio-2-0'), null);   // not an object
  assert.equal(resolveAgentTeam({}), null);                    // no role
  assert.equal(resolveAgentTeam({ id: 'x' }), null);           // no role
  assert.equal(resolveAgentTeam({ role: 'team' }), null);      // team with no id
  assert.equal(resolveAgentTeam({ id: 'm', role: 'team-member' }), null); // member with no parent
  // Never falls back to 'default' — the fallback the access-scope layer took with it.
  for (const cfg of [null, {}, { role: 'team' }, { id: 'm', role: 'team-member', teamId: 'default' }]) {
    assert.notEqual(resolveAgentTeam(cfg), 'default');
  }
});
