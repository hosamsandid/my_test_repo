'use strict';

// Unit tests for resource scoping (#302).
// Run: node --test admin-console/api/scope.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  computeScope, visibleTeam, visibleAgent,
  canManageTeam, isTeamAdminOfAny, canManageAgent, canManageEnvironment, visibleUser, describeAuthz, isKnownPrincipal,
  normalizeCredential, visibleCredential, canManageCredential, canDeleteCredential,
  canCreateCredential, canReassignCredential, credentialVisibleToTeam, personalLendToTeam,
  canViewUsageStatistics, assistSelectableEndpoint, resolveAgentTenant,
  visibleEnvironment, canCreateEnvironment, canRetierEnvironment, ownsEnvironment,
} = require('./scope');
// #2158: the global reach for environments/MCP servers is composed at the
// api.js call sites, never inside scope.js itself (AC4) — imported here only
// to prove the composition against the exact shape scope.js's own predicate
// refuses (the "shared, assigned to zero teams" record).
const { isGlobalEnvironment } = require('./global-resource');

// `u-seed` is the seeded administrator (#2059): on every stack the configured
// initial user is a REAL record whose subject happens to be `admin`, so
// `username: 'admin'` resolves through the ordinary lookup like anybody else and
// carries a userId. Before #2059 that subject matched no record at all and was
// granted `all: true` by a branch of its own — which is the branch this ticket
// deleted, and why the tests below assert an id where they used to assert null.
const users = [
  { id: 'u-seed', subject: 'admin', systemAdmin: true },
  { id: 'u-sys', subject: 'sys@corp.com', systemAdmin: true },
  { id: 'u-a', subject: 'alice@corp.com' },
  { id: 'u-b', subject: 'bob@corp.com' },
  { id: 'u-c', subject: 'carol@corp.com' },
];
const memberships = [
  { userId: 'u-a', teamId: 'payments', role: 'team-admin' },
  { userId: 'u-a', teamId: 'default', role: 'team-member' },
  { userId: 'u-b', teamId: 'risk', role: 'team-member' },
  // #2078: a team-ADMIN of a team literally named 'default'. Without one, every
  // "the `|| 'default'` fallback is gone" assertion passes vacuously — the old
  // code would have denied these callers anyway for lack of the admin role.
  { userId: 'u-c', teamId: 'default', role: 'team-admin' },
];

test('the seeded administrator sees everything, and has a user id (#2059 AC6)', () => {
  const s = computeScope({ username: 'admin', users, memberships });
  assert.equal(s.all, true);
  assert.equal(visibleTeam(s, 'risk'), true);
  assert.equal(visibleTeam(s, 'anything'), true);
  // The point of #2059: full visibility now comes WITH an identity, so
  // preferences persist, personal credentials can be owned, and the audit
  // actor is resolvable. It used to be `all: true` with `userId: null`.
  assert.equal(s.userId, 'u-seed');
});

test('a subject named `admin` with NO user record fails closed (#2059)', () => {
  // The inverse of the deleted branch. `ADMIN_USERNAME` is a seed consumed at
  // first boot, not a name with standing: a session claiming that subject on a
  // stack where no such record exists must see nothing, exactly like any other
  // unknown subject. Before #2059 this exact input returned `all: true`.
  const withoutSeed = users.filter(u => u.subject !== 'admin');
  const s = computeScope({ username: 'admin', users: withoutSeed, memberships });
  assert.equal(s.all, false);
  assert.equal(s.userId, null);
  assert.equal(visibleTeam(s, 'default'), false);
  const a = describeAuthz({ username: 'admin', users: withoutSeed, memberships });
  assert.equal(a.admin, false);
  assert.equal(a.systemAdmin, false);
  // ...and it is therefore NOT a principal the IAP bridge may auto-login,
  // which is the #1415 hole the `envAdmin` flag would otherwise have kept open.
  assert.equal(isKnownPrincipal(a), false);
});

test('System-Admin user sees everything', () => {
  const s = computeScope({ username: 'sys@corp.com', users, memberships });
  assert.equal(s.all, true);
  assert.equal(visibleTeam(s, 'payments'), true);
});

test('team member sees only their teams', () => {
  const s = computeScope({ username: 'alice@corp.com', users, memberships });
  assert.equal(s.all, false);
  assert.deepEqual([...s.teamIds].sort(), ['default', 'payments']);
  assert.equal(visibleTeam(s, 'payments'), true);
  assert.equal(visibleTeam(s, 'default'), true);
  assert.equal(visibleTeam(s, 'risk'), false); // not a member
});

test('cross-team isolation: bob (risk) cannot see payments', () => {
  const s = computeScope({ username: 'bob@corp.com', users, memberships });
  assert.equal(visibleTeam(s, 'risk'), true);
  assert.equal(visibleTeam(s, 'payments'), false);
});

