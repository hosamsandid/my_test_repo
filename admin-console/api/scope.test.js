'use strict';

// Unit tests for resource scoping (#302).
// Run: node --test admin-console/api/scope.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeScope, visibleTeam, visibleAgent,
  canManageTeam, canManageAgent, canManageEnvironment, visibleUser, describeAuthz, isKnownPrincipal,
  normalizeCredential, visibleCredential, canManageCredential,
  canCreateCredential, canReassignCredential, credentialVisibleToTeam,
  canViewUsageStatistics, assistSelectableEndpoint, resolveAgentTenant,
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

test('describeAuthz: chatFontSize surfaces the caller\'s own preference (#1437)', () => {
  const withPref = [
    { id: 'u-a', subject: 'alice@corp.com', chatFontSize: 16 },
    { id: 'u-b', subject: 'bob@corp.com' }, // no preference → default
  ];
  const alice = describeAuthz({ username: 'alice@corp.com', adminUsername: 'admin', users: withPref, memberships: [] });
  assert.equal(alice.chatFontSize, 16);
  const bob = describeAuthz({ username: 'bob@corp.com', adminUsername: 'admin', users: withPref, memberships: [] });
  assert.equal(bob.chatFontSize, 12); // default when unset
});

test('describeAuthz: env admin (no user record) gets the 12px default (#1437)', () => {
  const a = describeAuthz({ username: 'admin', adminUsername: 'admin', users, memberships });
  assert.equal(a.chatFontSize, 12);
});

test('isKnownPrincipal: registered user or env admin, fail-closed otherwise (#1415)', () => {
  assert.equal(isKnownPrincipal({ envAdmin: true, userId: null }), true);
  assert.equal(isKnownPrincipal({ envAdmin: false, userId: 'u1' }), true);
  assert.equal(isKnownPrincipal({ envAdmin: false, userId: null }), false);
  assert.equal(isKnownPrincipal({}), false);
  assert.equal(isKnownPrincipal(null), false);
  assert.equal(isKnownPrincipal(undefined), false);

  // Composed through describeAuthz — the production IAP-gate path.
  const authz = (username, u = users) => describeAuthz({ username, adminUsername: 'admin', users: u, memberships });
  assert.equal(isKnownPrincipal(authz('alice@corp.com')), true);  // registered, memberships
  assert.equal(isKnownPrincipal(authz('ALICE@corp.com')), true);  // subject match is case-insensitive
  assert.equal(isKnownPrincipal(authz('sys@corp.com')), true);    // registered System Admin
  assert.equal(isKnownPrincipal(authz('admin')), true);           // env admin
  assert.equal(isKnownPrincipal(authz('ghost@corp.com')), false); // stranger
  assert.equal(isKnownPrincipal(authz('alice@corp.com', [])), false); // degraded users-index read → unknown
});

test('describeAuthz: surfaces the caller\'s own githubHandle (#1385)', () => {
  const withHandle = [
    { id: 'u-a', subject: 'alice@corp.com', githubHandle: 'alice-gh' },
    { id: 'u-b', subject: 'bob@corp.com' }, // no handle set
  ];
  const alice = describeAuthz({ username: 'alice@corp.com', adminUsername: 'admin', users: withHandle, memberships });
  assert.equal(alice.githubHandle, 'alice-gh');
  // A user with no handle set reports the empty string, not undefined.
  const bob = describeAuthz({ username: 'bob@corp.com', adminUsername: 'admin', users: withHandle, memberships });
  assert.equal(bob.githubHandle, '');
  // The env single-admin credential has no user record → empty handle.
  const admin = describeAuthz({ username: 'admin', adminUsername: 'admin', users: withHandle, memberships });
  assert.equal(admin.githubHandle, '');
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

// ── assistSelectableEndpoint (#1210) — selection visibility, NOT management ──

test('assistSelectableEndpoint: plain team-member CAN select their team providers (unlike visibleCredential)', () => {
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships }); // team-member of risk
  // The whole point: a member who may NOT manage the credential may still select it.
  assert.equal(visibleCredential(bob, { authType: 'api-key', scope: 'team', teamId: 'risk' }), false);
  assert.equal(assistSelectableEndpoint(bob, { authType: 'api-key', scope: 'team', teamId: 'risk' }), true);
  assert.equal(assistSelectableEndpoint(bob, { authType: 'api-key', scope: 'system', assignedTeamIds: ['risk'] }), true);
  // Other teams / unassigned system providers stay non-selectable.
  assert.equal(assistSelectableEndpoint(bob, { authType: 'api-key', scope: 'team', teamId: 'payments' }), false);
  assert.equal(assistSelectableEndpoint(bob, { authType: 'api-key', scope: 'system', assignedTeamIds: ['payments'] }), false);
  assert.equal(assistSelectableEndpoint(bob, { authType: 'api-key', scope: 'system', assignedTeamIds: [] }), false);
});

