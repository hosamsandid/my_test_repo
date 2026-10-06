'use strict';

// #571 — the pure decisions behind the knowledge-graph response cache.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  knowledgeGraphCacheKey, mutationInvalidatesKnowledgeGraph, knowledgeGraphTtlMsFromEnv, knowledgeAugmentTimeoutMsFromEnv,
  knowledgeGraphKeyStaleForEvent, claimKnowledgeEventOffset, knowledgeEventMarkForFileSize,
} = require('./knowledge-graph-cache');

test('the key is scope | includeArchived | viewer; every admin shares one build', () => {
  const admin = { all: true, userId: 'u1' };
  const admin2 = { all: true, userId: null };
  assert.equal(knowledgeGraphCacheKey({ scope: 'global', includeArchived: false, viewerScope: admin }), 'global|0|all');
  assert.equal(
    knowledgeGraphCacheKey({ scope: 'global', includeArchived: false, viewerScope: admin }),
    knowledgeGraphCacheKey({ scope: 'global', includeArchived: false, viewerScope: admin2 }),
  );
  assert.equal(knowledgeGraphCacheKey({ scope: 'team:sq', includeArchived: true, viewerScope: { all: false, userId: 'u7' } }), 'team:sq|1|u:u7');
});

test('two non-admin viewers never share an entry', () => {
  const a = knowledgeGraphCacheKey({ scope: 'global', includeArchived: false, viewerScope: { all: false, userId: 'u1' } });
  const b = knowledgeGraphCacheKey({ scope: 'global', includeArchived: false, viewerScope: { all: false, userId: 'u2' } });
  assert.notEqual(a, b);
  assert.notEqual(a, 'global|0|all');
});

test('knowledge, skill and membership writes invalidate; reads and other routes do not', () => {
  for (const [m, u] of [
    ['POST', '/api/knowledge/item/k1/archive'],
    ['POST', '/api/knowledge/promote'],
    ['PUT', '/api/knowledge/review-mode?team=sq'],
    ['DELETE', '/api/skills/foo'],
    ['POST', '/api/skills'],
    ['POST', '/api/skills/promote-to-global'],
    ['POST', '/api/admin/memberships'],
    ['DELETE', '/api/admin/memberships/m1'],
  ]) assert.equal(mutationInvalidatesKnowledgeGraph(m, u), true, `${m} ${u}`);
  assert.equal(mutationInvalidatesKnowledgeGraph('GET', '/api/knowledge/graph'), false);
  assert.equal(mutationInvalidatesKnowledgeGraph('POST', '/api/knowledgebase'), false);
  assert.equal(mutationInvalidatesKnowledgeGraph('POST', '/api/chat/x'), false);
});

test('the roster table (agents, teams, environments) invalidates too', () => {
  assert.equal(mutationInvalidatesKnowledgeGraph('PUT', '/api/agents/sq-dev'), true);
  assert.equal(mutationInvalidatesKnowledgeGraph('POST', '/api/teams'), true);
  assert.equal(mutationInvalidatesKnowledgeGraph('PUT', '/api/environments/env1'), true);
});

test('TTL: default 5 s, explicit 0 is off, junk falls back', () => {
  assert.equal(knowledgeGraphTtlMsFromEnv({}), 5000);
  assert.equal(knowledgeGraphTtlMsFromEnv({ KNOWLEDGE_GRAPH_TTL_MS: '0' }), 0);
  assert.equal(knowledgeGraphTtlMsFromEnv({ KNOWLEDGE_GRAPH_TTL_MS: '1500' }), 1500);
  assert.equal(knowledgeGraphTtlMsFromEnv({ KNOWLEDGE_GRAPH_TTL_MS: 'x' }), 5000);
});

