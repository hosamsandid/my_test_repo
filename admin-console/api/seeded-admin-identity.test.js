'use strict';

// #2059 AC6: the seeded administrator's session resolves to a real user id, and
// the three things that were broken *because* it did not are consequently
// fixed — preferences persist, a personal credential can be owned and seen, and
// the audit actor carries an identity.
//
// AC6 asks for this "verified through the real `computeScope`, not a hand-built
// scope object", which is the point of this file: every scope below comes out of
// the production `computeScope`, and every verdict out of the production
// predicate, so a test cannot agree with a hand-rolled idea of the scope shape
// while the real one disagrees. Run: node --test admin-console/api/seeded-admin-identity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeScope, describeAuthz,
  visibleCredential, canManageCredential, canCreateCredential,
} = require('./scope');
const { buildEvent } = require('./audit');
const { createTeamsStore } = require('../../orchestrator/teams-store');
const { resolveInitialAdminSeed } = require('../../orchestrator/initial-admin-seed');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Build the users index a real first boot leaves behind: run the REAL seed
// resolution and the REAL store primitive against a temp workspace, then read
// the index back exactly as `getScope` does (`readJsonFile(USERS_INDEX, [])`).
// Nothing about the record is hand-written, so if the seeding ever stops
// producing a System Admin these assertions fail rather than pass on a fixture.
function seedRealStack(env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'seed-pass' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seeded-admin-'));
  const store = createTeamsStore({ root });
  store.ensureDefaultTeam();
  const seed = resolveInitialAdminSeed(env);
  store.seedInitialSystemAdmin(seed);

  const users = JSON.parse(fs.readFileSync(path.join(root, 'users', 'index.json'), 'utf8'));
  const memberships = [];
  return { root, store, users, memberships, subject: seed.subject };
}

test('the seeded administrator resolves to a real userId through the real computeScope', () => {
  const { users, memberships, subject } = seedRealStack();
  assert.equal(users.length, 1, 'a fresh stack ends first boot with exactly one record');

  const scope = computeScope({ username: subject, users, memberships });
  assert.equal(scope.all, true, 'full visibility, as before');
  assert.ok(scope.userId, 'but now WITH an identity — the whole point of #2059');
  assert.equal(scope.userId, users[0].id);

  // The session payload the client receives carries the same id.
  const authz = describeAuthz({ username: subject, users, memberships });
  assert.equal(authz.userId, scope.userId);
  assert.equal(authz.admin, true);
  assert.equal(authz.systemAdmin, true);
});

test('AC6.1 — PUT /api/me/preferences persists for it (no longer a silent no-op)', () => {
  const { users, memberships, subject } = seedRealStack();
  const scope = computeScope({ username: subject, users, memberships });

  // The route's own gate, quoted: `if (scope.userId == null) return res.json({ persisted: false })`.
  // Reproducing the CONDITION rather than the handler keeps this a test of the
  // scope, which is what AC6 is about; the handler itself is a proxy call.
  const persisted = !(scope.userId == null);
  assert.equal(persisted, true, 'the preference has somewhere on the server to go');

  // Prove the gate is the thing being satisfied: an unknown subject still fails
  // it, so the assertion above is not vacuously true of every scope.
  const stranger = computeScope({ username: 'nobody@corp.com', users, memberships });
  assert.equal(stranger.userId == null, true);
});

test('AC6.2 — a personal credential created by it is visible and manageable BY IT ONLY', () => {
  const { users, memberships, subject } = seedRealStack();
  const scope = computeScope({ username: subject, users, memberships });
  const mine = { id: 'k1', scope: 'personal', userId: scope.userId };

  assert.equal(canCreateCredential(scope, mine), true, 'it can own one as itself');
  assert.equal(visibleCredential(scope, mine), true, 'and see it');
  assert.equal(canManageCredential(scope, mine), true, 'and manage it');
  // (Asserted through the three public predicates rather than the private
  // `ownsPersonalCredential` they all delegate to — the module's surface is
  // deliberately narrow and a test is not a reason to widen it.)

  // The privacy rule is untouched: the personal tier has no scope.all bypass,
  // so being a System Admin buys nothing on somebody else's credential.
  const someoneElses = { id: 'k2', scope: 'personal', userId: 'u-other' };
  assert.equal(visibleCredential(scope, someoneElses), false);
  assert.equal(canManageCredential(scope, someoneElses), false);
  assert.equal(canCreateCredential(scope, someoneElses), false, 'nor can it claim their identity');

  // And an owner-less personal credential still matches nobody.
  assert.equal(visibleCredential(scope, { scope: 'personal' }), false);
});

test('AC6.3 — the audit actor is the seeded subject, resolvable to the record', () => {
  const { users, subject } = seedRealStack();

  // The real audit writer over a request shaped like the ones the gate produces
  // (`req.user = { username: session.sub }`).
  const event = buildEvent(
    { method: 'POST', originalUrl: '/api/teams', user: { username: subject }, body: {} },
    { statusCode: 201 },
  );
  assert.equal(event.actor, subject);
  assert.notEqual(event.actor, 'anonymous');

  // "Carries the user id" in the sense an access review needs: the actor is a
  // subject that resolves to exactly one record. The audit line stores the
  // subject rather than the uuid (unchanged by #2059 — that is the format every
  // existing line uses); what changed is that it now resolves to something.
  const matches = users.filter(u => u.subject.toLowerCase() === event.actor.toLowerCase());
  assert.equal(matches.length, 1, 'the audit actor names exactly one user record');
  assert.equal(matches[0].systemAdmin, true);
  assert.ok(matches[0].id, 'and that record has an id the review can cite');
});

test('an SSO stack (BOOTSTRAP_SYSTEM_ADMIN_SUBJECT) gets the same identity, without a password', () => {
  const { users, memberships, subject } = seedRealStack({
    BOOTSTRAP_SYSTEM_ADMIN_SUBJECT: 'ops@corp.com',
    BOOTSTRAP_SYSTEM_ADMIN_NAME: 'Ops',
    // Deliberately also set, to prove the bootstrap subject wins.
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'seed-pass',
  });
  assert.equal(subject, 'ops@corp.com');
  assert.equal(users.length, 1);

  const scope = computeScope({ username: 'ops@corp.com', users, memberships });
  assert.equal(scope.all, true);
  assert.ok(scope.userId, 'an IAP-authenticated administrator has an identity too');

  // The env pair did NOT also seed a record, so it cannot sign in either.
  assert.equal(computeScope({ username: 'admin', users, memberships }).all, false);
  assert.equal(users[0].passwordHash, undefined, 'no password: the IAP authenticates them');
});
