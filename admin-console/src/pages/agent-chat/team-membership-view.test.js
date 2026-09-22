import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  membershipsByTeam, teamMembershipIndicator, fitAdminNames,
} from './team-membership-view.js';

// Directory + membership fixtures mirror the `GET /api/users/directory` and
// `GET /api/admin/memberships` payloads `ShareTeamPanel` reads.
const dir = [
  { id: 'u-alice', displayName: 'Alice', email: 'alice@x' },
  { id: 'u-bob', displayName: 'Bob', email: 'bob@x' },
  { id: 'u-carol', displayName: 'Carol', email: 'carol@x' },
];
const admin = (userId, teamId) => ({ id: `${teamId}:${userId}`, userId, teamId, role: 'team-admin' });
const member = (userId, teamId) => ({ id: `${teamId}:${userId}`, userId, teamId, role: 'team-member' });

// ── membershipsByTeam ──────────────────────────────────────────────────────

test('membershipsByTeam: groups a flat payload by teamId', () => {
  const byTeam = membershipsByTeam([admin('u-alice', 't1'), member('u-bob', 't1'), admin('u-carol', 't2')]);
  assert.equal(byTeam.get('t1').length, 2);
  assert.equal(byTeam.get('t2').length, 1);
  assert.equal(byTeam.has('t3'), false);
});

test('membershipsByTeam: tolerates junk and missing teamId', () => {
  const byTeam = membershipsByTeam([null, {}, { userId: 'x' }, admin('u-alice', 't1')]);
  assert.equal(byTeam.size, 1);
  assert.equal(byTeam.get('t1').length, 1);
});

// ── teamMembershipIndicator ────────────────────────────────────────────────

test('own: a sole member who is the viewer', () => {
  const out = teamMembershipIndicator({ memberships: [admin('u-alice', 't1')], directory: dir, viewerId: 'u-alice' });
  assert.equal(out.kind, 'own');
});

test('AC3 edge: a sole-member team seen by someone else shows the member as its admin, not Own', () => {
  const out = teamMembershipIndicator({ memberships: [admin('u-alice', 't1')], directory: dir, viewerId: 'u-bob' });
  assert.equal(out.kind, 'admins');
  assert.deepEqual(out.names, ['Alice']);
});

test('AC3: one admin among several members shows that admin by name', () => {
  const out = teamMembershipIndicator({
    memberships: [admin('u-alice', 't1'), member('u-bob', 't1')], directory: dir, viewerId: 'u-alice',
  });
  assert.equal(out.kind, 'admins');
  assert.deepEqual(out.names, ['Alice']);
});

test('AC4: several admins are all listed, in sorted order', () => {
  const out = teamMembershipIndicator({
    memberships: [admin('u-carol', 't1'), admin('u-alice', 't1'), member('u-bob', 't1')],
    directory: dir, viewerId: 'u-alice',
  });
  assert.equal(out.kind, 'admins');
  assert.deepEqual(out.names, ['Alice', 'Carol']);
  assert.equal(out.title, 'Alice, Carol');
});

test('AC9: a team with no visible members renders no line', () => {
  assert.equal(teamMembershipIndicator({ memberships: [], directory: dir, viewerId: 'u-alice' }).kind, 'none');
});

test('a viewer-only team of one is Own even when the directory cannot name them', () => {
  const out = teamMembershipIndicator({ memberships: [admin('u-ghost', 't1')], directory: dir, viewerId: 'u-ghost' });
  assert.equal(out.kind, 'own');
});

// ── fitAdminNames ──────────────────────────────────────────────────────────
// `measure = s => s.length` makes "width" a character budget in these tests.

test('fitAdminNames: everything fits → no remainder', () => {
  const out = fitAdminNames(['Alice', 'Bob'], 100, s => s.length);
  assert.deepEqual(out, { text: 'Alice, Bob', hiddenCount: 0, title: 'Alice, Bob' });
});

test('fitAdminNames: overflow drops whole names from the tail and counts them', () => {
  const out = fitAdminNames(['Alice', 'Bob', 'Carol', 'Dave'], 12, s => s.length);
  // "Alice, Bob +2" is 13 chars > 12, so only "Alice +3" (8) fits.
  assert.equal(out.text, 'Alice');
  assert.equal(out.hiddenCount, 3);
  assert.equal(out.title, 'Alice, Bob, Carol, Dave');
});

test('fitAdminNames: never cuts a name mid-string — the shown text is always whole names', () => {
  const out = fitAdminNames(['Alexandra', 'Bartholomew'], 12, s => s.length);
  assert.equal(out.text, 'Alexandra');
  assert.equal(out.hiddenCount, 1);
});

test('fitAdminNames: a single over-long name is still shown (CSS ellipsis handles the cut)', () => {
  const out = fitAdminNames(['Bartholomew'], 3, s => s.length);
  assert.deepEqual(out, { text: 'Bartholomew', hiddenCount: 0, title: 'Bartholomew' });
});

test('fitAdminNames: unbounded width shows the full list', () => {
  const out = fitAdminNames(['Alice', 'Bob', 'Carol'], 0, s => s.length);
  assert.equal(out.text, 'Alice, Bob, Carol');
  assert.equal(out.hiddenCount, 0);
});

test('fitAdminNames: empty list is inert', () => {
  assert.deepEqual(fitAdminNames([], 100, s => s.length), { text: '', hiddenCount: 0, title: '' });
});
