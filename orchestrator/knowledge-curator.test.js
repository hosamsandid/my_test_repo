'use strict';

// Unit tests for the knowledge-curator pure core (Knowledge Flow, Phase 4).
// Run: node --test orchestrator/knowledge-curator.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  slugifySkillName,
  curatorSkillDraft,
  curatorSkillProvenance,
  curatorThemeSkillDraft,
  curatorThemeSkillProvenance,
  targetTransitionFor,
  planAutoPromotions,
  planAutoPromoteThemes,
} = require('./knowledge-curator');
const { resolvePromotionGates, knowledgeCurationConfig } = require('./knowledge-store');
const { buildCanonicalProjection, groupRelatedClusters, themeToCandidate } = require('./knowledge-convergence');

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

// Two distinct agents recording the same lesson → one converged cluster (conv 2).
function convergedClusters(text = 'this repo unit-tests pure helper cores only') {
  const entries = [
    entry({ id: 'aaaaaaaaaaaa', originAgent: 'acme-dev-1', text, createdAt: '2026-07-08T08:00:00Z', correlationId: '$e1' }),
    entry({ id: 'bbbbbbbbbbbb', originAgent: 'acme-dev-2', text, createdAt: '2026-07-08T09:00:00Z', correlationId: '$e2' }),
  ];
  return buildCanonicalProjection(entries, { simThreshold: 0.6, now: NOW }).clusters;
}

// ─── gate resolution ───────────────────────────────────────────────────────────

test('resolvePromotionGates: conservative defaults; team>global forced review', () => {
  const g = resolvePromotionGates(null);
  assert.equal(g['team>team'], 'auto');
  assert.equal(g['team>global'], 'review');
  assert.equal(g['agent>team'], 'review');
});

test('resolvePromotionGates: unknown mode clamps to review; team>global stays review even if auto', () => {
  const g = resolvePromotionGates({ knowledgePromotionGates: { 'team>team': 'bogus', 'team>global': 'auto', 'agent>team': 'auto' } });
  assert.equal(g['team>team'], 'review'); // invalid → fail-safe review
  assert.equal(g['team>global'], 'review'); // forced
  assert.equal(g['agent>team'], 'auto');
});

test('resolvePromotionGates: absent transition uses its default, present valid value honoured', () => {
  const g = resolvePromotionGates({ knowledgePromotionGates: { 'team>team': 'review' } });
  assert.equal(g['team>team'], 'review');
  assert.equal(g['agent>team'], 'review'); // absent → default
});

test('knowledgeCurationConfig: default cap + autoThemeMinLessons, clamp, legacy env', () => {
  assert.deepEqual(knowledgeCurationConfig(null), { maxAutoPromotionsPerPass: 3, autoThemeMinLessons: 4 });
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { maxAutoPromotionsPerPass: 7 } }).maxAutoPromotionsPerPass, 7);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { maxAutoPromotionsPerPass: 0 } }).maxAutoPromotionsPerPass, 3);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { maxAutoPromotionsPerPass: 'x' } }).maxAutoPromotionsPerPass, 3);
  // #604: autoThemeMinLessons per-team overridable, default 4, clamps to int >= 1.
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { autoThemeMinLessons: 6 } }).autoThemeMinLessons, 6);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { autoThemeMinLessons: 0 } }).autoThemeMinLessons, 4);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { autoThemeMinLessons: 'x' } }).autoThemeMinLessons, 4);
});

// ─── target transition ──────────────────────────────────────────────────────────

test('targetTransitionFor: always team>team in v1', () => {
  assert.equal(targetTransitionFor({ kind: 'fact' }), 'team>team');
});

// ─── planning ────────────────────────────────────────────────────────────────────

