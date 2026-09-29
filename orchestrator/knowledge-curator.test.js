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
  matchExistingSkill,
  curatorSkillExtension,
  curatorExtendProvenance,
  planAutoExtensions,
  buildSkillSynthesisRequest,
  buildSkillExtensionSynthesisRequest,
  markUnsynthesised,
  synthesisFallback,
  UNSYNTHESISED_MARKER,
  ensureSkillFrontmatter,
  renderSkillFrontmatter,
  deriveSkillDescription,
  MAX_DESCRIPTION_LEN,
} = require('./knowledge-curator');
const { parseSkillDescription } = require('./skill-source');
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
  // #779: the config now also carries digest-routing + auto-extend knobs (defaults:
  // routing on, graduate at 4 agents, auto-extend follows autonomy (null), floor 100).
  assert.deepEqual(knowledgeCurationConfig(null), {
    maxAutoPromotionsPerPass: 3, autoThemeMinLessons: 4,
    digestRouting: true, graduateAtAgents: 4, autoExtend: null, extendConfidenceFloor: 100,
    // #780: domain routing on by default, soft skill budget 12, synthesis opt-in.
    domainRouting: true, skillBudget: 12, synthesizeSkills: false,
    // #781: distillation cadence.
    distillAfterAmendments: 5,
    // #2592: a domain's FIRST skill needs ≥3 lessons from ≥2 agents (per team).
    domainSkillThreshold: { minLessons: 3, minAgents: 2 },
  });
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

test('planAutoPromoteThemes: resolveDomain → domain-based naming, absent → lesson-slug (AC4)', () => {
  const clusters = themeClusters(accumulationEntries());
  const gates = resolvePromotionGates(null);
  // No resolver → legacy lesson-slug name (backward-compatible).
  const slug = planAutoPromoteThemes(clusters, [], gates, { autoThemeMinLessons: 4, cap: 3, teamId: 'acme', now: NOW });
  assert.equal(slug.promote.length, 1);
  const slugName = slug.promote[0].name;
  // A resolver that places the theme in a domain → the skill is named after it.
  const resolveDomain = () => ({ id: 'review-practice', name: 'Review practice' });
  const domained = planAutoPromoteThemes(clusters, [], gates, { autoThemeMinLessons: 4, cap: 3, teamId: 'acme', now: NOW, resolveDomain });
  assert.equal(domained.promote.length, 1);
  assert.equal(domained.promote[0].name, 'review-practice');
  assert.equal(domained.promote[0].draft.name, 'review-practice');
  assert.notEqual(domained.promote[0].name, slugName);
  // A resolver that finds no domain → falls back to the lesson-slug name.
  const unresolved = planAutoPromoteThemes(clusters, [], gates, { autoThemeMinLessons: 4, cap: 3, teamId: 'acme', now: NOW, resolveDomain: () => null });
  assert.equal(unresolved.promote[0].name, slugName);
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

// ─── curator auto-extend (#779, skill-aggregation Phase 1) ──────────────────────

// A converged cluster (two agents) whose canonical member id is `canonId` — used
// to seed an existing skill's provenance entryIds for an id-lineage match.
function extendCluster(text = 'always rebase feature branches onto origin main') {
  return convergedClusters(text)[0];
}

test('knowledgeCurationConfig: #779 digest-routing knobs (default on, graduate 4, clamp)', () => {
  assert.equal(knowledgeCurationConfig(null).digestRouting, true);
  assert.equal(knowledgeCurationConfig(null).graduateAtAgents, 4);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { digestRouting: false } }).digestRouting, false);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { digestRouting: { enabled: false } } }).digestRouting, false);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { digestRouting: { graduateAtAgents: 6 } } }).graduateAtAgents, 6);
  // Must be strictly above the convergence threshold (2); a bogus/too-low value clamps to 4.
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { digestRouting: { graduateAtAgents: 2 } } }).graduateAtAgents, 4);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { digestRouting: { graduateAtAgents: 'x' } } }).graduateAtAgents, 4);
});

test('knowledgeCurationConfig: #779 auto-extend knobs (default follow-autonomy null, floor 100, overrides)', () => {
  assert.equal(knowledgeCurationConfig(null).autoExtend, null); // follow the autonomy dial
  assert.equal(knowledgeCurationConfig(null).extendConfidenceFloor, 100);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { autoExtend: false } }).autoExtend, false);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { autoExtend: true } }).autoExtend, true);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { autoExtend: { enabled: false } } }).autoExtend, false);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { autoExtend: { confidenceFloor: 50 } } }).extendConfidenceFloor, 50);
  assert.equal(knowledgeCurationConfig({ knowledgeCuration: { autoExtend: { confidenceFloor: 0 } } }).extendConfidenceFloor, 100);
});

