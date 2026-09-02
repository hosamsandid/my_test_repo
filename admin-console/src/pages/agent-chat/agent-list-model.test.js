import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGroups,
  applyStoredOrder,
  matchesFilter,
  orderModel,
  filterModel,
  passesDisabledFilter,
  buildAgentListModel,
  groupKey,
} from './agent-list-model.js';

const EMPTY_ORDER = { groups: [], singles: [], members: {} };
const ALL = { kind: 'all' };

const team       = (id, displayName) => ({ id, role: 'team', displayName });
const member     = (id, parentTeamId, displayName) => ({ id, role: 'team-member', parentTeamId, displayName });
const orch       = (id, displayName) => ({ id, role: 'orchestrator', displayName });
const bp         = (id, parentOrchestratorId, displayName) => ({ id, role: 'bp-instance', parentOrchestratorId, displayName });
const standalone = (id, displayName) => ({ id, role: 'agent', displayName });

// ── buildGroups ──────────────────────────────────────────────────────────

test('buildGroups groups team members under their team header', () => {
  const agents = [
    team('t1', 'Alpha'),
    member('t1-dev', 't1', 'Dev'),
    member('t1-qa', 't1', 'QA'),
    standalone('solo', 'Solo'),
  ];
  const { groups, singles } = buildGroups(agents);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'team');
  assert.equal(groups[0].id, 't1');
  assert.equal(groups[0].header.id, 't1');
  assert.deepEqual(groups[0].children.map(c => c.id), ['t1-dev', 't1-qa']);
  assert.deepEqual(singles.map(s => s.id), ['solo']);
});

test('buildGroups sorts children by display name', () => {
  const agents = [
    team('t1', 'Alpha'),
    member('t1-z', 't1', 'Zeta'),
    member('t1-a', 't1', 'Aardvark'),
  ];
  const { groups } = buildGroups(agents);
  assert.deepEqual(groups[0].children.map(c => c.displayName), ['Aardvark', 'Zeta']);
});

test('buildGroups surfaces a section for a headerless team referenced by a member', () => {
  const { groups } = buildGroups([member('t1-dev', 't1', 'Dev')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].header, null);
  assert.equal(groups[0].displayName, 't1'); // falls back to id
  assert.deepEqual(groups[0].children.map(c => c.id), ['t1-dev']);
});

test('buildGroups routes a parentless member into singles', () => {
  // A member with no parentTeamId has no group to belong to; anything with a
  // truthy parentTeamId always seeds/joins that team's (possibly headerless)
  // section, since the id is added to the team-id set.
  const agents = [team('t1', 'Alpha'), member('lost', undefined, 'Lost')];
  const { groups, singles } = buildGroups(agents);
  assert.deepEqual(groups.map(g => g.id), ['t1']);
  assert.deepEqual(singles.map(s => s.id), ['lost']);
});

test('buildGroups groups orchestrators with their bp-instances', () => {
  const agents = [orch('o1', 'Orch'), bp('bp-1', 'o1', 'BP One'), bp('bp-2', 'o1', 'BP Two')];
  const { groups } = buildGroups(agents);
  assert.equal(groups[0].kind, 'orchestrator');
  assert.deepEqual(groups[0].children.map(c => c.id), ['bp-1', 'bp-2']);
});

test('buildGroups sorts groups by display name', () => {
  const agents = [team('t2', 'Zeta'), team('t1', 'Alpha')];
  const { groups } = buildGroups(agents);
  assert.deepEqual(groups.map(g => g.displayName), ['Alpha', 'Zeta']);
});

// ── applyStoredOrder ───────────────────────────────────────────────────────

test('applyStoredOrder returns items unchanged when no order is stored', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  assert.equal(applyStoredOrder(items, [], x => x.id), items);
});

test('applyStoredOrder puts stored keys first, appends unknown items in place', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const out = applyStoredOrder(items, ['c', 'a'], x => x.id);
  assert.deepEqual(out.map(x => x.id), ['c', 'a', 'b']);
});

test('applyStoredOrder ignores stored keys no longer present', () => {
  const items = [{ id: 'a' }];
  const out = applyStoredOrder(items, ['gone', 'a'], x => x.id);
  assert.deepEqual(out.map(x => x.id), ['a']);
});

