'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeText,
  tokenSet,
  jaccard,
  similarity,
  similar,
  clusterEntries,
  buildCanonicalProjection,
  crossesConvergence,
  stableSuggestionId,
  planNewSuggestions,
} = require('./knowledge-convergence');
const { parseEntry, validateKnowledgeEntry } = require('./knowledge-store');

const NOW = '2026-07-08T12:00:00Z';

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
    status: over.status || 'active',
    ...over,
  };
}

// ─── text + similarity ───────────────────────────────────────────────────────

test('normalizeText: casing, punctuation, whitespace collapse', () => {
  assert.equal(normalizeText('  Polls  the Events-API, every 30s. '), 'polls the events api every 30s');
  assert.equal(normalizeText('Foo/Bar!!'), 'foo bar');
  assert.equal(normalizeText(''), '');
  assert.equal(normalizeText(null), '');
});

test('jaccard: empty/identical/partial', () => {
  assert.equal(jaccard(new Set(), new Set()), 1);
  assert.equal(jaccard(new Set(['a']), new Set()), 0);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'c'])), 1 / 3);
});

test('similarity: exact-normalized fast path is 1.0', () => {
  assert.equal(similarity('Branch from origin/main', 'branch from  origin main.'), 1);
});

test('similarity: near-duplicate scores high, unrelated scores low', () => {
  const a = 'github-poller polls the Events API every 30s';
  const b = 'the github-poller polls the Events API every 30 seconds';
  assert.ok(similarity(a, b) >= 0.6, `expected >=0.6 got ${similarity(a, b)}`);
  assert.ok(similarity(a, 'this repo unit-tests pure helper cores only') < 0.3);
});

test('similarity: empty text never matches', () => {
  assert.equal(similarity('', 'anything'), 0);
  assert.equal(similar('', '', 0.6), false);
  assert.equal(similar('', 'x', 0.5), false);
});

// ─── clustering ───────────────────────────────────────────────────────────────

test('clusterEntries: near-dups from distinct agents form one cluster; convergence = distinct agents', () => {
  const entries = [
    entry({ id: 'a1a1a1a1a1a1', originAgent: 'dev-1', text: 'The github-poller polls the Events API every 30s', createdAt: '2026-07-08T08:00:00Z' }),
    entry({ id: 'b2b2b2b2b2b2', originAgent: 'dev-2', text: 'github-poller polls the Events API every 30 seconds', createdAt: '2026-07-08T09:00:00Z' }),
    entry({ id: 'c3c3c3c3c3c3', originAgent: 'dev-3', text: 'Branch from origin/main', createdAt: '2026-07-08T10:00:00Z' }),
  ];
  const clusters = clusterEntries(entries, { simThreshold: 0.6 });
  assert.equal(clusters.length, 2);
  const poller = clusters.find((c) => c.text.includes('poller'));
  assert.deepEqual(poller.convergence, ['dev-1', 'dev-2']);
  assert.equal(poller.convergenceCount, 2);
  assert.equal(poller.canonicalId, 'a1a1a1a1a1a1'); // earliest wins
});

test('clusterEntries: same agent recording twice does NOT grow convergence', () => {
  const entries = [
    entry({ id: 'a1a1a1a1a1a1', originAgent: 'dev-1', text: 'the poller polls the events api every 30 seconds', createdAt: '2026-07-08T08:00:00Z' }),
    entry({ id: 'b2b2b2b2b2b2', originAgent: 'dev-1', text: 'the poller polls the events api every 30 seconds now', createdAt: '2026-07-08T09:00:00Z' }),
  ];
  const [c] = clusterEntries(entries, { simThreshold: 0.5 });
  assert.deepEqual(c.convergence, ['dev-1']);
  assert.equal(c.convergenceCount, 1);
  assert.deepEqual(c.memberIds.sort(), ['a1a1a1a1a1a1', 'b2b2b2b2b2b2']);
});

test('clusterEntries: kinds never cross-cluster', () => {
  const entries = [
    entry({ id: 'a1a1a1a1a1a1', kind: 'fact', text: 'same words here now' }),
    entry({ id: 'b2b2b2b2b2b2', kind: 'entity', text: 'same words here now' }),
  ];
  const clusters = clusterEntries(entries, { simThreshold: 0.6 });
  assert.equal(clusters.length, 2);
});

test('clusterEntries: tombstones/malformed are ignored', () => {
  const entries = [
    entry({ id: 'a1a1a1a1a1a1', text: 'hello world foo bar' }),
    entry({ id: 'b2b2b2b2b2b2', text: 'hello world foo bar', status: 'merged', mergedInto: 'a1a1a1a1a1a1' }),
    { garbage: true },
    null,
  ];
  const clusters = clusterEntries(entries, { simThreshold: 0.6 });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].memberIds, ['a1a1a1a1a1a1']);
});

