'use strict';

// Run: node --test admin-console/api/creator-membership.test.js
//
// #2081 AC1/AC2 (epic #2076 P3): the creator of a self-service Agent Team is
// its Team Admin, and the team is private by default.
//
// Two layers. The first is the pure decision (`planCreatorMembership`) — the
// idempotence property concept §10's P3 row asks for. The second is what
// actually matters and what a wiring guard cannot show: run the REAL `scope.js`
// predicates over the estate this feature produces and measure who can see the
// team. That layer also carries the counterfactual — the same estate WITHOUT
// the membership, which is the state `main` shipped — so "the creator can see
// their own team" is a measurement rather than a claim.
//
// api.js cannot be required (#651 — it binds two ports on require), so the fact
// that both handlers call this module is guarded separately, by
// `self-service-team-creation.test.js`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { planCreatorMembership, creatorEnvironmentOwnership, ROLE_TEAM_ADMIN } = require('./creator-membership');
const { resolveAgentTeam } = require('./agent-team');
const {
  computeScope, visibleAgent, canManageAgent, visibleTeam, canManageTeam,
  visibleEnvironment, canManageEnvironment,
} = require('./scope');

// ── 1. The decision ────────────────────────────────────────────────────────

test('a create by an identified human plans exactly one team-admin membership', () => {
  assert.deepEqual(
    planCreatorMembership({ userId: 'u-alice', teamAgentId: 'squad', teamCreated: true }),
    { userId: 'u-alice', teamId: 'squad', role: ROLE_TEAM_ADMIN },
  );
});

test('an extend plans nothing — which is what makes the write idempotent', () => {
  // `setMembership` is an upsert, so re-asserting on every extend would let a
  // `team-member` who adds a role promote themselves to `team-admin`.
  for (const teamCreated of [false, undefined, null, 'true', 0, 1]) {
    assert.equal(
      planCreatorMembership({ userId: 'u-alice', teamAgentId: 'squad', teamCreated }),
      null,
      `teamCreated=${JSON.stringify(teamCreated)} must not write a membership`,
    );
  }
});

test('a caller with no user record plans nothing, exactly like the owner stamp', () => {
  // The env single-admin (#276) and single-user compatibility mode (#1457)
  // both resolve to `scope.userId === null`. They hold `scope.all`, so the team
  // is visible to them anyway; a membership would have nobody to name.
  for (const userId of [null, undefined, '', '   ', 42, {}]) {
    assert.equal(planCreatorMembership({ userId, teamAgentId: 'squad', teamCreated: true }), null);
  }
  assert.equal(planCreatorMembership({ userId: 'u-alice', teamAgentId: '', teamCreated: true }), null);
  assert.equal(planCreatorMembership(), null);
});

test('the auto-created environment is stamped with the team, on the team tier', () => {
  assert.deepEqual(creatorEnvironmentOwnership('squad'), {
    scope: 'team', teamId: 'squad', assignedTeamIds: [],
  });
});

// ── 2. What the real predicates then answer ────────────────────────────────
//
// Alice creates `squad` with no prior membership. Bob is an ordinary user of
// another team. Root is a System Admin.

const USERS = [
  { id: 'u-alice', subject: 'alice@corp.com' },
  { id: 'u-bob', subject: 'bob@corp.com' },
  { id: 'u-root', subject: 'root@corp.com', systemAdmin: true },
];

const TEAM_AGENT = { id: 'squad', role: 'team', ownerId: 'u-alice', ownerSource: 'creator' };
const MEMBER_AGENT = { id: 'squad-developer', role: 'team-member', parentTeamId: 'squad' };
const TEAM_ENV = { id: 'squad', ...creatorEnvironmentOwnership('squad') };

// api.js's `agentMetaForScope`: the RESOLVED boundary plus the owner, which is
// the exact shape every gate is handed.
function meta(cfg) {
  return { teamId: resolveAgentTeam(cfg), ownerId: cfg && cfg.ownerId };
}

function scopeFor(username, memberships) {
  return computeScope({ username, users: USERS, memberships, authEnabled: true });
}

