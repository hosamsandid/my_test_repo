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