// ── D5: the System-Admin bypass census (#2078 AC3) ──────────────────────────
//
// The re-pointing keeps every `scope.all` short-circuit (concept §4.1: ten
// in-predicate ones plus two whole-predicate forms — twelve, none removed).
// A behavioural test cannot notice a bypass going missing from a predicate it
// does not exercise, and a missing bypass is a silent lock-out of the operator
// rather than a visible failure, so the count is pinned statically. Deliberately
// a floor, not an exact match: adding a predicate WITH a bypass is fine, losing
// one is not. `ownsPersonalCredential` deliberately has none (§2.2) — the three
// bypass-free predicates are named so a reader knows the omission is the design.
test('D5: every scope.all bypass survives the re-pointing', () => {
  const src = fs.readFileSync(path.join(__dirname, 'scope.js'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const shortCircuits = (src.match(/^\s*if \(scope\.all\) return true;$/gm) || []).length;
  const wholePredicates = (src.match(/return !!\(scope && scope\.all\);/g) || []).length;
  assert.ok(shortCircuits >= 10, `expected >=10 scope.all short-circuits, found ${shortCircuits}`);
  assert.ok(wholePredicates >= 2, `expected >=2 whole-predicate scope.all forms, found ${wholePredicates}`);

  // And the ones that must NOT gain one: a personal record is stronger than D5
  // (§2.2), and the rest take no caller scope at all.
  //
  // #2083 moved the personal-tier rule and the normalizer into resource-tier.js,
  // so the guard follows them there rather than checking the alias left behind:
  // asserting over a one-line re-export would have been vacuous the moment the
  // real predicate stopped living in this file. Both sources are swept.
  const tierSrc = fs.readFileSync(path.join(__dirname, 'resource-tier.js'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const bodyOf = (name) => {
    for (const [where, text] of [['scope.js', src], ['resource-tier.js', tierSrc]]) {
      const at = text.indexOf(`function ${name}(`);
      if (at === -1) continue;
      let depth = 0;
      for (let i = text.indexOf('{', at); i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) return { where, body: text.slice(at, i + 1) };
      }
      throw new Error(`unbalanced braces in ${name} (${where})`);
    }
    throw new assert.AssertionError({ message: `${name} must still exist in scope.js or resource-tier.js` });
  };
  for (const name of ['ownsPersonalTier', 'credentialVisibleToTeam', 'ownedByCaller', 'tierUsableByTeam']) {
    assert.doesNotMatch(bodyOf(name).body, /scope\.all/, `${name} must carry no admin bypass`);
  }
  // The two aliases really are the shared implementations, not forks of it —
  // otherwise the sweep above would be guarding a predicate nothing calls.
  assert.match(src, /const ownsPersonalCredential = ownsPersonalTier;/);
  assert.match(src, /const normalizeCredential = normalizeTier;/);
  // The personal tier is checked BEFORE the admin shortcut in every predicate
  // that has one. A `scope.all` line ahead of the personal branch would be the
  // silent way to lose #1567 D2, and it reads as correct code.
  for (const name of ['visibleCredential', 'canManageCredential', 'canCreateCredential',
                      'visibleEnvironment', 'canManageEnvironment', 'canCreateEnvironment']) {
    const { body } = bodyOf(name);
    const personalAt = body.search(/TIER_PERSONAL|'personal'/);
    const adminAt = body.indexOf('if (scope.all) return true;');
    assert.ok(personalAt !== -1, `${name} must handle the personal tier`);
    assert.ok(adminAt !== -1, `${name} must keep its scope.all bypass`);
    assert.ok(personalAt < adminAt, `${name}: the personal tier must be checked before scope.all`);
  }
});

test('#2078/§8.4: a resource with no teamId is invisible, it does NOT collapse to the default team', () => {
  // Alice IS a member of a team called 'default'. Before #2078 that made every
  // unowned resource in the installation visible to her through the `||
  // 'default'` fallback; with the access-scope layer collapsing, a team may be
  // created with that slug and the fallback becomes a real leak.
  const s = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(s.teamIds.has('default'), true, 'fixture premise: the fallback had a referent for alice');
  assert.equal(visibleTeam(s, undefined), false);
  assert.equal(visibleTeam(s, null), false);
  assert.equal(visibleTeam(s, ''), false);
  // Still fully visible to an admin — the fallback removal narrows non-admins only (D5).
  const sys = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  assert.equal(visibleTeam(sys, undefined), true);
});

test('unknown subject fails closed', () => {
  const s = computeScope({ username: 'ghost@corp.com', users, memberships });
  assert.equal(s.all, false);
  assert.equal(visibleTeam(s, 'default'), false);
});

test('no username fails closed', () => {
  const s = computeScope({ username: undefined, users, memberships });
  assert.equal(s.all, false);
});

test('visibleAgent: an agent WITH a team boundary is decided by membership alone (#2078 / D9)', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(visibleAgent(alice, { teamId: 'payments' }), true);
  // out-of-team agent never visible
  assert.equal(visibleAgent(alice, { teamId: 'risk' }), false);
  // The retired `visibility` field no longer gates anything: an in-team agent
  // owned by someone else stays visible (D9 — a member may read and chat), and
  // the string 'private' is inert rather than a hidden opt-in.
  assert.equal(visibleAgent(alice, { teamId: 'payments', ownerId: 'u-b' }), true);
  assert.equal(visibleAgent(alice, { teamId: 'payments', visibility: 'private', ownerId: 'u-b' }), true);
  // ...and out-of-team stays invisible even when alice owns it — the boundary wins.
  assert.equal(visibleAgent(alice, { teamId: 'risk', ownerId: 'u-a' }), false);
});

test('visibleAgent: an agent with NO team boundary is owner-only (#2078 / D8)', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(visibleAgent(alice, { teamId: null, ownerId: 'u-a' }), true);
  assert.equal(visibleAgent(alice, { teamId: null, ownerId: 'u-b' }), false);
  // Ownerless and teamless → nobody but an admin (§8.4 fail-closed).
  assert.equal(visibleAgent(alice, { teamId: null }), false);
});

test('visibleAgent: a caller with no user identity never matches the owner rule', () => {
  // The env single-admin has `userId: null`; so does an unknown subject. Neither
  // may be allowed to match an ownerless resource by null === null.
  const ghost = computeScope({ username: 'ghost@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(ghost.userId, null);
  assert.equal(visibleAgent(ghost, { teamId: null, ownerId: null }), false);
  assert.equal(visibleAgent(ghost, { teamId: null }), false);
});

test('visibleAgent: admin sees agents of every team and every owner (D5)', () => {
  const sys = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  assert.equal(visibleAgent(sys, { teamId: 'risk', ownerId: 'u-b' }), true);
  assert.equal(visibleAgent(sys, { teamId: null, ownerId: 'u-b' }), true);
});

// ── Admin-surface scoping & gating (#584) ──────────────────────────────────

test('computeScope records per-team roles for non-admins', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  assert.equal(alice.roles.get('payments'), 'team-admin');
  assert.equal(alice.roles.get('default'), 'team-member');
  assert.equal(alice.roles.has('risk'), false);
});

test('canManageTeam: admin manages any team', () => {
  const seeded = computeScope({ username: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  assert.equal(canManageTeam(seeded, 'risk'), true);
  assert.equal(canManageTeam(sys, 'anything'), true);
});

test('canManageTeam: team-admin manages only their admin team', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  assert.equal(canManageTeam(alice, 'payments'), true);  // team-admin
  assert.equal(canManageTeam(alice, 'default'), false);  // only a member
  assert.equal(canManageTeam(alice, 'risk'), false);     // not a member
});

test('canManageTeam: team-member manages nothing', () => {
  const bob = computeScope({ username: 'bob@corp.com', users, memberships });
  assert.equal(canManageTeam(bob, 'risk'), false);
});

// #2307: the floor permission for writing into the global skill pool — Team
// Admin of ANY team, not one named team. Distinct from canManageTeam, which
// only ever answers for one specific team.
test('isTeamAdminOfAny: admin is always any-team-admin, without needing a role map', () => {
  const seeded = computeScope({ username: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  assert.equal(isTeamAdminOfAny(seeded), true);
  assert.equal(isTeamAdminOfAny(sys), true);
});

test('isTeamAdminOfAny: true for a Team Admin of at least one team, even if not of every team they belong to', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships }); // team-admin of payments, member of default
  assert.equal(isTeamAdminOfAny(alice), true);
});

test('isTeamAdminOfAny: false for a plain team-member of every team they belong to', () => {
  const bob = computeScope({ username: 'bob@corp.com', users, memberships }); // team-member of risk only
  assert.equal(isTeamAdminOfAny(bob), false);
});

test('canManageTeam: a missing teamId fails closed, it does not collapse to default (#2078/§8.4)', () => {
  // Sharper than the pre-#2078 version, which passed for the wrong reason:
  // alice is only a *member* of 'default', so the old fallback denied her
  // anyway. Carol IS team-admin of 'default' — under the fallback she would
  // have managed every unowned resource in the installation.
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageTeam(alice, undefined), false);
  const carol = computeScope({ username: 'carol@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(carol.roles.get('default'), 'team-admin', 'fixture premise: the fallback had a referent');
  assert.equal(canManageTeam(carol, 'default'), true);
  assert.equal(canManageTeam(carol, undefined), false);
  assert.equal(canManageTeam(carol, null), false);
  assert.equal(canManageTeam(carol, ''), false);
});

test('visibleUser: non-admin sees only users sharing a team', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  assert.equal(visibleUser(alice, 'u-a', memberships), true);  // self
  assert.equal(visibleUser(alice, 'u-b', memberships), false); // bob is risk-only
  const sys = computeScope({ username: 'admin', users, memberships });
  assert.equal(visibleUser(sys, 'u-b', memberships), true);    // admin sees all
});

test('visibleUser: zero-team caller sees no user (fail-closed)', () => {
  const ghostUsers = [...users, { id: 'u-lonely', subject: 'lonely@corp.com' }];
  const s = computeScope({ username: 'lonely@corp.com', users: ghostUsers, memberships });
  assert.equal(visibleUser(s, 'u-lonely', memberships), false);
  assert.equal(visibleUser(s, 'u-a', memberships), false);
});

test('describeAuthz: the seeded administrator is an ordinary System Admin', () => {
  const a = describeAuthz({ username: 'admin', users, memberships });
  assert.equal(a.admin, true);
  assert.equal(a.systemAdmin, true, 'it IS a System-Admin record — not a special case');
  assert.equal(a.userId, 'u-seed');
  assert.deepEqual(a.teams, [], 'global visibility comes from the flag, not memberships');
  // Option C (PR #2094) restored the `envAdmin` flag but gated it on the pre-seed
  // state. Here a System-Admin record exists (`u-seed`), so for the same subject
  // the flag is FALSE — the operator is admitted as the real record, not the env
  // admin, which is exactly what keeps the #1415 IAP hole closed post-seed.
  assert.equal(a.envAdmin, false, 'seeded → the env-admin flag is false (real record, not the env admin)');
});

test('describeAuthz: System-Admin user', () => {
  const a = describeAuthz({ username: 'sys@corp.com', users, memberships });
  assert.equal(a.admin, true);
  assert.equal(a.systemAdmin, true);
  assert.equal(a.userId, 'u-sys');
});

test('describeAuthz: team user carries per-team roles', () => {
  const a = describeAuthz({ username: 'alice@corp.com', users, memberships });
  assert.equal(a.admin, false);
  assert.equal(a.systemAdmin, false);
  assert.equal(a.userId, 'u-a');
  const byTeam = Object.fromEntries(a.teams.map(t => [t.teamId, t.role]));
  assert.deepEqual(byTeam, { payments: 'team-admin', default: 'team-member' });
});

test('describeAuthz: unknown subject fails closed', () => {
  const a = describeAuthz({ username: 'ghost@corp.com', users, memberships });
  assert.equal(a.admin, false);
  assert.equal(a.systemAdmin, false);
  assert.deepEqual(a.teams, []);
});

test('describeAuthz: chatFontSize surfaces the caller\'s own preference (#1437)', () => {
  const withPref = [
    { id: 'u-a', subject: 'alice@corp.com', chatFontSize: 16 },
    { id: 'u-b', subject: 'bob@corp.com' }, // no preference → default
  ];
  const alice = describeAuthz({ username: 'alice@corp.com', users: withPref, memberships: [] });
  assert.equal(alice.chatFontSize, 16);
  const bob = describeAuthz({ username: 'bob@corp.com', users: withPref, memberships: [] });
  assert.equal(bob.chatFontSize, 12); // default when unset
});

test('describeAuthz: chatNotifyOnBack surfaces the caller\'s own opt-in, off by default (#2397)', () => {
  const withPref = [
    { id: 'u-a', subject: 'alice@corp.com', chatNotifyOnBack: true },
    { id: 'u-b', subject: 'bob@corp.com' }, // unset → off
  ];
  const alice = describeAuthz({ username: 'alice@corp.com', users: withPref, memberships: [] });
  assert.equal(alice.chatNotifyOnBack, true);
  const bob = describeAuthz({ username: 'bob@corp.com', users: withPref, memberships: [] });
  assert.equal(bob.chatNotifyOnBack, false); // off when unset
  // The recordless env admin (unknown subject) is off too.
  const stranger = describeAuthz({ username: 'nobody@corp.com', users: withPref, memberships: [] });
  assert.equal(stranger.chatNotifyOnBack, false);
});

test('describeAuthz: a record with no stored preference gets the 12px default (#1437)', () => {
  // The seeded administrator is such a record — and, unlike the recordless env
  // admin it replaced, its preference now actually persists (#2059 AC6).
  const a = describeAuthz({ username: 'admin', users, memberships });
  assert.equal(a.chatFontSize, 12);
});

test('isKnownPrincipal: a registered user record, fail-closed otherwise (#1415)', () => {
  assert.equal(isKnownPrincipal({ userId: 'u1' }), true);
  assert.equal(isKnownPrincipal({ userId: null }), false);
  // Option C (PR #2094): the env-admin arm is admitted again, but describeAuthz
  // only PRODUCES envAdmin:true pre-seed (gated on the System-Admin record), so a
  // bare `{ envAdmin: true }` represents the pre-seed bootstrap and is admitted.
  // The #1415 hole is closed one level up (post-seed → describeAuthz yields
  // envAdmin:false), asserted in the composed block below.
  assert.equal(isKnownPrincipal({ envAdmin: true, userId: null }), true);
  assert.equal(isKnownPrincipal({ admin: true, userId: null }), false, 'the admin flag alone is neither envAdmin nor a userId');
  assert.equal(isKnownPrincipal({}), false);
  assert.equal(isKnownPrincipal(null), false);
  assert.equal(isKnownPrincipal(undefined), false);

  // Composed through describeAuthz — the production IAP-gate path.
  const authz = (username, u = users) => describeAuthz({ username, users: u, memberships });
  assert.equal(isKnownPrincipal(authz('alice@corp.com')), true);  // registered, memberships
  assert.equal(isKnownPrincipal(authz('ALICE@corp.com')), true);  // subject match is case-insensitive
  assert.equal(isKnownPrincipal(authz('sys@corp.com')), true);    // registered System Admin
  assert.equal(isKnownPrincipal(authz('admin')), true);           // the seeded admin record (u-seed)
  assert.equal(isKnownPrincipal(authz('ghost@corp.com')), false); // stranger
  assert.equal(isKnownPrincipal(authz('alice@corp.com', [])), false); // degraded users-index read → unknown

  // Option C (PR #2094) — the pre-seed window and its post-seed closure:
  //  • fresh install (no System-Admin record): the env admin bootstraps in;
  const preSeed = describeAuthz({ username: 'admin', adminUsername: 'admin', users: [], memberships: [] });
  assert.equal(preSeed.envAdmin, true, 'fresh install: describeAuthz flags the env admin');
  assert.equal(isKnownPrincipal(preSeed), true, 'fresh install: the env admin is admitted to bootstrap');
  //  • once seeded, an identity merely NAMED as the admin with no record is
  //    refused — describeAuthz gates envAdmin off, so #1415 stays closed.
  const postSeed = describeAuthz({ username: 'nobody@corp.com', adminUsername: 'nobody@corp.com', users, memberships });
  assert.equal(postSeed.envAdmin, false, 'seeded: the env-admin flag is off for a no-record claim');
  assert.equal(isKnownPrincipal(postSeed), false, 'seeded: a bare admin-named claim is refused (#1415)');
});

test('describeAuthz: surfaces the caller\'s own githubHandle (#1385)', () => {
  const withHandle = [
    { id: 'u-a', subject: 'alice@corp.com', githubHandle: 'alice-gh' },
    { id: 'u-b', subject: 'bob@corp.com' }, // no handle set
  ];
  const alice = describeAuthz({ username: 'alice@corp.com', users: withHandle, memberships });
  assert.equal(alice.githubHandle, 'alice-gh');
  // A user with no handle set reports the empty string, not undefined.
  const bob = describeAuthz({ username: 'bob@corp.com', users: withHandle, memberships });
  assert.equal(bob.githubHandle, '');
  // A subject with no record at all (this fixture has no `admin` record)
  // reports the empty string too.
  const admin = describeAuthz({ username: 'admin', users: withHandle, memberships });
  assert.equal(admin.githubHandle, '');
});

// ── Credentials scope & management gate (#798) ─────────────────────────────
// alice = team-admin of 'payments', team-member of 'default'.
// bob   = team-member of 'risk'. sys = System Admin. admin = env admin.

test('normalizeCredential: legacy entry (no scope) is team-scoped by teamId', () => {
  assert.deepEqual(normalizeCredential({ id: 'k', teamId: 'payments' }),
    { id: 'k', scope: 'team', teamId: 'payments', assignedTeamIds: [] });
  // #2078/§8.4: no `|| 'default'` collapse. Every index entry is stamped by the
  // orchestrator's boot-time adoption pass, so an entry that still has no team
  // is one no team owns — it must fail closed, not land in the default team's lap.
  assert.equal(normalizeCredential({ id: 'k' }).teamId, null);
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(visibleCredential(alice, { id: 'k' }), false);
  assert.equal(canManageCredential(alice, { id: 'k' }), false);
});

test('normalizeCredential: system entry keeps assignedTeamIds, drops teamId', () => {
  const n = normalizeCredential({ id: 'k', scope: 'system', assignedTeamIds: ['payments', 'payments', 'risk'] });
  assert.equal(n.scope, 'system');
  assert.equal(n.teamId, null);
  assert.deepEqual(n.assignedTeamIds, ['payments', 'risk']);
});

test('visibleCredential: team-admin sees own team-scoped + system assigned to their team', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  assert.equal(visibleCredential(alice, { scope: 'team', teamId: 'payments' }), true);   // owns
  assert.equal(visibleCredential(alice, { scope: 'team', teamId: 'risk' }), false);       // other team
  assert.equal(visibleCredential(alice, { teamId: 'default' }), false);                   // only a member of default, not admin
  assert.equal(visibleCredential(alice, { scope: 'system', assignedTeamIds: ['payments'] }), true);  // assigned to her team
  assert.equal(visibleCredential(alice, { scope: 'system', assignedTeamIds: ['risk'] }), false);     // not assigned
  assert.equal(visibleCredential(alice, { scope: 'system', assignedTeamIds: [] }), false);           // unassigned → sysadmin-only
});

test('visibleCredential: any System Admin sees everything', () => {
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  const seeded = computeScope({ username: 'admin', users, memberships });
  assert.equal(visibleCredential(sys, { scope: 'system', assignedTeamIds: [] }), true);
  assert.equal(visibleCredential(seeded, { scope: 'team', teamId: 'risk' }), true);
});

test('visibleCredential: plain team-member sees no credentials (access deferred)', () => {
  const bob = computeScope({ username: 'bob@corp.com', users, memberships });
  assert.equal(visibleCredential(bob, { scope: 'team', teamId: 'risk' }), false);
  assert.equal(visibleCredential(bob, { scope: 'system', assignedTeamIds: ['risk'] }), false);
});

// ── assistSelectableEndpoint (#1210) — selection visibility, NOT management ──

test('assistSelectableEndpoint: plain team-member CAN select their team providers (unlike visibleCredential)', () => {
  const bob = computeScope({ username: 'bob@corp.com', users, memberships }); // team-member of risk
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
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  const env = computeScope({ username: 'admin', users, memberships });
  const bob = computeScope({ username: 'bob@corp.com', users, memberships });
  assert.equal(assistSelectableEndpoint(sys, { authType: 'oauth-token', scope: 'system', assignedTeamIds: [] }), false);
  assert.equal(assistSelectableEndpoint(env, { authType: 'oauth-token', scope: 'team', teamId: 'risk' }), false);
  assert.equal(assistSelectableEndpoint(bob, { authType: 'oauth-token', scope: 'team', teamId: 'risk' }), false);
});

test('assistSelectableEndpoint: scope.all (any System Admin) selects any non-oauth provider', () => {
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  const env = computeScope({ username: 'admin', users, memberships });
  assert.equal(assistSelectableEndpoint(sys, { authType: 'api-key', scope: 'system', assignedTeamIds: [] }), true);
  assert.equal(assistSelectableEndpoint(env, { authType: 'api-key', scope: 'team', teamId: 'risk' }), true);
});

test('assistSelectableEndpoint: pre-#800 legacy record (no scope) is team-scoped via normalizeCredential', () => {
  const bob = computeScope({ username: 'bob@corp.com', users, memberships }); // risk member
  // Legacy entry carries only teamId, no scope → treated as team-scoped owned by that team.
  assert.equal(assistSelectableEndpoint(bob, { authType: 'api-key', teamId: 'risk' }), true);
  assert.equal(assistSelectableEndpoint(bob, { authType: 'api-key', teamId: 'payments' }), false);
  // #2078/§8.4: a record with no teamId at all no longer collapses into the
  // default team — it is selectable by nobody but a full-visibility admin.
  const inDefault = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships }); // member of default
  assert.equal(assistSelectableEndpoint(inDefault, { authType: 'api-key' }), false);
  const sys = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  assert.equal(assistSelectableEndpoint(sys, { authType: 'api-key' }), true);
});