test('matchExistingSkill: id-lineage overlap outranks name; null when no signal', () => {
  const cluster = extendCluster();
  const cand = planAutoPromotions([cluster], [], resolvePromotionGates(null), { threshold: 2, teamId: 'acme', now: NOW }).promote[0].candidate;
  const shared = cand.entryIds[0];
  // id-lineage hit wins big
  const m = matchExistingSkill(cand, [
    { name: 'unrelated-skill', tier: 'team', entryIds: [] },
    { name: 'dev-workflow', tier: 'team', entryIds: [shared] },
  ]);
  assert.equal(m.name, 'dev-workflow');
  assert.ok(m.score >= 100);
  assert.equal(m.idOverlap, 1);
  // no signal → null
  assert.equal(matchExistingSkill(cand, [{ name: 'zzz-none', tier: 'team', entryIds: [] }]), null);
  assert.equal(matchExistingSkill(cand, []), null);
});

test('curatorSkillExtension: appends un-synthesised block; no-op when all present', () => {
  const cluster = extendCluster('rebase feature branches onto origin main before pushing');
  const cand = planAutoPromotions([cluster], [], resolvePromotionGates(null), { threshold: 2, teamId: 'acme', now: NOW }).promote[0].candidate;
  const prior = '# Dev workflow\n\n## The flow\n\n- open a PR\n';
  const ext = curatorSkillExtension(prior, cand);
  assert.ok(ext.added >= 1);
  assert.equal(ext.synthesised, false);
  assert.equal(ext.llmDrafted, false);
  assert.ok(ext.skillMd.includes('## Added knowledge'));
  assert.ok(ext.skillMd.includes('rebase feature branches onto origin main before pushing'));
  // Re-running against a doc that already contains the lesson adds nothing (idempotent-ish).
  const noop = curatorSkillExtension(ext.skillMd, cand);
  assert.equal(noop.added, 0);
  assert.equal(noop.skillMd.replace(/\s+$/, ''), ext.skillMd.replace(/\s+$/, ''));
});

test('curatorExtendProvenance: unions ids/agents, appends curator extension record', () => {
  const cluster = extendCluster();
  const cand = planAutoPromotions([cluster], [], resolvePromotionGates(null), { threshold: 2, teamId: 'acme', now: NOW }).promote[0].candidate;
  const existingProv = { fromTier: 'team', toTier: 'team', teamId: 'acme', entryIds: ['ffffffffffff'], originAgents: ['old-agent'], convergence: ['old-agent'] };
  const prov = curatorExtendProvenance({ existingProv, teamId: 'acme', entryIds: cand.entryIds, candidate: cand, now: NOW });
  assert.ok(prov.entryIds.includes('ffffffffffff')); // preserved
  for (const id of cand.entryIds) assert.ok(prov.entryIds.includes(id)); // merged
  assert.ok(prov.originAgents.includes('old-agent'));
  assert.ok(prov.originAgents.includes('acme-dev-1'));
  assert.equal(prov.lastExtendedBy, 'curator');
  assert.equal(prov.lastExtendedAt, NOW);
  assert.equal(prov.extensions.at(-1).extendedBy, 'curator');
  // #781: an amendment bumps the distillation counter (legacy record → 0, so first = 1).
  assert.equal(prov.amendmentsSinceDistillation, 1);
  const twice = curatorExtendProvenance({ existingProv: prov, teamId: 'acme', entryIds: cand.entryIds, candidate: cand, now: NOW });
  assert.equal(twice.amendmentsSinceDistillation, 2);
});

test('planAutoExtensions: id-lineage match + auto gate → extend, cluster claimed', () => {
  const cluster = extendCluster();
  const cand = planAutoPromotions([cluster], [], resolvePromotionGates(null), { threshold: 2, teamId: 'acme', now: NOW }).promote[0].candidate;
  const skills = [{ name: 'dev-workflow', tier: 'team', entryIds: [cand.entryIds[0]] }];
  const gates = resolvePromotionGates(null); // team>team auto
  const plan = planAutoExtensions([cluster], [], skills, gates, { threshold: 2, cap: 3, confidenceFloor: 100, teamId: 'acme', now: NOW });
  assert.equal(plan.extend.length, 1);
  assert.equal(plan.extend[0].target.name, 'dev-workflow');
  assert.equal(plan.extend[0].transition, 'team>team');
  assert.equal(plan.reviewExtend.length, 0);
  assert.ok(plan.consumedCanonicalIds.has(cluster.canonicalId));
});