test('planAutoPromotions: converged cluster with auto gate → promote', () => {
  const clusters = convergedClusters();
  const gates = resolvePromotionGates(null); // team>team auto
  const { promote, defer } = planAutoPromotions(clusters, [], gates, { threshold: 2, cap: 3, teamId: 'acme', now: NOW });
  assert.equal(promote.length, 1);
  assert.equal(defer.length, 0);
  assert.equal(promote[0].transition, 'team>team');
  assert.equal(typeof promote[0].name, 'string');
  assert.ok(promote[0].draft.skillMd.includes('#'));
  assert.equal(promote[0].candidate.convergenceCount, 2);
});

test('planAutoPromotions: below-threshold cluster is skipped', () => {
  const entries = [entry({ id: 'aaaaaaaaaaaa', originAgent: 'solo', text: 'only I know this' })];
  const clusters = buildCanonicalProjection(entries, { simThreshold: 0.6, now: NOW }).clusters;
  const gates = resolvePromotionGates(null);
  const { promote, defer } = planAutoPromotions(clusters, [], gates, { threshold: 2, cap: 3, now: NOW });
  assert.equal(promote.length, 0);
  assert.equal(defer.length, 0);
});

test('planAutoPromotions: review gate → defer with reason "gated"', () => {
  const clusters = convergedClusters();
  const gates = resolvePromotionGates({ knowledgePromotionGates: { 'team>team': 'review' } });
  const { promote, defer } = planAutoPromotions(clusters, [], gates, { threshold: 2, cap: 3, teamId: 'acme', now: NOW });
  assert.equal(promote.length, 0);
  assert.equal(defer.length, 1);
  assert.equal(defer[0].reason, 'gated');
});

test('planAutoPromotions: promoted/dismissed candidate is never re-promoted', () => {
  const clusters = convergedClusters();
  const gates = resolvePromotionGates(null);
  const cand = planAutoPromotions(clusters, [], gates, { threshold: 2, cap: 3, teamId: 'acme', now: NOW }).promote[0].candidate;
  for (const status of ['promoted', 'dismissed']) {
    const { promote, defer } = planAutoPromotions(clusters, [{ ...cand, status }], gates, { threshold: 2, cap: 3, teamId: 'acme', now: NOW });
    assert.equal(promote.length, 0, status);
    assert.equal(defer.length, 0, status);
  }
});

test('planAutoPromotions: cap respected, overflow deferred as "over-cap" (lossless)', () => {
  // Three distinct converged clusters (different kinds keep them apart).
  const mk = (kind, id1, id2, txt) => [
    entry({ id: id1, kind, originAgent: 'd1', text: txt, createdAt: '2026-07-08T08:00:00Z', correlationId: '$a' }),
    entry({ id: id2, kind, originAgent: 'd2', text: txt, createdAt: '2026-07-08T09:00:00Z', correlationId: '$b' }),
  ];
  const entries = [
    ...mk('fact', '111111111111', '222222222222', 'alpha lesson unique one'),
    ...mk('entity', '333333333333', '444444444444', 'beta entity unique two'),
    ...mk('convention', '555555555555', '666666666666', 'gamma convention unique three'),
  ];
  const clusters = buildCanonicalProjection(entries, { simThreshold: 0.6, now: NOW }).clusters;
  const gates = resolvePromotionGates(null);
  const { promote, defer } = planAutoPromotions(clusters, [], gates, { threshold: 2, cap: 2, teamId: 'acme', now: NOW });
  assert.equal(promote.length, 2);
  assert.equal(defer.length, 1);
  assert.equal(defer[0].reason, 'over-cap');
  // Nothing lost: every crossing cluster is either promoted or deferred.
  assert.equal(promote.length + defer.length, clusters.length);
});

test('planAutoPromotions: empty inputs → empty plan', () => {
  assert.deepEqual(planAutoPromotions([], [], {}, {}), { promote: [], defer: [] });
  assert.deepEqual(planAutoPromotions(null, null, null, {}), { promote: [], defer: [] });
});

// ─── draft + provenance ───────────────────────────────────────────────────────

