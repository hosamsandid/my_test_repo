'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAgentModels } = require('./agent-models');

// Minimal enriched usage record: only the fields this view reads (ts, agentId,
// teamId, roleId, modelUsage). Token payloads are irrelevant here.
function rec(ts, agentId, models, { teamId = 'team-a', roleId = 'developer' } = {}) {
  const modelUsage = {};
  for (const m of models) modelUsage[m] = { input: 1, output: 1, cacheCreationInput: 0, cacheReadInput: 0 };
  return { ts, agentId, teamId, roleId, modelUsage };
}

test('per agent: lists every model used, newest first, with invocation counts (AC4)', () => {
  const records = [
    rec('2026-09-01T10:00:00.000Z', 'team-a-dev', ['claude-sonnet-5']),
    rec('2026-09-02T10:00:00.000Z', 'team-a-dev', ['claude-sonnet-5']),
    rec('2026-09-03T10:00:00.000Z', 'team-a-dev', ['claude-opus-4-8']),
  ];
  const out = buildAgentModels(records);
  assert.equal(out.agents.length, 1);
  const a = out.agents[0];
  assert.equal(a.agentId, 'team-a-dev');
  assert.equal(a.teamId, 'team-a');
  assert.equal(a.roleId, 'developer');
  // Newest model first.
  assert.deepEqual(a.models.map((m) => m.model), ['claude-opus-4-8', 'claude-sonnet-5']);
  assert.deepEqual(a.models.map((m) => m.invocations), [1, 2]);
  // Current = the model on the most recent invocation.
  assert.deepEqual(a.currentModels, ['claude-opus-4-8']);
  assert.equal(a.lastUsed, '2026-09-03T10:00:00.000Z');
});

test('a single run using several models flags all of them as current', () => {
  const records = [
    rec('2026-09-01T10:00:00.000Z', 'multi', ['claude-haiku-4-5']),
    rec('2026-09-05T10:00:00.000Z', 'multi', ['claude-sonnet-5', 'claude-haiku-4-5']),
  ];
  const [a] = buildAgentModels(records).agents;
  assert.deepEqual(a.currentModels, ['claude-haiku-4-5', 'claude-sonnet-5']);
  // Every model still visible in the inventory.
  assert.deepEqual(a.models.map((m) => m.model).sort(), ['claude-haiku-4-5', 'claude-sonnet-5']);
});

test('distinct model list across all agents, sorted (drives the filter)', () => {
  const records = [
    rec('2026-09-01T10:00:00.000Z', 'a1', ['claude-fable-5']),
    rec('2026-09-01T11:00:00.000Z', 'a2', ['claude-sonnet-5']),
    rec('2026-09-01T12:00:00.000Z', 'a3', ['claude-fable-5', 'claude-opus-4-8']),
  ];
  const out = buildAgentModels(records);
  assert.deepEqual(out.models, ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5']);
});

test('half-open [since, until) window, matching usage-summary semantics', () => {
  const records = [
    rec('2026-09-01T00:00:00.000Z', 'a', ['m-early']),
    rec('2026-09-02T00:00:00.000Z', 'a', ['m-in']),
    rec('2026-09-03T00:00:00.000Z', 'a', ['m-until']),
  ];
  const out = buildAgentModels(records, { since: '2026-09-02T00:00:00.000Z', until: '2026-09-03T00:00:00.000Z' });
  const [a] = out.agents;
  assert.deepEqual(a.models.map((m) => m.model), ['m-in']); // early excluded, until excluded
});

test('team/role reflect the most recent record when they change over the window', () => {
  const records = [
    rec('2026-09-01T10:00:00.000Z', 'moved', ['m1'], { teamId: 'team-old', roleId: 'planner' }),
    rec('2026-09-09T10:00:00.000Z', 'moved', ['m1'], { teamId: 'team-new', roleId: 'developer' }),
  ];
  const [a] = buildAgentModels(records).agents;
  assert.equal(a.teamId, 'team-new');
  assert.equal(a.roleId, 'developer');
});

test('an agent that ran without model telemetry still appears with empty models', () => {
  const records = [{ ts: '2026-09-01T10:00:00.000Z', agentId: 'silent', teamId: 'team-a', roleId: 'dev' }];
  const [a] = buildAgentModels(records).agents;
  assert.equal(a.agentId, 'silent');
  assert.deepEqual(a.models, []);
  assert.deepEqual(a.currentModels, []);
});

test('missing agentId folds into an "unknown" bucket, never dropped', () => {
  const records = [rec('2026-09-01T10:00:00.000Z', undefined, ['m1'])];
  const [a] = buildAgentModels(records).agents;
  assert.equal(a.agentId, 'unknown');
});

test('null team/role carry through as null (rendered as a gap, not a fake value)', () => {
  const records = [{ ts: '2026-09-01T10:00:00.000Z', agentId: 'solo', teamId: null, roleId: null, modelUsage: { 'claude-fable-5': {} } }];
  const [a] = buildAgentModels(records).agents;
  assert.equal(a.teamId, null);
  assert.equal(a.roleId, null);
  assert.deepEqual(a.currentModels, ['claude-fable-5']);
});

test('agents sorted by team, then role, then agent id', () => {
  const records = [
    rec('2026-09-01T10:00:00.000Z', 'z', ['m'], { teamId: 'team-b', roleId: 'dev' }),
    rec('2026-09-01T10:00:00.000Z', 'a', ['m'], { teamId: 'team-a', roleId: 'planner' }),
    rec('2026-09-01T10:00:00.000Z', 'b', ['m'], { teamId: 'team-a', roleId: 'developer' }),
  ];
  const out = buildAgentModels(records);
  assert.deepEqual(out.agents.map((a) => a.agentId), ['b', 'a', 'z']);
});

test('empty / non-array input is safe', () => {
  assert.deepEqual(buildAgentModels([]).agents, []);
  assert.deepEqual(buildAgentModels(null).agents, []);
  assert.deepEqual(buildAgentModels(undefined).models, []);
});
