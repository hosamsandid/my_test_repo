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
  ownershipFromRecord,
  canManageCredentialClient,
  canReassignCredentialClient,
  adminTeamIdsOf,
  canAccessCredentialPages,
  isAdminForTeam,
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

test('isAdminForTeam: sysadmin → any team; team-admin → only that team; #2084 edge case', () => {
  // System Admin can add a provider for any team (they add system-scoped ones).
  assert.equal(isAdminForTeam({ admin: true }, 'default'), true);
  assert.equal(isAdminForTeam({ admin: true }, 'anything'), true);
  // Team Admin of the SAME team the agent lands in → yes.
  assert.equal(
    isAdminForTeam({ admin: false, teams: [{ teamId: 'default', role: 'team-admin' }] }, 'default'),
    true,
  );
  // THE #2084 EDGE CASE: Team Admin of team A, agent belongs to team B (default)
  // → no link. `canAccessCredentialPages` would have wrongly returned true here.
  const adminOfOtherTeam = { admin: false, teams: [{ teamId: 'team-a', role: 'team-admin' }] };
  assert.equal(isAdminForTeam(adminOfOtherTeam, 'default'), false);
  assert.equal(canAccessCredentialPages(adminOfOtherTeam), true, 'the weaker predicate would have offered a dead link');
  // Plain member → no; missing user / teamId → fail closed.
  assert.equal(isAdminForTeam({ admin: false, teams: [{ teamId: 'default', role: 'team-member' }] }, 'default'), false);
  assert.equal(isAdminForTeam(null, 'default'), false);
  assert.equal(isAdminForTeam({ admin: false, teams: [{ teamId: 'default', role: 'team-admin' }] }, ''), false);
});

// ── #2083: seeding the control from an existing record ──────────────────────
//
// Environments and MCP servers are edited in the panel they are created in, so
// the ownership control must open showing what the record already IS. Getting
// this wrong is not a cosmetic bug: a create-shaped default would post
// `{scope:'team', teamId:'default'}` over a shared record on the next ordinary
// save, silently un-sharing it — and the server would accept it from a System
// Admin, because for them it is a legal re-tier.
test('ownershipFromRecord: a shared record opens as shared, with its assignments', () => {
  const own = ownershipFromRecord(
    { id: 'env-shared', scope: 'system', assignedTeamIds: ['sdlc', 'billing'] },
    { isSysAdmin: true },
  );
  assert.equal(own.scope, 'system');
  assert.deepEqual(own.assignedTeamIds, ['sdlc', 'billing']);
  // Round-trips through the payload builder without losing an assignment —
  // which is the actual regression this guards.
  assert.deepEqual(ownershipPayload(own), { scope: 'system', assignedTeamIds: ['sdlc', 'billing'] });
});

test('ownershipFromRecord: a team record and a LEGACY record open identically', () => {
  const explicit = ownershipFromRecord({ scope: 'team', teamId: 'sdlc' }, { isSysAdmin: true });
  const legacy = ownershipFromRecord({ teamId: 'sdlc' }, { isSysAdmin: true });
  assert.deepEqual(explicit, { scope: 'team', teamId: 'sdlc', assignedTeamIds: [] });
  assert.deepEqual(legacy, explicit, 'a pre-#2083 record must not read as anything new');
});

test('ownershipFromRecord: no record falls back to the create default, for both roles', () => {
  assert.deepEqual(
    ownershipFromRecord(null, { isSysAdmin: true }),
    defaultOwnership({ isSysAdmin: true }),
  );
  assert.deepEqual(
    ownershipFromRecord(undefined, { isSysAdmin: false, adminTeamIds: ['risk'] }),
    defaultOwnership({ isSysAdmin: false, adminTeamIds: ['risk'] }),
  );
  // A non-object is a caller bug, not a tier — it must not crash the form.
  assert.equal(ownershipFromRecord('env-sdlc', { isSysAdmin: true }).scope, 'team');
});

test('ownershipFromRecord: a personal record keeps its owner rather than being re-tiered', () => {
  // Nothing creates a personal environment (the server refuses), but a personal
  // CREDENTIAL uses this same control, and opening one as team-tier would offer
  // the owner a save that hands their private credential to a team.
  const own = ownershipFromRecord({ scope: 'personal', userId: 'u-ada' }, { isSysAdmin: false });
  assert.equal(own.scope, 'personal');
  assert.equal(own.userId, 'u-ada');
});
