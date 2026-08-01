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
  filterEntriesToTeam,
  buildCanonicalProjection,
  crossesConvergence,
  stableSuggestionId,
  planNewSuggestions,
  classifyClusterRouting,
  planDigestRouting,
  toDigestOnlyRow,
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

test('clusterEntries: identical normalized text converges across kinds (C1, #605)', () => {
  // Same lesson recorded once as a fact, once as a convention — only casing /
  // punctuation differ, so both normalize identically. They must converge into
  // ONE cluster, and the canonical kind is the oldest member's (deterministic).
  const entries = [
    entry({ id: 'b2b2b2b2b2b2', kind: 'convention', originAgent: 'dev-2', text: 'Same words, here now.', createdAt: '2026-07-08T08:00:00Z' }),
    entry({ id: 'a1a1a1a1a1a1', kind: 'fact', originAgent: 'dev-1', text: 'same words here now', createdAt: '2026-07-08T09:00:00Z' }),
  ];
  const clusters = clusterEntries(entries, { simThreshold: 0.6 });
  assert.equal(clusters.length, 1);
  const [c] = clusters;
  assert.equal(c.canonicalId, 'b2b2b2b2b2b2'); // oldest wins
  assert.equal(c.kind, 'convention'); // canonical kind = winner's kind
  assert.deepEqual(c.memberIds.sort(), ['a1a1a1a1a1a1', 'b2b2b2b2b2b2']);
  assert.deepEqual(c.convergence, ['dev-1', 'dev-2']);
  assert.equal(c.convergenceCount, 2);
});

test('clusterEntries: cross-kind fuzzy (non-exact) matches do NOT converge', () => {
  // AC2: the fuzzy path stays within a single kind. These two share most tokens
  // (Jaccard >= threshold) but are not byte-identical after normalization, and
  // they carry different kinds — so they must remain two separate clusters.
  const entries = [
    entry({ id: 'a1a1a1a1a1a1', kind: 'fact', text: 'the poller polls the events api every 30 seconds' }),
    entry({ id: 'b2b2b2b2b2b2', kind: 'entity', text: 'the poller polls the events api every 30 seconds now' }),
  ];
  const clusters = clusterEntries(entries, { simThreshold: 0.5 });
  assert.equal(clusters.length, 2);
});

test('clusterEntries: same-kind fuzzy clustering is unchanged by the cross-kind path', () => {
  // AC2 guard: two same-kind fuzzy near-dups still cluster together exactly as
  // before, even when an unrelated different-kind entry is interleaved.
  const entries = [
    entry({ id: 'a1a1a1a1a1a1', kind: 'fact', originAgent: 'dev-1', text: 'poller polls the events api every 30s', createdAt: '2026-07-08T08:00:00Z' }),
    entry({ id: 'z9z9z9z9z9z9', kind: 'entity', originAgent: 'dev-9', text: 'the makefile builds the container image', createdAt: '2026-07-08T08:30:00Z' }),
    entry({ id: 'b2b2b2b2b2b2', kind: 'fact', originAgent: 'dev-2', text: 'poller polls the events api every 30 s', createdAt: '2026-07-08T09:00:00Z' }),
  ];
  const clusters = clusterEntries(entries, { simThreshold: 0.5 });
  assert.equal(clusters.length, 2);
  const poller = clusters.find((c) => c.text.includes('poller'));
  assert.deepEqual(poller.memberIds.sort(), ['a1a1a1a1a1a1', 'b2b2b2b2b2b2']);
  assert.equal(poller.kind, 'fact');
  assert.deepEqual(poller.convergence, ['dev-1', 'dev-2']);
});

