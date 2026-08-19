'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  planStaleTransitions, planSupersessions, planOpenCap, evidenceScore,
  lastEvidenceMs, WEEK_MS, DEFAULT_MAX_OPEN_SUGGESTIONS,
} = require('./knowledge-hygiene');

const NOW = '2026-07-22T00:00:00.000Z';
const nowMs = Date.parse(NOW);
const daysAgo = (n) => new Date(nowMs - n * 24 * 60 * 60 * 1000).toISOString();

test('lastEvidenceMs takes the newest of raisedAt / members / lastEvidenceAt', () => {
  const cand = {
    raisedAt: daysAgo(40),
    lastEvidenceAt: daysAgo(10),
    members: [{ createdAt: daysAgo(50) }, { createdAt: daysAgo(20) }],
  };
  assert.strictEqual(lastEvidenceMs(cand), Date.parse(daysAgo(10)));
});

test('open candidate quiet longer than maxWeeks goes stale', () => {
  const cands = [{ id: 'a', status: 'open', raisedAt: daysAgo(29) }];
  const r = planStaleTransitions(cands, { now: NOW, maxWeeks: 4 });
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(r.stale.map((c) => c.id), ['a']);
  assert.strictEqual(r.next[0].status, 'stale');
  assert.strictEqual(r.next[0].staleAt, NOW);
});

test('open candidate within the window stays open', () => {
  const cands = [{ id: 'a', status: 'open', raisedAt: daysAgo(27) }];
  const r = planStaleTransitions(cands, { now: NOW, maxWeeks: 4 });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.next[0].status, 'open');
});

test('observed open candidate is protected from ageing out and gets an evidence bump', () => {
  const cands = [{ id: 'a', status: 'open', raisedAt: daysAgo(99) }];
  const r = planStaleTransitions(cands, { now: NOW, maxWeeks: 4, observedIds: new Set(['a']) });
  assert.strictEqual(r.stale.length, 0);
  assert.strictEqual(r.next[0].status, 'open');
  assert.strictEqual(r.next[0].lastEvidenceAt, NOW);
});

test('stale candidate with fresh evidence revives to open and drops staleAt', () => {
  const cands = [{ id: 'a', status: 'stale', staleAt: daysAgo(5), raisedAt: daysAgo(99) }];
  const r = planStaleTransitions(cands, { now: NOW, maxWeeks: 4, observedIds: new Set(['a']) });
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(r.revive.map((c) => c.id), ['a']);
  assert.strictEqual(r.next[0].status, 'open');
  assert.strictEqual(r.next[0].lastEvidenceAt, NOW);
  assert.ok(!('staleAt' in r.next[0]));
});

test('stale candidate with no fresh evidence stays stale', () => {
  const cands = [{ id: 'a', status: 'stale', staleAt: daysAgo(5) }];
  const r = planStaleTransitions(cands, { now: NOW, maxWeeks: 4 });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.next[0].status, 'stale');
});

test('dismissed / promoted candidates are never touched', () => {
  const cands = [
    { id: 'd', status: 'dismissed', raisedAt: daysAgo(99) },
    { id: 'p', status: 'promoted', raisedAt: daysAgo(99) },
  ];
  const r = planStaleTransitions(cands, { now: NOW, maxWeeks: 4 });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.next[0].status, 'dismissed');
  assert.strictEqual(r.next[1].status, 'promoted');
});

test('idempotent: re-running on the transitioned list produces no further change', () => {
  const cands = [{ id: 'a', status: 'open', raisedAt: daysAgo(40) }];
  const first = planStaleTransitions(cands, { now: NOW, maxWeeks: 4 });
  const second = planStaleTransitions(first.next, { now: NOW, maxWeeks: 4 });
  assert.strictEqual(second.changed, false);
});

test('maxWeeks is configurable', () => {
  const cands = [{ id: 'a', status: 'open', raisedAt: daysAgo(10) }];
  assert.strictEqual(planStaleTransitions(cands, { now: NOW, maxWeeks: 4 }).changed, false);
  assert.strictEqual(planStaleTransitions(cands, { now: NOW, maxWeeks: 1 }).stale.length, 1);
});

test('WEEK_MS constant', () => {
  assert.strictEqual(WEEK_MS, 7 * 24 * 60 * 60 * 1000);
});

// ── planSupersessions (FIX-B) ────────────────────────────────────────────────

test('a grown open card supersedes the subset it grew from (same kind+source)', () => {
  const cands = [
    { id: 'small', status: 'open', kind: 'convention', source: 'convergence', entryIds: ['a', 'b'] },
    { id: 'big', status: 'open', kind: 'convention', source: 'convergence', entryIds: ['a', 'b', 'c'] },
  ];
  const r = planSupersessions(cands, { now: NOW });
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(r.superseded.map((c) => c.id), ['small']);
  const small = r.next.find((c) => c.id === 'small');
  assert.strictEqual(small.status, 'superseded');
  assert.strictEqual(small.supersededById, 'big');
  assert.strictEqual(small.supersededAt, NOW);
  assert.strictEqual(r.next.find((c) => c.id === 'big').status, 'open');
});

test('supersession requires same kind and same source', () => {
  const cands = [
    { id: 'a', status: 'open', kind: 'convention', source: 'convergence', entryIds: ['x'] },
    { id: 'b', status: 'open', kind: 'fact', source: 'convergence', entryIds: ['x', 'y'] },
    { id: 'c', status: 'open', kind: 'convention', source: 'related', entryIds: ['x', 'y'] },
  ];
  const r = planSupersessions(cands, { now: NOW });
  assert.strictEqual(r.changed, false);
});

