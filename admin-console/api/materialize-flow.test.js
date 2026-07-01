'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyNodeProvenance, planMaterialization, createMaterializer } = require('./materialize-flow');

test('classifyNodeProvenance routes BP roles to the claim loop, others to /api/teams', () => {
  assert.equal(classifyNodeProvenance({ role: 'bp-instance' }), 'bp');
  assert.equal(classifyNodeProvenance({ role: 'orchestrator' }), 'bp');
  assert.equal(classifyNodeProvenance({ role: 'team-member' }), 'team');
  assert.equal(classifyNodeProvenance({ role: 'agent' }), 'team');
  assert.equal(classifyNodeProvenance({}), 'team');
});

test('planMaterialization groups nodes by provenance', () => {
  const plan = planMaterialization({ nodes: [
    { id: 'dev', role: 'team-member' },
    { id: 'bb01', role: 'bp-instance' },
    { id: 'rev', role: 'team-member' },
  ] });
  assert.deepEqual(plan.team.map(n => n.id), ['dev', 'rev']);
  assert.deepEqual(plan.bp.map(n => n.id), ['bb01']);
});

test('createMaterializer dispatches each group to its adapter and skips empty groups', async () => {
  const calls = [];
  const materialize = createMaterializer({
    team: async (nodes) => { calls.push(['team', nodes.map(n => n.id)]); return 'team-ok'; },
    bp: async (nodes) => { calls.push(['bp', nodes.map(n => n.id)]); return 'bp-ok'; },
  });

  const out = await materialize({ nodes: [
    { id: 'dev', role: 'team-member' },
    { id: 'bb01', role: 'bp-instance' },
  ] });
  assert.deepEqual(out.results, { team: 'team-ok', bp: 'bp-ok' });
  assert.deepEqual(calls.sort(), [['bp', ['bb01']], ['team', ['dev']]]);

  // No BP nodes → bp adapter is never called.
  const calls2 = [];
  const m2 = createMaterializer({ team: async () => { calls2.push('team'); }, bp: async () => { calls2.push('bp'); } });
  await m2({ nodes: [{ id: 'x', role: 'agent' }] });
  assert.deepEqual(calls2, ['team']);
});