test('buildCanonicalProjection: cross-kind exact merge is deterministic & idempotent (C1, #605)', () => {
  // The evidence case from #605: the SAME lesson recorded as a convention and a
  // fact. Winner (oldest) keeps its kind + id; the absorbed member becomes a
  // merge tombstone (carrying its own original kind) filed under the winner's
  // kind bucket, and the projection round-trips byte-identically.
  const entries = [
    entry({ id: 'b2b2b2b2b2b2', kind: 'convention', originAgent: 'dev-2',
      text: 'gh-as-agent commit sets author but not committer', createdAt: '2026-07-08T08:00:00Z' }),
    entry({ id: 'a1a1a1a1a1a1', kind: 'fact', originAgent: 'dev-1',
      text: 'gh-as-agent commit sets author but not committer.', createdAt: '2026-07-08T09:00:00Z' }),
  ];
  const proj = buildCanonicalProjection(entries, { simThreshold: 0.6, now: NOW });
  assert.equal(proj.clusters.length, 1);
  // Winner's kind bucket holds the canonical entry AND the absorbed tombstone.
  assert.equal(proj.byKind.convention.canonical.length, 1);
  assert.equal(proj.byKind.convention.tombstones.length, 1);
  assert.ok(!proj.byKind.fact); // the fact winner was absorbed, so no fact bucket

  const canon = proj.byKind.convention.canonical[0];
  assert.equal(canon.id, 'b2b2b2b2b2b2');
  assert.equal(canon.kind, 'convention');
  assert.deepEqual(canon.convergence, ['dev-1', 'dev-2']);

  const tomb = proj.byKind.convention.tombstones[0];
  assert.equal(tomb.id, 'a1a1a1a1a1a1');
  assert.equal(tomb.kind, 'fact'); // tombstone keeps its own original kind
  assert.equal(tomb.status, 'merged');
  assert.equal(tomb.mergedInto, 'b2b2b2b2b2b2');

  for (const line of proj.lines.convention) assert.ok(parseEntry(line), `line parses: ${line}`);
  const proj2 = buildCanonicalProjection(entries, { simThreshold: 0.6, now: NOW });
  assert.deepEqual(proj2.lines, proj.lines);
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

// ─── related-theme aggregation ───────────────────────────────────────────────

const {
  groupRelatedClusters,
  themeQualifies,
  themeToCandidate,
  planRelatedSuggestions,
  clustersCoveredByThemes,
} = require('./knowledge-convergence');

// Distinct lessons that share topic vocabulary but are not near-duplicates.
function labelThemeEntries() {
  return [
    entry({ id: 'a1a1a1a1a1a1', originAgent: 'dev-1', kind: 'fact', createdAt: '2026-07-08T08:00:00Z',
      text: 'the ready-for-review label on a pull request triggers the code review agent' }),
    entry({ id: 'b2b2b2b2b2b2', originAgent: 'dev-2', kind: 'convention', createdAt: '2026-07-08T09:00:00Z',
      text: 'always set the ready-for-review label after opening a pull request' }),
    entry({ id: 'c3c3c3c3c3c3', originAgent: 'dev-1', kind: 'fact', createdAt: '2026-07-08T10:00:00Z',
      text: 'github delivers issues.labeled reliably but pull request label events are not guaranteed' }),
    // unrelated vocabulary — must not join the label theme
    entry({ id: 'd4d4d4d4d4d4', originAgent: 'dev-3', kind: 'fact', createdAt: '2026-07-08T11:00:00Z',
      text: 'the container image builds with podman compose from the makefile' }),
  ];
}

test('groupRelatedClusters: groups topic-sharing lessons across kinds, drops singletons', () => {
  const clusters = clusterEntries(labelThemeEntries(), { simThreshold: 0.6 });
  assert.equal(clusters.length, 4); // no near-dups → 4 distinct lessons
  const groups = groupRelatedClusters(clusters, { relatedThreshold: 0.3 });
  assert.equal(groups.length, 1); // only the label theme forms a group
  const g = groups[0];
  assert.equal(g.length, 3);
  const kinds = new Set(g.map((c) => c.kind));
  assert.ok(kinds.has('fact') && kinds.has('convention')); // cross-kind on purpose
});

test('themeQualifies: broad single-agent themes and cross-agent pairs qualify; a solo pair does not', () => {
  const c = (agents) => ({ convergence: agents });
  // 3 lessons, one agent → broad theme, qualifies
  assert.equal(themeQualifies([c(['a']), c(['a']), c(['a'])], { strongLessons: 3 }), true);
  // 2 lessons, two agents → cross-agent theme, qualifies
  assert.equal(themeQualifies([c(['a']), c(['b'])], {}), true);
  // 2 lessons, one agent → not yet a theme
  assert.equal(themeQualifies([c(['a']), c(['a'])], {}), false);
});

test('themeToCandidate: aggregates members, agents, kinds; stable id disjoint from convergence ids', () => {
  const clusters = clusterEntries(labelThemeEntries().slice(0, 3), { simThreshold: 0.6 });
  const groups = groupRelatedClusters(clusters, { relatedThreshold: 0.3 });
  const cand = themeToCandidate(groups[0], { teamId: 'acme', now: NOW });
  assert.equal(cand.source, 'related');
  assert.equal(cand.lessonCount, 3);
  assert.equal(cand.entryIds.length, 3);
  assert.deepEqual(cand.convergence, ['dev-1', 'dev-2']);
  assert.deepEqual(cand.kinds, ['convention', 'fact']);
  assert.equal(cand.text, clusters.find((c) => c.canonicalId === 'a1a1a1a1a1a1').text); // oldest lesson leads
  assert.match(cand.id, /^[0-9a-f]{12}$/);
  // pseudo-kind "related" keeps the id disjoint from a same-member convergence id
  assert.notEqual(cand.id, stableSuggestionId({ kind: cand.kind, memberIds: cand.entryIds }));
  // deterministic regardless of group order
  const cand2 = themeToCandidate(groups[0].slice().reverse(), { teamId: 'acme', now: NOW });
  assert.equal(cand2.id, cand.id);
  assert.equal(cand2.text, cand.text);
});

test('planRelatedSuggestions: raises a qualifying theme once, idempotent incl. dismissed', () => {
  const clusters = clusterEntries(labelThemeEntries(), { simThreshold: 0.6 });
  const { raise, batch } = planRelatedSuggestions(clusters, [], { relatedThreshold: 0.3, teamId: 'acme', now: NOW });
  assert.equal(raise.length, 1);
  assert.equal(raise[0].source, 'related');
  assert.equal(batch.count, 1);
  assert.equal(batch.samples[0].source, 'related');
  assert.equal(batch.samples[0].lessonCount, 3);

  // known (open) → nothing new
  const again = planRelatedSuggestions(clusters, raise, { relatedThreshold: 0.3, teamId: 'acme', now: NOW });
  assert.equal(again.raise.length, 0);
  assert.equal(again.batch, null);

  // dismissed → stays dismissed (operator said no to exactly this member set)
  const dismissed = [{ ...raise[0], status: 'dismissed' }];
  const after = planRelatedSuggestions(clusters, dismissed, { relatedThreshold: 0.3, teamId: 'acme', now: NOW });
  assert.equal(after.raise.length, 0);
});

test('planRelatedSuggestions: promoted knowledge never re-groups', () => {
  const clusters = clusterEntries(labelThemeEntries(), { simThreshold: 0.6 });
  const promoted = [{
    id: 'ffffffffffff', status: 'promoted', source: 'convergence',
    canonicalId: 'a1a1a1a1a1a1', entryIds: ['a1a1a1a1a1a1'],
  }];
  const { raise } = planRelatedSuggestions(clusters, promoted, { relatedThreshold: 0.3, teamId: 'acme', now: NOW });
  // the theme loses its 'a1' lesson; the remaining pair (dev-2 + dev-1) still qualifies
  assert.equal(raise.length, 1);
  assert.ok(!raise[0].entryIds.includes('a1a1a1a1a1a1'));
});

test('planNewSuggestions: dismissed candidates are not re-raised', () => {
  const clusters = clusterEntries([
    entry({ id: 'a1a1a1a1a1a1', originAgent: 'dev-1', text: 'poller polls the events api every 30s' }),
    entry({ id: 'b2b2b2b2b2b2', originAgent: 'dev-2', text: 'poller polls the events api every 30 s' }),
  ], { simThreshold: 0.5 });
  const first = planNewSuggestions(clusters, [], { threshold: 2, teamId: 'acme', now: NOW });
  assert.equal(first.raise.length, 1);
  const dismissed = [{ ...first.raise[0], status: 'dismissed' }];
  const second = planNewSuggestions(clusters, dismissed, { threshold: 2, teamId: 'acme', now: NOW });
  assert.equal(second.raise.length, 0);
});

test('clustersCoveredByThemes: a lesson inside an open theme card is covered', () => {
  const clusters = clusterEntries(labelThemeEntries(), { simThreshold: 0.6 });
  const { raise } = planRelatedSuggestions(clusters, [], { relatedThreshold: 0.3, teamId: 'acme', now: NOW });
  const covered = clustersCoveredByThemes(clusters, raise);
  assert.ok(covered.has('a1a1a1a1a1a1'));
  assert.ok(covered.has('b2b2b2b2b2b2'));
  assert.ok(!covered.has('d4d4d4d4d4d4')); // the unrelated lesson is not covered
  // dismissed theme covers nothing
  const none = clustersCoveredByThemes(clusters, [{ ...raise[0], status: 'dismissed' }]);
  assert.equal(none.size, 0);
});

test('themeToCandidate: members carry sourceRefs for skill provenance', () => {
  const entries = labelThemeEntries().slice(0, 2)
    .map((e, i) => (i === 0 ? { ...e, sourceRefs: [{ kind: 'pr', ref: '42' }] } : e));
  const clusters = clusterEntries(entries, { simThreshold: 0.6 });
  const groups = groupRelatedClusters(clusters, { relatedThreshold: 0.3 });
  const cand = themeToCandidate(groups[0], { teamId: 'acme', now: NOW });
  const withRefs = cand.members.find((m) => m.id === 'a1a1a1a1a1a1');
  assert.deepEqual(withRefs.sourceRefs, [{ kind: 'pr', ref: '42' }]);
  const without = cand.members.find((m) => m.id === 'b2b2b2b2b2b2');
  assert.ok(!('sourceRefs' in without));
});

// ─── filterEntriesToTeam (#603): team-scope the shared-branch clustering input ─

test('filterEntriesToTeam: multi-team shard set keeps only this team’s members', () => {
  const entries = [
    entry({ id: 'a1a1a1a1a1a1', originAgent: 'agent-studio-developer' }),
    entry({ id: 'b2b2b2b2b2b2', originAgent: 'agent-studio-reviewer' }),
    entry({ id: 'c3c3c3c3c3c3', originAgent: 'core-sdlc-developer' }),
    entry({ id: 'd4d4d4d4d4d4', originAgent: 'core-sdlc-reviewer' }),
  ];
  const members = new Set(['agent-studio', 'agent-studio-developer', 'agent-studio-reviewer']);
  const kept = filterEntriesToTeam(entries, members);
  assert.deepEqual(kept.map((e) => e.id), ['a1a1a1a1a1a1', 'b2b2b2b2b2b2']);
});

test('filterEntriesToTeam: single-team set is the identity function (no-op)', () => {
  const entries = [
    entry({ id: 'a1a1a1a1a1a1', originAgent: 'acme-dev-1' }),
    entry({ id: 'b2b2b2b2b2b2', originAgent: 'acme-dev-2' }),
  ];
  const kept = filterEntriesToTeam(entries, ['acme', 'acme-dev-1', 'acme-dev-2']);
  assert.equal(kept.length, entries.length);
  assert.deepEqual(kept, entries);
});

test('filterEntriesToTeam: accepts a member id array as well as a Set', () => {
  const entries = [
    entry({ id: 'a1a1a1a1a1a1', originAgent: 'team-a-dev' }),
    entry({ id: 'c3c3c3c3c3c3', originAgent: 'team-b-dev' }),
  ];
  assert.deepEqual(
    filterEntriesToTeam(entries, ['team-a-dev']).map((e) => e.id),
    ['a1a1a1a1a1a1'],
  );
});

test('filterEntriesToTeam: drops entries whose originAgent is missing/blank or unknown', () => {
  const entries = [
    entry({ id: 'a1a1a1a1a1a1', originAgent: 'team-a-dev' }),
    entry({ id: 'b2b2b2b2b2b2', originAgent: '   ' }),
    { id: 'c3c3c3c3c3c3', kind: 'fact', text: 'no origin at all' },
  ];
  assert.deepEqual(
    filterEntriesToTeam(entries, ['team-a-dev']).map((e) => e.id),
    ['a1a1a1a1a1a1'],
  );
});

test('filterEntriesToTeam: empty member set / non-array input yield no entries', () => {
  const entries = [entry({ id: 'a1a1a1a1a1a1', originAgent: 'team-a-dev' })];
  assert.deepEqual(filterEntriesToTeam(entries, []), []);
  assert.deepEqual(filterEntriesToTeam(entries, new Set()), []);
  assert.deepEqual(filterEntriesToTeam(null, ['team-a-dev']), []);
});

test('filterEntriesToTeam: feeding the scoped subset into projection excludes co-tenant clusters', () => {
  // Two teams sharing a branch; the same near-duplicate text is learned by each.
  const entries = [
    entry({ id: 'a1a1a1a1a1a1', originAgent: 'agent-studio-dev', text: 'branch from origin/main', createdAt: '2026-07-08T08:00:00Z' }),
    entry({ id: 'b2b2b2b2b2b2', originAgent: 'core-sdlc-dev', text: 'branch from origin main', createdAt: '2026-07-08T09:00:00Z' }),
  ];
  const scoped = filterEntriesToTeam(entries, new Set(['agent-studio', 'agent-studio-dev']));
  const proj = buildCanonicalProjection(scoped, { simThreshold: 0.5, now: NOW });
  const allOrigins = proj.clusters.flatMap((c) => c.members.map((m) => m.originAgent));
  assert.ok(allOrigins.every((o) => o === 'agent-studio-dev'));
  assert.ok(!allOrigins.includes('core-sdlc-dev'));
  // Idempotent (AC4): re-projecting the scoped subset is byte-identical.
  const proj2 = buildCanonicalProjection(scoped, { simThreshold: 0.5, now: NOW });
  assert.deepEqual(proj.lines, proj2.lines);
});

test('clustersCoveredByThemes: a promoted MANUAL combine covers its lessons too', () => {
  const clusters = clusterEntries(labelThemeEntries(), { simThreshold: 0.6 });
  const manual = [{
    id: 'eeeeeeeeeeee', source: 'manual', status: 'promoted',
    canonicalId: 'a1a1a1a1a1a1', entryIds: ['a1a1a1a1a1a1', 'b2b2b2b2b2b2'],
  }];
  const covered = clustersCoveredByThemes(clusters, manual);
  assert.ok(covered.has('a1a1a1a1a1a1'));
  assert.ok(covered.has('b2b2b2b2b2b2'));
  assert.ok(!covered.has('c3c3c3c3c3c3'));
});

// ─── digest-only routing (#779, skill-aggregation Phase 1) ──────────────────────

// A converged cluster of `kind` recorded independently by `agentCount` distinct
// agents (convergenceCount == agentCount), used to exercise the graduation edge.
function convergedOfKind(kind, text, agentCount) {
  const entries = [];
  for (let i = 0; i < agentCount; i += 1) {
    entries.push(entry({
      id: String.fromCharCode(97 + i).repeat(12),
      kind,
      originAgent: `acme-dev-${i + 1}`,
      text,
      createdAt: `2026-07-08T0${i}:00:00Z`,
      correlationId: `$e${i}`,
    }));
  }
  return buildCanonicalProjection(entries, { simThreshold: 0.6, now: NOW }).clusters[0];
}

test('classifyClusterRouting: single converged convention/fact → digest-only', () => {
  assert.equal(classifyClusterRouting(convergedOfKind('convention', 'always squash-merge feature prs', 2), {}), 'digest-only');
  assert.equal(classifyClusterRouting(convergedOfKind('fact', 'ci runs node --test on every pr', 2), {}), 'digest-only');
});

test('classifyClusterRouting: below convergence threshold → not-converged', () => {
  assert.equal(classifyClusterRouting(convergedOfKind('convention', 'only one agent knows this', 1), {}), 'not-converged');
});

test('classifyClusterRouting: entity kind is never digest-only (always a candidate)', () => {
  assert.equal(classifyClusterRouting(convergedOfKind('entity', 'the orchestrator service owns credentials', 2), {}), 'candidate');
});

test('classifyClusterRouting: graduates to candidate at >= graduateAtAgents', () => {
  const c3 = convergedOfKind('convention', 'reused label convention across the team', 3);
  const c4 = convergedOfKind('convention', 'reused label convention across the team', 4);
  assert.equal(classifyClusterRouting(c3, { graduateAtAgents: 4 }), 'digest-only');
  assert.equal(classifyClusterRouting(c4, { graduateAtAgents: 4 }), 'candidate');
});

test('planDigestRouting: routes digest-only out of the candidate path, keeps others', () => {
  const conv = convergedOfKind('convention', 'small convention the digest delivers', 2);
  const ent = convergedOfKind('entity', 'named domain entity worth a skill', 2);
  const routed = planDigestRouting([conv, ent], [], { threshold: 2, graduateAtAgents: 4, teamId: 'acme', now: NOW });
  // convention → digest-only; entity → still a candidate
  assert.deepEqual(routed.candidateClusters.map((c) => c.kind), ['entity']);
  assert.equal(routed.digestOnlyClusters.length, 1);
  assert.ok(routed.digestOnlyCanonicalIds.has(conv.canonicalId));
  assert.equal(routed.rows.length, 1);
  assert.equal(routed.rows[0].status, 'digest-only');
  assert.equal(routed.rows[0].kind, 'convention');
  assert.ok(routed.batch && routed.batch.type === 'digest-routing');
  assert.equal(routed.batch.count, 1);
});

test('planDigestRouting: idempotent — a recorded digest-only decision does not re-emit', () => {
  const conv = convergedOfKind('convention', 'small convention the digest delivers', 2);
  const first = planDigestRouting([conv], [], { threshold: 2, graduateAtAgents: 4, teamId: 'acme', now: NOW });
  assert.equal(first.rows.length, 1);
  // Feed the persisted digest-only row back in as existing store state.
  const second = planDigestRouting([conv], first.rows, { threshold: 2, graduateAtAgents: 4, teamId: 'acme', now: NOW });
  assert.equal(second.rows.length, 0, 'no new row for an already-recorded decision');
  assert.equal(second.batch, null);
  // Still routed OUT of the candidate path (the exclusion is not idempotency-gated).
  assert.equal(second.candidateClusters.length, 0);
  assert.ok(second.digestOnlyCanonicalIds.has(conv.canonicalId));
});

test('planDigestRouting: an already-open candidate id is treated as known (no digest row)', () => {
  const conv = convergedOfKind('convention', 'small convention the digest delivers', 2);
  const openRow = { id: stableSuggestionId(conv), status: 'open' };
  const routed = planDigestRouting([conv], [openRow], { threshold: 2, graduateAtAgents: 4, teamId: 'acme', now: NOW });
  assert.equal(routed.rows.length, 0);
  assert.equal(routed.batch, null);
});

test('planDigestRouting: a grown (graduated) cluster becomes a candidate on a later pass (AC2)', () => {
  // Pass 1: two agents → digest-only.
  const c2 = convergedOfKind('convention', 'a recurring team convention', 2);
  const p1 = planDigestRouting([c2], [], { threshold: 2, graduateAtAgents: 4, teamId: 'acme', now: NOW });
  assert.equal(p1.candidateClusters.length, 0);
  const store = [...p1.rows];
  // Pass 2: four agents (grown) — different member-id set ⇒ different stable id ⇒
  // classifies as a candidate and is NOT filtered out of the candidate path.
  const c4 = convergedOfKind('convention', 'a recurring team convention', 4);
  const p2 = planDigestRouting([c4], store, { threshold: 2, graduateAtAgents: 4, teamId: 'acme', now: NOW });
  assert.equal(p2.candidateClusters.length, 1);
  assert.equal(p2.digestOnlyClusters.length, 0);
  // planNewSuggestions now raises it (its grown stable id is unknown to the store).
  const { raise } = planNewSuggestions(p2.candidateClusters, store, { threshold: 2, teamId: 'acme', now: NOW });
  assert.equal(raise.length, 1);
  assert.equal(raise[0].convergenceCount, 4);
});

test('toDigestOnlyRow: lean, keyed by the same stable id a candidate would carry', () => {
  const conv = convergedOfKind('fact', 'ci runs the tests on every pr', 2);
  const row = toDigestOnlyRow(conv, { teamId: 'acme', now: NOW });
  assert.equal(row.id, stableSuggestionId(conv));
  assert.equal(row.status, 'digest-only');
  assert.equal(row.source, 'convergence');
  assert.equal(row.canonicalId, conv.canonicalId);
  assert.equal(row.routedAt, NOW);
  assert.ok(!/correlationId|sessionId|token/i.test(JSON.stringify(row)));
});

// ── #918 semantic convergence layer (synthetic vectors — no model needed) ────

const { semanticLinks: _semanticLinks, toCandidate: _toCandidate } = require('./knowledge-convergence');

function _semEntry(id, text, over = {}) {
  return { v: 1, id, kind: 'fact', text, originAgent: over.agent || 'dev-1',
    teamId: 'acme', createdAt: over.createdAt || '2026-07-01T10:00:00Z',
    correlationId: '$e', convergence: [over.agent || 'dev-1'], status: 'active', ...over };
}

test('#918: a paraphrase pair with no token overlap clusters ONLY with the semantic context, and is flagged', () => {
  const a = _semEntry('a'.repeat(12), 'Der Build schlägt hinter dem Proxy fehl', { agent: 'dev-1' });
  const b = _semEntry('b'.repeat(12), 'npm install fails behind the corporate firewall', { agent: 'dev-2', createdAt: '2026-07-02T10:00:00Z' });
  // lexical-only (no context): two clusters — bit-for-bit today's behaviour
  const plain = clusterEntries([a, b], { simThreshold: 0.6 });
  assert.equal(plain.length, 2);
  assert.ok(plain.every((c) => !c.semanticLink));
  // with vectors: one cluster, semantic-linked, candidate carries the hint
  const semantic = { vectors: new Map([[a.id, [1, 0]], [b.id, [1, 0]]]), cosineThreshold: 0.8 };
  const merged = clusterEntries([a, b], { simThreshold: 0.6, semantic });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].semanticLink, true);
  assert.equal(merged[0].convergenceCount, 2);
  const cand = _toCandidate(merged[0], { teamId: 'acme', now: '2026-07-08T12:00:00Z' });
  assert.equal(cand.semanticMatch, true);
  // a lexically-linked cluster carries NO semantic flag
  const lex = clusterEntries([
    _semEntry('c'.repeat(12), 'branch from origin main always'),
    _semEntry('d'.repeat(12), 'always branch from origin main', { agent: 'dev-2' }),
  ], { simThreshold: 0.6, semantic: { vectors: new Map(), cosineThreshold: 0.8 } });
  assert.equal(lex.length, 1);
  assert.ok(!lex[0].semanticLink);
  assert.ok(!('semanticMatch' in _toCandidate(lex[0], { teamId: 'acme', now: '2026-07-08T12:00:00Z' })));
});