test('planAutoExtensions: below-confidence match → review card in extend mode', () => {
  // Name-only overlap ('branch') scores 1 (< floor 100) → review, not auto.
  const cluster = extendCluster('branch protection should require a green build');
  const cand = planAutoPromotions([cluster], [], resolvePromotionGates(null), { threshold: 2, teamId: 'acme', now: NOW }).promote[0].candidate;
  const skills = [{ name: 'branch-hygiene', tier: 'team', entryIds: [] }];
  const gates = resolvePromotionGates(null);
  const plan = planAutoExtensions([cluster], [], skills, gates, { threshold: 2, cap: 3, confidenceFloor: 100, teamId: 'acme', now: NOW });
  assert.equal(plan.extend.length, 0);
  assert.equal(plan.reviewExtend.length, 1);
  assert.equal(plan.reviewExtend[0].reason, 'below-confidence');
  assert.equal(plan.reviewExtend[0].target.name, 'branch-hygiene');
  assert.ok(plan.consumedCanonicalIds.has(cluster.canonicalId)); // still claimed → no create-new
});

test('planAutoExtensions: gate not auto → review (never auto-extend team>global / gated)', () => {
  const cluster = extendCluster();
  const cand = planAutoPromotions([cluster], [], resolvePromotionGates(null), { threshold: 2, teamId: 'acme', now: NOW }).promote[0].candidate;
  const skills = [{ name: 'dev-workflow', tier: 'team', entryIds: [cand.entryIds[0]] }];
  const gates = resolvePromotionGates({ knowledgePromotionGates: { 'team>team': 'review' } });
  const plan = planAutoExtensions([cluster], [], skills, gates, { threshold: 2, cap: 3, confidenceFloor: 100, teamId: 'acme', now: NOW });
  assert.equal(plan.extend.length, 0);
  assert.equal(plan.reviewExtend.length, 1);
  assert.equal(plan.reviewExtend[0].reason, 'gated');
});

test('planAutoExtensions: cap respected — overflow deferred as over-cap review', () => {
  const mk = (kind, id1, id2, txt) => [
    entry({ id: id1, kind, originAgent: 'd1', text: txt, createdAt: '2026-07-08T08:00:00Z', correlationId: '$a' }),
    entry({ id: id2, kind, originAgent: 'd2', text: txt, createdAt: '2026-07-08T09:00:00Z', correlationId: '$b' }),
  ];
  const entries = [
    ...mk('fact', '111111111111', '222222222222', 'alpha lesson unique one'),
    ...mk('convention', '555555555555', '666666666666', 'gamma convention unique three'),
  ];
  const clusters = buildCanonicalProjection(entries, { simThreshold: 0.6, now: NOW }).clusters;
  // Each cluster id-matches its own skill (entryIds seeded from each cluster's members).
  const skills = clusters.map((c, i) => ({ name: `skill-${i}`, tier: 'team', entryIds: [c.memberIds[0]] }));
  const gates = resolvePromotionGates(null);
  const plan = planAutoExtensions(clusters, [], skills, gates, { threshold: 2, cap: 1, confidenceFloor: 100, teamId: 'acme', now: NOW });
  assert.equal(plan.extend.length, 1);
  assert.equal(plan.reviewExtend.length, 1);
  assert.equal(plan.reviewExtend[0].reason, 'over-cap');
  // Every crossing cluster is claimed (extend + review), never left to create-new.
  assert.equal(plan.consumedCanonicalIds.size, clusters.length);
});

test('planAutoExtensions: no matching skill → nothing claimed (left for create-new)', () => {
  const cluster = extendCluster();
  const skills = [{ name: 'totally-unrelated-xyz', tier: 'team', entryIds: ['aaaaaaaaaaab'] }];
  const gates = resolvePromotionGates(null);
  const plan = planAutoExtensions([cluster], [], skills, gates, { threshold: 2, cap: 3, confidenceFloor: 100, teamId: 'acme', now: NOW });
  assert.equal(plan.extend.length, 0);
  assert.equal(plan.reviewExtend.length, 0);
  assert.equal(plan.consumedCanonicalIds.size, 0);
});

