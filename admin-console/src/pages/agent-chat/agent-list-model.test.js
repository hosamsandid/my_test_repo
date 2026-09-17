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
  isStub,
  stubSectionLabel,
  isPoolInstance,
  poolInstancesLabel,
} from './agent-list-model.js';

const EMPTY_ORDER = { groups: [], singles: [], members: {} };
const ALL = { kind: 'all' };

const team       = (id, displayName) => ({ id, role: 'team', displayName });
const member     = (id, parentTeamId, displayName) => ({ id, role: 'team-member', parentTeamId, displayName });
const standalone = (id, displayName) => ({ id, role: 'agent', displayName });

// Leftover BriefingPack configs (#1964). The epic's hard cut means the platform
// can no longer create these roles, but an installation upgraded across the cut
// still has the config.json files on disk, so the list endpoint can still ship
// such a row. These fixtures keep the removal guards below non-vacuous, and
// double as "some other-role single" fixtures below (#2234) since — unlike a
// bare `standalone` — they still land in `singles`.
const orch = (id, displayName) => ({ id, role: 'orchestrator', displayName });
const bp   = (id, parentOrchestratorId, displayName) => ({ id, role: 'bp-instance', parentOrchestratorId, displayName });

// A live pool instance (#2273/#2297): an ordinary, chat-openable team member
// carrying the marker fields the endpoint ships only on such a row.
const instance = (id, parentTeamId, poolOf, poolItem, displayName) =>
  ({ id, role: 'team-member', parentTeamId, poolInstance: true, poolOf, poolItem, displayName: displayName || id });

// ── buildGroups ──────────────────────────────────────────────────────────

test('buildGroups groups team members under their team header', () => {
  const agents = [
    team('t1', 'Alpha'),
    member('t1-dev', 't1', 'Dev'),
    member('t1-qa', 't1', 'QA'),
  ];
  const { groups, singles } = buildGroups(agents);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'team');
  assert.equal(groups[0].id, 't1');
  assert.equal(groups[0].header.id, 't1');
  assert.deepEqual(groups[0].children.map(c => c.id), ['t1-dev', 't1-qa']);
  assert.deepEqual(singles, []);
});