test('#918: below-threshold cosine and missing vectors never link; cross-kind stays exact-only', () => {
  const a = _semEntry('a'.repeat(12), 'poller polls every thirty seconds');
  const b = _semEntry('b'.repeat(12), 'digest budget is three thousand tokens', { agent: 'dev-2' });
  // orthogonal vectors → no link
  const ortho = { vectors: new Map([[a.id, [1, 0]], [b.id, [0, 1]]]), cosineThreshold: 0.8 };
  assert.equal(clusterEntries([a, b], { simThreshold: 0.6, semantic: ortho }).length, 2);
  // one vector missing → no link (a fresh push matches only lexically until the backstop)
  const half = { vectors: new Map([[a.id, [1, 0]]]), cosineThreshold: 0.8 };
  assert.equal(clusterEntries([a, b], { simThreshold: 0.6, semantic: half }).length, 2);
  assert.equal(_semanticLinks(a, b, half), false);
  // cross-kind: identical vectors must NOT link fuzzy cross-kind pairs (#605 rule kept)
  const conv = _semEntry('c'.repeat(12), 'completely different wording here', { kind: 'convention', agent: 'dev-2' });
  const cross = { vectors: new Map([[a.id, [1, 0]], [conv.id, [1, 0]]]), cosineThreshold: 0.8 };
  assert.equal(clusterEntries([a, conv], { simThreshold: 0.6, semantic: cross }).length, 2);
});
