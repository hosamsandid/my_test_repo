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

test('consume: a poller event within the window is deduped once', () => {
  const store = new LabelDedupMarkers({ now: fixedNow(BASE) });
  store.add(marker({ appliedAt: BASE }));
  // First poller event ~10s later → within 5 min window → consumed.
  const first = store.consume(marker({ eventCreatedAt: BASE + 10_000 }));
  assert.ok(first, 'first matching event should consume the marker');
  // A second event for the same tuple no longer finds an unconsumed marker.
  const second = store.consume(marker({ eventCreatedAt: BASE + 15_000 }));
  assert.equal(second, null, 'consume-once: the marker is spent');
});

test('consume: an event outside the window is NOT deduped (legitimate re-label)', () => {
  const store = new LabelDedupMarkers({ now: fixedNow(BASE) });
  store.add(marker({ appliedAt: BASE }));
  // A re-label an hour later has a newer created_at, outside the 5 min window.
  const out = store.consume(marker({ eventCreatedAt: BASE + 60 * 60 * 1000 }));
  assert.equal(out, null);
});

test('consume: no marker → null (label set outside the plugin path)', () => {
  const store = new LabelDedupMarkers({ now: fixedNow(BASE) });
  assert.equal(store.consume(marker({ eventCreatedAt: BASE })), null);
});

test('consume: a different tuple does not match', () => {
  const store = new LabelDedupMarkers({ now: fixedNow(BASE) });
  store.add(marker({ appliedAt: BASE }));
  assert.equal(store.consume(marker({ number: 99, eventCreatedAt: BASE })), null);
  assert.equal(store.consume(marker({ label: 'req:refine', eventCreatedAt: BASE })), null);
  assert.equal(store.consume(marker({ agentId: 'other', eventCreatedAt: BASE })), null);
  // The original marker survives the near-misses.
  assert.ok(store.consume(marker({ eventCreatedAt: BASE })));
});

test('re-add re-arms the dedup for a legitimate later re-label', () => {
  let now = BASE;
  const store = new LabelDedupMarkers({ now: () => now });
  store.add(marker({ appliedAt: BASE }));
  assert.ok(store.consume(marker({ eventCreatedAt: BASE })), 'first apply deduped');
  // An hour later the label is applied again via the plugin → new marker.
  now = BASE + 60 * 60 * 1000;
  store.add(marker({ appliedAt: now }));
  assert.ok(store.consume(marker({ eventCreatedAt: now + 5_000 })), 'second apply deduped by fresh marker');
});

test('gc: markers past the TTL are dropped and no longer consume', () => {
  let now = BASE;
  const store = new LabelDedupMarkers({ now: () => now });
  store.add(marker({ appliedAt: BASE }));
  assert.equal(store.size(), 1);
  // Advance past the 6 h TTL; the next store op GCs the stale marker.
  now = BASE + 7 * 60 * 60 * 1000;
  assert.equal(store.consume(marker({ eventCreatedAt: BASE })), null);
  assert.equal(store.size(), 0);
});

test('accepts both ms-number and ISO-string times', () => {
  const store = new LabelDedupMarkers({ now: fixedNow(BASE) });
  store.add(marker({ appliedAt: '2026-09-01T12:00:00Z' }));
  assert.ok(store.consume(marker({ eventCreatedAt: '2026-09-01T12:01:00Z' })));
});
