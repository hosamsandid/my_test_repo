'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTeamsStore, DEFAULT_TEAM_ID } = require('./teams-store');

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-store-'));
  return { store: createTeamsStore({ root }), root };
}

test('createTeamsStore requires a root', () => {
  assert.throws(() => createTeamsStore({}), /root.*required/);
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

  // demote then re-run: should re-promote the same record, not duplicate
  store.updateUser(created.id, { systemAdmin: false });
  const promoted = store.ensureSystemAdmin({ subject: 'admin@corp.com' });
  assert.equal(promoted.id, created.id);
  assert.equal(promoted.systemAdmin, true);
  assert.equal(store.listUsers().length, 1);
});
