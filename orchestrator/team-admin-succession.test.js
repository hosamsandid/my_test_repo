'use strict';

// Run: node --test orchestrator/team-admin-succession.test.js
//
// The D4 last-admin rule (#2081 AC4/AC5), decided purely over a membership
// array. The store's enforcement of it — and the atomicity of the promotion —
// is covered in `teams-store.test.js`; this file covers the decision.

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('./team-admin-succession');

// alpha: two admins + a member.  beta: alice alone.  gamma: alice + a member.
const MEMBERSHIPS = [
  { userId: 'u-alice', teamId: 'alpha', role: 'team-admin' },
  { userId: 'u-bob', teamId: 'alpha', role: 'team-admin' },
  { userId: 'u-carol', teamId: 'alpha', role: 'team-member' },
  { userId: 'u-alice', teamId: 'beta', role: 'team-admin' },
  { userId: 'u-alice', teamId: 'gamma', role: 'team-admin' },
  { userId: 'u-dave', teamId: 'gamma', role: 'team-member' },
];

// ── The primitives ─────────────────────────────────────────────────────────

test('adminIdsOf reports only the team-admins of the named team', () => {
  assert.deepEqual(S.adminIdsOf(MEMBERSHIPS, 'alpha'), ['u-alice', 'u-bob']);
  assert.deepEqual(S.adminIdsOf(MEMBERSHIPS, 'gamma'), ['u-alice']);
  assert.deepEqual(S.adminIdsOf(MEMBERSHIPS, 'nope'), []);
  // Fail-closed on the shapes a corrupt index can produce, rather than throwing
  // — an unreadable membership must not be counted as an admin.
  assert.deepEqual(S.adminIdsOf(null, 'alpha'), []);
  assert.deepEqual(S.adminIdsOf([null, 'x', { userId: 1, teamId: 'alpha', role: 'team-admin' }], 'alpha'), []);
  assert.deepEqual(S.adminIdsOf(MEMBERSHIPS, ''), []);
});

test('isSoleAdmin is false for a co-admin and for a plain member', () => {
  assert.equal(S.isSoleAdmin(MEMBERSHIPS, 'u-alice', 'beta'), true);
  assert.equal(S.isSoleAdmin(MEMBERSHIPS, 'u-alice', 'alpha'), false, 'bob is also an admin of alpha');
  assert.equal(S.isSoleAdmin(MEMBERSHIPS, 'u-carol', 'alpha'), false, 'carol is not an admin at all');
  assert.equal(S.isSoleAdmin(MEMBERSHIPS, 'u-dave', 'gamma'), false);
});

test('soleAdminTeamIds lists exactly the teams the user is the last admin of', () => {
  assert.deepEqual(S.soleAdminTeamIds(MEMBERSHIPS, 'u-alice'), ['beta', 'gamma']);
  assert.deepEqual(S.soleAdminTeamIds(MEMBERSHIPS, 'u-bob'), [], 'alice co-admins alpha');
  assert.deepEqual(S.soleAdminTeamIds(MEMBERSHIPS, 'u-carol'), []);
  assert.deepEqual(S.soleAdminTeamIds(MEMBERSHIPS, 'u-nobody'), []);
});

// ── The hand-over decision (AC4) ───────────────────────────────────────────

test('a co-administered team needs no successor — the ticket\'s first edge case', () => {
  const plan = S.planAdminHandover({ memberships: MEMBERSHIPS, userId: 'u-alice', teamId: 'alpha' });
  assert.deepEqual(plan, { ok: true, promote: null });
});

test('demoting or removing a plain member is unconstrained', () => {
  const plan = S.planAdminHandover({ memberships: MEMBERSHIPS, userId: 'u-carol', teamId: 'alpha' });
  assert.deepEqual(plan, { ok: true, promote: null });
});

test('the sole admin is refused with a successor prompt — the second edge case', () => {
  const plan = S.planAdminHandover({ memberships: MEMBERSHIPS, userId: 'u-alice', teamId: 'gamma' });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, S.SUCCESSOR_REQUIRED);
  // The refusal must name the way out, not just say no: a 409 whose message
  // omits `successorUserId` leaves the caller with nothing to try.
  assert.match(plan.message, /successorUserId/);
  assert.match(plan.message, /gamma/);
});

