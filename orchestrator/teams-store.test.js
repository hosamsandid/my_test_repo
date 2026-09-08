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

// ---- appendMemberships (the #2077 D6 fan-out) -----------------------------

test('appendMemberships writes memberships keyed on an Agent Team id', () => {
  const { store } = freshStore();
  const user = store.createUser({ subject: 'ada@corp.com' });
  // No team record exists for 'sdlc-2-0' — that is the whole point: after the
  // collapse the referent is an Agent Team config, which this store cannot see.
  assert.throws(() => store.setMembership({ userId: user.id, teamId: 'sdlc-2-0', role: 'team-admin' }), /Team.*not found/);

  const added = store.appendMemberships([
    { userId: user.id, teamId: 'sdlc-2-0', role: 'team-admin', fromScopeId: 'default' },
  ]);
  assert.equal(added.length, 1);
  assert.equal(added[0].teamId, 'sdlc-2-0');
  assert.equal(added[0].role, 'team-admin');
  assert.equal(added[0].fromScopeId, 'default');
  assert.ok(added[0].id && added[0].createdAt);
  assert.equal(store.listMemberships({ teamId: 'sdlc-2-0' }).length, 1);
});

test('appendMemberships is idempotent and never rewrites an existing role', () => {
  const { store } = freshStore();
  const user = store.createUser({ subject: 'bob@corp.com' });
  store.appendMemberships([{ userId: user.id, teamId: 'squad', role: 'team-member' }]);

  // A second run adds nothing (AC6) …
  assert.deepEqual(store.appendMemberships([{ userId: user.id, teamId: 'squad', role: 'team-member' }]), []);
  // … and a differing role does NOT overwrite the record that is already there.
  assert.deepEqual(store.appendMemberships([{ userId: user.id, teamId: 'squad', role: 'team-admin' }]), []);
  const held = store.listMemberships({ userId: user.id, teamId: 'squad' });
  assert.equal(held.length, 1);
  assert.equal(held[0].role, 'team-member');
});

test('appendMemberships skips malformed entries and writes nothing for an empty plan', () => {
  const { store } = freshStore();
  const user = store.createUser({ subject: 'cyd@corp.com' });
  assert.deepEqual(store.appendMemberships([]), []);
  assert.deepEqual(store.appendMemberships(null), []);
  assert.deepEqual(store.appendMemberships([
    { userId: user.id, teamId: 'squad', role: 'boss' },   // not a MEMBERSHIP_ROLE
    { userId: '', teamId: 'squad', role: 'team-member' }, // no user
    { userId: user.id, teamId: '', role: 'team-member' }, // no team
  ]), []);
  assert.equal(store.listMemberships().length, 0);
});

test('appendMemberships de-duplicates within one call', () => {
  const { store } = freshStore();
  const user = store.createUser({ subject: 'dee@corp.com' });
  const added = store.appendMemberships([
    { userId: user.id, teamId: 'squad', role: 'team-member' },
    { userId: user.id, teamId: 'squad', role: 'team-admin' },
  ]);
  assert.equal(added.length, 1);
  assert.equal(added[0].role, 'team-member');
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

  // demote then re-run: should re-promote the same record, not duplicate
  store.updateUser(created.id, { systemAdmin: false });
  const promoted = store.ensureSystemAdmin({ subject: 'admin@corp.com' });
  assert.equal(promoted.id, created.id);
  assert.equal(promoted.systemAdmin, true);
  assert.equal(store.listUsers().length, 1);
});
