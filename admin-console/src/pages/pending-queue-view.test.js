import test from 'node:test';
import assert from 'node:assert/strict';
import { kindLabel, kindTooltip, entryDetail, totalPending } from './pending-queue-view.js';

test('kindLabel maps known kinds and falls back gracefully', () => {
  assert.equal(kindLabel('github'), 'GitHub event');
  assert.equal(kindLabel('session-set'), 'Session resume');
  assert.equal(kindLabel('weird'), 'weird');
  assert.equal(kindLabel(undefined), 'Unknown');
});

test('#1964 — the retired bp-event-batch kind falls through to the raw string', () => {
  // Its producer went in #1962 and its label here in #1964; a leftover entry in
  // a pending queue written before the cut still renders identifiably rather
  // than as 'Unknown', because the fallback is the kind itself.
  assert.equal(kindLabel('bp-event-batch'), 'bp-event-batch');
  assert.equal(kindTooltip('bp-event-batch'), kindTooltip('unknown'));
});

test('kindTooltip explains known kinds and falls back to the unknown copy', () => {
  assert.match(kindTooltip('github'), /waiting to be delivered/);
  assert.match(kindTooltip('github-digest'), /lossless summary/);
  assert.match(kindTooltip('throttle-warning'), /rate cap/);
  const fallback = kindTooltip('unknown');
  assert.equal(kindTooltip('weird'), fallback);
  assert.equal(kindTooltip(undefined), fallback);
});

test('entryDetail summarises a GitHub entry with all fields', () => {
  const d = entryDetail({ kind: 'github', event: 'pull_request.opened', repo: 'o/r', actor: 'alice', eventId: '42' });
  assert.equal(d, 'pull_request.opened · o/r · @alice · #42');
});

test('entryDetail tolerates missing GitHub fields', () => {
  assert.equal(entryDetail({ kind: 'github', event: 'push' }), 'push');
  assert.equal(entryDetail({ kind: 'github' }), '');
});

test('entryDetail shows the carried label in event (label) form for a labeled event (#1649)', () => {
  const d = entryDetail({ kind: 'github', event: 'issues.labeled', repo: 'o/r', actor: 'alice', eventId: '9', label: 'ready-2' });
  assert.equal(d, 'issues.labeled (ready-2) · o/r · @alice · #9');
});

test('entryDetail shows no label artifact for a non-label github entry (AC2)', () => {
  assert.equal(entryDetail({ kind: 'github', event: 'pull_request.opened', eventId: '42' }), 'pull_request.opened · #42');
});

test('entryDetail summarises non-GitHub kinds', () => {
  assert.equal(entryDetail({ kind: 'github-digest', count: 5, convKey: 'pr:1' }), '5 events · pr:1');
  assert.equal(entryDetail({ kind: 'session-set', roomId: '!r:x' }), 'room !r:x');
  assert.equal(entryDetail({ kind: 'throttle-warning', convKey: 'push:main' }), 'conv push:main');
  assert.equal(entryDetail({ kind: 'session-reset' }), '');
});

test('entryDetail is safe on junk input', () => {
  assert.equal(entryDetail(null), '');
  assert.equal(entryDetail('nope'), '');
  assert.equal(entryDetail({ kind: 'unknown' }), '');
});

test('totalPending prefers the total field but falls back to summing groups', () => {
  assert.equal(totalPending({ total: 7, agents: [] }), 7);
  assert.equal(totalPending({ agents: [{ entries: [1, 2] }, { entries: [3] }] }), 3);
  assert.equal(totalPending({ agents: [] }), 0);
  assert.equal(totalPending(null), 0);
});

// ── direct agent-to-agent hand-off (#2032) ──────────────────────────────────

test('a wake-agent entry has its own label and tooltip, not the unknown fallback', () => {
  // Without these it reads "wake-agent — An unrecognised queue entry", which is
  // how `handover-dm` still reads today.
  assert.equal(kindLabel('wake-agent'), 'Direct hand-off');
  assert.notEqual(kindTooltip('wake-agent'), kindTooltip('unknown'));
  assert.match(kindTooltip('wake-agent'), /no label/);
});

test('entryDetail leads a hand-off with the producer, then the note', () => {
  assert.equal(
    entryDetail({ kind: 'wake-agent', from: 'team-developer', note: 'Check step 3.' }),
    'from team-developer · “Check step 3.”',
  );
});

test('entryDetail degrades a hand-off with a missing half', () => {
  assert.equal(entryDetail({ kind: 'wake-agent', from: 'team-developer' }), 'from team-developer');
  assert.equal(entryDetail({ kind: 'wake-agent', note: 'x' }), '“x”');
  assert.equal(entryDetail({ kind: 'wake-agent' }), '');
});
