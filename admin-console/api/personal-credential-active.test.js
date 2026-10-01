'use strict';

// Unit tests for the console mirror of the runtime's personal-credential pick (#2655).
// Run: node --test admin-console/api/personal-credential-active.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { activePersonalCredentialId, ownerRespawnNeeded, markActivePersonal } = require('./personal-credential-active');
const { findPersonalCredentialState } = require('../../orchestrator/credential-resolution');

const team = { id: 'team-pat', scope: 'team', teamId: 't1' };
const a = { id: 'pat-a', scope: 'personal', userId: 'u1' };
const b = { id: 'pat-b', scope: 'personal', userId: 'u1' };
const other = { id: 'pat-x', scope: 'personal', userId: 'u2' };

test('the active personal credential is the first one of that owner in index order', () => {
  assert.equal(activePersonalCredentialId([team, other, a, b], 'u1'), 'pat-a');
  assert.equal(activePersonalCredentialId([team, other, a, b], 'u2'), 'pat-x');
  assert.equal(activePersonalCredentialId([team], 'u1'), null);
  assert.equal(activePersonalCredentialId(null, 'u1'), null);
  assert.equal(activePersonalCredentialId([a], null), null);
});

test('agrees with the orchestrator resolver (findPersonalCredentialState)', () => {
  for (const index of [[a, b], [b, a], [team, other, b, a], [team]]) {
    const runtime = findPersonalCredentialState(index, 'u1').entry;
    assert.equal(activePersonalCredentialId(index, 'u1'), runtime ? runtime.id : null);
  }
});

test('create: respawn only when the resolved credential changed', () => {
  // First personal token → it becomes the resolved one.
  assert.equal(ownerRespawnNeeded({ before: [team], after: [team, a], userId: 'u1' }), true);
  // Second personal token → the first stays resolved, nothing an agent holds changes.
  assert.equal(ownerRespawnNeeded({ before: [team, a], after: [team, a, b], userId: 'u1' }), false);
  // Somebody else's token never moves u1.
  assert.equal(ownerRespawnNeeded({ before: [a], after: [a, other], userId: 'u2' }), true);
  assert.equal(ownerRespawnNeeded({ before: [team], after: [team, team], userId: null }), false);
});

test('rotate: respawn only when the replaced credential is the resolved one', () => {
  assert.equal(ownerRespawnNeeded({ after: [a, b], userId: 'u1', rotatedId: 'pat-a' }), true);
  assert.equal(ownerRespawnNeeded({ after: [a, b], userId: 'u1', rotatedId: 'pat-b' }), false);
  assert.equal(ownerRespawnNeeded({ after: [team], userId: 'u1', rotatedId: 'team-pat' }), false);
});

test('markActivePersonal flags each owner’s first personal row, leaves shared rows alone', () => {
  const rows = markActivePersonal([team, a, b, other], [team, a, b, other]);
  assert.deepEqual(rows.map(r => r.activePersonal), [undefined, true, false, true]);
  assert.equal(rows[0], team);
  // A caller-filtered list is still judged against the full index.
  assert.deepEqual(markActivePersonal([b], [a, b]).map(r => r.activePersonal), [false]);
  assert.deepEqual(markActivePersonal(null, []), []);
});