// ── matchesFilter ──────────────────────────────────────────────────────────

test('matchesFilter: all/none passes everyone', () => {
  assert.equal(matchesFilter(standalone('x'), ALL), true);
  assert.equal(matchesFilter(standalone('x'), null), true);
});

test('matchesFilter: team filter keeps header + its members only', () => {
  const f = { kind: 'team', id: 't1' };
  assert.equal(matchesFilter(team('t1'), f), true);
  assert.equal(matchesFilter(member('t1-dev', 't1'), f), true);
  assert.equal(matchesFilter(member('t2-dev', 't2'), f), false);
  assert.equal(matchesFilter(standalone('solo'), f), false);
});

test('matchesFilter: agent filter keeps exactly one id', () => {
  const f = { kind: 'agent', id: 'solo' };
  assert.equal(matchesFilter(standalone('solo'), f), true);
  assert.equal(matchesFilter(standalone('other'), f), false);
});

// ── orderModel ─────────────────────────────────────────────────────────────

test('orderModel applies group, single, and per-member stored order', () => {
  const { groups, singles } = buildGroups([
    team('t1', 'Alpha'),
    member('t1-a', 't1', 'Aardvark'),
    member('t1-z', 't1', 'Zeta'),
    team('t2', 'Beta'),
    standalone('s1', 'S1'),
    standalone('s2', 'S2'),
  ]);
  const order = {
    groups: ['team:t2', 'team:t1'],
    singles: ['s2', 's1'],
    members: { 'team:t1': ['t1-z', 't1-a'] },
  };
  const { orderedGroups, orderedSingles } = orderModel(groups, singles, order);
  assert.deepEqual(orderedGroups.map(groupKey), ['team:t2', 'team:t1']);
  assert.deepEqual(orderedGroups[1].children.map(c => c.id), ['t1-z', 't1-a']);
  assert.deepEqual(orderedSingles.map(s => s.id), ['s2', 's1']);
});

test('orderModel tolerates a partial / missing order shape', () => {
  const { groups, singles } = buildGroups([team('t1', 'Alpha'), member('t1-a', 't1', 'A')]);
  // No members map at all.
  const { orderedGroups } = orderModel(groups, singles, { groups: [], singles: [] });
  assert.deepEqual(orderedGroups[0].children.map(c => c.id), ['t1-a']);
});

// ── filterModel ────────────────────────────────────────────────────────────

test('filterModel drops groups with no matching header or child', () => {
  const { groups, singles } = buildGroups([
    team('t1', 'Alpha'),
    member('t1-dev', 't1', 'Dev'),
    team('t2', 'Beta'),
    member('t2-dev', 't2', 'Dev2'),
  ]);
  const { orderedGroups, orderedSingles } = orderModel(groups, singles, EMPTY_ORDER);
  const { visibleGroups, empty } = filterModel(orderedGroups, orderedSingles, { kind: 'team', id: 't1' });
  assert.deepEqual(visibleGroups.map(g => g.id), ['t1']);
  assert.equal(empty, false);
});

test('filterModel reports empty when nothing matches', () => {
  const { groups, singles } = buildGroups([standalone('solo', 'Solo')]);
  const { orderedGroups, orderedSingles } = orderModel(groups, singles, EMPTY_ORDER);
  const model = filterModel(orderedGroups, orderedSingles, { kind: 'agent', id: 'nope' });
  assert.equal(model.empty, true);
  assert.deepEqual(model.visibleGroups, []);
  assert.deepEqual(model.visibleSingles, []);
});

// ── buildAgentListModel (composition) ────────────────────────────────────────

test('buildAgentListModel composes the three layers end-to-end', () => {
  const agents = [
    team('t1', 'Alpha'),
    member('t1-dev', 't1', 'Dev'),
    standalone('solo', 'Solo'),
  ];
  const model = buildAgentListModel(agents, EMPTY_ORDER, ALL);
  assert.deepEqual(model.visibleGroups.map(g => g.id), ['t1']);
  assert.deepEqual(model.visibleSingles.map(s => s.id), ['solo']);
  assert.equal(model.empty, false);
});