test('assistSelectableEndpoint: fail-closed on missing scope/endpoint', () => {
  assert.equal(assistSelectableEndpoint(null, { authType: 'api-key', scope: 'team', teamId: 'risk' }), false);
  const bob = computeScope({ username: 'bob@corp.com', users, memberships });
  assert.equal(assistSelectableEndpoint(bob, null), false);
});

// ── Global model providers (#2136) ─────────────────────────────────────────
// A `global` provider is reachable by EVERY user and EVERY agent with no team
// assignment at all — the "usable by all, assigned to nobody" case the shared
// tier could not express. Publishing one is a System-Admin act (enforced at the
// route); access opens to everyone. It never leaks its token (maskLlmEndpoint)
// and stays management-closed to non-admins (canManageCredential unchanged).

// A user in NO team at all — the case the ticket is about (teams retired).
const loneUsers = [...users, { id: 'u-d', subject: 'dave@corp.com' }];

test('visibleCredential: the generic predicate carries NO global bypass — a `global` flag never widens reach here (#2136 finding 2)', () => {
  // `visibleCredential` ALSO gates SSH keys and GitHub tokens (api.js GET
  // /api/ssh-keys, GET /api/github-tokens), so a stray `global: true` on ANY
  // credential shape must stay inert here — the blast radius of a leak is a
  // secret. Global MODEL-PROVIDER reachability is added only at the provider call
  // sites (api.js `providerVisible`, composing `isGlobalProvider`), never in this
  // generic predicate. So the flag changes nothing about what this answers.
  const bob = computeScope({ username: 'bob@corp.com', users: loneUsers, memberships }); // member of risk only
  const dave = computeScope({ username: 'dave@corp.com', users: loneUsers, memberships }); // no team
  assert.equal(dave.all, false);
  assert.equal(dave.teamIds.size, 0, 'fixture premise: dave is in no team');
  // With OR without the flag, a system-unassigned record is invisible to a
  // non-admin — an SSH key carrying `global: true` therefore stays gated.
  assert.equal(visibleCredential(dave, { scope: 'system', assignedTeamIds: [], global: true }), false);
  assert.equal(visibleCredential(bob, { scope: 'system', assignedTeamIds: [], global: true }), false);
  assert.equal(visibleCredential(dave, { scope: 'system', assignedTeamIds: [] }), false);
  // A System Admin still sees it (via scope.all), exactly like any system record.
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  assert.equal(visibleCredential(sys, { scope: 'system', assignedTeamIds: [], global: true }), true);
});

