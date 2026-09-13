'use strict';

// The no-lockout proof for the #2077 D6 ownership migration (epic #2076).
// Run: node --test admin-console/api/ownership-no-lockout.test.js
//
// #2041 AC2 / concept §8.3 specify the property as a SET EQUALITY over the real
// predicates, not a spot check:
//
//   For every resource R and every user U:
//     visible_after(U, R)   ⊇ visible_before(U, R)
//     canManage_after(U, R) ⊇ canManage_before(U, R)
//
// `⊇` and not `=` is deliberate. The N×M fan-out means some users legitimately
// GAIN reach — a `team-admin` of an access scope becomes `team-admin` of each
// Agent Team in it, which is exactly what D6 asks for. LOSING any reach is the
// failure this test exists to catch.
//
// ── Why this test lives in admin-console/api/ ───────────────────────────────
// The migration planner is `orchestrator/ownership-migration.js` but the
// predicates it must not break are `admin-console/api/scope.js`, and the two
// ship in disjoint images. The property is only meaningful when the REAL
// predicates run over the REAL planner's output, so the test is filed with the
// predicates and requires across (the `skill-manifest.test.js` /
// `skill-import.test.js` precedent). Running the planner's own unit tests
// instead would prove the plan is shaped as intended and nothing about access.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeScope,
  visibleTeam,
  visibleAgent,
  canManageTeam,
  canManageAgent,
  canManageEnvironment,
  visibleEnvironment,
  visibleCredential,
  canManageCredential,
  resolveAgentTenant,
} = require('./scope');

const {
  planOwnerBackfill,
  planMembershipRepoint,
} = require('../../orchestrator/ownership-migration');

const ADMIN_USERNAME = 'admin';

// ── The before-fixture ─────────────────────────────────────────────────────
//
// Three access scopes, deliberately covering the three failure modes §8.3
// names, plus the N×M case the fan-out is defined by.

const users = [
  { id: 'u-ada', subject: 'ada@corp.com', systemAdmin: false },
  { id: 'u-bob', subject: 'bob@corp.com', systemAdmin: false },
  { id: 'u-cyd', subject: 'cyd@corp.com', systemAdmin: false },
  { id: 'u-sys', subject: 'sys@corp.com', systemAdmin: true },
  // FAILURE MODE 1 — a user with NO membership at all. Fail-closed today; the
  // migration must leave them fail-closed, not sweep them into a team.
  { id: 'u-nul', subject: 'nul@corp.com', systemAdmin: false },
];

const membershipsBefore = [
  { id: 'm1', userId: 'u-ada', teamId: 'default', role: 'team-admin', createdAt: '2026-01-02T00:00:00.000Z' },
  { id: 'm2', userId: 'u-bob', teamId: 'default', role: 'team-member', createdAt: '2026-01-03T00:00:00.000Z' },
  { id: 'm3', userId: 'u-cyd', teamId: 'risk', role: 'team-admin', createdAt: '2026-01-04T00:00:00.000Z' },
  // Ada also reaches 'payments' as a plain member — so a user holding two
  // different roles in two scopes is covered.
  { id: 'm4', userId: 'u-ada', teamId: 'payments', role: 'team-member', createdAt: '2026-01-05T00:00:00.000Z' },
];

