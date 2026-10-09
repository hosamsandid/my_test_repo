'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildKnowledgeGraph } = require('./knowledge-graph');
const {
  ITEMS_PAGE_DEFAULT, ITEMS_PAGE_MAX, parseItemsQuery, selectItemsPage, graphWithoutItems, lessonTexts,
} = require('./knowledge-items-page');

const NOW = Date.parse('2026-10-07T12:00:00Z');

function entry(i, over = {}) {
  return {
    id: `e${String(i).padStart(11, '0')}`,
    kind: ['fact', 'convention', 'entity'][i % 3],
    text: `Lesson number ${i} about the build`,
    teamId: 't1',
    originAgent: i % 2 ? 'dev' : 'rev',
    convergence: i % 5 === 0 ? ['dev', 'rev'] : [i % 2 ? 'dev' : 'rev'],
    createdAt: new Date(Date.parse('2026-09-01T00:00:00Z') + i * 60_000).toISOString(),
    sourceRefs: [{ type: 'pr', ref: `#${i}`, url: `https://example.invalid/pr/${i}` }],
    ...over,
  };
}

function graphOf(entries) {
  return buildKnowledgeGraph({ scope: 'team:t1', entries, skills: [{ name: 'sk', tier: 'team', teamId: 't1', provenance: { entryId: entries[0].id } }], agents: [], now: NOW });
}

test('parseItemsQuery: defaults, clamping and unknown values', () => {
  assert.deepEqual(parseItemsQuery({}), {
    offset: 0, limit: ITEMS_PAGE_DEFAULT, q: '', kind: 'all', convergedOnly: false, today: false, agent: '', sort: 'created',
  });
  const p = parseItemsQuery({ offset: '-3', limit: '99999', q: '  Build ', kind: 'bogus', converged: '1', today: 'true', agent: 'dev', sort: 'used-asc' });
  assert.equal(p.offset, 0);
  assert.equal(p.limit, ITEMS_PAGE_MAX);
  assert.equal(p.q, 'build');
  assert.equal(p.kind, 'all');
  assert.equal(p.convergedOnly, true);
  assert.equal(p.today, true);
  assert.equal(p.agent, 'dev');
  assert.equal(p.sort, 'used-asc');
  assert.equal(parseItemsQuery({ limit: 'x', sort: 'nope' }).limit, ITEMS_PAGE_DEFAULT);
  assert.equal(parseItemsQuery({ sort: 'nope' }).sort, 'created');
});

test('selectItemsPage: newest first, paged, with the total of all matches', () => {
  const g = graphOf(Array.from({ length: 30 }, (_, i) => entry(i)));
  const p1 = selectItemsPage(g, parseItemsQuery({ limit: '10' }), NOW);
  assert.equal(p1.total, 30);
  assert.equal(p1.items.length, 10);
  assert.equal(p1.items[0].id, entry(29).id, 'ids carry no item: prefix');
  const p3 = selectItemsPage(g, parseItemsQuery({ limit: '10', offset: '20' }), NOW);
  assert.deepEqual(p3.items.map((i) => i.id), Array.from({ length: 10 }, (_, k) => entry(9 - k).id));
  assert.equal(selectItemsPage(g, parseItemsQuery({ offset: '40' }), NOW).items.length, 0);
});

test('selectItemsPage: kind / converged / agent / text / today filters', () => {
  const entries = Array.from({ length: 30 }, (_, i) => entry(i));
  entries.push(entry(99, { text: 'Use NODE_OPTIONS for vite', createdAt: '2026-10-07T10:00:00Z' }));
  const g = graphOf(entries);
  const sel = (q) => selectItemsPage(g, parseItemsQuery(q), NOW);
  assert.ok(sel({ kind: 'convention' }).items.every((i) => i.entryKind === 'convention'));
  assert.equal(sel({ converged: '1' }).total, 6);
  assert.ok(sel({ agent: 'rev' }).items.every((i) => i.convergence.includes('rev')));
  assert.deepEqual(sel({ q: 'node_options' }).items.map((i) => i.id), [entry(99).id]);
  assert.deepEqual(sel({ today: '1' }).items.map((i) => i.id), [entry(99).id]);
});