test('augment timeout: default 2500 ms and never off', () => {
  assert.equal(knowledgeAugmentTimeoutMsFromEnv({}), 2500);
  assert.equal(knowledgeAugmentTimeoutMsFromEnv({ KNOWLEDGE_AUGMENT_TIMEOUT_MS: '0' }), 2500);
  assert.equal(knowledgeAugmentTimeoutMsFromEnv({ KNOWLEDGE_AUGMENT_TIMEOUT_MS: '1000' }), 1000);
});

test('a feed event stales its own team, global and agent graphs — never another team', () => {
  const key = (scope, viewerScope = { all: true }) => knowledgeGraphCacheKey({ scope, includeArchived: false, viewerScope });
  const ev = { type: 'harvest', teamId: 'sq', agentId: 'sq-dev' };
  assert.equal(knowledgeGraphKeyStaleForEvent(key('team:sq'), ev), true);
  assert.equal(knowledgeGraphKeyStaleForEvent(key('team:sq', { all: false, userId: 'u1' }), ev), true, 'every viewer of the team');
  assert.equal(knowledgeGraphKeyStaleForEvent(key('team:sq2'), ev), false, 'a sibling squad keeps its build');
  assert.equal(knowledgeGraphKeyStaleForEvent(key('team:s'), ev), false, 'no prefix match');
  assert.equal(knowledgeGraphKeyStaleForEvent(key('global'), ev), true);
  assert.equal(knowledgeGraphKeyStaleForEvent(key('agent:other-agent'), ev), true, 'an agent key cannot name its squad');
  // A userId containing '|' cannot move the scope split.
  assert.equal(knowledgeGraphKeyStaleForEvent(key('team:sq2', { all: false, userId: 'a|team:sq' }), ev), false);
});

test('an event that cannot be placed in a team clears everything', () => {
  for (const ev of [{ type: 'x' }, { teamId: '' }, { teamId: 7 }, null]) {
    assert.equal(knowledgeGraphKeyStaleForEvent('team:sq|0|all', ev), true, JSON.stringify(ev));
  }
});

test('one event offset invalidates once, however many streams tail it', () => {
  let mark = 0;
  const seen = [];
  // Three streams each reach the same two lines (ends at 120 and 250).
  for (const stream of [1, 2, 3]) {
    for (const end of [120, 250]) {
      const r = claimKnowledgeEventOffset(mark, end);
      mark = r.mark;
      if (r.invalidate) seen.push([stream, end]);
    }
  }
  assert.deepEqual(seen, [[1, 120], [1, 250]]);
  assert.equal(mark, 250);
  // A late stream replaying older lines (a `since` reconnect) clears nothing.
  assert.equal(claimKnowledgeEventOffset(250, 80).invalidate, false);
  assert.deepEqual(claimKnowledgeEventOffset(250, 300), { invalidate: true, mark: 300 });
  assert.deepEqual(claimKnowledgeEventOffset(undefined, 10), { invalidate: true, mark: 10 });
  assert.deepEqual(claimKnowledgeEventOffset(5, NaN), { invalidate: false, mark: 5 });
});

test('a truncated events file resets the mark; a grown one keeps it', () => {
  assert.equal(knowledgeEventMarkForFileSize(250, 40), 0);
  assert.equal(knowledgeEventMarkForFileSize(250, 250), 250);
  assert.equal(knowledgeEventMarkForFileSize(250, 900), 250);
  assert.equal(knowledgeEventMarkForFileSize(undefined, 10), 0);
  // After the reset, the new file's first line invalidates again.
  assert.equal(claimKnowledgeEventOffset(knowledgeEventMarkForFileSize(250, 40), 40).invalidate, true);
});

test('mutationInvalidatesKnowledgeGraph: a long run of slashes costs linear time, not a backtracking regex', () => {
  const hostile = `/api/${'/'.repeat(200_000)}a`;
  const t0 = Date.now();
  assert.equal(mutationInvalidatesKnowledgeGraph('POST', hostile), false);
  assert.ok(Date.now() - t0 < 1000);
});