test('assistSelectableEndpoint: oauth-token providers are never selectable (even for admins)', () => {
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  const env = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(assistSelectableEndpoint(sys, { authType: 'oauth-token', scope: 'system', assignedTeamIds: [] }), false);
  assert.equal(assistSelectableEndpoint(env, { authType: 'oauth-token', scope: 'team', teamId: 'risk' }), false);
  assert.equal(assistSelectableEndpoint(bob, { authType: 'oauth-token', scope: 'team', teamId: 'risk' }), false);
});

test('assistSelectableEndpoint: scope.all (System Admin / env admin) selects any non-oauth provider', () => {
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  const env = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  assert.equal(assistSelectableEndpoint(sys, { authType: 'api-key', scope: 'system', assignedTeamIds: [] }), true);
  assert.equal(assistSelectableEndpoint(env, { authType: 'api-key', scope: 'team', teamId: 'risk' }), true);
});

test('assistSelectableEndpoint: pre-#800 legacy record (no scope) is team-scoped via normalizeCredential', () => {
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships }); // risk member
  // Legacy entry carries only teamId, no scope → treated as team-scoped owned by that team.
  assert.equal(assistSelectableEndpoint(bob, { authType: 'api-key', teamId: 'risk' }), true);
  assert.equal(assistSelectableEndpoint(bob, { authType: 'api-key', teamId: 'payments' }), false);
  // A legacy record with no teamId at all collapses to the default team.
  const legacyDefault = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships }); // member of default
  assert.equal(assistSelectableEndpoint(legacyDefault, { authType: 'api-key' }), true);
});

test('assistSelectableEndpoint: fail-closed on missing scope/endpoint', () => {
  assert.equal(assistSelectableEndpoint(null, { authType: 'api-key', scope: 'team', teamId: 'risk' }), false);
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(assistSelectableEndpoint(bob, null), false);
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

// ── Personal ownership tier (#1567 / epic #1558) ───────────────────────────
// A `personal` credential is owned by exactly one human (`userId`) and is
// strictly private to them: visible/manageable ONLY by its owner, with NO
// `scope.all` override — not even a System Admin or the env single-admin.

test('normalizeCredential: personal entry round-trips its owner, drops team/assignments (AC1)', () => {
  const n = normalizeCredential({ id: 'k', scope: 'personal', userId: 'u-a' });
  assert.deepEqual(n, { id: 'k', scope: 'personal', userId: 'u-a', teamId: null, assignedTeamIds: [] });
  // A personal entry with no owner normalizes to userId:null (matches nobody).
  assert.equal(normalizeCredential({ id: 'k', scope: 'personal' }).userId, null);
  // Team/system/legacy entries are unchanged by the personal addition.
  assert.deepEqual(normalizeCredential({ id: 'k', teamId: 'payments' }),
                   { id: 'k', scope: 'team', teamId: 'payments', assignedTeamIds: [] });
  assert.equal(normalizeCredential({ id: 'k', scope: 'system', assignedTeamIds: ['risk'] }).scope, 'system');
});

test('visibleCredential: a personal credential is visible ONLY to its owner (AC5 / D2)', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  const env = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  const aliceCred = { scope: 'personal', userId: 'u-a' };
  assert.equal(visibleCredential(alice, aliceCred), true);   // owner
  assert.equal(visibleCredential(bob, aliceCred), false);    // another member
  assert.equal(visibleCredential(sys, aliceCred), false);    // System Admin — NO scope.all bypass
  assert.equal(visibleCredential(env, aliceCred), false);    // env single-admin — NO scope.all bypass
  // An owner-less personal credential is visible to nobody (fail-closed).
  assert.equal(visibleCredential(alice, { scope: 'personal' }), false);
});

test('canManageCredential: only the owner manages a personal credential; scope.all denied (AC4)', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  const env = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  const aliceCred = { scope: 'personal', userId: 'u-a' };
  assert.equal(canManageCredential(alice, aliceCred), true);
  assert.equal(canManageCredential(bob, aliceCred), false);
  assert.equal(canManageCredential(sys, aliceCred), false);  // System Admin cannot manage a foreign personal cred
  assert.equal(canManageCredential(env, aliceCred), false);
});

