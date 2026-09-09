'use strict';

// The enforcement proof for #2078 (P2 of epic #2076; concept
// `docs/decentralised-access-concept.md` D1/D5/D8, §4.1).
// Run: node --test admin-console/api/team-membership-enforcement.test.js
//
// #2077 proved the MIGRATION lost nobody reach. This proves the re-pointed
// ENFORCEMENT decides from Agent Team membership: it runs the real predicates
// over the real boundary accessor (`agent-team.js resolveAgentTeam`) for the
// full user × agent cross-product, and states each acceptance criterion as an
// assertion over the resulting sets rather than as a spot check.
//
// ── Why a cross-product and not per-predicate cases ────────────────────────
// scope.test.js already covers each predicate in isolation. What that cannot
// catch is a boundary that resolves correctly and is then compared against the
// wrong key space — the exact failure D1 introduces the opportunity for. Only
// running config → boundary → predicate end to end catches it, so this file
// starts from agent CONFIGS (what is on disk) rather than from the `{ teamId }`
// meta shapes the predicates take.

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeScope, visibleAgent, canManageAgent, visibleTeam, canManageTeam } = require('./scope');
const { resolveAgentTeam } = require('./agent-team');

const ADMIN_USERNAME = 'admin';

// ── Fixture: the installation as P1 leaves it ───────────────────────────────
//
// Two Agent Teams that were both stamped into the single legacy access scope
// 'default', so the P1 fan-out produced one Agent-Team membership per (user,
// team) pair ALONGSIDE the legacy scope grant. Keeping both is what makes the
// AC5 no-regression check below meaningful: the legacy grants are still there,
// and the point is that enforcement no longer consults them for agents.

const users = [
  { id: 'u-ada', subject: 'ada@corp.com' },   // team-admin of squad-alpha
  { id: 'u-bob', subject: 'bob@corp.com' },   // team-member of squad-alpha
  { id: 'u-cyd', subject: 'cyd@corp.com' },   // team-admin of squad-beta
  { id: 'u-nul', subject: 'nul@corp.com' },   // no membership at all
  { id: 'u-sys', subject: 'sys@corp.com', systemAdmin: true },
  // Option C (PR #2094): the env admin is a real seeded record once activated.
  { id: 'u-envadmin', subject: 'admin', systemAdmin: true },
];

const memberships = [
  // Legacy access-scope grants — still on disk, retired with the stamps they
  // gate (concept §8.3 / Amendment A1.2). Enforcement must NOT reach an agent
  // through these any more.
  { userId: 'u-ada', teamId: 'default', role: 'team-admin' },
  { userId: 'u-bob', teamId: 'default', role: 'team-member' },
  { userId: 'u-cyd', teamId: 'default', role: 'team-admin' },
  // The Agent Team grants P1 fanned out. Note cyd is a `default` team-admin but
  // is fanned out as team-admin of squad-beta ONLY in this fixture — which is
  // what lets the cross-team assertions below distinguish the two key spaces.
  { userId: 'u-ada', teamId: 'squad-alpha', role: 'team-admin' },
  { userId: 'u-bob', teamId: 'squad-alpha', role: 'team-member' },
  { userId: 'u-cyd', teamId: 'squad-beta', role: 'team-admin' },
];

const configs = {
  'squad-alpha':      { id: 'squad-alpha', role: 'team', teamId: 'default', ownerId: 'u-ada' },
  'squad-alpha-dev':  { id: 'squad-alpha-dev', role: 'team-member', teamId: 'default', parentTeamId: 'squad-alpha' },
  // A member whose own stamp drifted away from its parent's scope — the state
  // planTenantBackfill exists to repair. After D1 the parent id simply wins, so
  // the drift cannot influence access at all.
  'squad-alpha-qa':   { id: 'squad-alpha-qa', role: 'team-member', teamId: 'stale-scope', parentTeamId: 'squad-alpha' },
  'squad-beta':       { id: 'squad-beta', role: 'team', teamId: 'default', ownerId: 'u-cyd' },
  'squad-beta-dev':   { id: 'squad-beta-dev', role: 'team-member', teamId: 'default', parentTeamId: 'squad-beta' },
  // Standalone agents (D8): no squad, private to their owner.
  'ada-scratch':      { id: 'ada-scratch', role: 'agent', teamId: 'default', ownerId: 'u-ada' },
  'nul-scratch':      { id: 'nul-scratch', role: 'agent', teamId: 'default', ownerId: 'u-nul' },
  // An ownerless standalone — the migration could not resolve an owner for it
  // (D6 ends in "else unset"). It must be reachable by admins only.
  'orphan-scratch':   { id: 'orphan-scratch', role: 'agent', teamId: 'default' },
};