test('credentialVisibleToTeam: the generic predicate carries NO global bypass (#2136 finding 2)', () => {
  // Same guard for the team-usability predicate usableEndpointsForTeam and the
  // env-orphan check build on: the raw `global` flag does not make a record
  // usable by an unassigned team HERE — the provider call site composes the
  // provider-specific rule, and an SSH key never reaches that path.
  assert.equal(credentialVisibleToTeam({ scope: 'system', assignedTeamIds: [], global: true }, 'payments'), false);
  assert.equal(credentialVisibleToTeam({ scope: 'system', assignedTeamIds: [], global: true }, undefined), false);
  // A non-global system-unassigned provider is likewise usable by no team.
  assert.equal(credentialVisibleToTeam({ scope: 'system', assignedTeamIds: [] }, 'payments'), false);
  // The ordinary tenant match still works for an assigned system record.
  assert.equal(credentialVisibleToTeam({ scope: 'system', assignedTeamIds: ['payments'] }, 'payments'), true);
});

test('assistSelectableEndpoint: a global provider is selectable by a user in no team (AC2)', () => {
  const dave = computeScope({ username: 'dave@corp.com', users: loneUsers, memberships });
  assert.equal(assistSelectableEndpoint(dave, { authType: 'api-key', scope: 'system', assignedTeamIds: [], global: true }), true);
  // Global never overrides the oauth-token exclusion — a subscription seat is
  // single-user and is never billable here, so it can never be global (edge case).
  assert.equal(assistSelectableEndpoint(dave, { authType: 'oauth-token', scope: 'system', assignedTeamIds: [], global: true }), false);
});

