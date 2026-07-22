'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { planStaleTransitions, lastEvidenceMs, WEEK_MS } = require('./knowledge-hygiene');

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
