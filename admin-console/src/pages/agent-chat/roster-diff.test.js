import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentRowEqual, mergeRoster, nextRosterState } from './roster-diff.js';

const agent = (id, extra = {}) => ({
  id,
  displayName: id,
  role: 'team-member',
  enabled: true,
  parentTeamId: 'team-1',
  ...extra,
});

// ── agentRowEqual ────────────────────────────────────────────────────────

test('agentRowEqual: same reference is equal', () => {
  const a = agent('a1');
  assert.equal(agentRowEqual(a, a), true);
});

test('agentRowEqual: identical fields are equal even as different objects', () => {
  assert.equal(agentRowEqual(agent('a1'), agent('a1')), true);
});

test('agentRowEqual: a changed field is not equal', () => {
  assert.equal(agentRowEqual(agent('a1'), agent('a1', { displayName: 'renamed' })), false);
});

test('agentRowEqual: a field present on one side only is not equal', () => {
  assert.equal(agentRowEqual(agent('a1'), agent('a1', { poolInstance: true })), false);
});

test('agentRowEqual: null/undefined never equals a real row', () => {
  assert.equal(agentRowEqual(null, agent('a1')), false);
  assert.equal(agentRowEqual(agent('a1'), null), false);
});

// ── mergeRoster ──────────────────────────────────────────────────────────

test('mergeRoster: identical rosters report unchanged and return the SAME list reference', () => {
  const prev = [agent('a1'), agent('a2')];
  const next = [{ ...prev[0] }, { ...prev[1] }]; // fresh objects, same content
  const { list, changed } = mergeRoster(prev, next);
  assert.equal(changed, false);
  assert.equal(list, prev); // exact reference, not just deep-equal
});

test('mergeRoster: an unchanged agent keeps its previous object reference', () => {
  const a1 = agent('a1');
  const a2 = agent('a2');
  const prev = [a1, a2];
  // a2 changes displayName; a1's fetched row is content-identical but a NEW object.
  const next = [{ ...a1 }, { ...a2, displayName: 'renamed' }];
  const { list, changed } = mergeRoster(prev, next);
  assert.equal(changed, true);
  assert.equal(list[0], a1); // reused, not the fresh object from `next`
  assert.notEqual(list[1], a2);
  assert.equal(list[1].displayName, 'renamed');
});

test('mergeRoster: a newly appeared agent is added and reported as changed', () => {
  const prev = [agent('a1')];
  const next = [agent('a1'), agent('a2')];
  const { list, changed } = mergeRoster(prev, next);
  assert.equal(changed, true);
  assert.equal(list.length, 2);
  assert.equal(list[0], prev[0]);
  assert.equal(list[1].id, 'a2');
});

test('mergeRoster: a removed agent is dropped and reported as changed', () => {
  const prev = [agent('a1'), agent('a2')];
  const next = [agent('a1')];
  const { list, changed } = mergeRoster(prev, next);
  assert.equal(changed, true);
  assert.deepEqual(list.map(a => a.id), ['a1']);
  assert.equal(list[0], prev[0]);
});

test('mergeRoster: a same-size swap (one removed, one added) is detected', () => {
  const prev = [agent('a1'), agent('a2')];
  const next = [agent('a1'), agent('a3')];
  const { list, changed } = mergeRoster(prev, next);
  assert.equal(changed, true);
  assert.deepEqual(list.map(a => a.id), ['a1', 'a3']);
});

test('mergeRoster: a pure reorder of identical rows is NOT reported as changed', () => {
  const a1 = agent('a1');
  const a2 = agent('a2');
  const prev = [a1, a2];
  const next = [{ ...a2 }, { ...a1 }]; // same rows, swapped position, fresh objects
  const { list, changed } = mergeRoster(prev, next);
  assert.equal(changed, false);
  assert.equal(list, prev); // caller keeps the old array/order, no re-render
});

test('mergeRoster: enabled -> disabled transition on a row is reported as changed', () => {
  const prev = [agent('a1', { enabled: true })];
  const next = [agent('a1', { enabled: false })];
  const { list, changed } = mergeRoster(prev, next);
  assert.equal(changed, true);
  assert.equal(list[0].enabled, false);
});

test('mergeRoster: a pool instance appearing under poolOf is added like any other row', () => {
  const prev = [agent('role-1')];
  const instanceRow = agent('role-1-i1', { poolInstance: true, poolOf: 'role-1', poolItem: 1 });
  const next = [agent('role-1'), instanceRow];
  const { list, changed } = mergeRoster(prev, next);
  assert.equal(changed, true);
  assert.equal(list.length, 2);
  assert.deepEqual(list[1], instanceRow);
});

test('mergeRoster: null/non-array inputs are treated as empty rosters', () => {
  assert.deepEqual(mergeRoster(null, null), { list: [], changed: false });
  const next = [agent('a1')];
  const { list, changed } = mergeRoster(null, next);
  assert.equal(changed, true);
  assert.equal(list[0], next[0]);
  const { list: list2, changed: changed2 } = mergeRoster([agent('a1')], null);
  assert.equal(changed2, true);
  assert.deepEqual(list2, []);
});

test('mergeRoster: empty -> empty is unchanged', () => {
  const { list, changed } = mergeRoster([], []);
  assert.equal(changed, false);
  assert.deepEqual(list, []);
});

// ── nextRosterState (the AgentRosterContext reducer) ──────────────────────

test('nextRosterState: first successful load of an EMPTY roster adopts [] (never stays null)', () => {
  // The blank-rail regression: null prev + empty payload must become [], so the
  // rail can render its "No agents yet." empty state for a zero-agent user.
  const out = nextRosterState(null, []);
  assert.notEqual(out, null);
  assert.deepEqual(out, []);
});

test('nextRosterState: first load of a null/absent payload also adopts []', () => {
  assert.deepEqual(nextRosterState(null, null), []);
  assert.deepEqual(nextRosterState(null, undefined), []);
});

test('nextRosterState: first load of a populated roster adopts it', () => {
  const next = [agent('a1'), agent('a2')];
  const out = nextRosterState(null, next);
  assert.equal(out, next);
});

test('nextRosterState: a stable later tick keeps the SAME array reference (AC7 no-op skip)', () => {
  const prev = [agent('a1'), agent('a2')];
  const next = [{ ...prev[0] }, { ...prev[1] }]; // fresh objects, same content
  const out = nextRosterState(prev, next);
  assert.equal(out, prev); // exact reference — no re-render
});

test('nextRosterState: an empty later tick keeps the previous empty array (no churn)', () => {
  const prev = [];
  assert.equal(nextRosterState(prev, []), prev);
});

test('nextRosterState: a changed later tick returns the merged list', () => {
  const prev = [agent('a1')];
  const out = nextRosterState(prev, [agent('a1'), agent('a2')]);
  assert.notEqual(out, prev);
  assert.deepEqual(out.map(a => a.id), ['a1', 'a2']);
  assert.equal(out[0], prev[0]); // unchanged row keeps its reference
});