test('planAutoExtensions: promoted/dismissed candidate is never auto-extended', () => {
  const cluster = extendCluster();
  const cand = planAutoPromotions([cluster], [], resolvePromotionGates(null), { threshold: 2, teamId: 'acme', now: NOW }).promote[0].candidate;
  const skills = [{ name: 'dev-workflow', tier: 'team', entryIds: [cand.entryIds[0]] }];
  const gates = resolvePromotionGates(null);
  for (const status of ['promoted', 'dismissed']) {
    const plan = planAutoExtensions([cluster], [{ ...cand, status }], skills, gates, { threshold: 2, cap: 3, confidenceFloor: 100, teamId: 'acme', now: NOW });
    assert.equal(plan.extend.length, 0, status);
    assert.equal(plan.reviewExtend.length, 0, status);
  }
});

test('planAutoExtensions: empty skills / empty clusters → empty plan', () => {
  const cluster = extendCluster();
  const p1 = planAutoExtensions([cluster], [], [], resolvePromotionGates(null), { threshold: 2, now: NOW });
  assert.equal(p1.extend.length, 0);
  assert.equal(p1.reviewExtend.length, 0);
  const p2 = planAutoExtensions([], [], [{ name: 'x', tier: 'team', entryIds: [] }], resolvePromotionGates(null), {});
  assert.equal(p2.extend.length, 0);
});

// ─── Phase 2 (#780): domain-based naming + default synthesis ────────────────────

test('curatorSkillDraft: domain-based naming when a domain is supplied (AC4)', () => {
  const cluster = { text: 'always run git pull first on every triggered run', kind: 'convention',
    members: [{ id: 'e1', text: 'always run git pull first', originAgent: 'dev' }], convergence: ['dev', 'rew'] };
  const withDomain = curatorSkillDraft(cluster, { domain: { id: 'dev-workflow', name: 'Dev workflow' } });
  assert.equal(withDomain.name, 'dev-workflow');
  // legacy fallback: no domain → lesson-slug (unchanged behaviour)
  const legacy = curatorSkillDraft(cluster);
  assert.notEqual(legacy.name, 'dev-workflow');
  assert.ok(legacy.name.length > 0);
});

test('curatorThemeSkillDraft: domain-based naming', () => {
  const candidate = { text: 'review practice', kind: 'convention', lessonCount: 3,
    members: [{ id: 'e1', text: 'reviewers apply one label', originAgent: 'rev' }], convergence: ['rev'] };
  assert.equal(curatorThemeSkillDraft(candidate, { domain: { id: 'review-practice', name: 'Review practice' } }).name, 'review-practice');
});

test('buildSkillSynthesisRequest: sectioned playbook contract with all five sections', () => {
  const candidate = { text: 'x', members: [{ text: 'lesson one' }, { text: 'lesson two' }] };
  const req = buildSkillSynthesisRequest(candidate, { domain: { name: 'Dev workflow', roles: ['developer'] } });
  assert.ok(req.max_tokens >= 1024);
  const c = req.messages[0].content;
  for (const s of ['When to use', 'The flow', 'Rules & conventions', 'Gotchas & edge cases', 'Examples & snippets']) {
    assert.ok(c.includes(`## ${s}`), `missing section ${s}`);
  }
  assert.ok(c.includes('# Dev workflow'));
  assert.ok(c.includes('for: developer'));
  assert.ok(c.includes('lesson one'));
});

test('buildSkillExtensionSynthesisRequest: carries the existing doc + new lessons', () => {
  const req = buildSkillExtensionSynthesisRequest('# Dev workflow\n\nold body', { members: [{ text: 'new lesson' }] }, { domain: { name: 'Dev workflow' } });
  const c = req.messages[0].content;
  assert.ok(c.includes('old body'));
  assert.ok(c.includes('new lesson'));
});

test('markUnsynthesised: injects a visible marker after H1, idempotent (AC3)', () => {
  const marked = markUnsynthesised('# Title\n\nbody here');
  assert.ok(marked.includes('Un-synthesised draft'));
  const lines = marked.split('\n');
  assert.equal(lines[0], '# Title'); // H1 stays first
  // idempotent: re-marking does not double-insert
  assert.equal(markUnsynthesised(marked), marked);
  // no H1 → marker at the very top
  assert.ok(markUnsynthesised('just text').startsWith(UNSYNTHESISED_MARKER));
});

