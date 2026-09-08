'use strict';

// Run: node --test orchestrator/team-admin-succession-store.test.js
//
// The D4 rule as the STORE enforces it (#2081 AC4/AC5), plus the two things the
// pure module cannot answer: that a membership may name an **Agent Team**, and
// that a hand-over lands atomically.
//
// Separate from `teams-store.test.js` on purpose — that file is the #299 data
// model's own suite and its fixtures predate the Agent Team referent; mixing
// the two would make it unclear which behaviour a failure belongs to.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTeamsStore } = require('./teams-store');
const S = require('./team-admin-succession');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aee-succession-'));
}

// A store whose Agent Team resolver knows exactly `knownAgentTeams`, so the
// injection can be exercised without any agent directory on disk.
function makeStore(knownAgentTeams = []) {
  const root = tmpRoot();
  const store = createTeamsStore({
    root,
    agentTeamExists: (id) => knownAgentTeams.includes(id),
  });
  return { root, store };
}

// `assert.throws` returns undefined, and these refusals are only interesting
// for the `statusHint`/`code` they carry — so catch and hand the error back.
function refusal(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a refusal, but the call succeeded');
}

function readMemberships(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'memberships', 'index.json'), 'utf8'));
}

// alice = sole admin of the Agent Team `squad`; dave = a member of it.
function seedSquad(store) {
  const alice = store.createUser({ subject: 'alice@corp.com' });
  const dave = store.createUser({ subject: 'dave@corp.com' });
  store.setMembership({ userId: alice.id, teamId: 'squad', role: 'team-admin' });
  store.setMembership({ userId: dave.id, teamId: 'squad', role: 'team-member' });
  return { alice, dave };
}

// ── A membership may name an Agent Team (the P3 precondition) ──────────────

test('setMembership accepts an Agent Team id through the injected resolver', () => {
  const { store } = makeStore(['squad']);
  const alice = store.createUser({ subject: 'alice@corp.com' });
  const m = store.setMembership({ userId: alice.id, teamId: 'squad', role: 'team-admin' });
  assert.equal(m.teamId, 'squad');
  assert.equal(m.role, 'team-admin');
});

test('an id that is neither a scope nor an Agent Team is still refused', () => {
  const { store } = makeStore(['squad']);
  const alice = store.createUser({ subject: 'alice@corp.com' });
  assert.throws(
    () => store.setMembership({ userId: alice.id, teamId: 'not-a-team', role: 'team-admin' }),
    /Team 'not-a-team' not found/,
  );
});

test('with no resolver injected the store keeps its pre-#2081 behaviour', () => {
  // The default is a CLOSED `() => false`, not "accept anything": a caller that
  // wires nothing must not silently gain a second, unvalidated key space.
  const root = tmpRoot();
  const store = createTeamsStore({ root });
  const alice = store.createUser({ subject: 'alice@corp.com' });
  assert.throws(() => store.setMembership({ userId: alice.id, teamId: 'squad', role: 'team-admin' }), /not found/);
  store.ensureDefaultTeam();
  assert.ok(store.setMembership({ userId: alice.id, teamId: 'default', role: 'team-admin' }));
});

test('a throwing resolver answers "no team", never "any team"', () => {
  const root = tmpRoot();
  const store = createTeamsStore({
    root,
    agentTeamExists: () => { throw new Error('unreadable config'); },
  });
  const alice = store.createUser({ subject: 'alice@corp.com' });
  assert.throws(() => store.setMembership({ userId: alice.id, teamId: 'squad', role: 'team-admin' }), /not found/);
});

// ── AC4: removal and demotion of the last admin ────────────────────────────

test('removing the last Team Admin is refused, with the D4 code', () => {
  const { store } = makeStore(['squad']);
  const { alice } = seedSquad(store);
  const err = refusal(() => store.removeMembership({ userId: alice.id, teamId: 'squad' }));
  assert.equal(err.statusHint, 409);
  assert.equal(err.code, S.SUCCESSOR_REQUIRED);
});

test('demoting the last Team Admin is refused too — the upsert is the same door', () => {
  const { store } = makeStore(['squad']);
  const { alice } = seedSquad(store);
  const err = refusal(() => store.setMembership({ userId: alice.id, teamId: 'squad', role: 'team-member' }));
  assert.equal(err.statusHint, 409);
  assert.equal(err.code, S.SUCCESSOR_REQUIRED);
});

test('naming a successor hands over: exactly one admin before and after', () => {
  const { root, store } = makeStore(['squad']);
  const { alice, dave } = seedSquad(store);
  store.removeMembership({ userId: alice.id, teamId: 'squad', successorUserId: dave.id });

  const after = readMemberships(root);
  assert.equal(after.length, 1, 'alice is gone, dave remains');
  assert.equal(after[0].userId, dave.id);
  assert.equal(after[0].role, 'team-admin', 'dave was promoted in the same operation');
  assert.deepEqual(S.adminIdsOf(after, 'squad'), [dave.id]);
});

