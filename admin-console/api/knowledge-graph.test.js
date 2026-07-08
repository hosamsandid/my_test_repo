'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseScope,
  dedupById,
  buildKnowledgeGraph,
  summarizeKnowledge,
} = require('./knowledge-graph');

// A fixed clock so the "today" window is deterministic.
const NOW = Date.parse('2026-07-08T12:00:00Z');

function entry(over = {}) {
  return {
    v: 1,
    id: over.id || 'aaaaaaaaaaaa',
    kind: over.kind || 'fact',
    text: over.text || 'a durable statement',
    originAgent: over.originAgent || 'acme-dev-1',
    teamId: over.teamId || 'acme',
    createdAt: over.createdAt || '2026-07-08T09:00:00Z',
    correlationId: over.correlationId || '$evt1',
    convergence: over.convergence || [over.originAgent || 'acme-dev-1'],
    status: 'active',
    ...over,
  };
}

// ── parseScope ────────────────────────────────────────────────────────────────

test('parseScope recognises agent/team, falls back to global', () => {
  assert.deepEqual(parseScope('agent:acme-dev-1'), { kind: 'agent', id: 'acme-dev-1', scope: 'agent:acme-dev-1' });
  assert.deepEqual(parseScope('team:acme'), { kind: 'team', id: 'acme', scope: 'team:acme' });
  assert.equal(parseScope('global').kind, 'global');
  assert.equal(parseScope('nonsense').kind, 'global');
  assert.equal(parseScope('').kind, 'global');
  assert.equal(parseScope(undefined).kind, 'global');
  assert.equal(parseScope('agent:').kind, 'global'); // empty id → global
});

// ── dedupById ───────────────────────────────────────────────────────────────

test('dedupById collapses same id across shard roots, newest wins', () => {
  const stale = entry({ id: 'dup1dup1dup1', text: 'old', createdAt: '2026-07-01T00:00:00Z' });
  const fresh = entry({ id: 'dup1dup1dup1', text: 'new', createdAt: '2026-07-05T00:00:00Z' });
  const out = dedupById([stale, fresh]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'new');
});

