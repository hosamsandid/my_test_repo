'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  planConsolidation,
  buildConsolidationMerge,
  makeMigrationState,
  normalizeMigrationState,
  nextPendingDomain,
  advanceMigration,
  markRoutedRemaining,
  isComplete,
  migrationSummary,
  consolidationEvent,
} = require('./knowledge-consolidation');

// NB: the AC3 grant-swap atomicity (add-before-remove) is proven where the merge
// grant-swap planner lives — admin-console/api/skill-merge.test.js — since the two
// services never cross-require. This suite covers the pure state machine + planner +
// the merge-input shape that feeds that planner.

const DOMAINS = [
  { id: 'dev-workflow', name: 'Dev workflow', scope: 'cross-role', roles: ['developer', 'reworker'] },
  { id: 'review-practice', name: 'Review practice', scope: 'role', roles: ['code-reviewer'] },
];

test('planConsolidation: assigns micro-skills + candidates to domains by vocab/lineage', () => {
  const skills = [
    { name: 'dev-workflow-branching', tier: 'team', entryIds: ['aaaaaaaaaaaa'] },
    { name: 'commit-conventions-dev', tier: 'team', entryIds: [] }, // vocab: 'dev'/'conventions' — weak, may be unassigned
    { name: 'review-practice-nits', tier: 'team', entryIds: [] },
    { name: 'totally-unrelated-xyz', tier: 'team', entryIds: [] },
  ];
  const candidates = [
    { id: 'c1', text: 'always run the review checklist before approving', entryIds: [] },
    { id: 'c2', text: 'zzzz qqqq nothing matches here', entryIds: [] },
  ];
  const plan = planConsolidation(DOMAINS, skills, candidates, {
    skillEntryIdsByDomain: { 'dev-workflow': ['aaaaaaaaaaaa'] }, // lineage anchor
  });
  const dev = plan.domains.find((d) => d.domainId === 'dev-workflow');
  const rev = plan.domains.find((d) => d.domainId === 'review-practice');
  assert.ok(dev.memberSkills.includes('dev-workflow-branching'), 'lineage → dev');
  assert.ok(rev.memberSkills.includes('review-practice-nits'), 'vocab → review');
  assert.ok(rev.candidateIds.includes('c1'), 'review candidate routed');
  assert.ok(plan.unassignedSkills.includes('totally-unrelated-xyz'));
  assert.ok(plan.unassignedCandidates.includes('c2'));
  // deterministic domain order
  assert.deepEqual(plan.domains.map((d) => d.domainId), ['dev-workflow', 'review-practice']);
});

test('planConsolidation: no confirmed domains → everything unassigned (no-op safe)', () => {
  const plan = planConsolidation([], [{ name: 's1', entryIds: [] }], [{ id: 'c1', text: 'x' }]);
  assert.deepEqual(plan.domains, []);
  assert.deepEqual(plan.unassignedSkills, ['s1']);
  assert.deepEqual(plan.unassignedCandidates, ['c1']);
});

test('buildConsolidationMerge: ≥2 members → merge input for planMerge; <2 → null', () => {
  const merge = buildConsolidationMerge(
    { domainId: 'dev-workflow', skill: 'dev-workflow', memberSkills: ['a', 'b', 'c'] },
    { teamId: 'agent-studio' },
  );
  assert.equal(merge.retireSources, true);
  assert.equal(merge.sources.length, 3);
  assert.deepEqual(merge.sources[0], { tier: 'team', teamId: 'agent-studio', name: 'a' });
  assert.deepEqual(merge.target, { tier: 'team', teamId: 'agent-studio', name: 'dev-workflow' });
  assert.equal(buildConsolidationMerge({ domainId: 'x', memberSkills: [] }, { teamId: 't' }), null);
});

test('planConsolidation: a domain\'s own skill is always its member (#2592)', () => {
  const plan = planConsolidation(DOMAINS, [
    { name: 'review-practice', tier: 'team', entryIds: [] },
    { name: 'dev-workflow-branching', tier: 'team', entryIds: [] },
  ], []);
  const rev = plan.domains.find((d) => d.domainId === 'review-practice');
  assert.deepEqual(rev.memberSkills, ['review-practice']);
  assert.equal(buildConsolidationMerge(rev, { teamId: 't' }), null, 'already the one domain skill');
});