test('canCreateCredential: any authenticated human creates a personal credential owned by self (AC3)', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships }); // team-admin
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });      // team-member
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });      // System Admin
  const env = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });             // env single-admin
  assert.equal(canCreateCredential(alice, { scope: 'personal', userId: 'u-a' }), true);
  assert.equal(canCreateCredential(bob, { scope: 'personal', userId: 'u-b' }), true);   // plain member CAN (unlike team/system)
  assert.equal(canCreateCredential(sys, { scope: 'personal', userId: 'u-sys' }), true); // as self, not via scope.all
  // Owning someone else's identity is refused even for a System Admin.
  assert.equal(canCreateCredential(sys, { scope: 'personal', userId: 'u-a' }), false);
  assert.equal(canCreateCredential(bob, { scope: 'personal', userId: 'u-a' }), false);
  // The env single-admin has no user record (userId null) → cannot own a personal credential.
  assert.equal(canCreateCredential(env, { scope: 'personal', userId: 'u-a' }), false);
});

test('credentialVisibleToTeam: used for the reassignment-orphan guard', () => {
  assert.equal(credentialVisibleToTeam({ scope: 'team', teamId: 'payments' }, 'payments'), true);
  assert.equal(credentialVisibleToTeam({ scope: 'team', teamId: 'payments' }, 'risk'), false);
  assert.equal(credentialVisibleToTeam({ scope: 'system', assignedTeamIds: ['payments', 'risk'] }, 'risk'), true);
  assert.equal(credentialVisibleToTeam({ scope: 'system', assignedTeamIds: ['payments'] }, 'risk'), false);
  assert.equal(credentialVisibleToTeam({ teamId: 'default' }, undefined), true); // legacy default
});

// ── Model Providers / LLM endpoints reuse the same primitives (#800) ───────
// Model Providers are stored as LLM endpoints and carry the identical
// scope/teamId/assignedTeamIds ownership shape, so the credential scope
// predicates gate them unchanged. These assertions pin that reuse on a
// provider-shaped entry (extra fields: baseUrl, models, authTokenId).

test('normalizeCredential: preserves provider-shaped fields (baseUrl/models)', () => {
  const legacy = { id: 'litellm', name: 'LiteLLM', teamId: 'payments',
    baseUrl: 'https://p/v1', authTokenId: 'litellm-x', models: [{ id: 'm', displayName: 'M' }] };
  const n = normalizeCredential(legacy);
  assert.equal(n.scope, 'team');
  assert.equal(n.teamId, 'payments');
  assert.deepEqual(n.assignedTeamIds, []);
  // The mask path reads these off the normalized copy — they must survive.
  assert.equal(n.baseUrl, 'https://p/v1');
  assert.equal(n.authTokenId, 'litellm-x');
  assert.deepEqual(n.models, [{ id: 'm', displayName: 'M' }]);

  const sys = normalizeCredential({ id: 'shared', scope: 'system', assignedTeamIds: ['payments'],
    baseUrl: 'https://s/v1', models: [] });
  assert.equal(sys.scope, 'system');
  assert.equal(sys.teamId, null);
  assert.equal(sys.baseUrl, 'https://s/v1');
});

test('provider gating: team-admin sees/manages own team provider, only uses assigned system one', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const teamProvider = { id: 'p1', scope: 'team', teamId: 'payments', baseUrl: 'https://p/v1' };
  const sysProvider  = { id: 'p2', scope: 'system', assignedTeamIds: ['payments'], baseUrl: 'https://s/v1' };
  const otherTeam    = { id: 'p3', scope: 'team', teamId: 'risk', baseUrl: 'https://r/v1' };
  // AC1/AC2: visible = own team-scoped + system assigned to her team; another team's is absent.
  assert.equal(visibleCredential(alice, teamProvider), true);
  assert.equal(visibleCredential(alice, sysProvider), true);
  assert.equal(visibleCredential(alice, otherTeam), false);
  // AC5/AC6: manage own team-scoped; never a system-scoped provider.
  assert.equal(canManageCredential(alice, teamProvider), true);
  assert.equal(canManageCredential(alice, sysProvider), false);
  // AC7: reassigning is System-Admin-only.
  assert.equal(canReassignCredential(alice), false);
});

// ── Config-write authorization for agents / environments (#989) ─────────────
// alice = team-admin of 'payments', team-member of 'default'.
// bob   = team-member of 'risk'. sys = System Admin. admin = env admin.