// ─── canonical projection ───────────────────────────────────────────────────

test('buildCanonicalProjection: winner + tombstone + grown convergence; lines valid & idempotent', () => {
  const entries = [
    entry({ id: 'a1a1a1a1a1a1', originAgent: 'dev-1', text: 'poller polls the events api every 30s', createdAt: '2026-07-08T08:00:00Z' }),
    entry({ id: 'b2b2b2b2b2b2', originAgent: 'dev-2', text: 'the poller polls the events api every 30 s', createdAt: '2026-07-08T09:00:00Z' }),
  ];
  const proj = buildCanonicalProjection(entries, { simThreshold: 0.5, now: NOW });
  assert.equal(proj.byKind.fact.canonical.length, 1);
  assert.equal(proj.byKind.fact.tombstones.length, 1);

  const canon = proj.byKind.fact.canonical[0];
  assert.equal(canon.id, 'a1a1a1a1a1a1');
  assert.deepEqual(canon.convergence, ['dev-1', 'dev-2']);
  assert.equal(canon.status, 'active');
  assert.equal(canon.updatedAt, NOW);

  const tomb = proj.byKind.fact.tombstones[0];
  assert.equal(tomb.id, 'b2b2b2b2b2b2');
  assert.equal(tomb.status, 'merged');
  assert.equal(tomb.mergedInto, 'a1a1a1a1a1a1');

  // every projected line parses + validates (canonical is a valid entry; tombstone parses)
  for (const line of proj.lines.fact) {
    const parsed = parseEntry(line);
    assert.ok(parsed, `line parses: ${line}`);
  }
  assert.ok(validateKnowledgeEntry(parseEntry(proj.lines.fact[0])).ok);

  // idempotent: re-run over the same shards → byte-identical lines
  const proj2 = buildCanonicalProjection(entries, { simThreshold: 0.5, now: NOW });
  assert.deepEqual(proj2.lines, proj.lines);
});

test('buildCanonicalProjection: no near-dups → no tombstones, convergence stays 1', () => {
  const entries = [
    entry({ id: 'a1a1a1a1a1a1', originAgent: 'dev-1', text: 'branch from origin main' }),
    entry({ id: 'b2b2b2b2b2b2', originAgent: 'dev-2', text: 'this repo tests pure helper cores only' }),
  ];
  const proj = buildCanonicalProjection(entries, { simThreshold: 0.6, now: NOW });
  assert.equal(proj.byKind.fact.canonical.length, 2);
  assert.equal(proj.byKind.fact.tombstones.length, 0);
  for (const c of proj.byKind.fact.canonical) assert.equal(c.convergence.length, 1);
});

// ─── suggestions ────────────────────────────────────────────────────────────

test('crossesConvergence: default threshold 2', () => {
  assert.equal(crossesConvergence({ convergence: ['a'] }, 2), false);
  assert.equal(crossesConvergence({ convergence: ['a', 'b'] }, 2), true);
  assert.equal(crossesConvergence({ convergence: ['a', 'b'] }, 3), false);
});

test('stableSuggestionId: order-independent, deterministic', () => {
  const a = stableSuggestionId({ kind: 'fact', memberIds: ['x1', 'y2'] });
  const b = stableSuggestionId({ kind: 'fact', memberIds: ['y2', 'x1'] });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, stableSuggestionId({ kind: 'entity', memberIds: ['x1', 'y2'] }));
});

test('planNewSuggestions: raises crossers, skips known, batches once', () => {
  const clusters = clusterEntries([
    entry({ id: 'a1a1a1a1a1a1', originAgent: 'dev-1', text: 'poller polls the events api every 30s', createdAt: '2026-07-08T08:00:00Z' }),
    entry({ id: 'b2b2b2b2b2b2', originAgent: 'dev-2', text: 'poller polls the events api every 30 s', createdAt: '2026-07-08T09:00:00Z' }),
    entry({ id: 'c3c3c3c3c3c3', originAgent: 'dev-1', text: 'lonely solitary singular unique fact', createdAt: '2026-07-08T10:00:00Z' }),
  ], { simThreshold: 0.5 });

  const { raise, batch } = planNewSuggestions(clusters, [], { threshold: 2, teamId: 'acme', now: NOW });
  assert.equal(raise.length, 1);
  assert.equal(raise[0].convergenceCount, 2);
  assert.equal(raise[0].source, 'convergence');
  assert.equal(raise[0].status, 'open');
  assert.equal(batch.type, 'suggestion');
  assert.equal(batch.count, 1);
  assert.equal(batch.teamId, 'acme');

  // second pass with the candidate already known → nothing raised
  const second = planNewSuggestions(clusters, raise, { threshold: 2, teamId: 'acme', now: NOW });
  assert.equal(second.raise.length, 0);
  assert.equal(second.batch, null);
});