test('buildConsolidationMerge: ONE member skill folds into the domain skill (#2592 AC11)', () => {
  const fold = buildConsolidationMerge({ domainId: 'x', memberSkills: ['only'] }, { teamId: 't' });
  assert.equal(fold.fold, true);
  assert.deepEqual(fold.sources, [{ tier: 'team', teamId: 't', name: 'only' }]);
  assert.deepEqual(fold.target, { tier: 'team', teamId: 't', name: 'x' });
  assert.equal(fold.retireSources, true);
  // The only member already IS the domain skill → nothing to fold.
  assert.equal(buildConsolidationMerge({ domainId: 'x', memberSkills: ['x'] }, { teamId: 't' }), null);
  // Two or more members stay an ordinary merge (no fold flag).
  assert.equal(buildConsolidationMerge({ domainId: 'x', memberSkills: ['a', 'b'] }, { teamId: 't' }).fold, undefined);
});

test('buildConsolidationMerge: feeds a well-formed multi-source merge (AC3 accept path)', () => {
  // The accept reuses skill-merge planMerge/planGrantMigration (atomicity proven in
  // that suite). Here we only assert the merge input this module produces is the shape
  // that planner consumes: ≥2 team sources + a team target + retireSources.
  const merge = buildConsolidationMerge(
    { domainId: 'dev-workflow', skill: 'dev-workflow', memberSkills: ['dev-workflow-branching', 'commit-conventions-dev'] },
    { teamId: 'agent-studio' },
  );
  assert.ok(merge.sources.length >= 2);
  assert.ok(merge.sources.every((s) => s.tier === 'team' && s.teamId === 'agent-studio' && s.name));
  assert.equal(merge.target.tier, 'team');
  assert.equal(merge.target.name, 'dev-workflow');
  assert.equal(merge.retireSources, true);
});

test('AC3 fixture: ≥10 micro-skills consolidate into a few domain playbooks', () => {
  // A fragmented team: 12 lesson-slug micro-skills, split across two domains by vocab.
  const skills = [
    ...['dev-workflow-branching', 'dev-workflow-commits', 'dev-workflow-rebasing', 'dev-workflow-pr-open',
      'dev-workflow-squash', 'dev-workflow-force-push', 'dev-workflow-stash'].map((name, i) => ({ name, tier: 'team', entryIds: [`dev${i}00000000`] })),
    ...['review-practice-nits', 'review-practice-blockers', 'review-practice-approve',
      'review-practice-security', 'review-practice-tests'].map((name, i) => ({ name, tier: 'team', entryIds: [`rev${i}00000000`] })),
  ];
  assert.ok(skills.length >= 10, 'fixture has ≥10 micro-skills');
  const plan = planConsolidation(DOMAINS, skills, []);
  const dev = plan.domains.find((d) => d.domainId === 'dev-workflow');
  const rev = plan.domains.find((d) => d.domainId === 'review-practice');
  // Every micro-skill routed by vocab into one of the two domains (none unassigned).
  assert.equal(plan.unassignedSkills.length, 0);
  assert.ok(dev.memberSkills.length >= 2 && rev.memberSkills.length >= 2);
  assert.equal(dev.memberSkills.length + rev.memberSkills.length, 12);
  // Each domain produces ONE playbook merge (many micro-skills → one target skill).
  const devMerge = buildConsolidationMerge(dev, { teamId: 'agent-studio' });
  const revMerge = buildConsolidationMerge(rev, { teamId: 'agent-studio' });
  assert.equal(devMerge.target.name, 'dev-workflow');
  assert.equal(revMerge.target.name, 'review-practice');
  assert.ok(devMerge.sources.length >= 2 && devMerge.retireSources === true);
  // 12 micro-skills collapse to 2 domain playbooks.
  const state = makeMigrationState(plan, { teamId: 'agent-studio', now: '2026-07-22T20:00:00Z' });
  assert.equal(state.domains.length, 2);
});

