'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  safeTeamSegment,
  canonicalClonePath,
  shouldRefresh,
  buildHarvestEvent,
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
