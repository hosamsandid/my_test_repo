'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTeamsStore, DEFAULT_TEAM_ID, normalizeGithubHandle, coerceGithubHandle, coerceChatFontSize } = require('./teams-store');

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-store-'));
  return { store: createTeamsStore({ root }), root };
}

test('createTeamsStore requires a root', () => {
  assert.throws(() => createTeamsStore({}), /root.*required/);
});

// ---- local passwords (#374) -----------------------------------------------

test('passwords: set, verify, and never leak the hash', () => {
  const { store } = freshStore();
  const u = store.createUser({ subject: 'jane@corp.com', displayName: 'Jane' });
  assert.equal(u.passwordHash, undefined); // not set yet
  assert.equal(store.sanitizeUser(u).hasPassword, false); // sanitized flag reflects no password

  // No password yet → cannot log in.
  assert.equal(store.verifyUserCredentials('jane@corp.com', 'whatever'), null);

  const updated = store.setUserPassword(u.id, 's3cret-pass');
  assert.equal(updated.passwordHash, undefined); // sanitized return
  assert.equal(updated.hasPassword, true);       // now reflects a set password

  // The raw stored record carries a scrypt hash, but sanitizeUser hides it
  // behind the boolean flag.
  const raw = store.listUsers().find(x => x.id === u.id);
  assert.match(raw.passwordHash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(store.sanitizeUser(raw).passwordHash, undefined);
  assert.equal(store.sanitizeUser(raw).hasPassword, true);

  // Correct password → authenticated (matched by subject), wrong → null.
  const ok = store.verifyUserCredentials('jane@corp.com', 's3cret-pass');
  assert.equal(ok.subject, 'jane@corp.com');
  assert.equal(ok.passwordHash, undefined);
  assert.equal(store.verifyUserCredentials('jane@corp.com', 'wrong'), null);
  assert.equal(store.verifyUserCredentials('nobody@corp.com', 's3cret-pass'), null);
});

test('passwords: clearing disables login again', () => {
  const { store } = freshStore();
  const u = store.createUser({ subject: 'bob@corp.com' });
  store.setUserPassword(u.id, 'pw');
  assert.ok(store.verifyUserCredentials('bob@corp.com', 'pw'));
  const cleared = store.clearUserPassword(u.id);
  assert.equal(cleared.hasPassword, false); // flag flips back after a clear
  assert.equal(store.verifyUserCredentials('bob@corp.com', 'pw'), null);
});

test('passwords: setUserPassword requires an existing user and a non-empty password', () => {
  const { store } = freshStore();
  assert.throws(() => store.setUserPassword('nope', 'pw'), /not found/);
  const u = store.createUser({ subject: 'x@corp.com' });
  assert.throws(() => store.setUserPassword(u.id, ''), /password is required/);
});

// ---- teams ----------------------------------------------------------------

test('teams: create / get / list / update', () => {
  const { store } = freshStore();
  assert.deepEqual(store.listTeams(), []);

  const t = store.createTeam({ id: 'alpha', name: 'Alpha', description: 'first' });
  assert.equal(t.id, 'alpha');
  assert.equal(t.name, 'Alpha');
  assert.ok(t.createdAt && t.updatedAt);

  assert.equal(store.listTeams().length, 1);
  assert.equal(store.getTeam('alpha').name, 'Alpha');
  assert.equal(store.getTeam('nope'), null);

  const u = store.updateTeam('alpha', { name: 'Alpha Renamed' });
  assert.equal(u.name, 'Alpha Renamed');
  assert.equal(store.getTeam('alpha').name, 'Alpha Renamed');
});

test('teams: id validation and uniqueness', () => {
  const { store } = freshStore();
  assert.throws(() => store.createTeam({ id: 'Bad Id', name: 'x' }), /team id/);
  assert.throws(() => store.createTeam({ id: 'ok', name: '' }), /name is required/);
  store.createTeam({ id: 'ok', name: 'OK' });
  assert.throws(() => store.createTeam({ id: 'ok', name: 'dup' }), /already exists/);
});

test('teams: default team cannot be deleted', () => {
  const { store } = freshStore();
  store.ensureDefaultTeam();
  assert.throws(() => store.deleteTeam(DEFAULT_TEAM_ID), /cannot be deleted/);
});

test('teams: delete cascades memberships', () => {
  const { store } = freshStore();
  store.createTeam({ id: 'beta', name: 'Beta' });
  const user = store.createUser({ subject: 'a@example.com' });
  store.setMembership({ userId: user.id, teamId: 'beta', role: 'team-admin' });
  assert.equal(store.listMemberships({ teamId: 'beta' }).length, 1);

  store.deleteTeam('beta');
  assert.equal(store.getTeam('beta'), null);
  assert.equal(store.listMemberships({ teamId: 'beta' }).length, 0);
});

// ---- users ----------------------------------------------------------------

test('users: create / lookup by subject / promote', () => {
  const { store } = freshStore();
  const u = store.createUser({ subject: 'jane@corp.com', displayName: 'Jane' });
  assert.ok(u.id);
  assert.equal(u.systemAdmin, false);
  assert.equal(u.displayName, 'Jane');

  assert.equal(store.getUserBySubject('JANE@corp.com').id, u.id, 'subject lookup is case-insensitive');
  assert.throws(() => store.createUser({ subject: 'jane@corp.com' }), /already exists/);

  const promoted = store.updateUser(u.id, { systemAdmin: true });
  assert.equal(promoted.systemAdmin, true);
});

test('users: subject required', () => {
  const { store } = freshStore();
  assert.throws(() => store.createUser({ displayName: 'x' }), /subject is required/);
});

// ---- GitHub handle (#1385) ------------------------------------------------

test('githubHandle: normalize strips leading @ and whitespace', () => {
  assert.equal(normalizeGithubHandle('  @octocat  '), 'octocat');
  assert.equal(normalizeGithubHandle('octocat'), 'octocat');
  assert.equal(normalizeGithubHandle('   '), '');
  assert.equal(normalizeGithubHandle('@'), '');
  assert.equal(normalizeGithubHandle(undefined), '');
  assert.equal(normalizeGithubHandle(42), '');
});

test('githubHandle: coerce validates the GitHub username rules', () => {
  assert.equal(coerceGithubHandle('@octocat'), 'octocat');
  assert.equal(coerceGithubHandle('mona-lisa-9'), 'mona-lisa-9');
  assert.equal(coerceGithubHandle(''), '');       // blank clears
  assert.equal(coerceGithubHandle(undefined), ''); // absent clears
  assert.throws(() => coerceGithubHandle('-bad'), /may not start or end with a hyphen/);
  assert.throws(() => coerceGithubHandle('bad-'), /may not start or end with a hyphen/);
  assert.throws(() => coerceGithubHandle('has space'), /letters, digits, and hyphens/);
  assert.throws(() => coerceGithubHandle('a'.repeat(40)), /39 characters or fewer/);
});

test('githubHandle: persisted on create, defaults to empty, updatable and clearable', () => {
  const { store } = freshStore();
  // Absent on create → empty string, not undefined.
  const plain = store.createUser({ subject: 'plain@corp.com' });
  assert.equal(plain.githubHandle, '');

  // Provided on create → normalized and stored.
  const u = store.createUser({ subject: 'jane@corp.com', githubHandle: '@jane-gh' });
  assert.equal(u.githubHandle, 'jane-gh');
  assert.equal(store.getUser(u.id).githubHandle, 'jane-gh');

  // Update sets a new value.
  assert.equal(store.updateUser(u.id, { githubHandle: 'jane2' }).githubHandle, 'jane2');
  // Blank clears it; an untouched update leaves it alone.
  assert.equal(store.updateUser(u.id, { githubHandle: '  ' }).githubHandle, '');
  store.updateUser(u.id, { githubHandle: 'jane3' });
  assert.equal(store.updateUser(u.id, { displayName: 'Jane' }).githubHandle, 'jane3');

  // An invalid handle is rejected at the store boundary.
  assert.throws(() => store.updateUser(u.id, { githubHandle: 'bad handle' }), /letters, digits, and hyphens/);
});

// ---- chat font size (#1437) -----------------------------------------------

test('chatFontSize: coerce validates the integer range [10,18]', () => {
  assert.equal(coerceChatFontSize(12), 12);
  assert.equal(coerceChatFontSize('16'), 16);
  assert.equal(coerceChatFontSize(undefined), undefined); // absent → unset
  assert.equal(coerceChatFontSize(null), undefined);
  assert.equal(coerceChatFontSize(''), undefined);
  assert.throws(() => coerceChatFontSize(9), /between 10 and 18/);
  assert.throws(() => coerceChatFontSize(19), /between 10 and 18/);
  assert.throws(() => coerceChatFontSize(12.5), /must be an integer/);
  assert.throws(() => coerceChatFontSize('big'), /must be an integer/);
});

test('chatFontSize: only persisted when set; updatable and clearable', () => {
  const { store } = freshStore();
  // Absent on create → the field is not written (session default applies).
  const plain = store.createUser({ subject: 'plain@corp.com' });
  assert.equal(plain.chatFontSize, undefined);

  // Provided on create → validated and stored.
  const u = store.createUser({ subject: 'jane@corp.com', chatFontSize: 16 });
  assert.equal(u.chatFontSize, 16);
  assert.equal(store.getUser(u.id).chatFontSize, 16);

  // Update sets a new value; a blank clears it back to unset.
  assert.equal(store.updateUser(u.id, { chatFontSize: 10 }).chatFontSize, 10);
  assert.equal(store.updateUser(u.id, { chatFontSize: '' }).chatFontSize, undefined);
  // An untouched update leaves an existing value alone.
  store.updateUser(u.id, { chatFontSize: 14 });
  assert.equal(store.updateUser(u.id, { displayName: 'Jane' }).chatFontSize, 14);

  // An out-of-range value is rejected at the store boundary.
  assert.throws(() => store.updateUser(u.id, { chatFontSize: 42 }), /between 10 and 18/);
});

test('users: delete cascades memberships', () => {
  const { store } = freshStore();
  store.createTeam({ id: 'gamma', name: 'Gamma' });
  const user = store.createUser({ subject: 'bob@corp.com' });
  store.setMembership({ userId: user.id, teamId: 'gamma', role: 'team-member' });

  store.deleteUser(user.id);
  assert.equal(store.getUser(user.id), null);
  assert.equal(store.listMemberships({ userId: user.id }).length, 0);
});

// ---- memberships ----------------------------------------------------------

test('memberships: upsert keeps one record per (user, team)', () => {
  const { store } = freshStore();
  store.createTeam({ id: 't1', name: 'T1' });
  const user = store.createUser({ subject: 'm@corp.com' });

  const first = store.setMembership({ userId: user.id, teamId: 't1', role: 'team-member' });
  const second = store.setMembership({ userId: user.id, teamId: 't1', role: 'team-admin' });
  assert.equal(first.id, second.id, 'same membership record is reused');
  assert.equal(second.role, 'team-admin');
  assert.equal(store.listMemberships({ userId: user.id, teamId: 't1' }).length, 1);
});

test('memberships: a user can hold different roles across teams', () => {
  const { store } = freshStore();
  store.createTeam({ id: 't1', name: 'T1' });
  store.createTeam({ id: 't2', name: 'T2' });
  const user = store.createUser({ subject: 'multi@corp.com' });
  store.setMembership({ userId: user.id, teamId: 't1', role: 'team-admin' });
  store.setMembership({ userId: user.id, teamId: 't2', role: 'team-member' });
  const mine = store.listMemberships({ userId: user.id });
  assert.equal(mine.length, 2);
  assert.equal(mine.find(m => m.teamId === 't1').role, 'team-admin');
  assert.equal(mine.find(m => m.teamId === 't2').role, 'team-member');
});

test('memberships: referential integrity and role validation', () => {
  const { store } = freshStore();
  store.createTeam({ id: 't1', name: 'T1' });
  const user = store.createUser({ subject: 'r@corp.com' });
  assert.throws(() => store.setMembership({ userId: user.id, teamId: 't1', role: 'boss' }), /role must be one of/);
  assert.throws(() => store.setMembership({ userId: 'ghost', teamId: 't1', role: 'team-member' }), /User.*not found/);
  assert.throws(() => store.setMembership({ userId: user.id, teamId: 'ghost', role: 'team-member' }), /Team.*not found/);
});

test('memberships: remove', () => {
  const { store } = freshStore();
  store.createTeam({ id: 't1', name: 'T1' });
  const user = store.createUser({ subject: 'x@corp.com' });
  store.setMembership({ userId: user.id, teamId: 't1', role: 'team-member' });
  store.removeMembership({ userId: user.id, teamId: 't1' });
  assert.equal(store.listMemberships({ teamId: 't1' }).length, 0);
  assert.throws(() => store.removeMembership({ userId: user.id, teamId: 't1' }), /No membership/);
});

// ---- bootstrap ------------------------------------------------------------

test('ensureDefaultTeam is idempotent', () => {
  const { store } = freshStore();
  const a = store.ensureDefaultTeam();
  const b = store.ensureDefaultTeam();
  assert.equal(a.id, DEFAULT_TEAM_ID);
  assert.equal(b.id, DEFAULT_TEAM_ID);
  assert.equal(store.listTeams().length, 1);
});

test('ensureSystemAdmin creates then promotes idempotently', () => {
  const { store } = freshStore();
  assert.equal(store.ensureSystemAdmin({}), null, 'no subject => no-op');

  const created = store.ensureSystemAdmin({ subject: 'admin@corp.com', displayName: 'Admin' });
  assert.equal(created.systemAdmin, true);

  // A second System Admin, so the demotion below is not the #2059 AC7 case (the
  // last System Admin may not be demoted). Without it this test would be
  // asserting the promote path through a refusal.
  store.createUser({ subject: 'second@corp.com', systemAdmin: true });

  // demote then re-run: should re-promote the same record, not duplicate
  store.updateUser(created.id, { systemAdmin: false });
  const promoted = store.ensureSystemAdmin({ subject: 'admin@corp.com' });
  assert.equal(promoted.id, created.id);
  assert.equal(promoted.systemAdmin, true);
  assert.equal(store.listUsers().length, 2);
});

// ---- the configured initial user is a seed, not a login (#2059) -------------

test('seedInitialSystemAdmin seeds one System Admin WITH its password on an empty stack', () => {
  const { store } = freshStore();
  const seeded = store.seedInitialSystemAdmin({
    subject: 'admin', password: 'seed-pass', displayName: 'Administrator', email: 'ops@corp.com',
  });

  assert.equal(store.listUsers().length, 1, 'exactly one record');
  assert.equal(seeded.subject, 'admin');
  assert.equal(seeded.systemAdmin, true);
  assert.equal(seeded.displayName, 'Administrator');
  assert.equal(seeded.email, 'ops@corp.com');
  // The return value is sanitized like every other user leaving the store.
  assert.equal(seeded.passwordHash, undefined, 'the hash never leaves the store');
  assert.equal(seeded.hasPassword, true);

  // AC2/AC9: the seeded credential really signs in, and resolves to that record.
  const verified = store.verifyUserCredentials('admin', 'seed-pass');
  assert.ok(verified, 'the seeded password authenticates');
  assert.equal(verified.id, seeded.id);
  assert.equal(store.verifyUserCredentials('admin', 'wrong'), null);
});

test('seedInitialSystemAdmin is inert once ANY user exists, and needs a subject', () => {
  const { store } = freshStore();
  assert.equal(store.seedInitialSystemAdmin({}), null, 'no subject => no-op');
  assert.equal(store.seedInitialSystemAdmin({ subject: '  ', password: 'p' }), null, 'blank subject => no-op');
  assert.equal(store.listUsers().length, 0);

  // AC1: a second pass on the same stack changes nothing (idempotent).
  const first = store.seedInitialSystemAdmin({ subject: 'admin', password: 'seed-pass' });
  const again = store.seedInitialSystemAdmin({ subject: 'admin', password: 'seed-pass' });
  assert.equal(again, null, 'the pass is inert on a warm stack');
  assert.equal(store.listUsers().length, 1);
  assert.equal(store.getUser(first.id).updatedAt, first.updatedAt, 'the record is not even touched');

  // AC1: a warm stack is unaffected even when the configured subject differs —
  // the seed cannot mint a second administrator after first boot.
  assert.equal(store.seedInitialSystemAdmin({ subject: 'someone-else', password: 'p' }), null);
  assert.equal(store.listUsers().length, 1);

  // ...and not even when the only existing record is an ordinary member: the
  // gate is "zero users", not "zero System Admins".
  const { store: other } = freshStore();
  other.createUser({ subject: 'plain@corp.com' });
  assert.equal(other.seedInitialSystemAdmin({ subject: 'admin', password: 'p' }), null);
  assert.equal(other.listUsers().length, 1);
  assert.equal(other.getUserBySubject('plain@corp.com').systemAdmin, false);
});

test('seedInitialSystemAdmin without a password creates a record that cannot password-login (SSO stacks)', () => {
  const { store } = freshStore();
  const seeded = store.seedInitialSystemAdmin({ subject: 'ops@corp.com' });
  assert.equal(seeded.systemAdmin, true);
  assert.equal(seeded.hasPassword, false);
  // `verifyUserCredentials` requires a passwordHash, so no password gets in.
  assert.equal(store.verifyUserCredentials('ops@corp.com', ''), null);
  assert.equal(store.verifyUserCredentials('ops@corp.com', 'anything'), null);
});

// ---- the last System Admin is protected (#2059 AC7 / #2041 AC18) -----------

test('users: the last System Admin cannot be deleted or demoted', () => {
  const { store } = freshStore();
  const admin = store.seedInitialSystemAdmin({ subject: 'admin', password: 'pw' });
  const member = store.createUser({ subject: 'member@corp.com' });

  assert.throws(() => store.deleteUser(admin.id), /last System Admin cannot be deleted/);
  assert.throws(() => store.updateUser(admin.id, { systemAdmin: false }), /last System Admin cannot be demoted/);
  // Refused server-side means refused: the record is untouched, not partially
  // edited (the systemAdmin branch runs before the write).
  assert.equal(store.getUser(admin.id).systemAdmin, true);

  // An ordinary member is unaffected in both directions.
  store.updateUser(member.id, { systemAdmin: false });
  store.deleteUser(member.id);
  assert.equal(store.getUser(member.id), null);
});

test('users: a second System Admin unblocks both actions, and other edits are never blocked', () => {
  const { store } = freshStore();
  const first = store.seedInitialSystemAdmin({ subject: 'admin', password: 'pw' });

  // Editing the last admin's other fields — including re-asserting the flag —
  // is not a demotion and must stay allowed.
  store.updateUser(first.id, { displayName: 'Renamed', systemAdmin: true });
  assert.equal(store.getUser(first.id).displayName, 'Renamed');

  const second = store.createUser({ subject: 'second@corp.com', systemAdmin: true });
  store.updateUser(first.id, { systemAdmin: false });
  assert.equal(store.getUser(first.id).systemAdmin, false);

  // `second` is now the last one, so it inherits the protection.
  assert.throws(() => store.deleteUser(second.id), /last System Admin cannot be deleted/);
  // The demoted record is an ordinary user again and deletes cleanly.
  store.deleteUser(first.id);
  assert.equal(store.listUsers().length, 1);
});

test('isLastSystemAdmin: no System Admin at all means nothing to protect', () => {
  const { isLastSystemAdmin } = require('./teams-store');
  assert.equal(isLastSystemAdmin([{ id: 'a' }, { id: 'b' }], 'a'), false, 'zero admins');
  assert.equal(isLastSystemAdmin([{ id: 'a', systemAdmin: true }], 'a'), true);
  assert.equal(isLastSystemAdmin([{ id: 'a', systemAdmin: true }], 'b'), false, 'not the admin');
  assert.equal(
    isLastSystemAdmin([{ id: 'a', systemAdmin: true }, { id: 'b', systemAdmin: true }], 'a'),
    false, 'two admins',
  );
  assert.equal(isLastSystemAdmin(null, 'a'), false, 'tolerates a missing list');

  // A truthy-but-not-true flag is not a System Admin anywhere else in the
  // store (`systemAdmin === true` on create/update), so it must not count here.
  assert.equal(isLastSystemAdmin([{ id: 'a', systemAdmin: 'yes' }], 'a'), false);
});

// The store-side deletion guard is what the Users page mirrors; a legacy stack
// with a single non-admin user must still be able to delete it, which is the
// case the "zero admins" branch above protects.
test('users: a lone ordinary user (legacy stack, no System Admin) is still deletable', () => {
  const { store } = freshStore();
  const only = store.createUser({ subject: 'lonely@corp.com' });
  store.deleteUser(only.id);
  assert.equal(store.listUsers().length, 0);
});
