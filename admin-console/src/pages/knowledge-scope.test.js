import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTeamParam,
  resolveSelectedTeam,
  teamTotals,
  streamScopeUrl,
} from './knowledge-scope.js';

test('parseTeamParam: canonical ?team= wins', () => {
  assert.equal(parseTeamParam('?team=alpha'), 'alpha');
  assert.equal(parseTeamParam('team=alpha'), 'alpha');
});

test('parseTeamParam: legacy ?scope=team:<id>', () => {
  assert.equal(parseTeamParam('?scope=team:beta'), 'beta');
});

test('parseTeamParam: team takes precedence over scope', () => {
  assert.equal(parseTeamParam('?team=alpha&scope=team:beta'), 'alpha');
});

test('parseTeamParam: absent / unrelated → null', () => {
  assert.equal(parseTeamParam(''), null);
  assert.equal(parseTeamParam('?foo=bar'), null);
  assert.equal(parseTeamParam('?scope=global'), null);
  assert.equal(parseTeamParam('?scope=agent:x'), null);
});

test('parseTeamParam: accepts a URLSearchParams instance', () => {
  assert.equal(parseTeamParam(new URLSearchParams('team=gamma')), 'gamma');
});

test('resolveSelectedTeam: returns id when it exists', () => {
  const teams = [{ id: 'a' }, { id: 'b' }];
  assert.equal(resolveSelectedTeam('b', teams), 'b');
});

test('resolveSelectedTeam: unknown / stale id → null', () => {
  const teams = [{ id: 'a' }];
  assert.equal(resolveSelectedTeam('zzz', teams), null);
});

test('resolveSelectedTeam: null inputs → null', () => {
  assert.equal(resolveSelectedTeam(null, [{ id: 'a' }]), null);
  assert.equal(resolveSelectedTeam('a', null), null);
});

test('teamTotals: reads a single team graph counts', () => {
  const data = { graph: { counts: { items: 5, today: 2, converged: 1, skills: 3, agents: 4 } } };
  assert.deepEqual(teamTotals(data), { items: 5, today: 2, converged: 1, skills: 3, agents: 4 });
});

test('teamTotals: missing data → all zeros', () => {
  assert.deepEqual(teamTotals(undefined), { items: 0, today: 0, converged: 0, skills: 0, agents: 0 });
  assert.deepEqual(teamTotals({}), { items: 0, today: 0, converged: 0, skills: 0, agents: 0 });
  assert.deepEqual(teamTotals({ graph: {} }), { items: 0, today: 0, converged: 0, skills: 0, agents: 0 });
});

test('streamScopeUrl: scoped url for a team, null otherwise', () => {
  assert.equal(streamScopeUrl('alpha'), '/api/knowledge/stream?scope=team:alpha');
  assert.equal(streamScopeUrl('a b'), '/api/knowledge/stream?scope=team:a%20b');
  assert.equal(streamScopeUrl(null), null);
  assert.equal(streamScopeUrl(''), null);
});