const AGENT_IDS = Object.keys(configs).sort();

// The api layer's `agentMetaForScope`, reproduced from its two ingredients so
// the test exercises the same composition production does.
function metaFor(id) {
  const cfg = configs[id];
  return { teamId: resolveAgentTeam(cfg), ownerId: cfg.ownerId };
}

function scopeFor(username, ms = memberships) {
  return computeScope({ username, adminUsername: ADMIN_USERNAME, users, memberships: ms });
}

function visibleSet(username, ms = memberships) {
  const s = scopeFor(username, ms);
  return AGENT_IDS.filter(id => visibleAgent(s, metaFor(id)));
}

function manageableSet(username, ms = memberships) {
  const s = scopeFor(username, ms);
  return AGENT_IDS.filter(id => canManageAgent(s, metaFor(id)));
}

// ── AC1 — a user sees exactly the agents of their Agent Teams ───────────────

test('AC1: visibility is exactly the caller\'s Agent Teams, plus their own standalone agents', () => {
  // ada: member of squad-alpha → its team + both members; plus her own scratch.
  assert.deepEqual(visibleSet('ada@corp.com'),
    ['ada-scratch', 'squad-alpha', 'squad-alpha-dev', 'squad-alpha-qa']);
  // bob: same team, plain member — D9 gives him the same READ set as ada minus
  // her private agent. Reading is not gated on the role.
  assert.deepEqual(visibleSet('bob@corp.com'),
    ['squad-alpha', 'squad-alpha-dev', 'squad-alpha-qa']);
  // cyd: the other squad only. This is the decisive assertion — cyd is a
  // team-admin of the legacy scope 'default' that BOTH squads are stamped into,
  // so reaching squad-alpha would mean enforcement still consults that stamp.
  assert.deepEqual(visibleSet('cyd@corp.com'), ['squad-beta', 'squad-beta-dev']);
  assert.equal(scopeFor('cyd@corp.com').roles.get('default'), 'team-admin',
    'fixture premise: the legacy grant that must NOT grant access is present');
  assert.equal(configs['squad-alpha'].teamId, 'default',
    'fixture premise: squad-alpha is still stamped with the scope cyd administers');
});

test('AC1 edge case: a user in NO team sees only their own standalone agents', () => {
  assert.deepEqual(visibleSet('nul@corp.com'), ['nul-scratch']);
  assert.deepEqual(manageableSet('nul@corp.com'), ['nul-scratch']);
  // An unknown subject has no identity at all and sees nothing — not even the
  // ownerless agent by a null === null match.
  assert.deepEqual(visibleSet('ghost@corp.com'), []);
});

test('AC1: a non-member sees none of a team\'s agents, by any route', () => {
  for (const username of ['cyd@corp.com', 'nul@corp.com']) {
    const seen = visibleSet(username);
    for (const id of ['squad-alpha', 'squad-alpha-dev', 'squad-alpha-qa']) {
      assert.equal(seen.includes(id), false, `${username} must not see ${id}`);
    }
  }
});

test('D8: a standalone agent is private to its owner; an ownerless one to admins alone', () => {
  for (const username of ['bob@corp.com', 'cyd@corp.com', 'nul@corp.com']) {
    assert.equal(visibleSet(username).includes('ada-scratch'), false);
  }
  // Ownerless + teamless fails closed for every non-admin (§8.4) — it does NOT
  // fall back into the default team, where all five users would have found it.
  for (const username of ['ada@corp.com', 'bob@corp.com', 'cyd@corp.com', 'nul@corp.com']) {
    assert.equal(visibleSet(username).includes('orphan-scratch'), false);
  }
  assert.equal(visibleSet('sys@corp.com').includes('orphan-scratch'), true);
});

test('the boundary comes from the parent, so a drifted member stamp cannot move an agent', () => {
  assert.equal(configs['squad-alpha-qa'].teamId, 'stale-scope',
    'fixture premise: the member disagrees with its parent');
  assert.equal(metaFor('squad-alpha-qa').teamId, 'squad-alpha');
  assert.equal(visibleSet('ada@corp.com').includes('squad-alpha-qa'), true);
  // Nobody holds a membership named 'stale-scope', and adding one grants nothing.
  const withStale = [...memberships, { userId: 'u-cyd', teamId: 'stale-scope', role: 'team-admin' }];
  assert.equal(visibleSet('cyd@corp.com', withStale).includes('squad-alpha-qa'), false);
});

// ── AC2 — team-admin manages their team's agents, team-member does not ──────

test('AC2: a team-admin manages exactly their own team\'s agents', () => {
  assert.deepEqual(manageableSet('ada@corp.com'),
    ['ada-scratch', 'squad-alpha', 'squad-alpha-dev', 'squad-alpha-qa']);
  assert.deepEqual(manageableSet('cyd@corp.com'), ['squad-beta', 'squad-beta-dev']);
});

