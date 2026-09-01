import test from 'node:test';
import assert from 'node:assert/strict';

import {
  systemAdminLabel, passwordLabel, usersToRows, isSelf, selfActionWarning, validateUserForm,
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
  // Env single-admin: no userId, username is not a user subject → not self.
  assert.equal(isSelf({ username: 'admin' }, row), false);
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
  // Removing someone else's System-Admin does not warn about self-lockout.
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