test('global never overrides the personal-tier privacy (fail closed)', () => {
  // A hand-edited personal+global record must not leak to everyone: personal is
  // stronger than global, so only its owner sees it.
  const dave = computeScope({ username: 'dave@corp.com', users: loneUsers, memberships });
  assert.equal(visibleCredential(dave, { scope: 'personal', userId: 'u-a', global: true }), false);
  assert.equal(credentialVisibleToTeam({ scope: 'personal', userId: 'u-a', global: true }, 'payments'), false);
});

test('canManageCredential/canCreateCredential: a global (system) provider stays System-Admin-only (AC5)', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships }); // team-admin of payments
  const dave = computeScope({ username: 'dave@corp.com', users: loneUsers, memberships });
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  const globalEp = { scope: 'system', assignedTeamIds: [], global: true };
  assert.equal(canManageCredential(alice, globalEp), false);
  assert.equal(canManageCredential(dave, globalEp), false);
  assert.equal(canManageCredential(sys, globalEp), true);
  // Non-admins cannot create a system/global provider; a System Admin can.
  assert.equal(canCreateCredential(alice, { scope: 'system', assignedTeamIds: [] }), false);
  assert.equal(canCreateCredential(sys, { scope: 'system', assignedTeamIds: [] }), true);
});

test('canManageCredential: team-admin manages own team creds, never system creds', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  assert.equal(canManageCredential(alice, { scope: 'team', teamId: 'payments' }), true);
  assert.equal(canManageCredential(alice, { scope: 'team', teamId: 'risk' }), false);
  assert.equal(canManageCredential(alice, { scope: 'system', assignedTeamIds: ['payments'] }), false); // AC5
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  assert.equal(canManageCredential(sys, { scope: 'system', assignedTeamIds: [] }), true);
});

test('canCreateCredential: team-admin only team-scoped for own team; system is sysadmin-only', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  assert.equal(canCreateCredential(alice, { scope: 'team', teamId: 'payments' }), true);
  assert.equal(canCreateCredential(alice, { scope: 'team', teamId: 'risk' }), false);
  assert.equal(canCreateCredential(alice, { scope: 'system', assignedTeamIds: ['payments'] }), false); // AC6
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  assert.equal(canCreateCredential(sys, { scope: 'system', assignedTeamIds: ['payments'] }), true);
});

test('canReassignCredential: System Admins only (AC7)', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
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
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  const bob = computeScope({ username: 'bob@corp.com', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  const env = computeScope({ username: 'admin', users, memberships });
  const aliceCred = { scope: 'personal', userId: 'u-a' };
  assert.equal(visibleCredential(alice, aliceCred), true);   // owner
  assert.equal(visibleCredential(bob, aliceCred), false);    // another member
  assert.equal(visibleCredential(sys, aliceCred), false);    // System Admin — NO scope.all bypass
  assert.equal(visibleCredential(env, aliceCred), false);    // the seeded admin is no exception either
  // An owner-less personal credential is visible to nobody (fail-closed).
  assert.equal(visibleCredential(alice, { scope: 'personal' }), false);
});

test('canManageCredential: only the owner manages a personal credential; scope.all denied (AC4)', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  const bob = computeScope({ username: 'bob@corp.com', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  const env = computeScope({ username: 'admin', users, memberships });
  const aliceCred = { scope: 'personal', userId: 'u-a' };
  assert.equal(canManageCredential(alice, aliceCred), true);
  assert.equal(canManageCredential(bob, aliceCred), false);
  assert.equal(canManageCredential(sys, aliceCred), false);  // System Admin cannot manage a foreign personal cred
  assert.equal(canManageCredential(env, aliceCred), false);  // nor can the seeded administrator
});

test('canDeleteCredential: a System Admin MAY delete a foreign personal credential (break-glass), but SEE/MANAGE stay owner-only', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  const bob = computeScope({ username: 'bob@corp.com', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  const aliceCred = { scope: 'personal', userId: 'u-a' };
  assert.equal(canDeleteCredential(alice, aliceCred), true);   // owner may always delete
  assert.equal(canDeleteCredential(bob, aliceCred), false);    // a non-owner, non-admin may not
  // THE decided exception (unified access model §6/§12.7): a System Admin MAY
  // delete it for governance / offboarding hygiene...
  assert.equal(canDeleteCredential(sys, aliceCred), true);
  // ...while SEE and MANAGE remain owner-only — the break-glass is delete-only.
  assert.equal(visibleCredential(sys, aliceCred), false);
  assert.equal(canManageCredential(sys, aliceCred), false);
});

test('canDeleteCredential: for non-personal tiers it is exactly canManageCredential', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships }); // team-admin of payments
  const bob = computeScope({ username: 'bob@corp.com', users, memberships });      // member of risk
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });      // System Admin
  const teamCred = { scope: 'team', teamId: 'payments' };
  const sysCred = { scope: 'system', assignedTeamIds: ['payments'] };
  for (const [who, cred] of [[alice, teamCred], [bob, teamCred], [sys, teamCred], [alice, sysCred], [sys, sysCred]]) {
    assert.equal(canDeleteCredential(who, cred), canManageCredential(who, cred));
  }
  // Concretely: the owning team's admin deletes a team cred; a member cannot;
  // only a System Admin deletes a system cred.
  assert.equal(canDeleteCredential(alice, teamCred), true);
  assert.equal(canDeleteCredential(bob, teamCred), false);
  assert.equal(canDeleteCredential(alice, sysCred), false);
  assert.equal(canDeleteCredential(sys, sysCred), true);
});