test('makeMigrationState + resumability: nextPendingDomain, advance, complete (AC5)', () => {
  const plan = planConsolidation(DOMAINS, [
    { name: 'dev-workflow-branching', entryIds: ['aaaaaaaaaaaa'] },
    { name: 'dev-workflow-commits', entryIds: ['bbbbbbbbbbbb'] },
    { name: 'review-practice-nits', entryIds: [] },
  ], [{ id: 'leftover', text: 'zzzz nothing' }], {
    skillEntryIdsByDomain: { 'dev-workflow': ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'] },
  });
  let state = makeMigrationState(plan, { teamId: 'agent-studio', now: '2026-07-22T20:00:00Z' });
  assert.equal(state.status, 'synthesis');
  assert.equal(state.domains.length, 2);
  assert.equal(state.unassignedCandidates.length, 1);

  // Resume: pick up at the first pending domain.
  assert.equal(nextPendingDomain(state).domainId, 'dev-workflow');

  // Accept the first domain → still pending work remains.
  state = advanceMigration(state, { domainId: 'dev-workflow', status: 'accepted', now: '2026-07-22T20:05:00Z' });
  assert.equal(state.domains[0].status, 'accepted');
  assert.equal(state.domains[0].acceptedAt, '2026-07-22T20:05:00Z');
  assert.equal(state.status, 'synthesis', 'not all decided yet');
  assert.equal(nextPendingDomain(state).domainId, 'review-practice');
  assert.equal(isComplete(state), false);

  // Simulate an interruption: round-trip through persistence (normalize) then resume.
  const persisted = JSON.parse(JSON.stringify(state));
  const resumed = normalizeMigrationState(persisted, {});
  assert.equal(nextPendingDomain(resumed).domainId, 'review-practice', 'resumes at the right domain');

  // Skip the second → all decided → phase advances to routing.
  state = advanceMigration(resumed, { domainId: 'review-practice', status: 'skipped', now: '2026-07-22T20:10:00Z' });
  assert.equal(state.status, 'routing');
  assert.equal(nextPendingDomain(state), null);
  assert.equal(isComplete(state), false, 'routing step not yet done');

  // Route the remaining candidates (step 4) → complete.
  state = markRoutedRemaining(state, { now: '2026-07-22T20:12:00Z' });
  assert.equal(state.status, 'complete');
  assert.equal(isComplete(state), true);

  const sum = migrationSummary(state);
  assert.deepEqual(sum, { status: 'complete', total: 2, accepted: 1, skipped: 1, pending: 0, routedRemaining: true, complete: true });
});

test('advanceMigration: pure (never mutates input) + unknown status → accepted', () => {
  const plan = planConsolidation(DOMAINS, [], []);
  const state = makeMigrationState(plan, { teamId: 't', now: '2026-07-22T20:00:00Z' });
  const before = JSON.parse(JSON.stringify(state));
  const next = advanceMigration(state, { domainId: 'dev-workflow', status: 'garbage', now: '2026-07-22T20:01:00Z' });
  assert.deepEqual(state, before, 'input untouched');
  assert.equal(next.domains.find((d) => d.domainId === 'dev-workflow').status, 'accepted');
});

test('normalizeMigrationState: tolerant of legacy/partial docs', () => {
  const n = normalizeMigrationState({ domains: [{ domainId: 'd1', status: 'bogus' }, { name: 'no-id' }] }, {});
  assert.equal(n.version, 1);
  assert.equal(n.domains.length, 1, 'id-less domain dropped');
  assert.equal(n.domains[0].status, 'pending', 'bogus status → pending');
  assert.equal(n.status, 'synthesis');
  assert.equal(n.routedRemaining, false);
});

test('consolidationEvent: transparency shape per step', () => {
  const ev = consolidationEvent('accepted', {
    teamId: 'agent-studio', domain: { id: 'dev-workflow', name: 'Dev workflow' },
    skill: 'dev-workflow', count: 4, now: '2026-07-22T20:00:00Z',
  });
  assert.deepEqual(ev, {
    type: 'consolidation', action: 'accepted', ts: '2026-07-22T20:00:00Z', teamId: 'agent-studio',
    domain: { id: 'dev-workflow', name: 'Dev workflow' }, skill: 'dev-workflow', count: 4,
  });
  assert.equal(consolidationEvent(undefined, {}).action, 'started');
});