// Agent configs. Scope 'default' holds TWO Agent Teams (the N×M case).
const configsBefore = {
  'sdlc-2-0': { id: 'sdlc-2-0', role: 'team', teamId: 'default' },
  'sdlc-2-0-dev': { id: 'sdlc-2-0-dev', role: 'team-member', teamId: 'default', parentTeamId: 'sdlc-2-0' },
  // FAILURE MODE 2 — a team-member whose stamped teamId DISAGREES with its
  // parent's (the state planTenantBackfill exists to fix). Its reach must not
  // change: `resolveAgentTenant` already makes the parent win.
  'sdlc-2-0-qa': { id: 'sdlc-2-0-qa', role: 'team-member', teamId: 'stale', parentTeamId: 'sdlc-2-0' },
  billing: { id: 'billing', role: 'team', teamId: 'default' },
  'billing-dev': { id: 'billing-dev', role: 'team-member', teamId: 'default', parentTeamId: 'billing' },
  'risk-squad': { id: 'risk-squad', role: 'team', teamId: 'risk' },
  scratch: { id: 'scratch', role: 'agent', teamId: 'risk' },
  // An Agent Team whose id coincides with an access-scope id — the coincidence
  // that made the two namespaces look interchangeable.
  payments: { id: 'payments', role: 'team', teamId: 'payments' },
  // An unstamped legacy agent: collapses to the default scope in both worlds.
  legacy: { id: 'legacy', role: 'agent' },
  // Post-#2229 (epic; #2234 decision), an ordinary standalone agent like
  // `scratch` no longer exists — this shape is now reached only by an
  // EPHEMERAL agent (`orchestrator/orchestrator.js`'s
  // `POST /internal/agents/ephemeral`, permanently excluded from the
  // team-of-one migration) or a malformed config. The owner-branch backfill
  // must not distinguish it from `scratch` — this fixture proves that,
  // alongside `scratch` rather than replacing it
  // (docs/decentralised-access-concept.md Amendment 10).
  ephemeral: { id: 'ephemeral', role: 'agent', ephemeral: true, teamId: 'risk' },
};

const environments = [
  { id: 'env-sdlc', teamId: 'default' },
  { id: 'env-risk', teamId: 'risk' },
  { id: 'env-unstamped' },
];

const credentials = [
  { id: 'cred-team-default', scope: 'team', teamId: 'default' },
  { id: 'cred-team-risk', scope: 'team', teamId: 'risk' },
  // FAILURE MODE 3 — a SYSTEM-tier credential assigned to several scopes. It
  // must stay reachable from every Agent Team of every assigned scope, or a
  // shared credential silently disappears.
  { id: 'cred-sys-multi', scope: 'system', assignedTeamIds: ['default', 'risk'] },
  { id: 'cred-sys-unassigned', scope: 'system', assignedTeamIds: [] },
  { id: 'cred-personal-ada', scope: 'personal', userId: 'u-ada' },
  { id: 'cred-personal-bob', scope: 'personal', userId: 'u-bob' },
];

// ── Applying the migration ─────────────────────────────────────────────────

// Apply both passes exactly as `migrateOwnershipModel` does in orchestrator.js:
// pass 1 stamps `ownerId` in place, pass 2 APPENDS the fanned-out memberships
// while the access-scope memberships stay (P1 changes no enforcement, which
// still keys on the resource stamps).
function applyMigration(configs, ms) {
  const after = {};
  for (const [id, cfg] of Object.entries(configs)) after[id] = { ...cfg };

  const { stamp } = planOwnerBackfill({ configs: after, users, memberships: ms });
  for (const s of stamp) {
    after[s.id].ownerId = s.ownerId;
    after[s.id].ownerSource = s.ownerSource;
  }

  const repoint = planMembershipRepoint({ configs: after, memberships: ms });
  const membershipsAfter = [
    ...ms,
    ...repoint.map((p, i) => ({
      id: `mig-${i}`,
      userId: p.userId,
      teamId: p.teamId,
      role: p.role,
      fromScopeId: p.fromScopeId,
      createdAt: '2026-09-08T00:00:00.000Z',
    })),
  ];
  return { configs: after, memberships: membershipsAfter, stamp, repoint };
}

const after = applyMigration(configsBefore, membershipsBefore);

// Every principal the installation has: the four named users, the never-granted
// one, and the env single-admin (whose username is not a user record at all).
const principals = [...users.map(u => u.subject), ADMIN_USERNAME];

function scopeFor(username, ms) {
  return computeScope({ username, adminUsername: ADMIN_USERNAME, users, memberships: ms });
}

