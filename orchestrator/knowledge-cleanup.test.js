'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { planTeamKnowledgePurge, filterEventsForTeam } = require('./knowledge-cleanup');

const ROOTS = {
  cloneRoot: '/workspace/knowledge',
  teamsDir: '/workspace/teams',
  suggestionsDir: '/workspace/knowledge-suggestions',
  archivedDir: '/workspace/knowledge-archived',
  reviewDir: '/workspace/knowledge-review',
  eventsFile: '/workspace/knowledge-events/events.jsonl',
};

// ── planTeamKnowledgePurge ────────────────────────────────────────────────────

test('plan lists every local team-scoped store for a valid team', () => {
  const plan = planTeamKnowledgePurge('agent-studio', ROOTS);
  assert.equal(plan.teamId, 'agent-studio');
  assert.deepEqual(plan.dirs, [
    '/workspace/knowledge/agent-studio',
    '/workspace/teams/agent-studio/skills',
  ]);
  assert.deepEqual(plan.files, [
    '/workspace/knowledge-suggestions/agent-studio.json',
    '/workspace/knowledge-archived/agent-studio.json',
    '/workspace/knowledge-review/agent-studio.json',
  ]);
  assert.equal(plan.eventsFile, '/workspace/knowledge-events/events.jsonl');
});

test('plan targets stay inside their roots (no traversal for a valid slug)', () => {
  const plan = planTeamKnowledgePurge('team_1.beta-2', ROOTS);
  for (const p of [...plan.dirs, ...plan.files]) {
    assert.ok(
      p.startsWith('/workspace/'),
      `${p} should stay under a /workspace root`,
    );
  }
});

test('plan fails closed on an unsafe team id → null (caller removes nothing)', () => {
  for (const bad of ['..', '../secrets', 'a/b', 'a\\b', '', '.', null, undefined, 42]) {
    assert.equal(planTeamKnowledgePurge(bad, ROOTS), null, `bad id ${JSON.stringify(bad)}`);
  }
});

test('plan omits targets whose root is not supplied', () => {
  const plan = planTeamKnowledgePurge('acme', { cloneRoot: '/workspace/knowledge' });
  assert.deepEqual(plan.dirs, ['/workspace/knowledge/acme']);
  assert.deepEqual(plan.files, []);
  assert.equal(plan.eventsFile, null);
});

// ── filterEventsForTeam ───────────────────────────────────────────────────────

const ev = (teamId, extra = {}) =>
  JSON.stringify({ type: 'harvest', ts: '2026-07-13T00:00:00Z', teamId, ...extra });

test('filter drops only the deleted team\'s events, keeps the rest verbatim', () => {
  const lines = [ev('acme'), ev('other'), ev('acme', { agentId: 'x' }), ev('other', { agentId: 'y' })];
  const { kept, removed } = filterEventsForTeam(lines.join('\n'), 'acme');
  assert.equal(removed, 2);
  assert.deepEqual(kept, [ev('other'), ev('other', { agentId: 'y' })]);
});

test('filter keeps unparseable lines (never lose another team\'s history)', () => {
  const lines = ['not json', ev('acme'), '{bad', ev('keep')];
  const { kept, removed } = filterEventsForTeam(lines.join('\n'), 'acme');
  assert.equal(removed, 1);
  assert.deepEqual(kept, ['not json', '{bad', ev('keep')]);
});

test('filter drops blank lines on rewrite', () => {
  const { kept } = filterEventsForTeam(['', ev('keep'), '   ', ''].join('\n'), 'acme');
  assert.deepEqual(kept, [ev('keep')]);
});

test('filter with an unsafe team id removes no events (only trims blanks)', () => {
  const lines = [ev('acme'), ev('other')];
  const { kept, removed } = filterEventsForTeam(lines.join('\n'), '../evil');
  assert.equal(removed, 0);
  assert.deepEqual(kept, lines);
});

test('filter tolerates empty / nullish content', () => {
  assert.deepEqual(filterEventsForTeam('', 'acme'), { kept: [], removed: 0 });
  assert.deepEqual(filterEventsForTeam(null, 'acme'), { kept: [], removed: 0 });
  assert.deepEqual(filterEventsForTeam(undefined, 'acme'), { kept: [], removed: 0 });
});