test('curatorSkillDraft: slug name, member texts, no secret fields', () => {
  const [cluster] = convergedClusters('branch from origin main always');
  const d = curatorSkillDraft(cluster);
  assert.ok(/^[a-z0-9-]+$/.test(d.name));
  assert.ok(d.skillMd.includes('branch from origin main always'));
  assert.equal(d.llmDrafted, false);
  assert.ok(!/correlationId|sessionId|token|secret/i.test(d.skillMd));
});

test('curatorSkillProvenance: promotedBy curator, entryIds present, attribution carried', () => {
  const [cluster] = convergedClusters();
  const prov = curatorSkillProvenance({ teamId: 'acme', cluster, entryIds: cluster.memberIds, now: NOW });
  assert.equal(prov.promotedBy, 'curator');
  assert.equal(prov.fromTier, 'team');
  assert.equal(prov.toTier, 'team');
  assert.ok(Array.isArray(prov.entryIds) && prov.entryIds.length >= 1); // graph skillEntryIds needs this
  assert.deepEqual(prov.originAgents.sort(), ['acme-dev-1', 'acme-dev-2']);
  assert.deepEqual(prov.convergence.sort(), ['acme-dev-1', 'acme-dev-2']);
  assert.equal(prov.originTeamId, 'acme');
  assert.equal(prov.promotedAt, NOW);
  assert.ok(prov.sessions.length >= 1);
});

test('curatorSkillProvenance: falls back to cluster memberIds when entryIds omitted', () => {
  const [cluster] = convergedClusters();
  const prov = curatorSkillProvenance({ teamId: 'acme', cluster, now: NOW });
  assert.deepEqual(prov.entryIds.slice().sort(), cluster.memberIds.slice().sort());
});

test('slugifySkillName: fallback to kind-based slug for empty/invalid text', () => {
  assert.equal(slugifySkillName('', 'entity'), 'entity-skill');
  assert.equal(slugifySkillName('!!!', 'fact'), 'fact-skill');
  assert.equal(slugifySkillName('Hello World Foo'), 'hello-world-foo');
});

// ─── theme (single-role accumulation) auto-promotion (#604) ─────────────────────

// One agent accumulating several topically-related (not near-duplicate) lessons —
// the primary single-role learning model. buildCanonicalProjection keeps them as
// distinct clusters; groupRelatedClusters bundles them into one theme.
function accumulationEntries() {
  return [
    entry({ id: 'a1a1a1a1a1a1', originAgent: 'acme-rev', kind: 'fact', createdAt: '2026-07-08T08:00:00Z',
      text: 'the ready-for-review label on a pull request triggers the code review agent' }),
    entry({ id: 'b2b2b2b2b2b2', originAgent: 'acme-rev', kind: 'convention', createdAt: '2026-07-08T09:00:00Z',
      text: 'always set the ready-for-review label after opening a pull request' }),
    entry({ id: 'c3c3c3c3c3c3', originAgent: 'acme-rev', kind: 'fact', createdAt: '2026-07-08T10:00:00Z',
      text: 'github delivers issues labeled reliably but pull request label events are not guaranteed' }),
    entry({ id: 'd4d4d4d4d4d4', originAgent: 'acme-rev', kind: 'convention', createdAt: '2026-07-08T11:00:00Z',
      text: 'a stale pull request review needs the ready-for-review label reapplied to re-notify' }),
  ];
}

// A second, vocabulary-disjoint theme (container build) so it never cross-groups
// with the label theme — used to exercise the per-pass cap.
function buildThemeEntries() {
  return [
    entry({ id: 'e5e5e5e5e5e5', originAgent: 'acme-ops', kind: 'fact', createdAt: '2026-07-08T08:00:00Z',
      text: 'the agent container image builds with podman compose from the makefile target' }),
    entry({ id: 'f6f6f6f6f6f6', originAgent: 'acme-ops', kind: 'convention', createdAt: '2026-07-08T09:00:00Z',
      text: 'rebuild the orchestrator container image with make build after editing the dockerfile' }),
    entry({ id: '676767676767', originAgent: 'acme-ops', kind: 'fact', createdAt: '2026-07-08T10:00:00Z',
      text: 'the podman compose file wires every service and volume for the container image stack' }),
    entry({ id: '787878787878', originAgent: 'acme-ops', kind: 'convention', createdAt: '2026-07-08T11:00:00Z',
      text: 'run make up to start the container image stack after a fresh podman compose build' }),
  ];
}