test('a named successor who is already a member is accepted, and is promoted', () => {
  const plan = S.planAdminHandover({
    memberships: MEMBERSHIPS, userId: 'u-alice', teamId: 'gamma', successorUserId: 'u-dave',
  });
  assert.deepEqual(plan, { ok: true, promote: { userId: 'u-dave', teamId: 'gamma' } });
});

test('a successor is refused when it is yourself, or not a member of THIS team', () => {
  const self = S.planAdminHandover({
    memberships: MEMBERSHIPS, userId: 'u-alice', teamId: 'gamma', successorUserId: 'u-alice',
  });
  assert.equal(self.code, S.SUCCESSOR_IS_SELF);

  // bob is a real user and a team-admin — of a DIFFERENT team. Naming him would
  // make this route a second, unaudited invitation path.
  const foreign = S.planAdminHandover({
    memberships: MEMBERSHIPS, userId: 'u-alice', teamId: 'gamma', successorUserId: 'u-bob',
  });
  assert.equal(foreign.code, S.SUCCESSOR_NOT_A_MEMBER);
  assert.match(foreign.message, /add them to the team first/i);

  const unknown = S.planAdminHandover({
    memberships: MEMBERSHIPS, userId: 'u-alice', teamId: 'gamma', successorUserId: 'u-ghost',
  });
  assert.equal(unknown.code, S.SUCCESSOR_NOT_A_MEMBER);
});

test('a blank or non-string successor reads as "none named", never as a pass', () => {
  for (const successorUserId of ['', '   ', null, undefined, 42, {}, ['u-dave']]) {
    const plan = S.planAdminHandover({
      memberships: MEMBERSHIPS, userId: 'u-alice', teamId: 'gamma', successorUserId,
    });
    assert.equal(plan.ok, false, `successor ${JSON.stringify(successorUserId)} must not be honoured`);
    assert.equal(plan.code, S.SUCCESSOR_REQUIRED);
  }
});

test('a solo team has no successor to name — refused, and the message says so', () => {
  // beta is alice alone: there is nobody to hand over to, so the only ways out
  // are adding somebody first or deleting the team. Both are in the message.
  const plan = S.planAdminHandover({
    memberships: MEMBERSHIPS, userId: 'u-alice', teamId: 'beta', successorUserId: 'u-dave',
  });
  assert.equal(plan.code, S.SUCCESSOR_NOT_A_MEMBER);
  const bare = S.planAdminHandover({ memberships: MEMBERSHIPS, userId: 'u-alice', teamId: 'beta' });
  assert.match(bare.message, /delete the team/i);
});

// ── The user-deletion decision (AC5) ───────────────────────────────────────

test('deleting a user is refused while they are the last admin of any team', () => {
  const plan = S.planUserDeletion({ memberships: MEMBERSHIPS, userId: 'u-alice' });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, S.LAST_TEAM_ADMIN);
  assert.deepEqual(plan.teamIds, ['beta', 'gamma']);
  // Every blocking team is named — offboarding is a task, and a refusal that
  // reports only the first one turns it into a guessing game.
  assert.match(plan.message, /'beta', 'gamma'/);
  assert.match(plan.message, /teams/, 'plural for more than one');
});

test('a co-admin and a plain member are both deletable', () => {
  assert.deepEqual(S.planUserDeletion({ memberships: MEMBERSHIPS, userId: 'u-bob' }), { ok: true, teamIds: [] });
  assert.deepEqual(S.planUserDeletion({ memberships: MEMBERSHIPS, userId: 'u-carol' }), { ok: true, teamIds: [] });
  assert.deepEqual(S.planUserDeletion({ memberships: [], userId: 'u-alice' }), { ok: true, teamIds: [] });
});

test('the single-team refusal reads in the singular', () => {
  const plan = S.planUserDeletion({
    memberships: [{ userId: 'u-alice', teamId: 'beta', role: 'team-admin' }], userId: 'u-alice',
  });
  assert.match(plan.message, /last Team Admin of team 'beta'/);
  assert.doesNotMatch(plan.message, /of teams/);
});

// ── Purity ─────────────────────────────────────────────────────────────────

test('no decision mutates the membership array it was handed', () => {
  const before = JSON.stringify(MEMBERSHIPS);
  S.planAdminHandover({ memberships: MEMBERSHIPS, userId: 'u-alice', teamId: 'gamma', successorUserId: 'u-dave' });
  S.planUserDeletion({ memberships: MEMBERSHIPS, userId: 'u-alice' });
  assert.equal(JSON.stringify(MEMBERSHIPS), before);
});
