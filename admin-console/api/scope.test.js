'use strict';

// Unit tests for resource scoping (#302).
// Run: node --test admin-console/api/scope.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeScope, visibleTeam, visibleAgent,
  canManageTeam, visibleUser, describeAuthz,
  normalizeCredential, visibleCredential, canManageCredential,
  canCreateCredential, canReassignCredential, credentialVisibleToTeam,
} = require('./scope');

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

// ── Admin-surface scoping & gating (#584) ──────────────────────────────────

test('computeScope records per-team roles for non-admins', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(alice.roles.get('payments'), 'team-admin');
  assert.equal(alice.roles.get('default'), 'team-member');
  assert.equal(alice.roles.has('risk'), false);
});

test('canManageTeam: admin manages any team', () => {
  const env = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageTeam(env, 'risk'), true);
  assert.equal(canManageTeam(sys, 'anything'), true);
});

test('canManageTeam: team-admin manages only their admin team', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageTeam(alice, 'payments'), true);  // team-admin
  assert.equal(canManageTeam(alice, 'default'), false);  // only a member
  assert.equal(canManageTeam(alice, 'risk'), false);     // not a member
});

test('canManageTeam: team-member manages nothing', () => {
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageTeam(bob, 'risk'), false);
});

test('canManageTeam: missing teamId collapses to default', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageTeam(alice, undefined), false); // alice is only a member of default
});

test('visibleUser: non-admin sees only users sharing a team', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(visibleUser(alice, 'u-a', memberships), true);  // self
  assert.equal(visibleUser(alice, 'u-b', memberships), false); // bob is risk-only
  const sys = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  assert.equal(visibleUser(sys, 'u-b', memberships), true);    // admin sees all
});

test('visibleUser: zero-team caller sees no user (fail-closed)', () => {
  const ghostUsers = [...users, { id: 'u-lonely', subject: 'lonely@corp.com' }];
  const s = computeScope({ username: 'lonely@corp.com', adminUsername: 'admin', users: ghostUsers, memberships });
  assert.equal(visibleUser(s, 'u-lonely', memberships), false);
  assert.equal(visibleUser(s, 'u-a', memberships), false);
});

test('describeAuthz: env admin', () => {
  const a = describeAuthz({ username: 'admin', adminUsername: 'admin', users, memberships });
  assert.equal(a.admin, true);
  assert.equal(a.envAdmin, true);
  assert.equal(a.systemAdmin, false);
  assert.deepEqual(a.teams, []);
});

test('describeAuthz: System-Admin user', () => {
  const a = describeAuthz({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(a.admin, true);
  assert.equal(a.envAdmin, false);
  assert.equal(a.systemAdmin, true);
  assert.equal(a.userId, 'u-sys');
});

test('describeAuthz: team user carries per-team roles', () => {
  const a = describeAuthz({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(a.admin, false);
  assert.equal(a.systemAdmin, false);
  assert.equal(a.userId, 'u-a');
  const byTeam = Object.fromEntries(a.teams.map(t => [t.teamId, t.role]));
  assert.deepEqual(byTeam, { payments: 'team-admin', default: 'team-member' });
});

test('describeAuthz: unknown subject fails closed', () => {
  const a = describeAuthz({ username: 'ghost@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(a.admin, false);
  assert.equal(a.systemAdmin, false);
  assert.deepEqual(a.teams, []);
});

// ── Credentials scope & management gate (#798) ─────────────────────────────
// alice = team-admin of 'payments', team-member of 'default'.
// bob   = team-member of 'risk'. sys = System Admin. admin = env admin.

test('normalizeCredential: legacy entry (no scope) is team-scoped by teamId', () => {
  assert.deepEqual(normalizeCredential({ id: 'k', teamId: 'payments' }),
    { id: 'k', scope: 'team', teamId: 'payments', assignedTeamIds: [] });
  assert.equal(normalizeCredential({ id: 'k' }).teamId, 'default'); // missing → default
});

test('normalizeCredential: system entry keeps assignedTeamIds, drops teamId', () => {
  const n = normalizeCredential({ id: 'k', scope: 'system', assignedTeamIds: ['payments', 'payments', 'risk'] });
  assert.equal(n.scope, 'system');
  assert.equal(n.teamId, null);
  assert.deepEqual(n.assignedTeamIds, ['payments', 'risk']);
});

test('visibleCredential: team-admin sees own team-scoped + system assigned to their team', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(visibleCredential(alice, { scope: 'team', teamId: 'payments' }), true);   // owns
  assert.equal(visibleCredential(alice, { scope: 'team', teamId: 'risk' }), false);       // other team
  assert.equal(visibleCredential(alice, { teamId: 'default' }), false);                   // only a member of default, not admin
  assert.equal(visibleCredential(alice, { scope: 'system', assignedTeamIds: ['payments'] }), true);  // assigned to her team
  assert.equal(visibleCredential(alice, { scope: 'system', assignedTeamIds: ['risk'] }), false);     // not assigned
  assert.equal(visibleCredential(alice, { scope: 'system', assignedTeamIds: [] }), false);           // unassigned → sysadmin-only
});

test('visibleCredential: system admin & env admin see everything', () => {
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  const env = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  assert.equal(visibleCredential(sys, { scope: 'system', assignedTeamIds: [] }), true);
  assert.equal(visibleCredential(env, { scope: 'team', teamId: 'risk' }), true);
});

test('visibleCredential: plain team-member sees no credentials (access deferred)', () => {
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(visibleCredential(bob, { scope: 'team', teamId: 'risk' }), false);
  assert.equal(visibleCredential(bob, { scope: 'system', assignedTeamIds: ['risk'] }), false);
});

test('canManageCredential: team-admin manages own team creds, never system creds', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageCredential(alice, { scope: 'team', teamId: 'payments' }), true);
  assert.equal(canManageCredential(alice, { scope: 'team', teamId: 'risk' }), false);
  assert.equal(canManageCredential(alice, { scope: 'system', assignedTeamIds: ['payments'] }), false); // AC5
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageCredential(sys, { scope: 'system', assignedTeamIds: [] }), true);
});

test('canCreateCredential: team-admin only team-scoped for own team; system is sysadmin-only', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canCreateCredential(alice, { scope: 'team', teamId: 'payments' }), true);
  assert.equal(canCreateCredential(alice, { scope: 'team', teamId: 'risk' }), false);
  assert.equal(canCreateCredential(alice, { scope: 'system', assignedTeamIds: ['payments'] }), false); // AC6
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canCreateCredential(sys, { scope: 'system', assignedTeamIds: ['payments'] }), true);
});

test('canReassignCredential: System Admins only (AC7)', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canReassignCredential(alice), false);
  assert.equal(canReassignCredential(sys), true);
});

test('credentialVisibleToTeam: used for the reassignment-orphan guard', () => {
  assert.equal(credentialVisibleToTeam({ scope: 'team', teamId: 'payments' }, 'payments'), true);
  assert.equal(credentialVisibleToTeam({ scope: 'team', teamId: 'payments' }, 'risk'), false);
  assert.equal(credentialVisibleToTeam({ scope: 'system', assignedTeamIds: ['payments', 'risk'] }, 'risk'), true);
  assert.equal(credentialVisibleToTeam({ scope: 'system', assignedTeamIds: ['payments'] }, 'risk'), false);
  assert.equal(credentialVisibleToTeam({ teamId: 'default' }, undefined), true); // legacy default
});