test('canCreateCredential: any authenticated human creates a personal credential owned by self (AC3)', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships }); // team-admin
  const bob = computeScope({ username: 'bob@corp.com', users, memberships });      // team-member
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });      // System Admin
  const seeded = computeScope({ username: 'admin', users, memberships });          // the seeded administrator
  assert.equal(canCreateCredential(alice, { scope: 'personal', userId: 'u-a' }), true);
  assert.equal(canCreateCredential(bob, { scope: 'personal', userId: 'u-b' }), true);   // plain member CAN (unlike team/system)
  assert.equal(canCreateCredential(sys, { scope: 'personal', userId: 'u-sys' }), true); // as self, not via scope.all
  // Owning someone else's identity is refused even for a System Admin.
  assert.equal(canCreateCredential(sys, { scope: 'personal', userId: 'u-a' }), false);
  assert.equal(canCreateCredential(bob, { scope: 'personal', userId: 'u-a' }), false);
  // #2059 flipped this case: the seeded administrator is a real record, so it
  // CAN own a personal credential — as itself. Owning someone else's is still
  // refused, which is the rule that actually matters (it never had a scope.all
  // bypass; before, it simply had no identity to match with).
  assert.equal(canCreateCredential(seeded, { scope: 'personal', userId: 'u-seed' }), true);
  assert.equal(canCreateCredential(seeded, { scope: 'personal', userId: 'u-a' }), false);
});

test('credentialVisibleToTeam: used for the reassignment-orphan guard', () => {
  assert.equal(credentialVisibleToTeam({ scope: 'team', teamId: 'payments' }, 'payments'), true);
  assert.equal(credentialVisibleToTeam({ scope: 'team', teamId: 'payments' }, 'risk'), false);
  assert.equal(credentialVisibleToTeam({ scope: 'system', assignedTeamIds: ['payments', 'risk'] }, 'risk'), true);
  assert.equal(credentialVisibleToTeam({ scope: 'system', assignedTeamIds: ['payments'] }, 'risk'), false);
  assert.equal(credentialVisibleToTeam({ teamId: 'default' }, undefined), true); // legacy default
});

// ── personalLendToTeam: the LIVE LEND (unified access model §7/§8, #2357) ────
// A personal credential is consumable by team T iff its owner is a CURRENT
// member of T. Composed at the consume call sites (behind AEE_RESOURCE_ACCESS_V2);
// the flag-gating is the caller's job, this predicate is the pure primitive.

test('personalLendToTeam: a member\'s personal credential is lent to their team', () => {
  const isMember = (u, t) => u === 'u-alice' && t === 'payments';
  const cred = { scope: 'personal', userId: 'u-alice', identity: 'human' };
  assert.equal(personalLendToTeam(cred, 'payments', isMember), true);
});

test('personalLendToTeam: the lend DIES when the owner leaves the team (AC: lend dies)', () => {
  // The membership gate is the whole lifetime of the lend — the same fixture,
  // once the owner is no longer returned as a member, is no longer consumable.
  const cred = { scope: 'personal', userId: 'u-alice', identity: 'human' };
  const stillMember = (u, t) => u === 'u-alice' && t === 'payments';
  const leftTeam = () => false; // membership row removed → no longer a member
  assert.equal(personalLendToTeam(cred, 'payments', stillMember), true);
  assert.equal(personalLendToTeam(cred, 'payments', leftTeam), false);
});

test('personalLendToTeam: never lends a teammate\'s credential to a team you are not in', () => {
  const isMember = (u, t) => u === 'u-alice' && t === 'payments';
  const cred = { scope: 'personal', userId: 'u-alice', identity: 'human' };
  assert.equal(personalLendToTeam(cred, 'risk', isMember), false, 'owner is not a member of risk');
});

test('personalLendToTeam: only PERSONAL credentials are lends — team/system/global are not', () => {
  const isMember = () => true;
  assert.equal(personalLendToTeam({ scope: 'team', teamId: 'payments' }, 'payments', isMember), false);
  assert.equal(personalLendToTeam({ scope: 'system', assignedTeamIds: ['payments'] }, 'payments', isMember), false);
  assert.equal(personalLendToTeam({ scope: 'system', global: true, identity: 'service' }, 'payments', isMember), false);
});

test('personalLendToTeam fails closed on missing owner / team / membership gate', () => {
  assert.equal(personalLendToTeam({ scope: 'personal', userId: 'u-a' }, 'payments', undefined), false, 'no gate');
  assert.equal(personalLendToTeam({ scope: 'personal', userId: null }, 'payments', () => true), false, 'no owner');
  assert.equal(personalLendToTeam({ scope: 'personal', userId: 'u-a' }, '', () => true), false, 'no team');
  assert.equal(personalLendToTeam(null, 'payments', () => true), false, 'no credential');
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
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
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
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  assert.equal(canManageAgent(alice, { teamId: 'payments' }), true);   // team-admin
  assert.equal(canManageAgent(alice, { teamId: 'default' }), false);   // only a member (AC1)
  assert.equal(canManageAgent(alice, { teamId: 'risk' }), false);      // not a member
  assert.equal(canManageAgent(alice, {}), false);                      // no team, no owner → closed
});

test('canManageAgent: an agent with NO team boundary is managed by its owner alone (#2078 / D8)', () => {
  // The mirror of visibleAgent's owner branch. Without it a standalone agent
  // would be visible to its creator and editable by nobody but a System Admin:
  // no membership can name a standalone agent, so canManageTeam always denies.
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageAgent(alice, { teamId: null, ownerId: 'u-a' }), true);
  assert.equal(canManageAgent(alice, { teamId: null, ownerId: 'u-b' }), false);
  assert.equal(canManageAgent(alice, { teamId: null }), false);
  // A plain team-member owns their standalone agent too — ownership is not a role.
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(bob.roles.get('risk'), 'team-member');
  assert.equal(canManageAgent(bob, { teamId: null, ownerId: 'u-b' }), true);
  // ...but owning an agent grants nothing over an agent that HAS a team: the
  // boundary is checked first, so ownership never bypasses the team-admin rule.
  assert.equal(canManageAgent(bob, { teamId: 'risk', ownerId: 'u-b' }), false);
  // A userId-null scope (e.g. a pre-seed env admin) must not match an ownerless
  // agent. Constructed directly: under Option C (PR #2094) the subject 'admin'
  // resolves to its real seeded record here (u-seed), so it no longer yields the
  // historical userId:null env scope — the invariant being pinned is that a null
  // userId never matches a null owner, independent of how the scope arose.
  const nullScope = { all: false, teamIds: new Set(), roles: new Map(), userId: null };
  assert.equal(canManageAgent(nullScope, { teamId: null, ownerId: null }), false);
});

test('canManageAgent: plain team-member manages no agent (AC1)', () => {
  const bob = computeScope({ username: 'bob@corp.com', users, memberships });
  assert.equal(canManageAgent(bob, { teamId: 'risk' }), false); // member, not admin
});