// The estate this feature produces: the planned membership, actually written.
const plan = planCreatorMembership({ userId: 'u-alice', teamAgentId: 'squad', teamCreated: true });
const AFTER = [plan, { userId: 'u-bob', teamId: 'other-squad', role: 'team-admin' }];
// The estate before it: alice owns the team and holds nothing.
const BEFORE = AFTER.filter(m => m.userId !== 'u-alice');

test('AC1: the creator can see AND manage the team they just created', () => {
  const alice = scopeFor('alice@corp.com', AFTER);
  assert.equal(visibleAgent(alice, meta(TEAM_AGENT)), true);
  assert.equal(canManageAgent(alice, meta(TEAM_AGENT)), true);
  assert.equal(canManageTeam(alice, 'squad'), true, 'Team Admin, so she may manage its members');
  // ...and its members and its environment, or the team is not usable.
  assert.equal(visibleAgent(alice, meta(MEMBER_AGENT)), true);
  assert.equal(canManageAgent(alice, meta(MEMBER_AGENT)), true);
  assert.equal(visibleEnvironment(alice, TEAM_ENV), true);
  assert.equal(canManageEnvironment(alice, TEAM_ENV), true);
});

test('the counterfactual: with only the owner stamp, the creator sees nothing', () => {
  // This is the state `main` shipped, and the reason AC1 is not satisfied by
  // `ownerFor(req)` alone: a `role: 'team'` agent IS its own access boundary,
  // so `visibleAgent` takes the membership branch and never reaches the owner.
  const alice = scopeFor('alice@corp.com', BEFORE);
  assert.equal(resolveAgentTeam(TEAM_AGENT), 'squad', 'the boundary is present, so ownership is not consulted');
  assert.equal(visibleAgent(alice, meta(TEAM_AGENT)), false);
  assert.equal(canManageAgent(alice, meta(TEAM_AGENT)), false);
  assert.equal(visibleAgent(alice, meta(MEMBER_AGENT)), false);
  assert.equal(visibleEnvironment(alice, TEAM_ENV), false);
});

test('AC2: a second ordinary user cannot see the team, its members or its environment', () => {
  const bob = scopeFor('bob@corp.com', AFTER);
  assert.equal(visibleTeam(bob, 'squad'), false);
  assert.equal(visibleAgent(bob, meta(TEAM_AGENT)), false);
  assert.equal(canManageAgent(bob, meta(TEAM_AGENT)), false);
  assert.equal(visibleAgent(bob, meta(MEMBER_AGENT)), false);
  assert.equal(visibleEnvironment(bob, TEAM_ENV), false);
  assert.equal(canManageEnvironment(bob, TEAM_ENV), false);
  // Owning nothing here is not enough on its own — assert the owner branch is
  // not what is answering, by handing bob an agent he DOES own.
  assert.equal(visibleAgent(bob, { teamId: null, ownerId: 'u-bob' }), true);
});

test('AC2: a System Admin can see it — the one exception D5 keeps', () => {
  const root = scopeFor('root@corp.com', AFTER);
  assert.equal(root.all, true);
  assert.equal(visibleAgent(root, meta(TEAM_AGENT)), true);
  assert.equal(canManageAgent(root, meta(TEAM_AGENT)), true);
  assert.equal(visibleEnvironment(root, TEAM_ENV), true);
});

test('a stray membership in another team grants nothing here', () => {
  // Bob is a full Team Admin — of `other-squad`. Private-by-default means the
  // grant is per team, not a tier that leaks sideways.
  const bob = scopeFor('bob@corp.com', AFTER);
  assert.equal(canManageTeam(bob, 'other-squad'), true);
  assert.equal(canManageTeam(bob, 'squad'), false);
});

test('an unstamped environment is invisible to its own team — why the stamp exists', () => {
  // The pre-#2081 shape: no tier fields at all. Since #2078 removed the
  // `|| 'default'` fallback this reads as `teamId: null`, i.e. reachable by no
  // team — a System-Admin-only environment on the page where the team's own
  // repository and credentials are configured.
  const alice = scopeFor('alice@corp.com', AFTER);
  const unstamped = { id: 'squad' };
  assert.equal(visibleEnvironment(alice, unstamped), false);
  assert.equal(visibleEnvironment(scopeFor('root@corp.com', AFTER), unstamped), true);
});
