import test from 'node:test';
import assert from 'node:assert/strict';

import { createRequire } from 'node:module';

import {
  systemAdminLabel, passwordLabel, chatIdentityLabel, chatIdentityDetail, usersToRows, isSelf, selfActionWarning, validateUserForm,
  isLastSystemAdmin, lastSystemAdminGuard, isValidEmail, INVALID_EMAIL_REASON,
} from './users-view.js';

test('systemAdminLabel / passwordLabel reflect the record flags', () => {
  assert.equal(systemAdminLabel({ systemAdmin: true }), 'System Admin');
  assert.equal(systemAdminLabel({ systemAdmin: false }), 'Member');
  assert.equal(systemAdminLabel(null), 'Member');
  assert.equal(passwordLabel({ hasPassword: true }), 'Set');
  assert.equal(passwordLabel({ hasPassword: false }), 'None');
  assert.equal(passwordLabel({}), 'None');
});

test('usersToRows flattens sortable/filterable keys and preserves the record', () => {
  const users = [
    { id: 'a', subject: 'jane@corp.com', displayName: 'Jane', email: 'jane@corp.com', systemAdmin: true, hasPassword: true },
    { id: 'b', subject: 'bob@corp.com', displayName: '', email: '', systemAdmin: false, hasPassword: false },
  ];
  const rows = usersToRows(users);
  assert.equal(rows[0].displayName, 'Jane');
  assert.equal(rows[0].systemAdminLabel, 'System Admin');
  assert.equal(rows[0].passwordLabel, 'Set');
  assert.equal(rows[0]._user, users[0]);
  // A blank display name falls back to the subject so the column is never empty.
  assert.equal(rows[1].displayName, 'bob@corp.com');
  assert.equal(rows[1].systemAdminLabel, 'Member');
  assert.equal(rows[1].passwordLabel, 'None');
});

test('usersToRows tolerates non-array input', () => {
  assert.deepEqual(usersToRows(null), []);
  assert.deepEqual(usersToRows(undefined), []);
});

test('isSelf matches by userId when present, else by subject', () => {
  const row = { id: 'u1', subject: 'jane@corp.com' };
  assert.equal(isSelf({ userId: 'u1', username: 'jane@corp.com' }, row), true);
  assert.equal(isSelf({ userId: 'u2', username: 'jane@corp.com' }, row), false); // userId wins when both sides have it
  assert.equal(isSelf({ username: 'jane@corp.com' }, row), true);                // subject fallback
  assert.equal(isSelf({ username: 'someone-else' }, row), false);
  assert.equal(isSelf(null, row), false);
  assert.equal(isSelf({ username: 'jane@corp.com' }, null), false);
  // A principal whose username matches no row's subject is not self. (Before
  // #2059 this was the env single-admin's permanent state; now it only happens
  // for a subject with no record, which can no longer sign in.)
  assert.equal(isSelf({ username: 'admin' }, row), false);
  // The seeded administrator (#2059) DOES match its own row, by id.
  assert.equal(isSelf({ userId: 'u-seed', username: 'admin' }, { id: 'u-seed', subject: 'admin' }), true);
});

test('selfActionWarning warns on self-lockout paths only', () => {
  const me = { userId: 'u1', username: 'jane@corp.com' };
  const self = { id: 'u1', subject: 'jane@corp.com', systemAdmin: true };
  const other = { id: 'u2', subject: 'bob@corp.com', systemAdmin: true };

  // Deleting yourself warns.
  assert.match(selfActionWarning({ me, target: self, action: 'delete' }), /own account/);
  // Deleting someone else does not.
  assert.equal(selfActionWarning({ me, target: other, action: 'delete' }), null);
  // Removing your own System-Admin warns.
  assert.match(selfActionWarning({ me, target: self, action: 'edit', nextSystemAdmin: false }), /administrative access/);
  // Keeping your own System-Admin (or a no-op) does not warn.
  assert.equal(selfActionWarning({ me, target: self, action: 'edit', nextSystemAdmin: true }), null);
  // Removing someone else's System-Admin does not warn about self-lockout. It
  // may still be REFUSED, but by the estate-level rule below, not by this one —
  // the two guards answer different questions and both can be live at once.
  assert.equal(selfActionWarning({ me, target: other, action: 'edit', nextSystemAdmin: false }), null);
});