// The full reach of one principal over the whole estate, as a set of
// `<predicate>:<resource>` strings. `resolveAgentTenant` is applied to agents
// exactly as `agentMetaForScope` does in api.js, so a team-member is judged on
// its resolved tenant and not its raw stamp.
function reach(username, configs, ms) {
  const scope = scopeFor(username, ms);
  const load = id => configs[id] || null;
  const out = new Set();

  for (const scopeId of ['default', 'risk', 'payments', 'stale', 'sdlc-2-0', 'billing', 'risk-squad']) {
    if (visibleTeam(scope, scopeId)) out.add(`visibleTeam:${scopeId}`);
    if (canManageTeam(scope, scopeId)) out.add(`canManageTeam:${scopeId}`);
  }
  for (const cfg of Object.values(configs)) {
    const resolved = { ...cfg, teamId: resolveAgentTenant(cfg, load) };
    if (visibleAgent(scope, resolved)) out.add(`visibleAgent:${cfg.id}`);
    if (canManageAgent(scope, resolved)) out.add(`canManageAgent:${cfg.id}`);
  }
  for (const env of environments) {
    if (visibleTeam(scope, env.teamId)) out.add(`visibleEnv:${env.id}`);
    if (canManageEnvironment(scope, env)) out.add(`canManageEnv:${env.id}`);
  }
  for (const cred of credentials) {
    if (visibleCredential(scope, cred)) out.add(`visibleCredential:${cred.id}`);
  }
  return out;
}

// ── The property (#2041 AC2, §8.3) ─────────────────────────────────────────

test('AC4 — no principal loses any reach over any resource (visible/canManage ⊇)', () => {
  for (const username of principals) {
    const before = reach(username, configsBefore, membershipsBefore);
    const now = reach(username, after.configs, after.memberships);
    const lost = [...before].filter(k => !now.has(k)).sort();
    assert.deepEqual(lost, [], `${username} lost reach: ${lost.join(', ')}`);
  }
});

test('AC4 — the assertion is not vacuous: the estate really is reachable before', () => {
  // A ⊇ check passes trivially against an empty "before". Pin that every
  // principal class actually reaches something, and that the cross-product is
  // the size the fixture describes.
  assert.ok(reach('ada@corp.com', configsBefore, membershipsBefore).size > 0);
  assert.ok(reach('cyd@corp.com', configsBefore, membershipsBefore).size > 0);
  // Option C (PR #2094): the pure env admin reaches nothing once seeded, so a
  // real System-Admin record stands in as the full-visibility principal here.
  assert.ok(reach('sys@corp.com', configsBefore, membershipsBefore).size > 0);
  // 6 principals × (7 teams×2 + 10 agents×2 + 3 envs×2 + 6 credentials) = every
  // pair is evaluated, so a silent fixture shrink is visible here.
  assert.equal(Object.keys(configsBefore).length, 10);
  assert.equal(principals.length, 6);
});

// ── #2083 (P5): adding the shared tier loses nobody any reach ──────────────
//
// P5 gives environments and MCP servers the tier they lacked. That is a change
// to the PREDICATES, not to the records — every environment on disk keeps its
// bare `teamId` — so the property to prove here is the mirror of the one above:
//
//   For every existing record R and every user U:
//     visible_tiered(U, R)   ⊇ visible_pre2083(U, R)
//     canManage_tiered(U, R) ⊇ canManage_pre2083(U, R)
//
// The "before" side has to be the LITERAL pre-#2083 predicates, reconstructed
// here, because the real ones have been replaced — reusing the new ones on both
// sides would compare a thing to itself and pass unconditionally.

// The two environment predicates exactly as they read on main before #2083.
const visibleEnvPre2083 = (scope, env) => visibleTeam(scope, env && env.teamId);
const canManageEnvPre2083 = (scope, env) => {
  if (!scope) return false;
  if (scope.all) return true;
  return canManageTeam(scope, env && env.teamId);
};