test('selectItemsPage: Last-used sort mirrors the table (never-used last / first)', () => {
  const g = graphOf([entry(1), entry(2), entry(3)]);
  const nodes = g.nodes.filter((n) => n.kind === 'item');
  nodes[0].lastUsedAt = '2026-10-01T00:00:00Z';
  nodes[1].lastUsedAt = '2026-10-05T00:00:00Z';
  g.retrievalStats = true;
  const desc = selectItemsPage(g, parseItemsQuery({ sort: 'used-desc' }), NOW);
  assert.deepEqual(desc.items.map((i) => i.id), [entry(2).id, entry(1).id, entry(3).id]);
  assert.equal(desc.retrievalStats, true);
  const asc = selectItemsPage(g, parseItemsQuery({ sort: 'used-asc' }), NOW);
  assert.deepEqual(asc.items.map((i) => i.id), [entry(3).id, entry(1).id, entry(2).id]);
});

test('slim items keep what the card / row renders and drop the heavy provenance', () => {
  const g = graphOf([entry(5, { loadTriggers: [{ type: 'keyword', pattern: 'ci' }] })]);
  const [it] = selectItemsPage(g, parseItemsQuery({}), NOW).items;
  assert.equal(it.text, entry(5).text);
  assert.equal(it.converged, true);
  assert.equal(it.convergenceCount, 2);
  assert.deepEqual(it.provenance, { originAgent: 'dev' });
  assert.deepEqual(it.loadTriggers, [{ type: 'keyword', pattern: 'ci' }]);
  assert.equal(it.archived, false);
  assert.equal('sourceRefs' in it.provenance, false);
});

test('graphWithoutItems: drops item nodes and their edges, leaves the cached graph untouched', () => {
  const g = graphOf(Array.from({ length: 10 }, (_, i) => entry(i)));
  const before = JSON.stringify(g);
  const slim = graphWithoutItems(g);
  assert.equal(JSON.stringify(g), before, 'input not mutated');
  assert.equal(slim.nodes.some((n) => n.kind === 'item'), false);
  assert.ok(slim.nodes.some((n) => n.kind === 'agent'));
  assert.ok(slim.nodes.some((n) => n.kind === 'skill'));
  assert.equal(slim.edges.length, 0);
  assert.deepEqual(slim.counts, g.counts, 'header counts stay complete');
  assert.equal(slim.itemsOmitted, true);
});

test('a ~5,000-entry team: initial payload (graph without items + first page) stays well below 1 MB', () => {
  const long = 'x'.repeat(400);
  const g = graphOf(Array.from({ length: 5000 }, (_, i) => entry(i, { text: `${i} ${long}` })));
  const full = Buffer.byteLength(JSON.stringify(g));
  const initial = Buffer.byteLength(JSON.stringify(graphWithoutItems(g)))
    + Buffer.byteLength(JSON.stringify(selectItemsPage(g, parseItemsQuery({}), NOW)));
  assert.ok(full > 2_000_000, `fixture is realistic (${full} B)`);
  assert.ok(initial < 100_000, `initial payload ${initial} B`);
});

test('lessonTexts: live lessons only, oldest first, capped', () => {
  const g = buildKnowledgeGraph({
    scope: 'team:t1', now: NOW, includeArchived: true,
    entries: [entry(1), entry(2, { status: 'archived' }), entry(3)],
  });
  assert.deepEqual(lessonTexts(g), [entry(1).text, entry(3).text]);
  assert.equal(lessonTexts(graphOf(Array.from({ length: 10 }, (_, i) => entry(i))), 4).length, 4);
});