test('AC2: a team-member manages nothing, while still seeing everything in the team', () => {
  assert.deepEqual(manageableSet('bob@corp.com'), []);
  assert.ok(visibleSet('bob@corp.com').length > 0, 'read access is unaffected (D9)');
});

// ── AC3 — the System-Admin bypass survives untouched (D5) ───────────────────

test('AC3: a System Admin and the env admin see and manage EVERY agent', () => {
  for (const username of ['sys@corp.com', ADMIN_USERNAME]) {
    assert.deepEqual(visibleSet(username), AGENT_IDS, `${username} list route`);
    assert.deepEqual(manageableSet(username), AGENT_IDS, `${username} mutation route`);
  }
  // …including on the team/environment gates, which is the other half of "one
  // list route and one mutation route" AC3 asks to be proven.
  const sys = scopeFor('sys@corp.com');
  assert.equal(visibleTeam(sys, 'squad-beta'), true);
  assert.equal(canManageTeam(sys, 'squad-beta'), true);
  assert.equal(visibleTeam(sys, undefined), true, 'the §8.4 fail-closed never applies to scope.all');
});

// ── AC5 — no regression for the single-team / default installation ──────────

test('AC5: on a single-team installation every caller keeps exactly the reach they had', () => {
  // One Agent Team in one scope: the shape this repository actually runs. Before
  // #2078 reach came from the 'default' scope grant; after, from the fanned-out
  // squad grant. The observable sets must be identical.
  const oneTeam = {
    'solo': { id: 'solo', role: 'team', teamId: 'default', ownerId: 'u-ada' },
    'solo-dev': { id: 'solo-dev', role: 'team-member', teamId: 'default', parentTeamId: 'solo' },
  };
  const ms = [
    { userId: 'u-ada', teamId: 'default', role: 'team-admin' },
    { userId: 'u-bob', teamId: 'default', role: 'team-member' },
    { userId: 'u-ada', teamId: 'solo', role: 'team-admin' },
    { userId: 'u-bob', teamId: 'solo', role: 'team-member' },
  ];
  const ids = Object.keys(oneTeam).sort();
  const meta = (id) => ({ teamId: resolveAgentTeam(oneTeam[id]), ownerId: oneTeam[id].ownerId });
  const scope = (u) => computeScope({ username: u, adminUsername: ADMIN_USERNAME, users, memberships: ms });

  assert.deepEqual(ids.filter(id => visibleAgent(scope('ada@corp.com'), meta(id))), ids);
  assert.deepEqual(ids.filter(id => canManageAgent(scope('ada@corp.com'), meta(id))), ids);
  assert.deepEqual(ids.filter(id => visibleAgent(scope('bob@corp.com'), meta(id))), ids);
  assert.deepEqual(ids.filter(id => canManageAgent(scope('bob@corp.com'), meta(id))), []);
  assert.deepEqual(ids.filter(id => visibleAgent(scope(ADMIN_USERNAME), meta(id))), ids);
});

test('AC5: dropping the legacy scope grants changes nothing — enforcement no longer reads them', () => {
  // The forward-compatibility half of AC5, and the thing that makes P5's
  // clean-up safe: with only the Agent Team grants left, every agent set above
  // is bit-for-bit the same. If this ever fails, some gate is still resolving an
  // agent through the retired access-scope layer.
  const agentTeamGrantsOnly = memberships.filter(m => m.teamId !== 'default');
  for (const username of ['ada@corp.com', 'bob@corp.com', 'cyd@corp.com', 'nul@corp.com', 'sys@corp.com', ADMIN_USERNAME]) {
    assert.deepEqual(visibleSet(username, agentTeamGrantsOnly), visibleSet(username), `${username} visible`);
    assert.deepEqual(manageableSet(username, agentTeamGrantsOnly), manageableSet(username), `${username} manageable`);
  }
});

// ── Edge case — revocation takes effect on the next request ─────────────────

test('an agent becomes invisible on the next request after its team grant is removed', () => {
  assert.equal(visibleSet('bob@corp.com').includes('squad-alpha-dev'), true);
  const revoked = memberships.filter(m => !(m.userId === 'u-bob' && m.teamId === 'squad-alpha'));
  // The scope is derived per request from the membership list, so there is no
  // cache to invalidate — but bob keeps his LEGACY 'default' grant, and that
  // must not keep the agent alive for him.
  assert.ok(revoked.some(m => m.userId === 'u-bob' && m.teamId === 'default'));
  assert.deepEqual(visibleSet('bob@corp.com', revoked), []);
  assert.deepEqual(manageableSet('bob@corp.com', revoked), []);
});
