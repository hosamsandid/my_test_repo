import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupAgentsByTeam, hiddenAgentsNotice, boundAgentsLead, respawnFailureLead,
} from './group-agents-by-team.js';

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

// ── #1501: the hidden-agent blast-radius copy ────────────────────────
//
// The rule these encode: an agent the caller may not see is never NAMED, and
// never SILENTLY OMITTED either. An operator deciding whether to rotate a
// shared credential needs the true reach of the restart.

test('hiddenAgentsNotice: nothing hidden yields no notice at all', () => {
  assert.equal(hiddenAgentsNotice({ count: 0, teamCount: 0, standalone: 0 }), null);
  assert.equal(hiddenAgentsNotice(undefined), null);
});

test('hiddenAgentsNotice: states the count and where, and says they are restarted too', () => {
  const notice = hiddenAgentsNotice({ count: 3, teamCount: 2, standalone: 0 });
  assert.match(notice, /3 further agents/);
  assert.match(notice, /in 2 other teams/);
  assert.match(notice, /will be restarted/);
  assert.match(notice, /not shown here/);
});

test('hiddenAgentsNotice: one hidden agent in one other team reads in the singular', () => {
  const notice = hiddenAgentsNotice({ count: 1, teamCount: 1, standalone: 0 });
  assert.match(notice, /1 further agent in another team is/);
  assert.doesNotMatch(notice, /agents/);
});

test('hiddenAgentsNotice: teamless hidden agents do not claim a team that does not exist', () => {
  const notice = hiddenAgentsNotice({ count: 2, teamCount: 0, standalone: 2 });
  assert.match(notice, /2 further agents outside your teams are/);
  assert.doesNotMatch(notice, /other team/);
});

test('hiddenAgentsNotice: both kinds of hidden agent are named in one clause', () => {
  const notice = hiddenAgentsNotice({ count: 3, teamCount: 1, standalone: 1 });
  assert.match(notice, /in another team and outside your teams/);
});

test('boundAgentsLead: with visible agents it is the plain pre-#1501 lead', () => {
  assert.match(boundAgentsLead(2, { count: 0, teamCount: 0, standalone: 0 }),
    /The following 2 agents are enabled and bound to this provider, and will be restarted:/);
  assert.match(boundAgentsLead(1, undefined), /The following agent is enabled/);
});

test('boundAgentsLead: all-hidden still announces the restart, in counts only', () => {
  // The real case: a system-scoped provider shared across teams, rotated by an
  // admin of one of them. The list is empty; the restart is not.
  const lead = boundAgentsLead(0, { count: 4, teamCount: 2, standalone: 0 });
  assert.match(lead, /4 agents/);
  assert.match(lead, /in 2 other teams/);
  assert.match(lead, /will be restarted/);
  assert.match(lead, /not listed/);
});

test('boundAgentsLead: all-hidden singular reads correctly', () => {
  const lead = boundAgentsLead(0, { count: 1, teamCount: 1, standalone: 0 });
  assert.match(lead, /1 agent in another team is enabled/);
  assert.match(lead, /it is not listed/);
});

test('respawnFailureLead: no hidden failures is the plain listing lead', () => {
  assert.match(respawnFailureLead(2, 0), /^2 agents could not be restarted/);
  assert.match(respawnFailureLead(2, 0), /:$/);
});

test('respawnFailureLead: hidden failures are added to the total, then explained', () => {
  const lead = respawnFailureLead(1, 2);
  assert.match(lead, /^3 agents could not be restarted/, 'the total is the true reach');
  assert.match(lead, /2 of them you do not have access to/);
});

test('respawnFailureLead: an all-hidden failure is still surfaced', () => {
  const lead = respawnFailureLead(0, 1);
  assert.match(lead, /^1 agent could not be restarted/);
  assert.match(lead, /it may still be using the old credentials/);
  assert.match(lead, /it is not listed/);
});
