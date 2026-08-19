import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCredential,
  isPersonalCredential,
  teamsById,
  credentialScopeLabel,
  creatableScopes,
  defaultOwnership,
  ownershipPayload,
  canManageCredentialClient,
  canReassignCredentialClient,
  adminTeamIdsOf,
  canAccessCredentialPages,
} from './credential-scope-view.js';

const names = { default: 'Default', payments: 'Payments', risk: 'Risk' };

test('normalizeCredential: legacy entry (no scope) → team-scoped by teamId', () => {
  assert.deepEqual(normalizeCredential({ id: 'k', teamId: 'payments' }), {
    id: 'k', scope: 'team', teamId: 'payments', assignedTeamIds: [],
  });
});

test('normalizeCredential: missing teamId collapses to default', () => {
  assert.equal(normalizeCredential({ id: 'k' }).teamId, 'default');
});

test('normalizeCredential: system entry keeps assignedTeamIds, drops teamId', () => {
  const n = normalizeCredential({ id: 'k', scope: 'system', assignedTeamIds: ['payments', 'payments', 'risk'] });
  assert.equal(n.scope, 'system');
  assert.equal(n.teamId, null);
  assert.deepEqual(n.assignedTeamIds, ['payments', 'risk']); // de-duped
});

test('normalizeCredential: personal entry keeps userId, drops team/system fields', () => {
  const n = normalizeCredential({ id: 'k', scope: 'personal', userId: 'u-7', teamId: 'ignored' });
  assert.equal(n.scope, 'personal');
  assert.equal(n.userId, 'u-7');
  assert.equal(n.teamId, null);
  assert.deepEqual(n.assignedTeamIds, []);
});

test('isPersonalCredential: true only for the personal tier', () => {
  assert.equal(isPersonalCredential({ scope: 'personal', userId: 'u-1' }), true);
  assert.equal(isPersonalCredential({ scope: 'team', teamId: 'x' }), false);
  assert.equal(isPersonalCredential({ scope: 'system', assignedTeamIds: [] }), false);
  assert.equal(isPersonalCredential({ teamId: 'legacy' }), false);
});

test('teamsById maps id → name', () => {
  assert.deepEqual(teamsById([{ id: 'a', name: 'Alpha' }, { id: 'b' }]), { a: 'Alpha', b: 'b' });
});

test('credentialScopeLabel: team-scoped', () => {
  const l = credentialScopeLabel({ scope: 'team', teamId: 'payments' }, names);
  assert.equal(l.scope, 'team');
  assert.equal(l.label, 'Team');
  assert.equal(l.detail, 'Payments');
});

test('credentialScopeLabel: system assigned to teams', () => {
  const l = credentialScopeLabel({ scope: 'system', assignedTeamIds: ['payments', 'risk'] }, names);
  assert.equal(l.scope, 'system');
  assert.deepEqual(l.teams, ['Payments', 'Risk']);
  assert.equal(l.detail, 'Payments, Risk');
});

test('credentialScopeLabel: system assigned to zero teams → Unassigned', () => {
  const l = credentialScopeLabel({ scope: 'system', assignedTeamIds: [] }, names);
  assert.equal(l.detail, 'Unassigned');
  assert.deepEqual(l.teams, []);
});

test('credentialScopeLabel: personal → Personal / Private to you', () => {
  const l = credentialScopeLabel({ scope: 'personal', userId: 'u-1' }, names);
  assert.equal(l.scope, 'personal');
  assert.equal(l.label, 'Personal');
  assert.equal(l.detail, 'Private to you');
  assert.deepEqual(l.teams, []);
});

test('creatableScopes: sysadmin gets both, team admin only team', () => {
  assert.deepEqual(creatableScopes({ isSysAdmin: true }), ['system', 'team']);
  assert.deepEqual(creatableScopes({ isSysAdmin: false }), ['team']);
});

test('defaultOwnership: sysadmin → team/default; team admin → first admin team', () => {
  assert.deepEqual(defaultOwnership({ isSysAdmin: true }), { scope: 'team', teamId: 'default', assignedTeamIds: [] });
  assert.deepEqual(defaultOwnership({ isSysAdmin: false, adminTeamIds: ['payments', 'risk'] }),
    { scope: 'team', teamId: 'payments', assignedTeamIds: [] });
});

test('ownershipPayload: strips to API shape', () => {
  assert.deepEqual(ownershipPayload({ scope: 'team', teamId: 'payments', assignedTeamIds: [] }),
    { scope: 'team', teamId: 'payments' });
  assert.deepEqual(ownershipPayload({ scope: 'system', assignedTeamIds: ['a', 'a', 'b'] }),
    { scope: 'system', assignedTeamIds: ['a', 'b'] });
});

test('canManageCredentialClient: sysadmin manages everything', () => {
  const caller = { isSysAdmin: true, adminTeamIds: [] };
  assert.equal(canManageCredentialClient({ scope: 'system', assignedTeamIds: ['x'] }, caller), true);
  assert.equal(canManageCredentialClient({ scope: 'team', teamId: 'x' }, caller), true);
});

test('canManageCredentialClient: team admin manages only own team-scoped creds', () => {
  const caller = { isSysAdmin: false, adminTeamIds: ['payments'] };
  assert.equal(canManageCredentialClient({ scope: 'team', teamId: 'payments' }, caller), true);
  assert.equal(canManageCredentialClient({ scope: 'team', teamId: 'risk' }, caller), false);
  // never a system cred, even one assigned to their team
  assert.equal(canManageCredentialClient({ scope: 'system', assignedTeamIds: ['payments'] }, caller), false);
});

test('canManageCredentialClient: personal — only the owner, no sysadmin bypass', () => {
  const cred = { scope: 'personal', userId: 'u-1' };
  // owner manages it
  assert.equal(canManageCredentialClient(cred, { userId: 'u-1' }), true);
  // a different user (even a sys admin) may not — no scope.all bypass (D2)
  assert.equal(canManageCredentialClient(cred, { isSysAdmin: true, userId: 'u-2' }), false);
  assert.equal(canManageCredentialClient(cred, { isSysAdmin: true, adminTeamIds: [], userId: null }), false);
  // an unowned personal credential matches nobody
  assert.equal(canManageCredentialClient({ scope: 'personal' }, { userId: 'u-1' }), false);
});

test('canReassignCredentialClient: sysadmin only', () => {
  assert.equal(canReassignCredentialClient({ isSysAdmin: true }), true);
  assert.equal(canReassignCredentialClient({ isSysAdmin: false }), false);
});

test('adminTeamIdsOf: only team-admin memberships', () => {
  const user = { teams: [
    { teamId: 'payments', role: 'team-admin' },
    { teamId: 'default', role: 'team-member' },
    { teamId: 'risk', role: 'team-admin' },
  ] };
  assert.deepEqual(adminTeamIdsOf(user), ['payments', 'risk']);
});

test('canAccessCredentialPages: admin, any team-admin → yes; plain member → no', () => {
  assert.equal(canAccessCredentialPages({ admin: true }), true);
  assert.equal(canAccessCredentialPages({ admin: false, teams: [{ teamId: 't', role: 'team-admin' }] }), true);
  assert.equal(canAccessCredentialPages({ admin: false, teams: [{ teamId: 't', role: 'team-member' }] }), false);
  assert.equal(canAccessCredentialPages(null), false);
});