// Every environment/MCP-server shape that exists on disk today: a stamped one,
// one in a scope holding two Agent Teams, and the unstamped legacy record.
const untieredRecords = [
  { id: 'env-sdlc', teamId: 'default' },
  { id: 'env-risk', teamId: 'risk' },
  { id: 'env-pay', teamId: 'payments' },
  { id: 'env-unstamped' },
];

test('#2083 — the tier addition changes NO existing record for ANY principal', () => {
  for (const username of principals) {
    const scope = scopeFor(username, after.memberships);
    for (const rec of untieredRecords) {
      // Exact equality, not ⊇: this phase re-points nothing, so a record whose
      // reach MOVED at all would mean the tier had leaked a new grant in.
      assert.equal(
        visibleEnvironment(scope, rec), visibleEnvPre2083(scope, rec),
        `${username}: visibility of ${rec.id} moved`,
      );
      assert.equal(
        canManageEnvironment(scope, rec), canManageEnvPre2083(scope, rec),
        `${username}: manageability of ${rec.id} moved`,
      );
    }
  }
});

test('#2083 — that equality is not vacuous: the pre-#2083 predicates really do grant things', () => {
  const ada = scopeFor('ada@corp.com', after.memberships);
  const nul = scopeFor('nul@corp.com', after.memberships);
  const env = scopeFor('sys@corp.com', after.memberships); // Option C: the operator is a seeded System-Admin record, not the retired env admin
  // Ada is team-admin of the 'default' scope, so she both sees and manages it.
  assert.equal(visibleEnvPre2083(ada, { teamId: 'default' }), true);
  assert.equal(canManageEnvPre2083(ada, { teamId: 'default' }), true);
  // The never-granted user reaches none of it, and the operator reaches all.
  assert.equal(visibleEnvPre2083(nul, { teamId: 'default' }), false);
  assert.equal(visibleEnvPre2083(env, { teamId: 'risk' }), true);
  // And the two implementations are genuinely different code: a SHARED record
  // is the case where they diverge, which is the whole point of the phase.
  const shared = { id: 'env-shared', scope: 'system', assignedTeamIds: ['sdlc-2-0'] };
  assert.equal(visibleEnvPre2083(ada, shared), false, 'the old filter could not see a shared record');
  assert.equal(visibleEnvironment(ada, shared), true, 'the new one can');
});

test('#2083 — a shared record reaches exactly its assigned teams, measured over the real estate', () => {
  // Ada is team-admin of scope 'default', which P1 fanned out to BOTH Agent
  // Teams in it (sdlc-2-0 and billing). Cyd administers 'risk' only.
  const shared = { id: 'env-shared', scope: 'system', assignedTeamIds: ['sdlc-2-0'] };
  const reachOf = (u) => {
    const scope = scopeFor(u, after.memberships);
    return [visibleEnvironment(scope, shared), canManageEnvironment(scope, shared)];
  };
  assert.deepEqual(reachOf('ada@corp.com'), [true, true], 'fanned-out team-admin of an assigned team');
  assert.deepEqual(reachOf('bob@corp.com'), [true, false], 'fanned-out member: reads, cannot change');
  assert.deepEqual(reachOf('cyd@corp.com'), [false, false], 'admin of an unassigned team reaches nothing');
  assert.deepEqual(reachOf('nul@corp.com'), [false, false]);
  assert.deepEqual(reachOf('sys@corp.com'), [true, true]); // Option C: full visibility is the seeded System-Admin, not the retired env admin
});

test('#2083 — THE decisive case: promoting a two-team scope keeps its admin able to manage it', () => {
  // This is why `canManageEnvironment` does NOT copy `canManageCredential`'s
  // outright system-tier refusal. Scope 'default' holds two Agent Teams, so a
  // future re-point of `env-sdlc` cannot name one of them (A2.5) and must
  // promote it to the shared tier assigned to both. Under the credential rule
  // Ada — who manages it today — could not manage it afterwards, and that is a
  // manage-axis lockout §8.3 forbids.
  const ada = scopeFor('ada@corp.com', after.memberships);
  const before = { id: 'env-sdlc', teamId: 'default' };
  const promoted = { id: 'env-sdlc', scope: 'system', assignedTeamIds: ['sdlc-2-0', 'billing'] };

  assert.equal(canManageEnvPre2083(ada, before), true, 'premise: she manages it today');
  assert.equal(canManageEnvironment(ada, promoted), true, 'and still would after a promotion');
  assert.equal(visibleEnvironment(ada, promoted), true);
  // The counterfactual, so the claim is measured rather than asserted: the
  // credential rule applied to the same record DOES lose her the reach.
  assert.equal(canManageCredential(ada, promoted), false,
    'the credential system tier refuses outright — copying it would have been the lockout');
});