test('dedupById uses updatedAt over createdAt when present', () => {
  const a = entry({ id: 'dup2dup2dup2', text: 'a', createdAt: '2026-07-05T00:00:00Z' });
  const b = entry({ id: 'dup2dup2dup2', text: 'b', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-09T00:00:00Z' });
  const out = dedupById([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'b'); // b has the newer updatedAt
});

test('dedupById drops entries without a string id and tolerates junk', () => {
  const out = dedupById([entry({ id: 'good1good1go' }), { id: 123 }, null, 'x', {}]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'good1good1go');
});

// ── lane assignment ───────────────────────────────────────────────────────────

test('team scope: agents→agent lane, entries→team lane, skills→global lane', () => {
  const g = buildKnowledgeGraph({
    scope: 'team:acme',
    now: NOW,
    entries: [
      entry({ id: 'aaaaaaaaaaaa', originAgent: 'acme-dev-1', convergence: ['acme-dev-1'] }),
      entry({ id: 'bbbbbbbbbbbb', originAgent: 'acme-dev-2', convergence: ['acme-dev-2'] }),
    ],
    agents: [
      { id: 'acme-dev-1', parentTeamId: 'acme', displayName: 'Dev One' },
      { id: 'acme-dev-2', parentTeamId: 'acme', displayName: 'Dev Two' },
    ],
    skills: [
      { name: 'cobol-analysis', tier: 'team', teamId: 'acme' },
      { name: 'jcl-convert', tier: 'global', originTeamId: 'acme' },
      { name: 'unrelated', tier: 'team', teamId: 'other' },
    ],
  });
  assert.deepEqual(g.lanes, ['agent', 'team', 'global']);
  const laneKinds = (lane) => g.nodes.filter((n) => n.lane === lane).map((n) => n.kind);
  assert.deepEqual(laneKinds('agent'), ['agent', 'agent']);
  assert.deepEqual(laneKinds('team'), ['item', 'item']);
  // global lane: team-tier of this team + global promoted from this team, not other-team skill.
  const skillNames = g.nodes.filter((n) => n.lane === 'global').map((n) => n.label).sort();
  assert.deepEqual(skillNames, ['cobol-analysis', 'jcl-convert']);
  // agent label comes from displayName.
  assert.equal(g.nodes.find((n) => n.id === 'agent:acme-dev-1').label, 'Dev One');
});

test('global scope collapses agents into one node per contributing team', () => {
  const g = buildKnowledgeGraph({
    scope: 'global',
    now: NOW,
    entries: [
      entry({ id: 'aaaaaaaaaaaa', teamId: 'acme', originAgent: 'acme-dev-1' }),
      entry({ id: 'bbbbbbbbbbbb', teamId: 'acme', originAgent: 'acme-dev-2' }),
      entry({ id: 'cccccccccccc', teamId: 'beta', originAgent: 'beta-dev-1' }),
    ],
    skills: [{ name: 'g1', tier: 'global', originTeamId: 'acme' }],
  });
  const agentLane = g.nodes.filter((n) => n.lane === 'agent');
  assert.deepEqual(agentLane.map((n) => n.id).sort(), ['team:acme', 'team:beta']);
  assert.ok(agentLane.every((n) => n.kind === 'team'));
  // team lane summarised (no per-entry nodes) in global scope.
  assert.equal(g.nodes.filter((n) => n.lane === 'team').length, 0);
  // global-tier skill shows.
  assert.equal(g.nodes.filter((n) => n.lane === 'global').length, 1);
  // counts still summarise all items.
  assert.equal(g.counts.items, 3);
});

// ── harvested edges + convergence ─────────────────────────────────────────────

test('one harvested edge per convergence contributor; origin tagged', () => {
  const g = buildKnowledgeGraph({
    scope: 'team:acme',
    now: NOW,
    entries: [
      entry({
        id: '9f3a12bc7de0',
        originAgent: 'acme-dev-1',
        convergence: ['acme-dev-1', 'acme-dev-2', 'acme-dev-3'],
      }),
    ],
  });
  const harvested = g.edges.filter((e) => e.kind === 'harvested');
  assert.equal(harvested.length, 3);
  assert.equal(harvested.every((e) => e.to === 'item:9f3a12bc7de0'), true);
  const origin = harvested.filter((e) => e.origin);
  assert.equal(origin.length, 1);
  assert.equal(origin[0].from, 'agent:acme-dev-1');
  // convergence surfaced on the item node.
  const item = g.nodes.find((n) => n.id === 'item:9f3a12bc7de0');
  assert.equal(item.convergenceCount, 3);
  assert.equal(item.converged, true);
});

test('single-contributor item is not converged', () => {
  const g = buildKnowledgeGraph({
    scope: 'team:acme',
    now: NOW,
    entries: [entry({ id: 'aaaaaaaaaaaa', convergence: ['acme-dev-1'] })],
  });
  const item = g.nodes.find((n) => n.kind === 'item');
  assert.equal(item.convergenceCount, 1);
  assert.equal(item.converged, false);
  assert.equal(g.edges.filter((e) => e.kind === 'harvested').length, 1);
});

// ── scope filtering ───────────────────────────────────────────────────────────

test('agent scope keeps only items the agent originated or converged on', () => {
  const g = buildKnowledgeGraph({
    scope: 'agent:acme-dev-1',
    now: NOW,
    entries: [
      entry({ id: 'aaaaaaaaaaaa', originAgent: 'acme-dev-1', convergence: ['acme-dev-1'] }),
      entry({ id: 'bbbbbbbbbbbb', originAgent: 'acme-dev-2', convergence: ['acme-dev-2', 'acme-dev-1'] }),
      entry({ id: 'cccccccccccc', originAgent: 'acme-dev-3', convergence: ['acme-dev-3'] }),
    ],
  });
  const itemIds = g.nodes.filter((n) => n.kind === 'item').map((n) => n.id).sort();
  assert.deepEqual(itemIds, ['item:aaaaaaaaaaaa', 'item:bbbbbbbbbbbb']);
  // co-contributor acme-dev-2 renders faded, focus agent not faded.
  const focus = g.nodes.find((n) => n.id === 'agent:acme-dev-1');
  const co = g.nodes.find((n) => n.id === 'agent:acme-dev-2');
  assert.ok(!focus.faded);
  assert.equal(co.faded, true);
  assert.ok(!g.nodes.find((n) => n.id === 'agent:acme-dev-3')); // not a contributor to kept items
});

test('agent scope shows the focus agent even with no contributions', () => {
  const g = buildKnowledgeGraph({
    scope: 'agent:new-agent',
    now: NOW,
    entries: [entry({ id: 'aaaaaaaaaaaa', originAgent: 'other' })],
  });
  assert.ok(g.nodes.find((n) => n.id === 'agent:new-agent'));
  assert.equal(g.counts.items, 0);
});

// ── counts ────────────────────────────────────────────────────────────────────

test('counts: byKind, today, converged, totals', () => {
  const g = buildKnowledgeGraph({
    scope: 'team:acme',
    now: NOW,
    entries: [
      entry({ id: 'aaaaaaaaaaaa', kind: 'fact', createdAt: '2026-07-08T09:00:00Z' }), // today
      entry({ id: 'bbbbbbbbbbbb', kind: 'fact', createdAt: '2026-07-01T00:00:00Z' }), // old
      entry({ id: 'cccccccccccc', kind: 'entity', createdAt: '2026-07-08T11:00:00Z', convergence: ['x', 'y'] }), // today + converged
      entry({ id: 'dddddddddddd', kind: 'convention', createdAt: '2026-07-08T00:00:00Z' }), // today
    ],
  });
  assert.equal(g.counts.items, 4);
  assert.deepEqual(g.counts.byKind, { fact: 2, entity: 1, convention: 1 });
  assert.equal(g.counts.today, 3);
  assert.equal(g.counts.converged, 1);
});

// ── promoted edges ────────────────────────────────────────────────────────────

test('promoted edge appears iff a skill provenance links a present entry', () => {
  const withLink = buildKnowledgeGraph({
    scope: 'team:acme',
    now: NOW,
    entries: [entry({ id: '9f3a12bc7de0' })],
    skills: [{ name: 'cobol-analysis', tier: 'team', teamId: 'acme', provenance: { entryId: '9f3a12bc7de0' } }],
  });
  const promoted = withLink.edges.filter((e) => e.kind === 'promoted');
  assert.equal(promoted.length, 1);
  assert.deepEqual(promoted[0], { from: 'item:9f3a12bc7de0', to: 'skill:cobol-analysis', kind: 'promoted' });

  const noLink = buildKnowledgeGraph({
    scope: 'team:acme',
    now: NOW,
    entries: [entry({ id: '9f3a12bc7de0' })],
    skills: [{ name: 'cobol-analysis', tier: 'team', teamId: 'acme' }],
  });
  assert.equal(noLink.edges.filter((e) => e.kind === 'promoted').length, 0);
});

// ── edge cases ────────────────────────────────────────────────────────────────

test('empty entries → empty lanes, no throw', () => {
  const g = buildKnowledgeGraph({ scope: 'team:acme', now: NOW, entries: [] });
  assert.deepEqual(g.nodes, []);
  assert.deepEqual(g.edges, []);
  assert.equal(g.counts.items, 0);
  assert.deepEqual(g.counts.byKind, {});
});

test('unknown scope resolves to global', () => {
  const g = buildKnowledgeGraph({ scope: 'weird:thing', now: NOW, entries: [entry()] });
  assert.equal(g.scope, 'global');
});

test('warnings are echoed through', () => {
  const g = buildKnowledgeGraph({ scope: 'global', now: NOW, entries: [], warnings: ['no canonical KB clone for team; read from agent checkouts'] });
  assert.deepEqual(g.warnings, ['no canonical KB clone for team; read from agent checkouts']);
});

test('deduped stale + canonical shards converge to one item node', () => {
  const g = buildKnowledgeGraph({
    scope: 'team:acme',
    now: NOW,
    entries: [
      entry({ id: '9f3a12bc7de0', text: 'stale copy', createdAt: '2026-07-01T00:00:00Z' }),
      entry({ id: '9f3a12bc7de0', text: 'fresh copy', createdAt: '2026-07-08T00:00:00Z' }),
    ],
  });
  const items = g.nodes.filter((n) => n.kind === 'item');
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'fresh copy');
});

// ── summary ───────────────────────────────────────────────────────────────────

test('summarizeKnowledge returns lean counts with same scope semantics', () => {
  const entries = [
    entry({ id: 'aaaaaaaaaaaa', createdAt: '2026-07-08T09:00:00Z', convergence: ['x', 'y'] }),
    entry({ id: 'bbbbbbbbbbbb', createdAt: '2026-07-01T00:00:00Z' }),
  ];
  const s = summarizeKnowledge({ scope: 'team:acme', entries, now: NOW });
  assert.equal(s.items, 2);
  assert.equal(s.today, 1);
  assert.equal(s.converged, 1);
  assert.equal(s.scope, 'team:acme');
});