test('canManageAgent: team-admin manages agents of their admin team only', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageAgent(alice, { teamId: 'payments' }), true);   // team-admin
  assert.equal(canManageAgent(alice, { teamId: 'default' }), false);   // only a member (AC1)
  assert.equal(canManageAgent(alice, { teamId: 'risk' }), false);      // not a member
  assert.equal(canManageAgent(alice, {}), false);                      // missing → default, not admin
});

test('canManageAgent: plain team-member manages no agent (AC1)', () => {
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageAgent(bob, { teamId: 'risk' }), false); // member, not admin
});

test('canManageAgent: env admin & System-Admin user manage any agent', () => {
  const env = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageAgent(env, { teamId: 'risk' }), true);
  assert.equal(canManageAgent(sys, { teamId: 'anything' }), true);
});

test('canManageAgent: missing scope / unknown subject fail closed', () => {
  const unknown = computeScope({ username: 'ghost@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageAgent(unknown, { teamId: 'default' }), false);
  assert.equal(canManageAgent(null, { teamId: 'default' }), false);
  assert.equal(canManageAgent(undefined, { teamId: 'payments' }), false);
});

test('canManageEnvironment: team-admin manages own team env; member/other denied', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const bob   = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageEnvironment(alice, { teamId: 'payments' }), true);
  assert.equal(canManageEnvironment(alice, { teamId: 'default' }), false); // only a member
  assert.equal(canManageEnvironment(alice, { teamId: 'risk' }), false);    // other team
  assert.equal(canManageEnvironment(bob, { teamId: 'risk' }), false);      // member, not admin
  assert.equal(canManageEnvironment(alice, {}), false);                    // missing → default
});

test('canManageEnvironment: env admin & System-Admin manage any env (no regression)', () => {
  const env = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageEnvironment(env, { teamId: 'risk' }), true);
  assert.equal(canManageEnvironment(sys, { teamId: 'payments' }), true);
  assert.equal(canManageEnvironment(null, { teamId: 'payments' }), false); // missing scope fails closed
});

// ── Token-usage statistics visibility (#801) ────────────────────────────────

test('canViewUsageStatistics: env admin & System-Admin user may view (AC3/AC6)', () => {
  const envAdmin = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  const sysAdmin = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canViewUsageStatistics(envAdmin), true);
  assert.equal(canViewUsageStatistics(sysAdmin), true);
});

test('canViewUsageStatistics: Team Admin & Team Member are denied (AC1/AC2)', () => {
  // alice is team-admin of payments; bob is a plain team-member of risk.
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const bob   = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canViewUsageStatistics(alice), false);
  assert.equal(canViewUsageStatistics(bob), false);
});

test('canViewUsageStatistics: unknown subject / missing scope fail closed', () => {
  const unknown = computeScope({ username: 'ghost@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canViewUsageStatistics(unknown), false);
  assert.equal(canViewUsageStatistics(null), false);
  assert.equal(canViewUsageStatistics(undefined), false);
});

// ── Per-agent Model-Provider switch: curated target set (agent-provider-switch)
//
// The provider switcher must build its allowed target set from
// credentialVisibleToTeam (does the AGENT's team own/get-assigned this
// provider?), NOT from visibleCredential (which gates on the *caller's*
// team-admin role and is intentionally closed to Team Members). These tests pin
// that a plain Team Member can switch within their team's providers even though
// the general credential listing shows them nothing.
test('provider switch: a Team Member gets the team-usable set though visibleCredential is closed', () => {
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships }); // team-member of 'risk'
  const teamEp   = { id: 'ep-risk', scope: 'team', teamId: 'risk' };
  const otherEp  = { id: 'ep-pay', scope: 'team', teamId: 'payments' };
  const systemEp = { id: 'ep-shared', scope: 'system', assignedTeamIds: ['risk'] };

  // The curated set is by the agent's team — bob's team is 'risk'.
  assert.equal(credentialVisibleToTeam(teamEp, 'risk'), true);
  assert.equal(credentialVisibleToTeam(systemEp, 'risk'), true);
  assert.equal(credentialVisibleToTeam(otherEp, 'risk'), false); // no cross-team leak

  // …yet the member's own credential listing (role-gated) shows none of them.
  assert.equal(visibleCredential(bob, teamEp), false);
  assert.equal(visibleCredential(bob, systemEp), false);
});