test('AC4 — a mutation that DOES lose reach is caught (the guard is real)', () => {
  // Prove the check fires: run the same comparison against a migration that
  // REPLACES the scope memberships instead of adding to them — the tempting
  // reading of §8.1, and the one that empties every list in P1.
  const replaced = after.memberships.filter(m => m.fromScopeId !== undefined);
  let sawLoss = false;
  for (const username of principals) {
    const before = reach(username, configsBefore, membershipsBefore);
    const now = reach(username, after.configs, replaced);
    if ([...before].some(k => !now.has(k))) sawLoss = true;
  }
  assert.equal(sawLoss, true, 'a replacing migration must be detected as a reach loss');
});

// ── The three failure modes, called out individually ───────────────────────

test('failure mode 1 — a user with no membership stays fail-closed', () => {
  const before = scopeFor('nul@corp.com', membershipsBefore);
  const now = scopeFor('nul@corp.com', after.memberships);
  assert.equal(before.all, false);
  assert.equal(now.all, false);
  assert.equal(now.teamIds.size, 0, 'the migration must not grant a membership-less user anything');
  assert.equal(reach('nul@corp.com', after.configs, after.memberships).size, 0);
});

test('failure mode 2 — a team-member with a drifted stamp keeps its reach', () => {
  // The parent wins in both worlds, so the drifted stamp never mattered.
  const load = id => after.configs[id] || null;
  assert.equal(resolveAgentTenant(configsBefore['sdlc-2-0-qa'], id => configsBefore[id] || null), 'default');
  assert.equal(resolveAgentTenant(after.configs['sdlc-2-0-qa'], load), 'default');
  for (const username of ['ada@corp.com', 'bob@corp.com']) {
    const now = reach(username, after.configs, after.memberships);
    assert.ok(now.has('visibleAgent:sdlc-2-0-qa'), `${username} must still see the drifted member`);
  }
  // And it gains no owner of its own — a member follows its team (D8).
  // Asserted over EVERY member, not just this one: the drifted member's scope
  // ('stale') has no members, so it would end up ownerless even if members were
  // wrongly made ownable — the assertion is only non-vacuous for a member whose
  // scope does resolve ('sdlc-2-0-dev', 'billing-dev').
  const members = Object.values(after.configs).filter(c => c.role === 'team-member');
  assert.equal(members.length, 3);
  assert.ok(
    members.some(c => resolveScopeOwnerIsResolvable(c)),
    'the fixture must contain a member whose own scope HAS an owner, or this is vacuous',
  );
  for (const m of members) {
    assert.equal('ownerId' in m, false, `${m.id} must carry no ownerId of its own (D8)`);
    assert.equal('ownerSource' in m, false, `${m.id} must carry no ownerSource of its own (D8)`);
  }
});

// Does this config's own `teamId` scope have a member the D6 rule could pick?
// Used only to keep the D8 assertion above honest.
function resolveScopeOwnerIsResolvable(cfg) {
  return membershipsBefore.some(m => m.teamId === (cfg.teamId || 'default'));
}

