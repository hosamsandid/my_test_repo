'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  safeTeamSegment,
  canonicalClonePath,
  shouldRefresh,
  buildHarvestEvent,
  buildPromotionCleanupEvent,
  leanEntry,
  parsePushEntries,
} = require('./knowledge-feed');

// ── safeTeamSegment / canonicalClonePath ──────────────────────────────────────

test('safeTeamSegment accepts slugs, rejects traversal + separators', () => {
  assert.equal(safeTeamSegment('acme'), 'acme');
  assert.equal(safeTeamSegment('team_1.beta-2'), 'team_1.beta-2');
  assert.equal(safeTeamSegment('..'), null);
  assert.equal(safeTeamSegment('a/b'), null);
  assert.equal(safeTeamSegment('a\\b'), null);
  assert.equal(safeTeamSegment('../etc'), null);
  assert.equal(safeTeamSegment(''), null);
  assert.equal(safeTeamSegment(null), null);
});

test('canonicalClonePath joins under root, fails closed on bad team id', () => {
  assert.equal(canonicalClonePath('/workspace/knowledge', 'acme'), '/workspace/knowledge/acme');
  assert.equal(canonicalClonePath('/workspace/knowledge', '../secrets'), null);
});

// ── shouldRefresh ─────────────────────────────────────────────────────────────

test('shouldRefresh honours throttle + refreshes on missing/garbage', () => {
  const now = 1_000_000;
  assert.equal(shouldRefresh(now - 40_000, now, 30_000), true);
  assert.equal(shouldRefresh(now - 10_000, now, 30_000), false);
  assert.equal(shouldRefresh(null, now, 30_000), true);
  assert.equal(shouldRefresh('nope', now, 30_000), true);
});

// ── buildHarvestEvent / leanEntry ─────────────────────────────────────────────

test('buildHarvestEvent carries a lean entry summary', () => {
  const ev = buildHarvestEvent({
    teamId: 'acme',
    agentId: 'acme-dev-1',
    ts: '2026-07-08T09:12:00Z',
    entry: { id: '9f3a12bc7de0', kind: 'fact', text: 'hi', originAgent: 'acme-dev-1', convergenceCount: 3, secret: 'x' },
  });
  assert.equal(ev.type, 'harvest');
  assert.equal(ev.teamId, 'acme');
  assert.equal(ev.agentId, 'acme-dev-1');
  assert.equal(ev.ts, '2026-07-08T09:12:00Z');
  // lean: only the whitelisted fields survive — no `secret`.
  assert.deepEqual(ev.entry, { id: '9f3a12bc7de0', kind: 'fact', text: 'hi', originAgent: 'acme-dev-1', convergenceCount: 3 });
});

test('buildHarvestEvent is count-only when entry is absent/garbage', () => {
  const ev = buildHarvestEvent({ teamId: 'acme', agentId: 'acme-dev-1' });
  assert.equal(ev.type, 'harvest');
  assert.ok(!('entry' in ev));
  assert.equal(buildHarvestEvent({ teamId: 'acme', agentId: 'x', entry: { kind: 'fact' } }).entry, undefined); // no id
});

test('leanEntry defaults convergenceCount to 1', () => {
  assert.equal(leanEntry({ id: 'aaaaaaaaaaaa' }).convergenceCount, 1);
  assert.equal(leanEntry({ id: 'aaaaaaaaaaaa', convergenceCount: 0 }).convergenceCount, 1);
  assert.equal(leanEntry(null), null);
});

// ── buildPromotionCleanupEvent (#559) ─────────────────────────────────────────

test('buildPromotionCleanupEvent is a distinguishable typed event with a count', () => {
  const ev = buildPromotionCleanupEvent({
    teamId: 'acme',
    skill: { name: 'cobol-tips', tier: 'team', extra: 'drop-me' },
    entryIds: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
    auto: false,
    ts: '2026-07-14T09:12:00Z',
  });
  // Separate from promotion/extension so the feed trace stays legible (AC9).
  assert.equal(ev.type, 'promotion-cleanup');
  assert.equal(ev.teamId, 'acme');
  assert.equal(ev.ts, '2026-07-14T09:12:00Z');
  assert.equal(ev.count, 2);
  assert.deepEqual(ev.entryIds, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  // skill is normalised to name/tier only — no stray fields leak.
  assert.deepEqual(ev.skill, { name: 'cobol-tips', tier: 'team' });
  assert.equal(ev.auto, false);
});

test('buildPromotionCleanupEvent marks the autonomy-3 auto path + tolerates gaps', () => {
  const ev = buildPromotionCleanupEvent({ teamId: 'acme', entryIds: ['aaaaaaaaaaaa'], auto: true });
  assert.equal(ev.auto, true);           // E6 — curator auto-promote cleanup
  assert.equal(ev.skill, null);          // no skill supplied
  assert.equal(ev.count, 1);
  assert.ok(typeof ev.ts === 'string' && ev.ts); // defaulted timestamp

  // Junk / empty entryIds collapse to an empty, count-0 event (never throws).
  const empty = buildPromotionCleanupEvent({ teamId: 'acme', entryIds: [null, 42, ''] });
  assert.deepEqual(empty.entryIds, []);
  assert.equal(empty.count, 0);
  assert.equal(buildPromotionCleanupEvent({}).count, 0);
});

// ── parsePushEntries ──────────────────────────────────────────────────────────

test('parsePushEntries handles object, string, and junk bodies', () => {
  const body = { entries: [{ id: 'aaaaaaaaaaaa', kind: 'fact', text: 't' }, { kind: 'fact' }] };
  const out = parsePushEntries(body);
  assert.equal(out.length, 1); // the id-less one is dropped
  assert.equal(out[0].id, 'aaaaaaaaaaaa');

  assert.deepEqual(parsePushEntries(JSON.stringify(body)).map((e) => e.id), ['aaaaaaaaaaaa']);
  assert.deepEqual(parsePushEntries('{bad json'), []);
  assert.deepEqual(parsePushEntries({}), []);
  assert.deepEqual(parsePushEntries(null), []);
});
