'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scopeRepoStatus, findRepoStatus } = require('./github-repo-status-scope');

const rows = [
  {
    repo: 'team-a/app', status: 'listening', group: 'listening',
    tokenEnvironment: { id: 'env-a', name: 'Env A', tokenId: 'tok-a', tokenState: 'ok', teamId: 'team-a' },
    environments: [{ id: 'env-a', name: 'Env A', tokenId: 'tok-a', tokenState: 'ok', teamId: 'team-a' }],
    agentRepositoryAgents: [],
    triggers: [
      { agentId: 'a-dev', agentName: 'A Dev', triggerId: 't1', events: ['push'], counted: true, ignoredReason: null },
      { agentId: 'b-dev', agentName: 'B Dev', triggerId: 't2', events: ['push'], counted: true, ignoredReason: null },
    ],
    relatedAgentIds: ['a-dev', 'b-dev', 'team-a'],
  },
  {
    repo: 'team-b/secret', status: 'no-trigger', group: 'not-listening',
    tokenEnvironment: { id: 'env-b', name: 'Env B', tokenId: 'tok-b', tokenState: 'ok', teamId: 'team-b' },
    environments: [{ id: 'env-b', name: 'Env B', tokenId: 'tok-b', tokenState: 'ok', teamId: 'team-b' }],
    agentRepositoryAgents: [{ id: 'b-dev', name: 'B Dev' }],
    triggers: [],
    relatedAgentIds: ['b-dev', 'team-b'],
  },
];

test('AC9: a system admin sees every repository, without the internal relatedAgentIds', () => {
  const out = scopeRepoStatus(rows, { all: true });
  assert.deepEqual(out.map((r) => r.repo), ['team-a/app', 'team-b/secret']);
  assert.ok(out.every((r) => !('relatedAgentIds' in r)));
  assert.equal(out[0].triggers.length, 2);
});

test('AC9: a non-admin cannot see another team\'s repository', () => {
  const out = scopeRepoStatus(rows, { visibleAgentIds: new Set(['a-dev', 'team-a']), visibleEnvIds: new Set(['env-a']) });
  assert.deepEqual(out.map((r) => r.repo), ['team-a/app']);
});

test('AC9: subscriber details only include agents the viewer may see', () => {
  const [row] = scopeRepoStatus(rows, { visibleAgentIds: new Set(['a-dev', 'team-a']), visibleEnvIds: new Set(['env-a']) });
  assert.deepEqual(row.triggers.map((t) => t.agentId), ['a-dev']);
  assert.ok(!('relatedAgentIds' in row));
});

test('AC9: an environment the viewer cannot see is not named; its token use still shows', () => {
  const [row] = scopeRepoStatus(rows, { visibleAgentIds: new Set(['b-dev']), visibleEnvIds: new Set() });
  assert.equal(row.repo, 'team-a/app');
  assert.deepEqual(row.environments, []);
  assert.equal(row.hiddenEnvironmentCount, 1);
  assert.deepEqual(row.tokenEnvironment, { id: null, name: null, tokenId: null, tokenState: 'ok', teamId: null, hidden: true });
});

test('AC9: token values never appear — only ids', () => {
  const json = JSON.stringify(scopeRepoStatus(rows, { all: true }));
  assert.doesNotMatch(json, /ghp_|github_pat_/);
});

test('findRepoStatus looks a row up by owner/name', () => {
  assert.equal(findRepoStatus(rows, 'team-b/secret').status, 'no-trigger');
  assert.equal(findRepoStatus(rows, 'nope/nope'), null);
  assert.equal(findRepoStatus(null, 'team-b/secret'), null);
});