test('validateUserForm mirrors backend create/edit rules', () => {
  // Create: subject required, display name optional.
  assert.match(validateUserForm({ subject: '', displayName: 'Jane' }, 'create'), /Subject is required/);
  assert.equal(validateUserForm({ subject: 'jane@corp.com', displayName: '' }, 'create'), null);
  // Edit: display name required (subject is immutable, not validated here).
  assert.match(validateUserForm({ subject: 'jane@corp.com', displayName: '   ' }, 'edit'), /cannot be empty/);
  assert.equal(validateUserForm({ subject: 'jane@corp.com', displayName: 'Jane' }, 'edit'), null);
});

// ── email format (#2695 finding 88) ────────────────────────────────────────

test('validateUserForm rejects a malformed email in both modes; blank stays optional', () => {
  for (const mode of ['create', 'edit']) {
    const base = { subject: 'jane', displayName: 'Jane' };
    assert.equal(validateUserForm({ ...base, email: 'not-an-email' }, mode), INVALID_EMAIL_REASON, mode);
    assert.equal(validateUserForm({ ...base, email: 'jane@corp' }, mode), INVALID_EMAIL_REASON, mode);
    assert.equal(validateUserForm({ ...base, email: ' jane.doe@corp.com ' }, mode), null, mode);
    assert.equal(validateUserForm({ ...base, email: '' }, mode), null, mode);
    assert.equal(validateUserForm({ ...base, email: undefined }, mode), null, mode);
  }
  // The required-field message still wins over the email one.
  assert.match(validateUserForm({ subject: '', email: 'x' }, 'create'), /Subject is required/);
});

test('the email rule and sentence match the store exactly (two containers, one rule)', () => {
  const require_ = createRequire(import.meta.url);
  const store = require_('../../../orchestrator/teams-store.js');
  assert.equal(INVALID_EMAIL_REASON, store.INVALID_EMAIL_REASON);
  for (const v of ['a@b.co', 'jane.doe+x@corp.example.com', ' a@b.co ', '', 'x', 'a@b', 'a b@c.d', '@b.co', 'a@@b.co', 'a@b.', null]) {
    assert.equal(isValidEmail(v), store.isValidEmail(v), `disagree on ${JSON.stringify(v)}`);
  }
});


// ── the last System Admin (#2059 AC7) ──────────────────────────────────────

const seeded = { id: 'u-seed', subject: 'admin', systemAdmin: true };
const second = { id: 'u-2', subject: 'ops@corp.com', systemAdmin: true };
const member = { id: 'u-m', subject: 'bob@corp.com' };

test('isLastSystemAdmin mirrors the store, including its strictness', () => {
  assert.equal(isLastSystemAdmin([seeded, member], seeded), true);
  assert.equal(isLastSystemAdmin([seeded, member], member), false, 'not an admin');
  assert.equal(isLastSystemAdmin([seeded, second], seeded), false, 'two admins');
  // Zero System Admins → nothing to protect, so a legacy stack's lone ordinary
  // user stays deletable.
  assert.equal(isLastSystemAdmin([member], member), false);
  // Fail-safe on missing input: never claim a record is load-bearing when we
  // cannot tell (the server is the authority and would refuse anyway).
  assert.equal(isLastSystemAdmin(null, seeded), false);
  assert.equal(isLastSystemAdmin([seeded], null), false);
  assert.equal(isLastSystemAdmin([seeded], {}), false, 'no id to compare');
  // A truthy-but-not-true flag is not System Admin anywhere in the store.
  assert.equal(isLastSystemAdmin([{ id: 'x', systemAdmin: 'yes' }], { id: 'x' }), false);
});