test('equal or disjoint sets are never superseded', () => {
  const cands = [
    { id: 'a', status: 'open', kind: 'convention', source: 'convergence', entryIds: ['x', 'y'] },
    { id: 'b', status: 'open', kind: 'convention', source: 'convergence', entryIds: ['x', 'y'] },
    { id: 'c', status: 'open', kind: 'convention', source: 'convergence', entryIds: ['p', 'q'] },
  ];
  const r = planSupersessions(cands, { now: NOW });
  assert.strictEqual(r.changed, false);
});

test('dismissed / promoted / domain-proposal rows are excluded from supersession', () => {
  const cands = [
    { id: 'dp-team', status: 'open', source: 'domain-proposal', entryIds: ['a'] },
    { id: 'dp-big', status: 'open', source: 'domain-proposal', entryIds: ['a', 'b'] },
    { id: 'dis', status: 'dismissed', kind: 'convention', source: 'convergence', entryIds: ['a'] },
    { id: 'big', status: 'open', kind: 'convention', source: 'convergence', entryIds: ['a', 'b'] },
  ];
  const r = planSupersessions(cands, { now: NOW });
  assert.strictEqual(r.changed, false);
});

test('transitive chain: only the maximal cover stays open', () => {
  const cands = [
    { id: 'c1', status: 'open', kind: 'convention', source: 'convergence', entryIds: ['a'] },
    { id: 'c2', status: 'open', kind: 'convention', source: 'convergence', entryIds: ['a', 'b'] },
    { id: 'c3', status: 'open', kind: 'convention', source: 'convergence', entryIds: ['a', 'b', 'c'] },
  ];
  const r = planSupersessions(cands, { now: NOW });
  assert.deepStrictEqual(r.superseded.map((c) => c.id).sort(), ['c1', 'c2']);
  assert.strictEqual(r.next.find((c) => c.id === 'c3').status, 'open');
});

test('planSupersessions is idempotent', () => {
  const cands = [
    { id: 'small', status: 'open', kind: 'convention', source: 'convergence', entryIds: ['a', 'b'] },
    { id: 'big', status: 'open', kind: 'convention', source: 'convergence', entryIds: ['a', 'b', 'c'] },
  ];
  const first = planSupersessions(cands, { now: NOW });
  const second = planSupersessions(first.next, { now: NOW });
  assert.strictEqual(second.changed, false);
});

// ── planOpenCap (FIX-C) ──────────────────────────────────────────────────────

test('planOpenCap evicts lowest-evidence open cards down to the cap', () => {
  const mk = (id, agents, days) => ({
    id, status: 'open', kind: 'convention', source: 'convergence',
    convergenceCount: agents, raisedAt: daysAgo(days), members: [{ createdAt: daysAgo(days) }],
  });
  const cands = [
    mk('strong', 5, 1),   // high evidence, fresh
    mk('mid', 2, 1),
    mk('weak-old', 1, 60), // lowest evidence
  ];
  const r = planOpenCap(cands, { now: NOW, maxOpen: 2 });
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(r.evicted.map((c) => c.id), ['weak-old']);
  assert.strictEqual(r.next.find((c) => c.id === 'weak-old').status, 'stale');
  assert.strictEqual(r.next.filter((c) => c.status === 'open').length, 2);
});

test('planOpenCap never evicts the domain-proposal singleton or amendment cards', () => {
  const cands = [
    { id: 'dp-team', status: 'open', source: 'domain-proposal', raisedAt: daysAgo(90) },
    { id: 'amend', status: 'open', source: 'convergence', extendMode: true, raisedAt: daysAgo(90) },
    { id: 'c1', status: 'open', source: 'convergence', kind: 'convention', convergenceCount: 3, raisedAt: daysAgo(1) },
    { id: 'c2', status: 'open', source: 'convergence', kind: 'convention', convergenceCount: 2, raisedAt: daysAgo(1) },
  ];
  const r = planOpenCap(cands, { now: NOW, maxOpen: 3 });
  // openCount 4 > cap 3 → evict 1, but protected rows are off-limits, so c2 (lowest) goes.
  assert.deepStrictEqual(r.evicted.map((c) => c.id), ['c2']);
  assert.strictEqual(r.next.find((c) => c.id === 'dp-team').status, 'open');
  assert.strictEqual(r.next.find((c) => c.id === 'amend').status, 'open');
});

test('planOpenCap is a no-op at or under the cap and is idempotent', () => {
  const cands = [
    { id: 'a', status: 'open', source: 'convergence', convergenceCount: 2, raisedAt: daysAgo(1) },
    { id: 'b', status: 'open', source: 'convergence', convergenceCount: 2, raisedAt: daysAgo(1) },
  ];
  assert.strictEqual(planOpenCap(cands, { now: NOW, maxOpen: 5 }).changed, false);
  const first = planOpenCap(cands, { now: NOW, maxOpen: 1 });
  const second = planOpenCap(first.next, { now: NOW, maxOpen: 1 });
  assert.strictEqual(second.changed, false);
});

test('evidenceScore rewards more agents/lessons and recency', () => {
  const fresh = { convergenceCount: 3, members: [{}, {}], raisedAt: NOW };
  const stale = { convergenceCount: 3, members: [{}, {}], raisedAt: daysAgo(60) };
  assert.ok(evidenceScore(fresh, NOW) > evidenceScore(stale, NOW));
  const more = { convergenceCount: 5, members: [{}, {}], raisedAt: NOW };
  assert.ok(evidenceScore(more, NOW) > evidenceScore(fresh, NOW));
  assert.ok(evidenceScore(stale, NOW) > 0); // recency discounts, never nullifies
});

test('DEFAULT_MAX_OPEN_SUGGESTIONS constant', () => {
  assert.strictEqual(DEFAULT_MAX_OPEN_SUGGESTIONS, 40);
});