test('failure mode 3 — a multi-scope system credential stays reachable', () => {
  // Ada (admin of 'default') and Cyd (admin of 'risk') each reach it before and
  // after, through their own scope's assignment.
  for (const username of ['ada@corp.com', 'cyd@corp.com']) {
    assert.ok(reach(username, configsBefore, membershipsBefore).has('visibleCredential:cred-sys-multi'), username);
    assert.ok(reach(username, after.configs, after.memberships).has('visibleCredential:cred-sys-multi'), username);
  }
  // A plain member never could manage a system credential, and still cannot —
  // ⊇ must not be read as "everyone gains".
  assert.equal(reach('bob@corp.com', after.configs, after.memberships).has('visibleCredential:cred-sys-multi'), false);
});

test('the personal tier keeps its no-scope.all guarantee across the migration', () => {
  // Populating ownerId must not make a personal credential visible to an admin.
  for (const username of [ADMIN_USERNAME, 'sys@corp.com']) {
    const r = reach(username, after.configs, after.memberships);
    assert.equal(r.has('visibleCredential:cred-personal-ada'), false, username);
    assert.equal(r.has('visibleCredential:cred-personal-bob'), false, username);
  }
  assert.ok(reach('ada@corp.com', after.configs, after.memberships).has('visibleCredential:cred-personal-ada'));
  assert.equal(reach('ada@corp.com', after.configs, after.memberships).has('visibleCredential:cred-personal-bob'), false);
});

// ── What the migration produced (AC1/AC2/AC5/AC6) ──────────────────────────

test('AC5 — every team and standalone agent carries an owner afterwards', () => {
  for (const cfg of Object.values(after.configs)) {
    if (cfg.role !== 'team' && cfg.role !== 'agent') continue;
    assert.ok(cfg.ownerId, `${cfg.id} has no owner`);
    assert.equal(cfg.ownerSource, 'migration');
  }
  // The owner is the D6 pick for the resource's own scope, not a global default.
  assert.equal(after.configs['sdlc-2-0'].ownerId, 'u-ada');
  assert.equal(after.configs['risk-squad'].ownerId, 'u-cyd');
  assert.equal(after.configs.scratch.ownerId, 'u-cyd');
  assert.equal(after.configs.payments.ownerId, 'u-ada');
  assert.equal(after.configs.legacy.ownerId, 'u-ada'); // unstamped → default scope
  // #2234: the ephemeral-agent shape backfills identically to `scratch` — the
  // owner-branch code does not (and must not) branch on `ephemeral`.
  assert.equal(after.configs.ephemeral.ownerId, after.configs.scratch.ownerId);
});

test('AC2/AC3 — memberships now reference Agent Team ids, with roles preserved', () => {
  const agentTeamIds = new Set(
    Object.values(after.configs).filter(c => c.role === 'team').map(c => c.id),
  );
  const migrated = after.memberships.filter(m => m.fromScopeId !== undefined);
  assert.ok(migrated.length > 0);
  for (const m of migrated) {
    assert.ok(agentTeamIds.has(m.teamId), `${m.teamId} is not an Agent Team`);
    assert.ok(m.role === 'team-admin' || m.role === 'team-member');
    // The role is carried over from the scope grant, never upgraded.
    const source = membershipsBefore.find(s => s.userId === m.userId && s.teamId === m.fromScopeId);
    assert.equal(m.role, source.role);
  }
  // Ada is admin of scope 'default' → team-admin of BOTH its Agent Teams.
  const adaTeams = migrated.filter(m => m.userId === 'u-ada' && m.role === 'team-admin').map(m => m.teamId).sort();
  assert.deepEqual(adaTeams, ['billing', 'sdlc-2-0']);
});

test('AC6 — a second migration run is a complete no-op', () => {
  const second = applyMigration(after.configs, after.memberships);
  assert.deepEqual(second.stamp, [], 'no owner re-stamped');
  assert.deepEqual(second.repoint, [], 'no membership re-added');
  assert.equal(second.memberships.length, after.memberships.length);
  // And reach is bit-for-bit identical, so idempotence is a property of access
  // and not only of the plan arrays.
  for (const username of principals) {
    assert.deepEqual(
      [...reach(username, after.configs, after.memberships)].sort(),
      [...reach(username, second.configs, second.memberships)].sort(),
      username,
    );
  }
});