test('canManageAgent: the seeded admin & any System-Admin user manage any agent', () => {
  const env = computeScope({ username: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  assert.equal(canManageAgent(env, { teamId: 'risk' }), true);
  assert.equal(canManageAgent(sys, { teamId: 'anything' }), true);
});

test('canManageAgent: missing scope / unknown subject fail closed', () => {
  const unknown = computeScope({ username: 'ghost@corp.com', users, memberships });
  assert.equal(canManageAgent(unknown, { teamId: 'default' }), false);
  assert.equal(canManageAgent(null, { teamId: 'default' }), false);
  assert.equal(canManageAgent(undefined, { teamId: 'payments' }), false);
});

test('canManageEnvironment: team-admin manages own team env; member/other denied', () => {
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  const bob   = computeScope({ username: 'bob@corp.com', users, memberships });
  assert.equal(canManageEnvironment(alice, { teamId: 'payments' }), true);
  assert.equal(canManageEnvironment(alice, { teamId: 'default' }), false); // only a member
  assert.equal(canManageEnvironment(alice, { teamId: 'risk' }), false);    // other team
  assert.equal(canManageEnvironment(bob, { teamId: 'risk' }), false);      // member, not admin
  assert.equal(canManageEnvironment(alice, {}), false);                    // missing → default
});

// ── #2083 (P5): the shared tier for environments and MCP servers ────────────
//
// One predicate family serves both kinds, so every case below is equally a
// statement about an MCP server record.

const SHARED = (assignedTeamIds) => ({ id: 'env-shared', scope: 'system', assignedTeamIds });

test('#2083: a legacy environment record behaves exactly as it did before the tier existed', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const carol = computeScope({ username: 'carol@corp.com', adminUsername: 'admin', users, memberships });
  // No `scope` field at all — the shape every environment on disk has today.
  const legacy = { id: 'env-pay', teamId: 'payments' };
  assert.equal(visibleEnvironment(alice, legacy), true);
  assert.equal(canManageEnvironment(alice, legacy), true);
  assert.equal(visibleEnvironment(carol, legacy), false);
  assert.equal(canManageEnvironment(carol, legacy), false);
  // And an explicit team-tier record is indistinguishable from the legacy one.
  const explicit = { id: 'env-pay', scope: 'team', teamId: 'payments', assignedTeamIds: [] };
  assert.equal(visibleEnvironment(alice, explicit), visibleEnvironment(alice, legacy));
  assert.equal(canManageEnvironment(alice, explicit), canManageEnvironment(alice, legacy));
});

test('#2083: visibility is MEMBERSHIP, not the admin role — the documented divergence from visibleCredential', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  // Alice is a plain MEMBER of 'default'. D9 says a Team Member may read.
  const env = { id: 'env-def', teamId: 'default' };
  assert.equal(visibleEnvironment(alice, env), true, 'a member must still see their team environment');
  assert.equal(canManageEnvironment(alice, env), false, 'but must not manage it');
  // The same record as a CREDENTIAL is invisible to her — that is the #798
  // deferral this ticket deliberately does not import into the env path.
  assert.equal(visibleCredential(alice, { scope: 'team', teamId: 'default' }), false);
});

test('#2071: an owner-stamped environment is visible AND manageable by its owner, and no one else', () => {
  const carol = computeScope({ username: 'carol@corp.com', adminUsername: 'admin', users, memberships });
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  // A teamless user's own QuickStart environment: no team tier, an ownerId (the
  // D8 owner branch, the shape POST /api/quickstart writes since #2071).
  const owned = { id: 'env-quickstart', ownerId: 'u-c' };
  assert.equal(ownsEnvironment(carol, owned), true);
  assert.equal(visibleEnvironment(carol, owned), true, 'the owner sees their own environment');
  assert.equal(canManageEnvironment(carol, owned), true, 'and may edit it in place');
  // Private to its owner — another ordinary user sees and manages nothing.
  assert.equal(ownsEnvironment(bob, owned), false);
  assert.equal(visibleEnvironment(bob, owned), false);
  assert.equal(canManageEnvironment(bob, owned), false);
  // A record with no ownerId never triggers the owner branch (no regression on
  // the team/system tiers).
  assert.equal(ownsEnvironment(carol, { id: 'x', teamId: 'payments' }), false);
});

test('#2083: a shared environment reaches every assigned team, and no other', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  const shared = SHARED(['payments', 'ops']);
  assert.equal(visibleEnvironment(alice, shared), true);   // member of payments
  assert.equal(visibleEnvironment(bob, shared), false);    // risk only
  // A shared record carries no owning team, which is exactly why the old
  // `visibleTeam(scope, env.teamId)` filter hid it from everyone.
  assert.equal(visibleTeam(alice, shared.teamId), false);
});

test('#2083: a shared environment is MANAGEABLE by every assigned team-admin — the no-lockout rule', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const carol = computeScope({ username: 'carol@corp.com', adminUsername: 'admin', users, memberships });
  const shared = SHARED(['payments', 'default']);
  assert.equal(canManageEnvironment(alice, shared), true, 'team-admin of payments');
  assert.equal(canManageEnvironment(carol, shared), true, 'team-admin of default');
  // A plain member of an assigned team may read it but not change it.
  const sharedDefaultOnly = SHARED(['default']);
  assert.equal(visibleEnvironment(alice, sharedDefaultOnly), true, 'alice is a member of default');
  assert.equal(canManageEnvironment(alice, sharedDefaultOnly), false, 'but only a member');
  // THE DIVERGENCE, stated as a test: the credential rule refuses outright, and
  // copying it would have made the P5 migration a manage-axis lockout.
  assert.equal(canManageCredential(alice, { scope: 'system', assignedTeamIds: ['payments'] }), false);
});

test('#2083: a shared record assigned to zero teams is reachable by System Admins only', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const carol = computeScope({ username: 'carol@corp.com', adminUsername: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  const orphan = SHARED([]);
  assert.equal(visibleEnvironment(alice, orphan), false);
  assert.equal(canManageEnvironment(alice, orphan), false);
  // Including the team literally named 'default' — never orphaned INTO view.
  assert.equal(visibleEnvironment(carol, orphan), false);
  assert.equal(canManageEnvironment(carol, orphan), false);
  assert.equal(visibleEnvironment(sys, orphan), true);
  assert.equal(canManageEnvironment(sys, orphan), true);
});

// #2158: the case above is split into GLOBAL and NOT GLOBAL rather than
// deleted (AC12) — a global record has the IDENTICAL underlying shape
// (`scope: 'system'`, `assignedTeamIds: []`) and means the OPPOSITE thing
// (everyone reaches it, not nobody). `scope.js`'s own `visibleEnvironment`
// stays exactly as asserted above — the global flag is composed at the
// api.js call sites, not here (AC4) — but the composition must still turn
// "reachable by System Admins only" into "reachable by everyone".
test('#2158: a global record has the IDENTICAL shape as the zero-assignment shared record, and the composed reach is the opposite', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const carol = computeScope({ username: 'carol@corp.com', adminUsername: 'admin', users, memberships });
  const orphan = SHARED([]); // scope:'system', assignedTeamIds:[] — no `global` key
  const global = { ...orphan, global: true }; // the identical shape, plus the flag

  // scope.js's own predicate is UNCHANGED by the flag — it does not know about
  // `global` at all, which is the point of keeping the rule out of this module.
  assert.equal(visibleEnvironment(alice, global), false);
  assert.equal(visibleEnvironment(carol, global), false);

  // But `isGlobalEnvironment` reads it as reachable — this IS the predicate
  // api.js composes with `visibleEnvironment` at every read/list call site, so
  // the OR-composition (not `visibleEnvironment` alone) is what a normal user
  // actually meets.
  assert.equal(isGlobalEnvironment(orphan), false, 'no `global` key — still just an unreachable orphan');
  assert.equal(isGlobalEnvironment(global), true);
  assert.equal(visibleEnvironment(alice, global) || isGlobalEnvironment(global), true);
  assert.equal(visibleEnvironment(carol, global) || isGlobalEnvironment(global), true);

  // A hand-edited/stale record — `global: true` on a TEAM-tier record — is
  // never global (AC5): the predicate re-reads `scope === 'system'` too.
  assert.equal(isGlobalEnvironment({ scope: 'team', teamId: 'payments', global: true }), false);
});