test('groupKey namespaces team and orchestrator ids so they cannot collide', () => {
  assert.equal(groupKey({ kind: 'team', id: 'x' }), 'team:x');
  assert.equal(groupKey({ kind: 'orchestrator', id: 'x' }), 'orchestrator:x');
});

// ── disabled-agents filter (#1928, epic decision D2) ─────────────────────────

const off = (agent) => ({ ...agent, enabled: false });

test('passesDisabledFilter hides disabled rows only while the opt-in is off', () => {
  assert.equal(passesDisabledFilter({ enabled: false }, false), false);
  assert.equal(passesDisabledFilter({ enabled: false }, true), true);
  assert.equal(passesDisabledFilter({ enabled: true }, false), true);
  // An absent flag means enabled — the pre-#1928 payload shape.
  assert.equal(passesDisabledFilter({}, false), true);
});

test('AC6 — with the filter off the list is exactly what it was before', () => {
  const agents = [
    team('t1', 'Alpha'),
    member('t1-dev', 't1', 'Dev'),
    off(member('t1-qa', 't1', 'QA')),
    standalone('solo', 'Solo'),
    off(standalone('paused', 'Paused')),
  ];
  const model = buildAgentListModel(agents, EMPTY_ORDER, ALL);
  assert.deepEqual(model.visibleGroups[0].children.map(c => c.id), ['t1-dev']);
  assert.deepEqual(model.visibleSingles.map(s => s.id), ['solo']);
});

test('AC6 — with the filter on the disabled rows appear alongside the rest', () => {
  const agents = [
    team('t1', 'Alpha'),
    member('t1-dev', 't1', 'Dev'),
    off(member('t1-qa', 't1', 'QA')),
    standalone('solo', 'Solo'),
    off(standalone('paused', 'Paused')),
  ];
  const model = buildAgentListModel(agents, EMPTY_ORDER, ALL, true);
  assert.deepEqual(model.visibleGroups[0].children.map(c => c.id), ['t1-dev', 't1-qa']);
  assert.deepEqual(model.visibleSingles.map(s => s.id), ['paused', 'solo']);
});

test('a disabled team header is hidden while its enabled members still group', () => {
  const { groups, singles } = buildGroups([
    off(team('t1', 'Alpha')),
    member('t1-dev', 't1', 'Dev'),
  ]);
  const { orderedGroups, orderedSingles } = orderModel(groups, singles, EMPTY_ORDER);

  const hidden = filterModel(orderedGroups, orderedSingles, ALL, false);
  assert.equal(hidden.visibleGroups.length, 1);
  assert.equal(hidden.visibleGroups[0].header, null);
  assert.deepEqual(hidden.visibleGroups[0].children.map(c => c.id), ['t1-dev']);

  const shown = filterModel(orderedGroups, orderedSingles, ALL, true);
  assert.equal(shown.visibleGroups[0].header.id, 't1');
});

test('a group whose every row is disabled drops out entirely with the filter off', () => {
  const { groups, singles } = buildGroups([
    off(team('t1', 'Alpha')),
    off(member('t1-dev', 't1', 'Dev')),
  ]);
  const { orderedGroups, orderedSingles } = orderModel(groups, singles, EMPTY_ORDER);
  const model = filterModel(orderedGroups, orderedSingles, ALL, false);
  assert.deepEqual(model.visibleGroups, []);
  assert.equal(model.empty, true);
});

test('the disabled filter composes with the text/entity filter rather than overriding it', () => {
  const agents = [
    team('t1', 'Alpha'),
    off(member('t1-qa', 't1', 'QA')),
    off(standalone('paused', 'Paused')),
  ];
  const model = buildAgentListModel(agents, EMPTY_ORDER, { kind: 'team', id: 't1' }, true);
  // Filter says "team t1 only", so the disabled standalone stays out even
  // though the disabled opt-in is on.
  assert.deepEqual(model.visibleSingles, []);
  assert.deepEqual(model.visibleGroups[0].children.map(c => c.id), ['t1-qa']);
});
