'use strict';

// Unit tests for resource scoping (#302).
// Run: node --test admin-console/api/scope.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeScope, visibleTeam, visibleAgent } = require('./scope');

const users = [
  { id: 'u-sys', subject: 'sys@corp.com', systemAdmin: true },
  { id: 'u-a', subject: 'alice@corp.com' },
  { id: 'u-b', subject: 'bob@corp.com' },
];
const memberships = [
  { userId: 'u-a', teamId: 'payments', role: 'team-admin' },
  { userId: 'u-a', teamId: 'default', role: 'team-member' },
  { userId: 'u-b', teamId: 'risk', role: 'team-member' },
];

test('env admin sees everything', () => {
  const s = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  assert.equal(s.all, true);
  assert.equal(visibleTeam(s, 'risk'), true);
  assert.equal(visibleTeam(s, 'anything'), true);
});

test('System-Admin user sees everything', () => {
  const s = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(s.all, true);
  assert.equal(visibleTeam(s, 'payments'), true);
});

test('team member sees only their teams', () => {
  const s = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(s.all, false);
  assert.deepEqual([...s.teamIds].sort(), ['default', 'payments']);
  assert.equal(visibleTeam(s, 'payments'), true);
  assert.equal(visibleTeam(s, 'default'), true);
  assert.equal(visibleTeam(s, 'risk'), false); // not a member
});

test('cross-team isolation: bob (risk) cannot see payments', () => {
  const s = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(visibleTeam(s, 'risk'), true);
  assert.equal(visibleTeam(s, 'payments'), false);
});

test('missing teamId is treated as the default team', () => {
  const s = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(visibleTeam(s, undefined), true);  // alice is in default
  const sBob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(visibleTeam(sBob, undefined), false); // bob is not in default
});

test('unknown subject fails closed', () => {
  const s = computeScope({ username: 'ghost@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(s.all, false);
  assert.equal(visibleTeam(s, 'default'), false);
});

test('no username fails closed', () => {
  const s = computeScope({ username: undefined, adminUsername: 'admin', users, memberships });
  assert.equal(s.all, false);
});

test('visibleAgent: private agent only visible to owner (non-admin)', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const teamAgent = { teamId: 'payments', visibility: 'team' };
  const privOwn = { teamId: 'payments', visibility: 'private', ownerId: 'u-a' };
  const privOther = { teamId: 'payments', visibility: 'private', ownerId: 'u-b' };
  assert.equal(visibleAgent(alice, teamAgent), true);
  assert.equal(visibleAgent(alice, privOwn), true);
  assert.equal(visibleAgent(alice, privOther), false); // private, not owner
  // out-of-team agent never visible
  assert.equal(visibleAgent(alice, { teamId: 'risk', visibility: 'team' }), false);
});

test('visibleAgent: admin sees private agents of others', () => {
  const sys = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  assert.equal(visibleAgent(sys, { teamId: 'risk', visibility: 'private', ownerId: 'u-b' }), true);
});

test('visibleAgent: missing visibility defaults to team-wide', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(visibleAgent(alice, { teamId: 'payments' }), true);
});