function themeClusters(entries) {
  return buildCanonicalProjection(entries, { simThreshold: 0.6, now: NOW }).clusters;
}

test('accumulation fixture forms one strong single-agent theme', () => {
  const clusters = themeClusters(accumulationEntries());
  assert.equal(clusters.length, 4); // 4 distinct lessons, no near-dups
  const groups = groupRelatedClusters(clusters, { relatedThreshold: 0.3 });
  assert.equal(groups.length, 1); // one theme
  const cand = themeToCandidate(groups[0], { teamId: 'acme', now: NOW });
  assert.equal(cand.lessonCount, 4);
  assert.deepEqual(cand.convergence, ['acme-rev']); // single role, explicitly allowed
});

test('planAutoPromoteThemes: strong single-agent theme with auto gate → promote', () => {
  const clusters = themeClusters(accumulationEntries());
  const gates = resolvePromotionGates(null); // team>team auto
  const { promote, defer } = planAutoPromoteThemes(clusters, [], gates, { autoThemeMinLessons: 4, cap: 3, teamId: 'acme', now: NOW });
  assert.equal(promote.length, 1);
  assert.equal(defer.length, 0);
  assert.equal(promote[0].transition, 'team>team');
  assert.equal(promote[0].candidate.source, 'related');
  assert.equal(promote[0].candidate.lessonCount, 4);
  assert.equal(typeof promote[0].name, 'string');
  assert.ok(promote[0].draft.skillMd.includes('#'));
});

test('planAutoPromoteThemes: lessonCount below autoThemeMinLessons defers "below-threshold"', () => {
  const clusters = themeClusters(accumulationEntries()); // lessonCount 4
  const gates = resolvePromotionGates(null);
  const { promote, defer } = planAutoPromoteThemes(clusters, [], gates, { autoThemeMinLessons: 5, cap: 3, teamId: 'acme', now: NOW });
  assert.equal(promote.length, 0);
  assert.equal(defer.length, 1);
  assert.equal(defer[0].reason, 'below-threshold');
});

test('planAutoPromoteThemes: card-floor theme (3 lessons) stays a card at default threshold 4', () => {
  const clusters = themeClusters(accumulationEntries().slice(0, 3));
  const groups = groupRelatedClusters(clusters, { relatedThreshold: 0.3 });
  assert.equal(groups[0].length, 3); // strongLessons floor
  const gates = resolvePromotionGates(null);
  const { promote, defer } = planAutoPromoteThemes(clusters, [], gates, { autoThemeMinLessons: 4, cap: 3, teamId: 'acme', now: NOW });
  assert.equal(promote.length, 0);
  assert.equal(defer.length, 1);
  assert.equal(defer[0].reason, 'below-threshold');
});

test('planAutoPromoteThemes: non-auto gate → defer "gated"', () => {
  const clusters = themeClusters(accumulationEntries());
  const gates = resolvePromotionGates({ knowledgePromotionGates: { 'team>team': 'review' } });
  const { promote, defer } = planAutoPromoteThemes(clusters, [], gates, { autoThemeMinLessons: 4, cap: 3, teamId: 'acme', now: NOW });
  assert.equal(promote.length, 0);
  assert.equal(defer.length, 1);
  assert.equal(defer[0].reason, 'gated');
});

