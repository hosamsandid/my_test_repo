import test from 'node:test';
import assert from 'node:assert/strict';
import { toRows, modelOptions, filterRowsByModel, isCurrentModel } from './agent-models-view.js';

const payload = {
  since: null,
  until: null,
  agents: [
    {
      agentId: 'team-a-consistency-analyst',
      teamId: 'spec-kit-javier',
      roleId: 'consistency-analyst',
      lastUsed: '2026-09-23T12:00:00.000Z',
      currentModels: ['claude-fable-5'],
      models: [
        { model: 'claude-fable-5', lastUsed: '2026-09-23T12:00:00.000Z', invocations: 9 },
        { model: 'claude-sonnet-5', lastUsed: '2026-09-20T09:00:00.000Z', invocations: 2 },
      ],
    },
    {
      agentId: 'team-a-planner',
      teamId: 'spec-kit-javier',
      roleId: 'planner',
      lastUsed: '2026-09-23T10:00:00.000Z',
      currentModels: ['claude-sonnet-5'],
      models: [{ model: 'claude-sonnet-5', lastUsed: '2026-09-23T10:00:00.000Z', invocations: 5 }],
    },
  ],
  models: ['claude-fable-5', 'claude-sonnet-5'],
};

test('toRows flattens agents with string mirrors for filter/sort', () => {
  const rows = toRows(payload);
  assert.equal(rows.length, 2);
  const analyst = rows[0];
  assert.equal(analyst.agentId, 'team-a-consistency-analyst');
  assert.equal(analyst.teamId, 'spec-kit-javier');
  assert.equal(analyst.roleId, 'consistency-analyst');
  assert.equal(analyst.current, 'claude-fable-5');
  assert.equal(analyst.models, 'claude-fable-5, claude-sonnet-5');
  assert.deepEqual(analyst.modelNames, ['claude-fable-5', 'claude-sonnet-5']);
  assert.equal(analyst.lastUsed, '2026-09-23T12:00:00.000Z');
});

test('toRows renders missing team/role as empty string, not "null"', () => {
  const rows = toRows({ agents: [{ agentId: 'solo', teamId: null, roleId: null, currentModels: [], models: [] }] });
  assert.equal(rows[0].teamId, '');
  assert.equal(rows[0].roleId, '');
  assert.equal(rows[0].models, '');
});

test('toRows is safe on empty / malformed payloads', () => {
  assert.deepEqual(toRows(null), []);
  assert.deepEqual(toRows({}), []);
  assert.deepEqual(toRows({ agents: 'nope' }), []);
});

test('modelOptions prefers the payload model list', () => {
  assert.deepEqual(modelOptions(payload), ['claude-fable-5', 'claude-sonnet-5']);
});

test('modelOptions derives + sorts from agents when the list is absent', () => {
  const p = {
    agents: [
      { agentId: 'a', models: [{ model: 'zeta' }, { model: 'alpha' }] },
      { agentId: 'b', models: [{ model: 'alpha' }] },
    ],
  };
  assert.deepEqual(modelOptions(p), ['alpha', 'zeta']);
});

test('filterRowsByModel answers "which agents use model X"', () => {
  const rows = toRows(payload);
  const onFable = filterRowsByModel(rows, 'claude-fable-5');
  assert.deepEqual(onFable.map((r) => r.agentId), ['team-a-consistency-analyst']);
  // sonnet is used by both agents (analyst historically, planner currently).
  const onSonnet = filterRowsByModel(rows, 'claude-sonnet-5');
  assert.deepEqual(onSonnet.map((r) => r.agentId).sort(), ['team-a-consistency-analyst', 'team-a-planner']);
});

test('filterRowsByModel with no model returns all rows', () => {
  const rows = toRows(payload);
  assert.equal(filterRowsByModel(rows, '').length, 2);
  assert.equal(filterRowsByModel(rows, null).length, 2);
});

test('isCurrentModel distinguishes the live model from older ones', () => {
  const [analyst] = toRows(payload);
  assert.equal(isCurrentModel(analyst, 'claude-fable-5'), true);
  assert.equal(isCurrentModel(analyst, 'claude-sonnet-5'), false); // used, but not current
  assert.equal(isCurrentModel(null, 'claude-fable-5'), false);
});
