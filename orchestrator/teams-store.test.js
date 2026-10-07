'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTeamsStore, DEFAULT_TEAM_ID, normalizeGithubHandle, coerceGithubHandle, coerceChatFontSize, coerceChatNotifyOnBack, coerceChatListFilter, coerceFlowsListFilter, isValidEmail, INVALID_EMAIL_REASON } = require('./teams-store');

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-store-'));
  return { store: createTeamsStore({ root }), root };
}

test('createTeamsStore requires a root', () => {
  assert.throws(() => createTeamsStore({}), /root.*required/);
});

// ---- Matrix identity pointer (#1458) --------------------------------------

test('matrix identity: a new user has no pointer until one is stamped', () => {
  const { store } = freshStore();
  const u = store.createUser({ subject: 'jane@corp.com', displayName: 'Jane' });
  assert.equal(u.matrixUserId, undefined);
  assert.equal(store.getUser(u.id).matrixUserId, undefined);
});

test('matrix identity: setUserMatrixIdentity persists the pointer and bumps updatedAt', () => {
  const { store } = freshStore();
  const u = store.createUser({ subject: 'jane@corp.com', displayName: 'Jane' });
  const stamped = store.setUserMatrixIdentity(u.id, '@u-0123456789abcdef:local');
  assert.equal(stamped.matrixUserId, '@u-0123456789abcdef:local');
  assert.equal(store.getUser(u.id).matrixUserId, '@u-0123456789abcdef:local');
  assert.ok(store.getUser(u.id).updatedAt >= u.updatedAt);
});

test('matrix identity: re-stamping replaces the pointer (idempotent re-provisioning)', () => {
  const { store } = freshStore();
  const u = store.createUser({ subject: 'jane@corp.com' });
  store.setUserMatrixIdentity(u.id, '@u-1111111111111111:local');
  store.setUserMatrixIdentity(u.id, '@u-2222222222222222:local');
  assert.equal(store.getUser(u.id).matrixUserId, '@u-2222222222222222:local');
});

test('matrix identity: the pointer survives sanitizeUser — it is public, not a secret', () => {
  // The localpart is visible to every member of every room the human joins, so
  // unlike passwordHash it must NOT be stripped: consumers need it to resolve
  // "which Matrix account is this human?".
  const { store } = freshStore();
  const u = store.createUser({ subject: 'jane@corp.com' });
  store.setUserMatrixIdentity(u.id, '@u-0123456789abcdef:local');
  assert.equal(store.sanitizeUser(store.getUser(u.id)).matrixUserId, '@u-0123456789abcdef:local');
});

test('matrix identity: setUserMatrixIdentity validates its inputs', () => {
  const { store } = freshStore();
  const u = store.createUser({ subject: 'jane@corp.com' });
  assert.throws(() => store.setUserMatrixIdentity('nope', '@u-1:local'), /not found/);
  assert.throws(() => store.setUserMatrixIdentity(u.id, ''), /matrixUserId is required/);
  assert.throws(() => store.setUserMatrixIdentity(u.id, '   '), /matrixUserId is required/);
});

test('matrix identity: a service account can never be stamped as a person (#2721 AC7)', () => {
  const { store } = freshStore();
  const u = store.createUser({ subject: 'jane@corp.com' });
  for (const service of ['@k-zyskowski_accent:local', '@admin:local', '@my-assistant:local', '@u-payments:local']) {
    assert.throws(() => store.setUserMatrixIdentity(u.id, service), /personal Matrix identity/);
  }
  assert.equal(store.getUser(u.id).matrixUserId, undefined);
});

test('matrix identity: clearNonPersonalMatrixIdentities drops shared-admin pointers only (#2721 AC7)', () => {
  const { store, root } = freshStore();
  const a = store.createUser({ subject: 'admin@corp.com', systemAdmin: true });
  const b = store.createUser({ subject: 'jane@corp.com' });
  store.setUserMatrixIdentity(b.id, '@u-0123456789abcdef:local');
  // Simulate a record pointed at the shared admin account by an older build.
  const indexPath = path.join(root, 'users', 'index.json');
  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  raw.find(r => r.id === a.id).matrixUserId = '@k-zyskowski_accent:local';
  fs.writeFileSync(indexPath, JSON.stringify(raw));

  assert.deepEqual(store.clearNonPersonalMatrixIdentities(), [a.id]);
  assert.equal(store.getUser(a.id).matrixUserId, undefined);
  assert.equal(store.getUser(b.id).matrixUserId, '@u-0123456789abcdef:local');
  assert.deepEqual(store.clearNonPersonalMatrixIdentities(), [], 'idempotent');
});

