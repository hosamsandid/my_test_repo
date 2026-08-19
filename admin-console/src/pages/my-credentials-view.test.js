import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canOwnPersonalCredentials,
  personalOwnerId,
  personalCredentials,
  adminManagedCredentials,
  personalCreateBody,
} from './my-credentials-view.js';

test('canOwnPersonalCredentials: a real user (has userId) can', () => {
  assert.equal(canOwnPersonalCredentials({ username: 'alice', userId: 'u-1' }), true);
});

test('canOwnPersonalCredentials: env single-admin (userId null) cannot', () => {
  assert.equal(canOwnPersonalCredentials({ username: 'admin', userId: null, admin: true }), false);
  assert.equal(canOwnPersonalCredentials({ username: 'admin', admin: true }), false);
});

test('canOwnPersonalCredentials: signed-out / missing input fails closed', () => {
  assert.equal(canOwnPersonalCredentials(null), false);
  assert.equal(canOwnPersonalCredentials(undefined), false);
  assert.equal(canOwnPersonalCredentials({}), false);
});

test('personalOwnerId returns the user id or null', () => {
  assert.equal(personalOwnerId({ userId: 'u-9' }), 'u-9');
  assert.equal(personalOwnerId({ userId: null }), null);
  assert.equal(personalOwnerId(null), null);
});

test('personalCredentials: keeps only the caller-owned personal entries', () => {
  const list = [
    { id: 'a', scope: 'personal', userId: 'u-1' },
    { id: 'b', scope: 'personal', userId: 'u-2' }, // someone else's — must be dropped
    { id: 'c', scope: 'team', teamId: 'payments' },
    { id: 'd', scope: 'system', assignedTeamIds: ['risk'] },
  ];
  const mine = personalCredentials(list, 'u-1');
  assert.deepEqual(mine.map(c => c.id), ['a']);
  // normalized shape
  assert.equal(mine[0].scope, 'personal');
  assert.equal(mine[0].teamId, null);
});

test('personalCredentials: defensive — no leak without a caller id', () => {
  const list = [{ id: 'a', scope: 'personal', userId: 'u-1' }];
  assert.deepEqual(personalCredentials(list, null), []);
  assert.deepEqual(personalCredentials(list, ''), []);
  assert.deepEqual(personalCredentials('nope', 'u-1'), []);
});

test('personalCredentials: a personal entry with no owner never matches', () => {
  const list = [{ id: 'a', scope: 'personal' }];
  assert.deepEqual(personalCredentials(list, 'u-1'), []);
});

test('adminManagedCredentials: drops every personal entry, keeps team/system/legacy', () => {
  const list = [
    { id: 'a', scope: 'personal', userId: 'u-1' },
    { id: 'b', scope: 'team', teamId: 'payments' },
    { id: 'c', scope: 'system', assignedTeamIds: ['risk'] },
    { id: 'd', teamId: 'legacy' }, // pre-#798 legacy → team
  ];
  assert.deepEqual(adminManagedCredentials(list).map(c => c.id), ['b', 'c', 'd']);
  assert.deepEqual(adminManagedCredentials(null), []);
});

test('personalCreateBody: declares the personal tier + label, never a userId', () => {
  assert.deepEqual(personalCreateBody({ name: '  My laptop key  ', id: 'my-key' }), {
    scope: 'personal', name: 'My laptop key', id: 'my-key',
  });
});

test('personalCreateBody: omits id when blank (server auto-derives)', () => {
  assert.deepEqual(personalCreateBody({ name: 'Token' }), { scope: 'personal', name: 'Token' });
  assert.deepEqual(personalCreateBody({ name: 'Token', id: '   ' }), { scope: 'personal', name: 'Token' });
});
