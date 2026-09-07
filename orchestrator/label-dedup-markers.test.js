'use strict';

// Unit tests for the internal-fast-path dedup markers (#1858).
// Run: node --test orchestrator/label-dedup-markers.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { LabelDedupMarkers } = require('./label-dedup-markers');

const BASE = Date.parse('2026-09-01T12:00:00Z');
const marker = (over = {}) => ({
  agentId: 'dev', triggerId: 't-ready', repo: 'org/repo', kind: 'issue', number: 42, label: 'ready', ...over,
});

function fixedNow(ms) { return () => ms; }

test('shouldDrop: a poller event within the window is deduped', () => {
  const store = new LabelDedupMarkers({ now: fixedNow(BASE) });
  store.add(marker({ appliedAt: BASE }));
  const hit = store.shouldDrop(marker({ eventCreatedAt: BASE + 10_000 }));
  assert.ok(hit, 'a matching event inside the window should drop');
});

test('shouldDrop: window-scoped, NOT consume-once — every event of one apply is deduped', () => {
  // The reported double-fire: one human apply churns up several matching
  // `*.labeled` events (the real `ready` delivery, the `ready:wip` claim add,
  // a co-added `ux`), all within the window. Consume-once dropped only the
  // first; window-scoping must drop ALL of them.
  const store = new LabelDedupMarkers({ now: fixedNow(BASE) });
  store.add(marker({ appliedAt: BASE }));
  assert.ok(store.shouldDrop(marker({ eventCreatedAt: BASE + 3_000 })), '1st echo dropped');
  assert.ok(store.shouldDrop(marker({ eventCreatedAt: BASE + 15_000 })), '2nd echo dropped');
  assert.ok(store.shouldDrop(marker({ eventCreatedAt: BASE + 33_000 })), '3rd echo dropped');
});

test('shouldDrop: an event outside the window is NOT deduped (legitimate re-label)', () => {
  const store = new LabelDedupMarkers({ now: fixedNow(BASE) });
  store.add(marker({ appliedAt: BASE }));
  // A re-label an hour later has a newer created_at, outside the 5 min window.
  const out = store.shouldDrop(marker({ eventCreatedAt: BASE + 60 * 60 * 1000 }));
  assert.equal(out, null);
});

test('shouldDrop: no marker → null (label set outside the plugin path)', () => {
  const store = new LabelDedupMarkers({ now: fixedNow(BASE) });
  assert.equal(store.shouldDrop(marker({ eventCreatedAt: BASE })), null);
});

test('shouldDrop: a different tuple does not match', () => {
  const store = new LabelDedupMarkers({ now: fixedNow(BASE) });
  store.add(marker({ appliedAt: BASE }));
  assert.equal(store.shouldDrop(marker({ number: 99, eventCreatedAt: BASE })), null);
  assert.equal(store.shouldDrop(marker({ label: 'req:refine', eventCreatedAt: BASE })), null);
  assert.equal(store.shouldDrop(marker({ agentId: 'other', eventCreatedAt: BASE })), null);
  // The original marker survives the near-misses.
  assert.ok(store.shouldDrop(marker({ eventCreatedAt: BASE })));
});

test('re-add re-arms the dedup window for a legitimate later re-label', () => {
  let now = BASE;
  const store = new LabelDedupMarkers({ now: () => now });
  store.add(marker({ appliedAt: BASE }));
  assert.ok(store.shouldDrop(marker({ eventCreatedAt: BASE })), 'first apply deduped');
  // An hour later the label is applied again via the plugin → marker re-armed
  // with a fresh appliedAt; its window travels to the new time.
  now = BASE + 60 * 60 * 1000;
  store.add(marker({ appliedAt: now }));
  assert.ok(store.shouldDrop(marker({ eventCreatedAt: now + 5_000 })), 'second apply deduped by re-armed window');
  // An event back at the ORIGINAL apply time now falls outside the moved window.
  assert.equal(store.shouldDrop(marker({ eventCreatedAt: BASE })), null);
});

test('gc: markers past the TTL are dropped and no longer dedup', () => {
  let now = BASE;
  const store = new LabelDedupMarkers({ now: () => now });
  store.add(marker({ appliedAt: BASE }));
  assert.equal(store.size(), 1);
  // Advance past the 6 h TTL; the next store op GCs the stale marker.
  now = BASE + 7 * 60 * 60 * 1000;
  assert.equal(store.shouldDrop(marker({ eventCreatedAt: BASE })), null);
  assert.equal(store.size(), 0);
});

test('accepts both ms-number and ISO-string times', () => {
  const store = new LabelDedupMarkers({ now: fixedNow(BASE) });
  store.add(marker({ appliedAt: '2026-09-01T12:00:00Z' }));
  assert.ok(store.shouldDrop(marker({ eventCreatedAt: '2026-09-01T12:01:00Z' })));
});