test('lastSystemAdminGuard names the reason per action', () => {
  const del = lastSystemAdminGuard({ users: [seeded, member], target: seeded, action: 'delete' });
  assert.equal(del.ok, false);
  assert.match(del.reason, /cannot be deleted/);
  assert.match(del.reason, /promote another user/, 'the refusal says how to get unstuck');

  const dem = lastSystemAdminGuard({ users: [seeded, member], target: seeded, action: 'demote' });
  assert.equal(dem.ok, false);
  assert.match(dem.reason, /cannot be demoted/);

  // Allowed cases carry no reason, so a call site cannot render a stale one.
  for (const args of [
    { users: [seeded, second], target: seeded, action: 'delete' },
    { users: [seeded, member], target: member, action: 'delete' },
    { users: [seeded, member], target: seeded, action: 'promote' }, // ticking it ON is never blocked
    {},
  ]) {
    const g = lastSystemAdminGuard(args);
    assert.equal(g.ok, true, JSON.stringify(args));
    assert.equal(g.reason, null);
  }
});

// The rule is duplicated across two containers (the store cannot be imported
// into the browser bundle), so this is the two-sided guard that the sentence the
// page shows is byte-identical to the one the server throws. Without it the
// disabled control could explain a refusal in words the 409 never uses.
test('the mirrored refusal sentences match the store exactly', () => {
  const require_ = createRequire(import.meta.url);
  const store = require_('../../../orchestrator/teams-store.js');

  assert.equal(
    lastSystemAdminGuard({ users: [seeded], target: seeded, action: 'delete' }).reason,
    store.LAST_SYSTEM_ADMIN_DELETE_REASON,
  );
  assert.equal(
    lastSystemAdminGuard({ users: [seeded], target: seeded, action: 'demote' }).reason,
    store.LAST_SYSTEM_ADMIN_DEMOTE_REASON,
  );
  // ...and the predicates agree, so the page never disables a control the
  // server would have allowed (or enables one it would refuse).
  for (const [users, target] of [
    [[seeded, member], seeded], [[seeded, second], seeded],
    [[seeded, member], member], [[member], member], [[], seeded],
  ]) {
    assert.equal(
      isLastSystemAdmin(users, target),
      store.isLastSystemAdmin(users, target.id),
      `client and store disagree about ${target.id} among ${users.length} users`,
    );
  }
});

test('chatIdentityLabel shows present / pending / failed per user (#2721 AC8)', () => {
  assert.equal(chatIdentityLabel({ matrixIdentity: { status: 'ready' } }), 'Ready');
  assert.equal(chatIdentityLabel({ matrixIdentity: { status: 'pending' } }), 'Pending');
  assert.equal(chatIdentityLabel({ matrixIdentity: { status: 'failed', error: 'x' } }), 'Failed');
  assert.equal(chatIdentityLabel({}), 'Pending', 'an undecorated record is never shown as ready');
  assert.equal(chatIdentityLabel({ matrixIdentity: { status: 'bogus' } }), 'Pending');
  assert.equal(usersToRows([{ id: 'u', matrixIdentity: { status: 'ready' } }])[0].chatIdentityLabel, 'Ready');
});

test('chatIdentityDetail explains a failure and is empty otherwise', () => {
  const detail = chatIdentityDetail({ matrixIdentity: { status: 'failed', error: 'homeserver unavailable', lastAttemptAt: '2026-10-01T10:00:00.000Z' } });
  assert.match(detail, /homeserver unavailable/);
  assert.match(detail, /2026-10-01T10:00:00.000Z/);
  assert.match(detail, /retried automatically/);
  assert.equal(chatIdentityDetail({ matrixIdentity: { status: 'ready' } }), '');
  assert.equal(chatIdentityDetail({}), '');
});