test('synthesisFallback: LLM text used when usable, else marked heuristic + re-queued (AC3)', () => {
  const heuristic = { name: 'dev-workflow', skillMd: '# Dev workflow\n\n## What\n- a lesson' };
  const good = synthesisFallback({ heuristic, llmText: '# Dev workflow\n\n## The flow\nabstracted process text that is long enough' });
  assert.equal(good.synthesised, true);
  assert.equal(good.needsResynthesis, false);
  assert.equal(good.llmDrafted, true);
  assert.ok(!good.skillMd.includes('Un-synthesised'));

  const bad = synthesisFallback({ heuristic, llmText: null });
  assert.equal(bad.synthesised, false);
  assert.equal(bad.needsResynthesis, true);
  assert.equal(bad.llmDrafted, false);
  assert.ok(bad.skillMd.includes('Un-synthesised draft'));
  assert.equal(bad.name, 'dev-workflow');

  // too-short / non-markdown LLM output is treated as a failed call
  assert.equal(synthesisFallback({ heuristic, llmText: 'ok' }).synthesised, false);
});

// ─── SKILL.md frontmatter (#805) ────────────────────────────────────────────────

test('ensureSkillFrontmatter: prepends a valid block when none exists (AC1)', () => {
  const out = ensureSkillFrontmatter('# Title\n\n## What\n- a lesson', { name: 'my-skill', description: 'Reach for this when X' });
  assert.ok(out.startsWith('---\n'));
  assert.equal(parseSkillDescription(out), 'Reach for this when X');
  assert.ok(/^name[ \t]*:[ \t]*my-skill$/m.test(out));
  assert.ok(out.includes('# Title')); // body preserved
});

test('ensureSkillFrontmatter: preserves an existing non-empty description (E5)', () => {
  const md = '---\nname: kept\ndescription: authored value\n---\n\n# Kept';
  const out = ensureSkillFrontmatter(md, { name: 'other', description: 'weaker auto value' });
  assert.equal(out, md); // untouched — complete already
  assert.equal(parseSkillDescription(out), 'authored value');
});

test('ensureSkillFrontmatter: injects only the missing key into an existing block', () => {
  const md = '---\nname: only-name\n---\n\n# Body';
  const out = ensureSkillFrontmatter(md, { name: 'ignored', description: 'filled in' });
  assert.equal((out.match(/^---$/gm) || []).length, 2); // still exactly one block
  assert.equal(parseSkillDescription(out), 'filled in');
  assert.ok(/^name[ \t]*:[ \t]*only-name$/m.test(out)); // existing name kept
});

test('ensureSkillFrontmatter: never double-wraps an already-frontmattered body (E1)', () => {
  const md = '---\nname: a\ndescription: b\n---\n\n# Body';
  const out = ensureSkillFrontmatter(md, { name: 'x', description: 'y' });
  assert.equal((out.match(/^---$/gm) || []).length, 2);
  assert.equal(parseSkillDescription(out), 'b');
});

test('ensureSkillFrontmatter: tolerates a stray leading blank before the block', () => {
  const out = ensureSkillFrontmatter('\n\n---\nname: a\ndescription: b\n---\n\n# Body', {});
  assert.ok(out.startsWith('---\n'));
  assert.equal(parseSkillDescription(out), 'b');
});

test('curatorSkillDraft: emits parseable frontmatter with name + description (AC1/AC4)', () => {
  const [cluster] = convergedClusters('branch from origin main always');
  const d = curatorSkillDraft(cluster);
  assert.ok(d.skillMd.startsWith('---\n'));
  const desc = parseSkillDescription(d.skillMd);
  assert.ok(desc && desc.length > 0);
  assert.equal(desc, d.description);
  assert.ok(!/\n/.test(desc)); // single line (AC8)
});

test('curatorThemeSkillDraft: emits parseable frontmatter (AC1)', () => {
  const clusters = convergedClusters('rebase feature branches before pushing');
  const cand = themeToCandidate ? null : null; // guard: use candidate shape directly
  const candidate = { text: 'Dev workflow theme', kind: 'convention', members: [{ text: 'lesson one', originAgent: 'dev-1', id: 'aaaaaaaaaaaa' }], convergence: ['dev-1'], lessonCount: 1 };
  const d = curatorThemeSkillDraft(candidate, { domain: { id: 'dev-workflow', name: 'Dev workflow', roles: ['developer'] } });
  assert.ok(d.skillMd.startsWith('---\n'));
  assert.equal(parseSkillDescription(d.skillMd), d.description);
  assert.equal(d.name, 'dev-workflow');
  void clusters;
});

