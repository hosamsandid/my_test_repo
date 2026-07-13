'use strict';

// Unit tests for the knowledge-curator pure core (Knowledge Flow, Phase 4).
// Run: node --test orchestrator/knowledge-curator.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  slugifySkillName,
  curatorSkillDraft,
  curatorSkillProvenance,
  targetTransitionFor,
  planAutoPromotions,
} = require('./knowledge-curator');
const { resolvePromotionGates, knowledgeCurationConfig } = require('./knowledge-store');
const { buildCanonicalProjection } = require('./knowledge-convergence');

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

test('knowledgeCurationConfig: default cap, clamp, legacy env', () => {
  assert.deepEqual(knowledgeCurationConfig(null), { maxAutoPromotionsPerPass: 3 });
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { maxAutoPromotionsPerPass: 7 } }).maxAutoPromotionsPerPass, 7);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { maxAutoPromotionsPerPass: 0 } }).maxAutoPromotionsPerPass, 3);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { maxAutoPromotionsPerPass: 'x' } }).maxAutoPromotionsPerPass, 3);
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