test('#2234 — a standalone agent (role: "agent") never appears in buildGroups', () => {
  // Every agent minted since #2229 Phase B is a team of one; the only
  // standalone `role: 'agent'` configs left are ephemeral one-shot workers,
  // which have no UI surface at all by design. A leftover other-role config
  // (#1964) still lands in singles — only `agent` is excluded.
  const agents = [team('t1', 'Alpha'), standalone('solo', 'Solo'), orch('o1', 'Orch')];
  const { groups, singles } = buildGroups(agents);
  assert.deepEqual(singles.map(s => s.id), ['o1']);
  assert.deepEqual(groups.map(g => g.id), ['t1']);
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

test('#1964 — buildGroups forms no orchestrator group; leftover rows list as singles', () => {
  // AC2: the grouping logic handles teams and standalone agents only. A
  // leftover orchestrator / bp-instance config is still *listed* (dropping a row
  // silently is the one outcome a user cannot tell from a missing agent) — it
  // just no longer gets a section of its own.
  const agents = [orch('o1', 'Orch'), bp('bp-1', 'o1', 'BP One'), bp('bp-2', 'o1', 'BP Two')];
  const { groups, singles } = buildGroups(agents);
  assert.deepEqual(groups, []);
  assert.deepEqual(singles.map(s => s.id), ['bp-1', 'bp-2', 'o1']);
});

test('#1964 — every group buildGroups produces is a team', () => {
  const { groups } = buildGroups([
    team('t1', 'Alpha'), member('t1-dev', 't1', 'Dev'),
    orch('o1', 'Orch'), bp('bp-1', 'o1', 'BP One'),
  ]);
  assert.deepEqual(groups.map(g => g.kind), ['team']);
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

test('#1964 — there is no orchestrator filter branch left', () => {
  // The filter spec is `all | team | agent` now. A stored `orchestrator` filter
  // from before the cut is rejected by `loadFilter` in AgentChat.jsx; should one
  // reach here anyway it degrades to the unknown-kind fallthrough (everyone
  // visible) rather than to a branch that reads `parentOrchestratorId`.
  const f = { kind: 'orchestrator', id: 'o1' };
  assert.equal(matchesFilter(orch('o1', 'Orch'), f), true);
  assert.equal(matchesFilter(standalone('solo'), f), true);
  assert.equal(matchesFilter(bp('bp-1', 'other'), f), true);
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
    orch('s1', 'S1'),
    orch('s2', 'S2'),
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
  const { groups, singles } = buildGroups([orch('solo', 'Solo')]);
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
    orch('solo', 'Solo'),
  ];
  const model = buildAgentListModel(agents, EMPTY_ORDER, ALL);
  assert.deepEqual(model.visibleGroups.map(g => g.id), ['t1']);
  assert.deepEqual(model.visibleSingles.map(s => s.id), ['solo']);
  assert.equal(model.empty, false);
});

test('groupKey namespaces a group id with its kind', () => {
  // Teams are the only kind since #1964, but the key stays namespaced: every
  // persisted collapse / order / drag entry is written as `team:<id>`, and a
  // bare id would both invalidate those and collide with a single agent's id.
  assert.equal(groupKey({ kind: 'team', id: 'x' }), 'team:x');
  assert.notEqual(groupKey({ kind: 'team', id: 'x' }), 'x');
});

// ── disabled-agents filter (#1928, epic decision D2) ─────────────────────────

// A *paused* agent: provisioned (it has a chat identity) and then switched off.
// `hasToken` is what tells it apart from a stub, and the endpoint has shipped
// that field since #1928 — the fixture spells it out because since #1957 the
// two states are filtered differently.
const off = (agent) => ({ ...agent, enabled: false, hasToken: true });

test('passesDisabledFilter hides disabled rows only while the opt-in is off', () => {
  assert.equal(passesDisabledFilter({ enabled: false, hasToken: true }, false), false);
  assert.equal(passesDisabledFilter({ enabled: false, hasToken: true }, true), true);
  assert.equal(passesDisabledFilter({ enabled: true }, false), true);
  // An absent flag means enabled — the pre-#1928 payload shape.
  assert.equal(passesDisabledFilter({}, false), true);
});

test('AC6 — with the filter off the list is exactly what it was before', () => {
  const agents = [
    team('t1', 'Alpha'),
    member('t1-dev', 't1', 'Dev'),
    off(member('t1-qa', 't1', 'QA')),
    orch('solo', 'Solo'),
    off(orch('paused', 'Paused')),
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
    orch('solo', 'Solo'),
    off(orch('paused', 'Paused')),
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
    off(orch('paused', 'Paused')),
  ];
  const model = buildAgentListModel(agents, EMPTY_ORDER, { kind: 'team', id: 't1' }, true);
  // Filter says "team t1 only", so the disabled standalone stays out even
  // though the disabled opt-in is on.
  assert.deepEqual(model.visibleSingles, []);
  assert.deepEqual(model.visibleGroups[0].children.map(c => c.id), ['t1-qa']);
});

// ── not-materialized members (#1957) ─────────────────────────────────────────

// A STUB member: configuration and triggers only. The endpoint ships
// `hasToken: false` for it and never sets `enabled`, which is exactly what
// `agentState()` reads to tell it apart from the paused row above.
const stub = (id, parentTeamId, displayName) =>
  ({ id, role: 'team-member', parentTeamId, displayName, enabled: false, hasToken: false });

test('isStub tells a never-provisioned member from a paused one', () => {
  assert.equal(isStub(stub('t1-dev', 't1', 'Dev')), true);
  assert.equal(isStub(off(member('t1-qa', 't1', 'QA'))), false);
  assert.equal(isStub(member('t1-ops', 't1', 'Ops')), false);
});

test('stubSectionLabel carries the count so it is readable while collapsed (AC2)', () => {
  assert.equal(stubSectionLabel(3), 'Not materialized yet (3)');
  assert.equal(stubSectionLabel(1), 'Not materialized yet (1)');
});

test('AC1 — stubs land in their team group, split out of the active members', () => {
  const agents = [
    team('t1', 'Alpha'),
    member('t1-dev', 't1', 'Dev'),
    stub('t1-qa', 't1', 'QA'),
    stub('t1-arch', 't1', 'Architect'),
  ];
  const { groups } = buildGroups(agents);
  assert.deepEqual(groups[0].children.map(c => c.id), ['t1-dev']);
  // Sorted by display name like the active members are.
  assert.deepEqual(groups[0].stubs.map(c => c.id), ['t1-arch', 't1-qa']);
});

test('AC2 — a team with no stubs gets an empty section list, never a placeholder', () => {
  const { groups } = buildGroups([team('t1', 'Alpha'), member('t1-dev', 't1', 'Dev')]);
  assert.deepEqual(groups[0].stubs, []);
});

test('#1964 — a tokenless leftover bp-instance is never mistaken for a team stub', () => {
  // `isStub` is role-agnostic (it reads `agentState`), so a disabled, never
  // provisioned bp-instance answers true. It must still land in `singles` and
  // never in some team's not-materialized section, which is keyed on
  // `parentTeamId` and now has no other producer.
  const leftover = { ...bp('o1-a', 'o1', 'A'), enabled: false };
  assert.equal(isStub(leftover), true);
  const { groups, singles } = buildGroups([team('t1', 'Alpha'), leftover]);
  assert.deepEqual(groups[0].stubs, []);
  assert.deepEqual(singles.map(s => s.id), ['o1-a']);
});

test('edge case — a team whose members are ALL stubs still appears', () => {
  const agents = [team('t1', 'Alpha'), stub('t1-dev', 't1', 'Dev'), stub('t1-qa', 't1', 'QA')];
  const model = buildAgentListModel(agents, EMPTY_ORDER, ALL);
  assert.equal(model.empty, false);
  assert.equal(model.visibleGroups.length, 1);
  assert.deepEqual(model.visibleGroups[0].children, []);
  assert.deepEqual(model.visibleGroups[0].stubs.map(s => s.id), ['t1-dev', 't1-qa']);
});

test('a fully-deferred team with no team row of its own still forms a group', () => {
  // Nothing but stubs and no header: the group has to survive the
  // "header or children" drop rule, or the team is invisible.
  const model = buildAgentListModel([stub('t1-dev', 't1', 'Dev')], EMPTY_ORDER, ALL);
  assert.deepEqual(model.visibleGroups.map(g => g.id), ['t1']);
  assert.deepEqual(model.visibleGroups[0].stubs.map(s => s.id), ['t1-dev']);
  assert.deepEqual(model.visibleSingles, []);
});

test('a stub is never swept up by the disabled-agents filter', () => {
  // `stub` and `paused` are different states (the edge case in the ticket): the
  // opt-in governs paused rows only, so the stub section neither appears nor
  // vanishes with it.
  assert.equal(passesDisabledFilter(stub('t1-qa', 't1', 'QA'), false), true);

  const agents = [team('t1', 'Alpha'), stub('t1-qa', 't1', 'QA'), off(member('t1-dev', 't1', 'Dev'))];
  const hidden = buildAgentListModel(agents, EMPTY_ORDER, ALL, false);
  assert.deepEqual(hidden.visibleGroups[0].children, []);            // paused row hidden
  assert.deepEqual(hidden.visibleGroups[0].stubs.map(s => s.id), ['t1-qa']);

  const shown = buildAgentListModel(agents, EMPTY_ORDER, ALL, true);
  assert.deepEqual(shown.visibleGroups[0].children.map(c => c.id), ['t1-dev']);
  assert.deepEqual(shown.visibleGroups[0].stubs.map(s => s.id), ['t1-qa']);
});

test('the team filter narrows the stub section like the member list', () => {
  const agents = [
    team('t1', 'Alpha'), stub('t1-qa', 't1', 'QA'),
    team('t2', 'Beta'),  stub('t2-qa', 't2', 'QA2'),
  ];
  const model = buildAgentListModel(agents, EMPTY_ORDER, { kind: 'team', id: 't1' });
  assert.deepEqual(model.visibleGroups.map(g => g.id), ['t1']);
  assert.deepEqual(model.visibleGroups[0].stubs.map(s => s.id), ['t1-qa']);
});

test('AC8 — stubs do not disturb the stored member order or the active list', () => {
  const agents = [
    team('t1', 'Alpha'),
    member('t1-dev', 't1', 'Dev'),
    member('t1-qa', 't1', 'QA'),
    stub('t1-arch', 't1', 'Architect'),
  ];
  const order = { groups: [], singles: [], members: { 'team:t1': ['t1-qa', 't1-dev'] } };
  const model = buildAgentListModel(agents, order, ALL);
  // The stored order names only the materialized members and still applies
  // verbatim — a stub is not part of the drag-reorderable list.
  assert.deepEqual(model.visibleGroups[0].children.map(c => c.id), ['t1-qa', 't1-dev']);
  assert.deepEqual(model.visibleGroups[0].stubs.map(s => s.id), ['t1-arch']);
});

test('a parentless stub is listed as a single rather than dropped silently', () => {
  const { groups, singles } = buildGroups([team('t1', 'Alpha'), stub('lost', undefined, 'Lost')]);
  assert.deepEqual(groups.map(g => g.id), ['t1']);
  assert.deepEqual(singles.map(s => s.id), ['lost']);
});

// ── pool instance sub-grouping (#2273/#2297) ─────────────────────────────────

test('isPoolInstance tells a spawned instance from an ordinary member', () => {
  assert.equal(isPoolInstance(instance('t1-dev-i1', 't1', 't1-dev', 1)), true);
  assert.equal(isPoolInstance(member('t1-dev', 't1', 'Dev')), false);
});

test('poolInstancesLabel carries the count, mirrors stubSectionLabel (AC1)', () => {
  assert.equal(poolInstancesLabel(2), 'Instances (2)');
  assert.equal(poolInstancesLabel(1), 'Instances (1)');
});

test('AC1 — a pooled role nests its live instances, sorted by poolItem', () => {
  const agents = [
    team('t1', 'Alpha'),
    member('t1-dev', 't1', 'Dev'),
    instance('t1-dev-i2', 't1', 't1-dev', 2),
    instance('t1-dev-i1', 't1', 't1-dev', 1),
  ];
  const { groups } = buildGroups(agents);
  assert.deepEqual(groups[0].children.map(c => c.id), ['t1-dev']);
  assert.deepEqual(groups[0].children[0].instances.map(i => i.id), ['t1-dev-i1', 't1-dev-i2']);
});

test('AC1 — a role with no live instances gets an empty instances list, never a placeholder', () => {
  const { groups } = buildGroups([team('t1', 'Alpha'), member('t1-dev', 't1', 'Dev')]);
  assert.deepEqual(groups[0].children[0].instances, []);
});

test('an instance is not counted twice — it never also appears flat among the children', () => {
  const agents = [
    team('t1', 'Alpha'),
    member('t1-dev', 't1', 'Dev'),
    member('t1-qa', 't1', 'QA'),
    instance('t1-dev-i1', 't1', 't1-dev', 1),
  ];
  const { groups } = buildGroups(agents);
  assert.deepEqual(groups[0].children.map(c => c.id), ['t1-dev', 't1-qa']);
});

test('an orphaned instance (its role template is gone) lists flat rather than vanishing', () => {
  const agents = [
    team('t1', 'Alpha'),
    member('t1-qa', 't1', 'QA'),
    instance('t1-dev-i1', 't1', 't1-dev', 1, 'Orphan'),
  ];
  const { groups } = buildGroups(agents);
  assert.deepEqual(groups[0].children.map(c => c.id), ['t1-dev-i1', 't1-qa']);
});

test('ordinary members are unaffected — a team with no pooled role behaves exactly as before', () => {
  const agents = [team('t1', 'Alpha'), member('t1-dev', 't1', 'Dev'), member('t1-qa', 't1', 'QA')];
  const model = buildAgentListModel(agents, EMPTY_ORDER, ALL);
  assert.deepEqual(model.visibleGroups[0].children.map(c => c.id), ['t1-dev', 't1-qa']);
  assert.deepEqual(model.visibleGroups[0].children.map(c => c.instances), [[], []]);
});

test('filterModel narrows a role instances list by the same disabled-agents opt-in', () => {
  const agents = [
    team('t1', 'Alpha'),
    member('t1-dev', 't1', 'Dev'),
    instance('t1-dev-i1', 't1', 't1-dev', 1),
    off(instance('t1-dev-i2', 't1', 't1-dev', 2)),
  ];
  const hidden = buildAgentListModel(agents, EMPTY_ORDER, ALL, false);
  assert.deepEqual(hidden.visibleGroups[0].children[0].instances.map(i => i.id), ['t1-dev-i1']);

  const shown = buildAgentListModel(agents, EMPTY_ORDER, ALL, true);
  assert.deepEqual(shown.visibleGroups[0].children[0].instances.map(i => i.id), ['t1-dev-i1', 't1-dev-i2']);
});

test('the team filter narrows the instances list like the member list', () => {
  const agents = [
    team('t1', 'Alpha'), member('t1-dev', 't1', 'Dev'), instance('t1-dev-i1', 't1', 't1-dev', 1),
    team('t2', 'Beta'),  member('t2-dev', 't2', 'Dev2'), instance('t2-dev-i1', 't2', 't2-dev', 1),
  ];
  const model = buildAgentListModel(agents, EMPTY_ORDER, { kind: 'team', id: 't1' });
  assert.deepEqual(model.visibleGroups.map(g => g.id), ['t1']);
  assert.deepEqual(model.visibleGroups[0].children[0].instances.map(i => i.id), ['t1-dev-i1']);
});
