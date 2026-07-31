import test from 'node:test';
import assert from 'node:assert/strict';

import { groupAgentsByTeam } from './group-agents-by-team.js';

test('groupAgentsByTeam: multiple agents sharing a teamId land in one group', () => {
  const agents = [
    { id: 'a1', teamId: 't1', teamName: 'Team One' },
    { id: 'a2', teamId: 't1', teamName: 'Team One' },
  ];
  const groups = groupAgentsByTeam(agents);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 't1');
  assert.equal(groups[0].name, 'Team One');
  assert.equal(groups[0].agents.length, 2);
});

test('groupAgentsByTeam: a group name falls back to teamId when teamName is missing', () => {
  const agents = [{ id: 'a1', teamId: 't1', teamName: null }];
  const groups = groupAgentsByTeam(agents);
  assert.equal(groups[0].name, 't1');
});

test('groupAgentsByTeam: agents with no teamId land in a trailing "Standalone agents" group', () => {
  const agents = [
    { id: 'a1', teamId: 't1', teamName: 'Team One' },
    { id: 'a2', teamId: null, teamName: null },
  ];
  const groups = groupAgentsByTeam(agents);
  assert.equal(groups.length, 2);
  assert.equal(groups[groups.length - 1].name, 'Standalone agents');
  assert.equal(groups[groups.length - 1].agents.length, 1);
  assert.equal(groups[groups.length - 1].agents[0].id, 'a2');
});

test('groupAgentsByTeam: groups are sorted by name via localeCompare', () => {
  const agents = [
    { id: 'a1', teamId: 'tz', teamName: 'Zeta Team' },
    { id: 'a2', teamId: 'ta', teamName: 'Alpha Team' },
  ];
  const groups = groupAgentsByTeam(agents);
  assert.deepEqual(groups.map(g => g.name), ['Alpha Team', 'Zeta Team']);
});

test('groupAgentsByTeam: standalone group always comes after every real team group, regardless of name', () => {
  const agents = [
    { id: 'a1', teamId: null, teamName: null },
    { id: 'a2', teamId: 'tz', teamName: 'Zeta Team' },
  ];
  const groups = groupAgentsByTeam(agents);
  assert.deepEqual(groups.map(g => g.name), ['Zeta Team', 'Standalone agents']);
});

test('groupAgentsByTeam: empty input returns an empty array', () => {
  assert.deepEqual(groupAgentsByTeam([]), []);
});

test('groupAgentsByTeam: a single agent produces a single single-agent group', () => {
  const groups = groupAgentsByTeam([{ id: 'a1', teamId: 't1', teamName: 'Team One' }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].agents.length, 1);
});