test('curatorSkillExtension: keeps frontmatter valid; adds it to a legacy doc (AC3)', () => {
  const cluster = extendCluster('rebase feature branches onto origin main before pushing');
  const cand = planAutoPromotions([cluster], [], resolvePromotionGates(null), { threshold: 2, teamId: 'acme', now: NOW }).promote[0].candidate;
  // legacy doc without frontmatter → gains one
  const ext = curatorSkillExtension('# Dev workflow\n\n## The flow\n- open a PR\n', cand, { name: 'dev-workflow' });
  assert.ok(ext.added >= 1);
  assert.ok(ext.skillMd.startsWith('---\n'));
  assert.ok(parseSkillDescription(ext.skillMd));
  assert.ok(ext.skillMd.includes('## Added knowledge'));
  // extending a doc that already carries a description preserves it (E5)
  const ext2 = curatorSkillExtension('---\nname: dev\ndescription: authored one\n---\n\n# Dev\n- old', cand, { name: 'dev' });
  assert.equal(parseSkillDescription(ext2.skillMd), 'authored one');
});

test('synthesisFallback: guarantees frontmatter on LLM output, keeps its own (AC2/E1)', () => {
  const heuristic = { name: 'dev-workflow', skillMd: '---\nname: dev-workflow\ndescription: det fallback\n---\n\n# Dev\n\n## What\n- a lesson' };
  const fm = { name: 'dev-workflow', description: 'det fallback' };
  // LLM omits frontmatter → deterministic fallback injected
  const noFm = synthesisFallback({ heuristic, llmText: '# Dev\n\n## The flow\nlong abstracted playbook content here', frontmatter: fm });
  assert.equal(noFm.synthesised, true);
  assert.equal(parseSkillDescription(noFm.skillMd), 'det fallback');
  // LLM includes its own frontmatter → preserved, not double-wrapped
  const own = synthesisFallback({ heuristic, llmText: '---\nname: dev\ndescription: llm line\n---\n\n# Dev\n\n## The flow\nlong abstracted playbook content here', frontmatter: fm });
  assert.equal(parseSkillDescription(own.skillMd), 'llm line');
  assert.equal((own.skillMd.match(/^---$/gm) || []).length, 2);
  // fallback (bad LLM) branch still guarantees frontmatter
  const bad = synthesisFallback({ heuristic, llmText: null, frontmatter: fm });
  assert.ok(parseSkillDescription(bad.skillMd));
  assert.ok(bad.skillMd.includes('Un-synthesised draft'));
});

test('synthesisFallback: without a frontmatter fallback, output is untouched (legacy)', () => {
  const heuristic = { name: 'x', skillMd: '# X\n\n## What\n- a' };
  const out = synthesisFallback({ heuristic, llmText: '# X\n\n## The flow\nlong enough abstracted content goes here' });
  assert.ok(!out.skillMd.startsWith('---')); // no frontmatter forced when none supplied
});

test('frontmatter scalars survive special characters (E4) and long descriptions (E3)', () => {
  const md = ensureSkillFrontmatter('# T', { name: 'weird-name', description: 'Handle "quoted": colons, and # hashes' });
  assert.equal(parseSkillDescription(md), "Handle 'quoted': colons, and # hashes");
  const long = ensureSkillFrontmatter('# T', { name: 'n', description: 'word '.repeat(120) });
  const d = parseSkillDescription(long);
  assert.ok(d.length <= MAX_DESCRIPTION_LEN);
  assert.ok(d.endsWith('…'));
  assert.ok(!/\n/.test(d));
});

test('deriveSkillDescription: deterministic, single-line, domain-aware', () => {
  const a = deriveSkillDescription({ text: 'always rebase' });
  assert.equal(a, deriveSkillDescription({ text: 'always rebase' })); // deterministic
  assert.ok(!/\n/.test(a));
  const withDomain = deriveSkillDescription({ text: 'x' }, { domain: { name: 'Dev workflow', roles: ['developer'] } });
  assert.ok(withDomain.includes('Dev workflow'));
  assert.ok(withDomain.includes('developer'));
});

test('renderSkillFrontmatter: always yields a non-empty name + description block', () => {
  const block = renderSkillFrontmatter({});
  assert.ok(block.startsWith('---\n') && block.endsWith('\n---'));
  assert.equal(parseSkillDescription(`${block}\n\n# body`), 'Team-curated knowledge skill.');
});
