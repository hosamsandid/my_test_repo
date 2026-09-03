'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyNodeProvenance, planMaterialization, createMaterializer } = require('./materialize-flow');

// Removal guard (#1962): the BriefingPack provenance is gone. `bp-instance`
// and `orchestrator` used to classify as 'bp' and be dispatched to the
// orchestrator claim loop; both roles and that loop were removed, so every
// node — INCLUDING a leftover BP-shaped node in an old draft on an upgraded
// stack — must now route to /api/teams and never to a BP adapter.
test('classifyNodeProvenance routes every node to /api/teams — no BP provenance left', () => {
  assert.equal(classifyNodeProvenance({ role: 'team-member' }), 'team');
  assert.equal(classifyNodeProvenance({ role: 'agent' }), 'team');
  assert.equal(classifyNodeProvenance({}), 'team');
  // The two retired roles specifically.
  assert.equal(classifyNodeProvenance({ role: 'bp-instance' }), 'team');
  assert.equal(classifyNodeProvenance({ role: 'orchestrator' }), 'team');
});

test('planMaterialization puts every node in the team group and exposes no bp group', () => {
  const plan = planMaterialization({ nodes: [
    { id: 'dev', role: 'team-member' },
    { id: 'bb01', role: 'bp-instance' },
    { id: 'rev', role: 'team-member' },
  ] });
  assert.deepEqual(plan.team.map(n => n.id), ['dev', 'bb01', 'rev']);
  assert.deepEqual(Object.keys(plan), ['team']);
});

test('planMaterialization tolerates a missing / non-array nodes list', () => {
  assert.deepEqual(planMaterialization({}).team, []);
  assert.deepEqual(planMaterialization({ nodes: 'nope' }).team, []);
  assert.deepEqual(planMaterialization(null).team, []);
});

test('createMaterializer dispatches the team group and ignores a stray bp adapter', async () => {
  const calls = [];
  const materialize = createMaterializer({
    team: async (nodes) => { calls.push(['team', nodes.map(n => n.id)]); return 'team-ok'; },
    // A caller still passing a `bp` adapter (pre-#1962 shape) must never see it
    // invoked — that is the removal this guards.
    bp: async (nodes) => { calls.push(['bp', nodes.map(n => n.id)]); return 'bp-ok'; },
  });

  const out = await materialize({ nodes: [
    { id: 'dev', role: 'team-member' },
    { id: 'bb01', role: 'bp-instance' },
  ] });
  assert.deepEqual(out.results, { team: 'team-ok' });
  assert.deepEqual(calls, [['team', ['dev', 'bb01']]]);
});

test('createMaterializer skips an empty flow and an absent adapter', async () => {
  const calls = [];
  const m = createMaterializer({ team: async () => { calls.push('team'); } });
  await m({ nodes: [] });
  assert.deepEqual(calls, []);
  // No adapter wired at all → no throw, empty results.
  const out = await createMaterializer({})({ nodes: [{ id: 'x', role: 'agent' }] });
  assert.deepEqual(out.results, {});
  assert.deepEqual(out.plan.team.map(n => n.id), ['x']);
});