test('#2083: creating a SHARED environment is System-Admin-only; a team one needs team-admin', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const bob = computeScope({ username: 'bob@corp.com', adminUsername: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canCreateEnvironment(alice, { scope: 'team', teamId: 'payments' }), true);
  assert.equal(canCreateEnvironment(alice, { scope: 'team', teamId: 'risk' }), false);
  assert.equal(canCreateEnvironment(bob, { scope: 'team', teamId: 'risk' }), false, 'member, not admin');
  // The shared tier: refused for a Team Admin even of an assigned team.
  assert.equal(canCreateEnvironment(alice, { scope: 'system', assignedTeamIds: ['payments'] }), false);
  assert.equal(canCreateEnvironment(sys, { scope: 'system', assignedTeamIds: ['payments'] }), true);
  // No `|| 'default'`: a create naming no team is refused, not attributed.
  assert.equal(canCreateEnvironment(alice, {}), false);
  assert.equal(canCreateEnvironment(null, { scope: 'team', teamId: 'payments' }), false);
});

test('#2083: re-tiering is System-Admin-only, and is a narrower question than editing', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const env = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canRetierEnvironment(alice), false);
  assert.equal(canRetierEnvironment(sys), true);
  assert.equal(canRetierEnvironment(env), true);
  assert.equal(canRetierEnvironment(null), false);
  // Alice may still EDIT the record she administers — the two gates answer
  // different questions and only one of them is an operator act.
  assert.equal(canManageEnvironment(alice, { teamId: 'payments' }), true);
});

test('#2083: a hand-written personal environment fails closed to its owner, with no admin bypass', () => {
  // Nothing can create one (resolveTieredOwnership refuses, guarded in
  // tiered-resource-routes.test.js), but the predicates must still answer
  // safely for a record edited onto disk rather than crash or default open.
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  const mine = { id: 'env-p', scope: 'personal', userId: 'u-a' };
  assert.equal(visibleEnvironment(alice, mine), true);
  assert.equal(canManageEnvironment(alice, mine), true);
  assert.equal(visibleEnvironment(sys, mine), false, 'the personal tier has no scope.all bypass');
  assert.equal(canManageEnvironment(sys, mine), false);
});

test('#2083: a malformed record fails closed for a non-admin and stays visible to the operator', () => {
  const alice = computeScope({ username: 'alice@corp.com', adminUsername: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  for (const bad of [null, undefined, {}, { scope: 'nonsense' }]) {
    assert.equal(visibleEnvironment(alice, bad), false, 'a non-admin reaches nothing unstamped (§8.4)');
    assert.equal(canManageEnvironment(alice, bad), false);
    // The operator keeps `scope.all`, deliberately: this is the same answer
    // `visibleTeam(sys, undefined)` already gives (asserted above), and it is
    // the SAFE direction — a record too broken to name its team is exactly the
    // one only a System Admin can repair, so hiding it would be an operator
    // lock-out dressed as a fail-closed default.
    assert.equal(visibleEnvironment(sys, bad), true);
    assert.equal(canManageEnvironment(sys, bad), true);
  }
  // A missing caller scope still fails closed on every path.
  assert.equal(visibleEnvironment(null, { teamId: 'payments' }), false);
  assert.equal(canManageEnvironment(null, { teamId: 'payments' }), false);
  assert.equal(canCreateEnvironment(null, { teamId: 'payments' }), false);
});

test('canManageEnvironment: env admin & System-Admin manage any env (no regression)', () => {
  const env = computeScope({ username: 'admin', adminUsername: 'admin', users, memberships });
  const sys = computeScope({ username: 'sys@corp.com', adminUsername: 'admin', users, memberships });
  assert.equal(canManageEnvironment(env, { teamId: 'risk' }), true);
  assert.equal(canManageEnvironment(sys, { teamId: 'payments' }), true);
  assert.equal(canManageEnvironment(null, { teamId: 'payments' }), false); // missing scope fails closed
});

// ── Token-usage statistics visibility (#801) ────────────────────────────────

test('canViewUsageStatistics: any System-Admin user may view (AC3/AC6)', () => {
  const seededAdmin = computeScope({ username: 'admin', users, memberships });
  const sysAdmin = computeScope({ username: 'sys@corp.com', users, memberships });
  assert.equal(canViewUsageStatistics(seededAdmin), true);
  assert.equal(canViewUsageStatistics(sysAdmin), true);
});

test('canViewUsageStatistics: Team Admin & Team Member are denied (AC1/AC2)', () => {
  // alice is team-admin of payments; bob is a plain team-member of risk.
  const alice = computeScope({ username: 'alice@corp.com', users, memberships });
  const bob   = computeScope({ username: 'bob@corp.com', users, memberships });
  assert.equal(canViewUsageStatistics(alice), false);
  assert.equal(canViewUsageStatistics(bob), false);
});

test('canViewUsageStatistics: unknown subject / missing scope fail closed', () => {
  const unknown = computeScope({ username: 'ghost@corp.com', users, memberships });
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
  const bob = computeScope({ username: 'bob@corp.com', users, memberships }); // team-member of 'risk'
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
  const sys = computeScope({ username: 'sys@corp.com', users, memberships });
  const otherEp = { id: 'ep-pay', scope: 'team', teamId: 'payments' };
  assert.equal(visibleCredential(sys, otherEp), true);
  // … but the switch is gated on the AGENT team's entitlement, not the caller's
  // visibility: a 'risk' agent still can't be bound to a 'payments' provider.
  assert.equal(credentialVisibleToTeam(otherEp, 'risk'), false);
});

// ── Agent → CREDENTIAL tenant resolution ────────────────────────────────────
// Since #2078 this is the credential/model-provider axis ONLY; the access
// boundary collapsed into agent-team.js `resolveAgentTeam` (tested there and in
// team-membership-enforcement.test.js). This block is deliberately unchanged:
// credential records are still stamped with access-scope ids until P5 re-points
// them, so the hop below must keep answering exactly what it answered before —
// a regression here makes every team-scoped provider unusable, which is the bug
// the hop was introduced to fix.
//
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
  // Post-#2229 (epic; #2234 decision), an ordinary standalone agent no longer
  // exists — this shape is now reached only by an ephemeral agent
  // (`orchestrator/orchestrator.js`'s `POST /internal/agents/ephemeral`,
  // permanently excluded from the team-of-one migration) or a malformed
  // config. `resolveAgentTenant` doesn't branch on `ephemeral` either way —
  // this fixture proves that stays true, alongside `standalone` above rather
  // than replacing it (docs/decentralised-access-concept.md Amendment 10).
  standaloneEphemeral: { id: 'standalone-ephemeral', role: 'agent', ephemeral: true, teamId: 'risk' },
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

test('tenant: an ephemeral agent resolves exactly like any other standalone agent (#2234)', () => {
  assert.equal(resolveAgentTenant(tenantAgents.standaloneEphemeral, loadTenantAgent), 'risk');
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