test('planAutoPromoteThemes: per-pass cap respected, overflow deferred "over-cap" (lossless)', () => {
  const clusters = themeClusters([...accumulationEntries(), ...buildThemeEntries()]);
  const gates = resolvePromotionGates(null);
  // Both themes qualify with a generous cap.
  const wide = planAutoPromoteThemes(clusters, [], gates, { autoThemeMinLessons: 4, cap: 3, teamId: 'acme', now: NOW });
  assert.equal(wide.promote.length, 2);
  // With cap 1 the second theme is deferred, not dropped.
  const { promote, defer } = planAutoPromoteThemes(clusters, [], gates, { autoThemeMinLessons: 4, cap: 1, teamId: 'acme', now: NOW });
  assert.equal(promote.length, 1);
  assert.ok(defer.some((d) => d.reason === 'over-cap'));
  assert.equal(promote.length + defer.length, wide.promote.length);
});

test('planAutoPromoteThemes: promoted/dismissed theme is never re-promoted (idempotent)', () => {
  const clusters = themeClusters(accumulationEntries());
  const gates = resolvePromotionGates(null);
  const cand = planAutoPromoteThemes(clusters, [], gates, { autoThemeMinLessons: 4, cap: 3, teamId: 'acme', now: NOW }).promote[0].candidate;
  for (const status of ['promoted', 'dismissed']) {
    const { promote } = planAutoPromoteThemes(clusters, [{ ...cand, status }], gates, { autoThemeMinLessons: 4, cap: 3, teamId: 'acme', now: NOW });
    assert.equal(promote.length, 0, status);
  }
});

test('planAutoPromoteThemes: empty inputs → empty plan', () => {
  assert.deepEqual(planAutoPromoteThemes([], [], {}, {}), { promote: [], defer: [] });
  assert.deepEqual(planAutoPromoteThemes(null, null, null, {}), { promote: [], defer: [] });
});

test('curatorThemeSkillDraft: accumulation framing, member texts, no secret fields', () => {
  const groups = groupRelatedClusters(themeClusters(accumulationEntries()), { relatedThreshold: 0.3 });
  const cand = themeToCandidate(groups[0], { teamId: 'acme', now: NOW });
  const d = curatorThemeSkillDraft(cand);
  assert.ok(/^[a-z0-9-]+$/.test(d.name));
  assert.ok(d.skillMd.includes('accumulated by this team')); // theme framing, not convergence
  assert.ok(d.skillMd.includes('pull request')); // a member lesson made it in
  assert.equal(d.llmDrafted, false);
  assert.ok(!/correlationId|sessionId|token|secret/i.test(d.skillMd));
});

test('curatorThemeSkillProvenance: promotedBy curator, entryIds trace every member', () => {
  const groups = groupRelatedClusters(themeClusters(accumulationEntries()), { relatedThreshold: 0.3 });
  const cand = themeToCandidate(groups[0], { teamId: 'acme', now: NOW });
  const prov = curatorThemeSkillProvenance({ teamId: 'acme', candidate: cand, entryIds: cand.entryIds, now: NOW });
  assert.equal(prov.promotedBy, 'curator');
  assert.equal(prov.fromTier, 'team');
  assert.equal(prov.toTier, 'team');
  // graph builder's skillEntryIds() needs the member ids to render the T1→T2 edge.
  assert.deepEqual(prov.entryIds.slice().sort(), cand.entryIds.slice().sort());
  assert.deepEqual(prov.convergence, ['acme-rev']);
  assert.equal(prov.originTeamId, 'acme');
  assert.equal(prov.promotedAt, NOW);
});

test('curatorThemeSkillProvenance: falls back to candidate entryIds when omitted', () => {
  const groups = groupRelatedClusters(themeClusters(accumulationEntries()), { relatedThreshold: 0.3 });
  const cand = themeToCandidate(groups[0], { teamId: 'acme', now: NOW });
  const prov = curatorThemeSkillProvenance({ teamId: 'acme', candidate: cand, now: NOW });
  assert.deepEqual(prov.entryIds.slice().sort(), cand.entryIds.slice().sort());
});