test('a demotion with a successor leaves the team with exactly one admin', () => {
  const { root, store } = makeStore(['squad']);
  const { alice, dave } = seedSquad(store);
  store.setMembership({ userId: alice.id, teamId: 'squad', role: 'team-member', successorUserId: dave.id });

  const after = readMemberships(root);
  assert.deepEqual(S.adminIdsOf(after, 'squad'), [dave.id]);
  assert.equal(after.find(m => m.userId === alice.id).role, 'team-member', 'alice stays, demoted');
});

test('a refused hand-over writes nothing at all', () => {
  const { root, store } = makeStore(['squad']);
  const { alice } = seedSquad(store);
  const before = JSON.stringify(readMemberships(root));
  assert.throws(() => store.removeMembership({ userId: alice.id, teamId: 'squad' }));
  assert.throws(() => store.setMembership({ userId: alice.id, teamId: 'squad', role: 'team-member' }));
  assert.throws(() => store.removeMembership({ userId: alice.id, teamId: 'squad', successorUserId: 'u-ghost' }));
  assert.equal(JSON.stringify(readMemberships(root)), before);
});

test('removing a co-admin, or a plain member, needs no successor', () => {
  const { root, store } = makeStore(['squad']);
  const { alice, dave } = seedSquad(store);
  store.setMembership({ userId: dave.id, teamId: 'squad', role: 'team-admin' });
  store.removeMembership({ userId: alice.id, teamId: 'squad' });
  assert.deepEqual(S.adminIdsOf(readMemberships(root), 'squad'), [dave.id]);
});

test('adding a member and PROMOTING one are never gated by the rule', () => {
  const { store } = makeStore(['squad']);
  const { alice, dave } = seedSquad(store);
  // Re-asserting the sole admin's own role must not trip the demotion branch.
  assert.ok(store.setMembership({ userId: alice.id, teamId: 'squad', role: 'team-admin' }));
  assert.ok(store.setMembership({ userId: dave.id, teamId: 'squad', role: 'team-admin' }));
});

// ── AC5: user deletion ─────────────────────────────────────────────────────

test('deleting the last Team Admin of a team is refused', () => {
  const { store } = makeStore(['squad']);
  const { alice } = seedSquad(store);
  const err = refusal(() => store.deleteUser(alice.id));
  assert.equal(err.statusHint, 409);
  assert.equal(err.code, S.LAST_TEAM_ADMIN);
  assert.match(err.message, /squad/);
  assert.ok(store.getUser(alice.id), 'the user record survives the refusal');
});

test('deleting becomes possible once a successor holds the team', () => {
  const { store } = makeStore(['squad']);
  const { alice, dave } = seedSquad(store);
  store.setMembership({ userId: dave.id, teamId: 'squad', role: 'team-admin' });
  assert.deepEqual(store.deleteUser(alice.id), { id: alice.id, deleted: true });
  assert.equal(store.getUser(alice.id), null);
});

test('the ticket\'s third edge case: share, hand over, then leave', () => {
  const { root, store } = makeStore(['squad']);
  const alice = store.createUser({ subject: 'alice@corp.com' });
  // A freshly self-created team: its creator alone.
  store.setMembership({ userId: alice.id, teamId: 'squad', role: 'team-admin' });
  assert.throws(() => store.removeMembership({ userId: alice.id, teamId: 'squad' }), /last Team Admin/);

  // Share it, name the newcomer, leave. Allowed, and the team keeps an admin.
  const bob = store.createUser({ subject: 'bob@corp.com' });
  store.setMembership({ userId: bob.id, teamId: 'squad', role: 'team-member' });
  store.removeMembership({ userId: alice.id, teamId: 'squad', successorUserId: bob.id });
  assert.deepEqual(S.adminIdsOf(readMemberships(root), 'squad'), [bob.id]);
  assert.deepEqual(store.deleteUser(alice.id), { id: alice.id, deleted: true });
});

// ── Deleting the team itself is the other way out ──────────────────────────

test('removeTeamMemberships drops the grants a deleted Agent Team leaves behind', () => {
  const { root, store } = makeStore(['squad', 'other']);
  const { alice } = seedSquad(store);
  store.setMembership({ userId: alice.id, teamId: 'other', role: 'team-member' });

  assert.equal(store.removeTeamMemberships('squad'), 2);
  assert.deepEqual(readMemberships(root).map(m => m.teamId), ['other'], 'other team untouched');
  assert.equal(store.removeTeamMemberships('squad'), 0, 'idempotent');
  assert.equal(store.removeTeamMemberships(''), 0);
});

test('a deleted team stops blocking its admin\'s deletion', () => {
  // Without the cascade this is the wedge: the team is gone, so nobody can ever
  // be promoted in it, and its last admin could never be deleted again.
  const { store } = makeStore(['squad']);
  const { alice } = seedSquad(store);
  assert.throws(() => store.deleteUser(alice.id), /last Team Admin/);
  store.removeTeamMemberships('squad');
  assert.deepEqual(store.deleteUser(alice.id), { id: alice.id, deleted: true });
});