test('matrix identity: deleting a user drops the pointer with the record', () => {
  const { store } = freshStore();
  const u = store.createUser({ subject: 'jane@corp.com' });
  store.setUserMatrixIdentity(u.id, '@u-0123456789abcdef:local');
  store.deleteUser(u.id);
  assert.equal(store.getUser(u.id), null);
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

// ---- chat "agent is back" notification opt-in (#2397) ---------------------

test('chatNotifyOnBack: coerce accepts booleans, treats blank as unset, rejects non-booleans', () => {
  assert.equal(coerceChatNotifyOnBack(true), true);
  assert.equal(coerceChatNotifyOnBack(false), false);
  assert.equal(coerceChatNotifyOnBack(undefined), undefined); // absent → unset
  assert.equal(coerceChatNotifyOnBack(null), undefined);
  assert.equal(coerceChatNotifyOnBack(''), undefined);
  assert.throws(() => coerceChatNotifyOnBack('yes'), /must be a boolean/);
  assert.throws(() => coerceChatNotifyOnBack(1), /must be a boolean/);
});

test('chatNotifyOnBack: only persisted when true; false/blank clears it', () => {
  const { store } = freshStore();
  // Off by default → the field is never written.
  const plain = store.createUser({ subject: 'plain2@corp.com' });
  assert.equal(plain.chatNotifyOnBack, undefined);
  // Explicit false on create is still not stored (off is the default).
  const off = store.createUser({ subject: 'off@corp.com', chatNotifyOnBack: false });
  assert.equal(off.chatNotifyOnBack, undefined);
  // Explicit true on create is stored.
  const on = store.createUser({ subject: 'on@corp.com', chatNotifyOnBack: true });
  assert.equal(on.chatNotifyOnBack, true);
  assert.equal(store.getUser(on.id).chatNotifyOnBack, true);

  // Update toggles it and clears it.
  assert.equal(store.updateUser(plain.id, { chatNotifyOnBack: true }).chatNotifyOnBack, true);
  assert.equal(store.updateUser(plain.id, { chatNotifyOnBack: false }).chatNotifyOnBack, undefined);
  // An untouched update leaves an existing value alone.
  store.updateUser(plain.id, { chatNotifyOnBack: true });
  assert.equal(store.updateUser(plain.id, { displayName: 'Plain' }).chatNotifyOnBack, true);
  // A non-boolean is rejected at the store boundary.
  assert.throws(() => store.updateUser(plain.id, { chatNotifyOnBack: 'on' }), /must be a boolean/);
});

// ---- Agent-Chat rail team selection (#2740) -------------------------------

test('chatListFilter: coerce accepts { hidden: string[] }, folds duplicates, treats blank as unset', () => {
  assert.deepEqual(coerceChatListFilter({ hidden: ['team:a', 'singles', 'team:a'] }), { hidden: ['team:a', 'singles'] });
  assert.deepEqual(coerceChatListFilter({ hidden: [] }), { hidden: [] });
  assert.equal(coerceChatListFilter(undefined), undefined);
  assert.equal(coerceChatListFilter(null), undefined);
  assert.equal(coerceChatListFilter(''), undefined);
  assert.throws(() => coerceChatListFilter(['team:a']), /hidden array/);
  assert.throws(() => coerceChatListFilter({ hidden: 'team:a' }), /hidden array/);
  assert.throws(() => coerceChatListFilter({ hidden: [42] }), /non-empty strings/);
  assert.throws(() => coerceChatListFilter({ hidden: [''] }), /non-empty strings/);
  assert.throws(() => coerceChatListFilter({ hidden: ['x'.repeat(513)] }), /non-empty strings/);
  const tooMany = Array.from({ length: 2001 }, (_, i) => `team:t${i}`);
  assert.throws(() => coerceChatListFilter({ hidden: tooMany }), /at most 2000/);
});

test('chatListFilter: an oversized hidden array is rejected before its entries are inspected', () => {
  // 2001 non-string entries: the size check must fire first, not the per-key one.
  assert.throws(() => coerceChatListFilter({ hidden: Array(2001).fill(42) }), /at most 2000 entries/);
  // A huge array must be rejected without iterating it (no O(n²) dedupe on the event loop).
  const huge = new Proxy(Array(1_000_000).fill('team:x'), {
    get(target, prop, receiver) {
      if (prop === Symbol.iterator) throw new Error('hidden was iterated');
      return Reflect.get(target, prop, receiver);
    },
  });
  assert.throws(() => coerceChatListFilter({ hidden: huge }), /at most 2000 entries/);
  // Duplicates up to the cap are still folded.
  assert.deepEqual(coerceChatListFilter({ hidden: Array(2000).fill('team:a') }), { hidden: ['team:a'] });
});

test('chatListFilter: update stores it, leaves it alone when absent, blank clears it', () => {
  const { store } = freshStore();
  const u = store.createUser({ subject: 'filter@corp.com' });
  assert.equal(u.chatListFilter, undefined);
  assert.deepEqual(store.updateUser(u.id, { chatListFilter: { hidden: ['team:a'] } }).chatListFilter, { hidden: ['team:a'] });
  assert.deepEqual(store.getUser(u.id).chatListFilter, { hidden: ['team:a'] });
  // An untouched update leaves the saved selection alone.
  assert.deepEqual(store.updateUser(u.id, { displayName: 'F' }).chatListFilter, { hidden: ['team:a'] });
  // Unknown properties are not carried over into the stored record.
  assert.deepEqual(store.updateUser(u.id, { chatListFilter: { hidden: [], extra: 1 } }).chatListFilter, { hidden: [] });
  assert.equal(store.updateUser(u.id, { chatListFilter: null }).chatListFilter, undefined);
  assert.throws(() => store.updateUser(u.id, { chatListFilter: { hidden: [1] } }), /non-empty strings/);
});

// ---- Flows rail selection (#2859) -----------------------------------------

test('flowsListFilter: same shape and bounds as chatListFilter, stored separately', () => {
  assert.deepEqual(coerceFlowsListFilter({ hidden: ['draft:a', 'team:b', 'draft:a'] }), { hidden: ['draft:a', 'team:b'] });
  assert.equal(coerceFlowsListFilter(null), undefined);
  assert.throws(() => coerceFlowsListFilter({ hidden: 'draft:a' }), /flowsListFilter must be an object/);
  assert.throws(() => coerceFlowsListFilter({ hidden: [''] }), /flowsListFilter\.hidden entries/);
  assert.throws(() => coerceFlowsListFilter({ hidden: Array(2001).fill('x') }), /at most 2000/);
  const { store } = freshStore();
  const u = store.createUser({ subject: 'flows@corp.com' });
  store.updateUser(u.id, { chatListFilter: { hidden: ['team:c'] } });
  assert.deepEqual(store.updateUser(u.id, { flowsListFilter: { hidden: ['draft:x'] } }).flowsListFilter, { hidden: ['draft:x'] });
  // The two preferences never overwrite each other.
  assert.deepEqual(store.getUser(u.id).chatListFilter, { hidden: ['team:c'] });
  assert.deepEqual(store.updateUser(u.id, { chatListFilter: null }).flowsListFilter, { hidden: ['draft:x'] });
  assert.equal(store.updateUser(u.id, { flowsListFilter: '' }).flowsListFilter, undefined);
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

// ---- Email validation (#2695 finding 88) -----------------------------------

test('users: a malformed email is refused on create and on update (400)', () => {
  const { store } = freshStore();
  for (const bad of ['not-an-email', 'jane@corp', '@corp.com', 'jane doe@corp.com', 'jane@@corp.com']) {
    assert.throws(() => store.createUser({ subject: `s-${bad}`, email: bad }), (err) => {
      assert.equal(err.statusHint, 400);
      assert.equal(err.code, 'invalid-email');
      assert.equal(err.message, INVALID_EMAIL_REASON);
      return true;
    }, bad);
  }
  assert.equal(store.listUsers().length, 0, 'a refused create must not persist a record');

  const u = store.createUser({ subject: 'jane', email: ' jane.doe@corp.com ' });
  assert.equal(u.email, 'jane.doe@corp.com');
  assert.throws(() => store.updateUser(u.id, { email: 'not-an-email' }), (err) => err.statusHint === 400);
  assert.equal(store.getUser(u.id).email, 'jane.doe@corp.com', 'a refused update keeps the stored email');
  // Blank still clears — the field stays optional.
  assert.equal(store.updateUser(u.id, { email: '  ' }).email, '');
  assert.equal(store.createUser({ subject: 'no-mail' }).email, '');
});

test('users: a malformed configured seed email is dropped, not fatal to seeding', () => {
  const { store } = freshStore();
  const seeded = store.seedInitialSystemAdmin({ subject: 'admin', email: 'not-an-email' });
  assert.ok(seeded && seeded.systemAdmin);
  assert.equal(seeded.email, '');
});

test('isValidEmail accepts plausible addresses only', () => {
  for (const ok of ['a@b.co', 'jane.doe+x@corp.example.com']) assert.equal(isValidEmail(ok), true, ok);
  for (const bad of ['', 'x', 'a@b', 'a b@c.d', null, 42]) assert.equal(isValidEmail(bad), false, String(bad));
});
