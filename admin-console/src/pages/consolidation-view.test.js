import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASE_LABELS,
  CONSOLIDATION_ACTION_LABELS,
  consolidationActionLabel,
  nextPendingDomain,
  migrationProgress,
  isResumable,
  mergeForDomain,
  planDomainRows,
  planFoldTotals,
} from './consolidation-view.js';

const PLAN = {
  domains: [
    { domainId: 'ci', name: 'CI & build', skill: 'ci-and-build', scope: 'team', roles: ['dev'], memberSkills: ['a', 'b', 'c'], candidateIds: ['x1', 'x2'] },
    { domainId: 'review', name: 'Review', skill: 'review', memberSkills: ['d'], candidateIds: ['x3'] },
    { domainId: 'empty', name: 'Empty', skill: 'empty', memberSkills: [], candidateIds: [] },
  ],
  unassignedSkills: ['loner'],
  unassignedCandidates: ['x4', 'x5'],
};

const MERGES = [
  { domainId: 'ci', skill: 'ci-and-build', merge: { sources: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], target: { name: 'ci-and-build' }, retireSources: true } },
  // 'review' has one member -> buildConsolidationMerge returned null, so it is absent.
];

function stateFrom(statuses, { routedRemaining = false, status = 'synthesis' } = {}) {
  return {
    version: 1,
    teamId: 'agent-studio',
    status,
    routedRemaining,
    domains: statuses.map(([domainId, st]) => ({ domainId, skill: domainId, name: domainId, status: st, memberSkills: [], candidateIds: [] })),
    unassignedCandidates: [],
  };
}

test('PHASE_LABELS / action labels expose the server phases + actions', () => {
  assert.deepEqual(Object.keys(PHASE_LABELS), ['bootstrap', 'synthesis', 'routing', 'complete']);
  assert.deepEqual(Object.keys(CONSOLIDATION_ACTION_LABELS), ['started', 'accepted', 'skipped', 'routed', 'completed']);
  assert.equal(consolidationActionLabel('accepted'), 'Playbook accepted');
  assert.equal(consolidationActionLabel('nope'), 'Consolidation update');
});

test('nextPendingDomain returns the first pending step, null when all decided', () => {
  const s = stateFrom([['a', 'accepted'], ['b', 'pending'], ['c', 'pending']]);
  assert.equal(nextPendingDomain(s).domainId, 'b');
  assert.equal(nextPendingDomain(stateFrom([['a', 'accepted'], ['b', 'skipped']])), null);
  assert.equal(nextPendingDomain(null), null);
});

test('migrationProgress mirrors the server summary; idle on null', () => {
  const idle = migrationProgress(null);
  assert.equal(idle.status, 'idle');
  assert.equal(idle.total, 0);
  assert.equal(idle.complete, false);

  const p = migrationProgress(stateFrom([['a', 'accepted'], ['b', 'skipped'], ['c', 'pending']]));
  assert.deepEqual(
    { total: p.total, accepted: p.accepted, skipped: p.skipped, pending: p.pending, decided: p.decided },
    { total: 3, accepted: 1, skipped: 1, pending: 1, decided: 2 },
  );
  assert.equal(p.complete, false);
});

test('migrationProgress.complete needs routedRemaining AND all decided', () => {
  const allDecidedNoRoute = migrationProgress(stateFrom([['a', 'accepted']], { status: 'routing' }));
  assert.equal(allDecidedNoRoute.complete, false);

  const done = migrationProgress(stateFrom([['a', 'accepted']], { routedRemaining: true, status: 'complete' }));
  assert.equal(done.complete, true);

  // routedRemaining but a domain still pending -> not complete.
  const pendingLeft = migrationProgress(stateFrom([['a', 'pending']], { routedRemaining: true }));
  assert.equal(pendingLeft.complete, false);
});

test('isResumable: in-progress yes, complete no, null no', () => {
  assert.equal(isResumable(null), false);
  assert.equal(isResumable(stateFrom([['a', 'pending']])), true);
  assert.equal(isResumable(stateFrom([['a', 'accepted']], { routedRemaining: true, status: 'complete' })), false);
});

test('mergeForDomain returns the ≥2-source merge, null for <2 / missing', () => {
  assert.equal(mergeForDomain(MERGES, 'ci').sources.length, 3);
  assert.equal(mergeForDomain(MERGES, 'review'), null); // single member -> absent
  assert.equal(mergeForDomain(MERGES, 'nope'), null);
  assert.equal(mergeForDomain(null, 'ci'), null);
  // A wrapper whose merge has <2 sources is treated as non-mergeable.
  assert.equal(mergeForDomain([{ domainId: 'z', merge: { sources: [{ name: 'only' }] } }], 'z'), null);
});

test('planDomainRows annotates counts + mergeable, preserves order', () => {
  const rows = planDomainRows(PLAN, MERGES);
  assert.deepEqual(rows.map((r) => r.domainId), ['ci', 'review', 'empty']);
  assert.deepEqual(
    rows.map((r) => ({ m: r.memberCount, c: r.candidateCount, merge: r.mergeable })),
    [{ m: 3, c: 2, merge: true }, { m: 1, c: 1, merge: false }, { m: 0, c: 0, merge: false }],
  );
});

test('planFoldTotals sums the collapse headline', () => {
  assert.deepEqual(planFoldTotals(PLAN), {
    domains: 3,
    skills: 4, // 3 + 1 + 0
    candidates: 3, // 2 + 1 + 0
    unassignedSkills: 1,
    unassignedCandidates: 2,
  });
  assert.deepEqual(planFoldTotals(null), { domains: 0, skills: 0, candidates: 0, unassignedSkills: 0, unassignedCandidates: 0 });
});