test('provider switch: even a System Admin cannot target a provider the agent team lacks', () => {
  // System Admin sees every credential (visibleCredential true) …
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  const otherEp = { id: 'ep-pay', scope: 'team', teamId: 'payments' };
  assert.equal(visibleCredential(sys, otherEp), true);
  // … but the switch is gated on the AGENT team's entitlement, not the caller's
  // visibility: a 'risk' agent still can't be bound to a 'payments' provider.
  assert.equal(credentialVisibleToTeam(otherEp, 'risk'), false);
});

// ── Agent → human tenant resolution ─────────────────────────────────────────
// A team-member's tenant is its parent Agent Team's `teamId`. `parentTeamId`
// itself is an Agent-Team id in a different namespace and must never be used as
// a tenant — doing so silently empties every team-scoped lookup whenever the
// Agent Team's id is not also a human Team id.

const tenantAgents = {
  // Agent Team 'sdlc-2-0' is owned by the human team 'default'.
  'sdlc-2-0': { id: 'sdlc-2-0', role: 'team', teamId: 'default' },
  'sdlc-2-0-analyst': { id: 'sdlc-2-0-analyst', role: 'team-member', teamId: 'default', parentTeamId: 'sdlc-2-0' },
  // A member whose own stamp drifted away from its parent's tenant.
  'sdlc-2-0-dev': { id: 'sdlc-2-0-dev', role: 'team-member', teamId: 'stale', parentTeamId: 'sdlc-2-0' },
  // Agent Team whose id coincides with a human team id (the case that hid the bug).
  payments: { id: 'payments', role: 'team', teamId: 'payments' },
  'payments-dev': { id: 'payments-dev', role: 'team-member', teamId: 'payments', parentTeamId: 'payments' },
  standalone: { id: 'standalone', role: 'agent', teamId: 'risk' },
};
const loadTenantAgent = (id) => tenantAgents[id] || null;

test('tenant: a team-member resolves to its parent Agent Team\'s human team, not the Agent-Team id', () => {
  assert.equal(resolveAgentTenant(tenantAgents['sdlc-2-0-analyst'], loadTenantAgent), 'default');
  // The regression this guards: 'sdlc-2-0' is an Agent Team, not a human team,
  // so using it as a tenant made every provider invisible.
  assert.notEqual(resolveAgentTenant(tenantAgents['sdlc-2-0-analyst'], loadTenantAgent), 'sdlc-2-0');
});

test('tenant: the parent wins over a drifted own stamp', () => {
  assert.equal(resolveAgentTenant(tenantAgents['sdlc-2-0-dev'], loadTenantAgent), 'default');
});

test('tenant: the coinciding-id case keeps resolving as before', () => {
  assert.equal(resolveAgentTenant(tenantAgents['payments-dev'], loadTenantAgent), 'payments');
});

test('tenant: agents without a parent use their own teamId', () => {
  assert.equal(resolveAgentTenant(tenantAgents.standalone, loadTenantAgent), 'risk');
  assert.equal(resolveAgentTenant(tenantAgents['sdlc-2-0'], loadTenantAgent), 'default');
});

test('tenant: falls back to the own stamp when the parent is missing or unstamped', () => {
  const orphan = { id: 'orphan', role: 'team-member', teamId: 'risk', parentTeamId: 'gone' };
  assert.equal(resolveAgentTenant(orphan, loadTenantAgent), 'risk');
  const unstamped = { id: 'u', role: 'team-member', teamId: 'risk', parentTeamId: 'no-team' };
  assert.equal(resolveAgentTenant(unstamped, () => ({ id: 'no-team', role: 'team' })), 'risk');
});

test('tenant: defaults to the default team on missing input', () => {
  assert.equal(resolveAgentTenant(null, loadTenantAgent), 'default');
  assert.equal(resolveAgentTenant({ id: 'x' }, loadTenantAgent), 'default');
  assert.equal(resolveAgentTenant({ id: 'x', parentTeamId: 'sdlc-2-0' }, undefined), 'default');
});

test('tenant: the resolved tenant is what unlocks the team-scoped provider set', () => {
  // End-to-end of the reported bug: the providers assigned to 'default' are
  // reachable for a member of an Agent Team whose id is not a human team.
  const systemEp = { id: 'ep-shared', scope: 'system', assignedTeamIds: ['default'] };
  const tenant = resolveAgentTenant(tenantAgents['sdlc-2-0-analyst'], loadTenantAgent);
  assert.equal(credentialVisibleToTeam(systemEp, tenant), true);
  assert.equal(credentialVisibleToTeam(systemEp, 'sdlc-2-0'), false); // pre-fix behaviour
});
