import test from 'node:test';
import assert from 'node:assert/strict';

import { groupAgentsForOwnership, agentTeamTenant } from './teams-ownership.js';

const agents = [
  { id: 'sdlc', role: 'team', displayName: 'SDLC Squad', teamId: 'alpha' },
  { id: 'sdlc-dev', role: 'team-member', parentTeamId: 'sdlc', teamId: 'alpha' },
  { id: 'sdlc-rev', role: 'team-member', parentTeamId: 'sdlc', teamId: 'alpha' },
  { id: 'lonewolf', role: 'agent', teamId: 'default' },
  { id: 'orch', role: 'orchestrator', teamId: 'default' },
  { id: 'orphan', role: 'team-member', parentTeamId: 'gone', teamId: 'default' },
];

test('groups team-members under their parent Agent Team', () => {
  const { agentTeams } = groupAgentsForOwnership(agents);
  assert.equal(agentTeams.length, 1);
  assert.equal(agentTeams[0].team.id, 'sdlc');
  assert.deepEqual(agentTeams[0].members.map(m => m.id), ['sdlc-dev', 'sdlc-rev']);
});

test('standalone agents exclude team agents and grouped members', () => {
  const { standaloneAgents } = groupAgentsForOwnership(agents);
  const ids = standaloneAgents.map(a => a.id);
  assert.ok(ids.includes('lonewolf'));
  assert.ok(ids.includes('orch'));
  assert.ok(!ids.includes('sdlc'));
  assert.ok(!ids.includes('sdlc-dev'));
});

test('orphan member (parent gone) falls back to standalone, not crashing (E2)', () => {
  const { agentTeams, standaloneAgents } = groupAgentsForOwnership(agents);
  assert.ok(standaloneAgents.map(a => a.id).includes('orphan'));
  // and it is not attached to any team group
  assert.ok(!agentTeams.some(g => g.members.some(m => m.id === 'orphan')));
});

test('a team with zero members still appears as an assignable group (E1)', () => {
  const solo = [{ id: 'solo', role: 'team', displayName: 'Solo', teamId: 'default' }];
  const { agentTeams } = groupAgentsForOwnership(solo);
  assert.equal(agentTeams.length, 1);
  assert.deepEqual(agentTeams[0].members, []);
});

test('handles empty / bad input without throwing', () => {
  assert.deepEqual(groupAgentsForOwnership(null), { agentTeams: [], standaloneAgents: [] });
  assert.deepEqual(groupAgentsForOwnership([]), { agentTeams: [], standaloneAgents: [] });
  assert.deepEqual(groupAgentsForOwnership([null, undefined]), { agentTeams: [], standaloneAgents: [] });
});

test('groups + standalone are sorted by label for stable rendering', () => {
  const many = [
    { id: 'b-team', role: 'team', displayName: 'Bravo' },
    { id: 'a-team', role: 'team', displayName: 'Alpha' },
    { id: 'z-agent', role: 'agent', displayName: 'Zeta' },
    { id: 'm-agent', role: 'agent', displayName: 'Mike' },
  ];
  const { agentTeams, standaloneAgents } = groupAgentsForOwnership(many);
  assert.deepEqual(agentTeams.map(g => g.team.id), ['a-team', 'b-team']);
  assert.deepEqual(standaloneAgents.map(a => a.id), ['m-agent', 'z-agent']);
});

test('agentTeamTenant reads the team agent teamId, else default', () => {
  assert.equal(agentTeamTenant({ teamId: 'alpha' }, 'default'), 'alpha');
  assert.equal(agentTeamTenant({}, 'default'), 'default');
  assert.equal(agentTeamTenant(null, 'default'), 'default');
});
