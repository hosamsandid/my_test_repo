'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  planDeletion,
  permitDeletion,
  requiredPermission,
  archiveStamp,
  parseArchiveId,
  planArchivePrune,
  tierSegment,
  DEFAULT_RETENTION_DAYS,
} = require('./skill-deletion');

test('planDeletion: defaults source-less delete to the global tier', () => {
  const p = planDeletion({ name: 'jcl-tips' });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.tier, 'global');
  assert.strictEqual(p.cascade, false);
  assert.deepStrictEqual(p.permission, { needsSystemAdmin: true, teamAdminOf: [] });
});

test('planDeletion: accepts the legacy `source` alias and query-string cascade', () => {
  const p = planDeletion({ source: 'team', name: 'jcl-tips', teamId: 'payments', cascade: 'true' });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.tier, 'team');
  assert.strictEqual(p.teamId, 'payments');
  assert.strictEqual(p.cascade, true);
  assert.deepStrictEqual(p.permission, { needsSystemAdmin: false, teamAdminOf: ['payments'] });
});

test('planDeletion: agent tier requires an agentId and is System-Admin gated', () => {
  const bad = planDeletion({ tier: 'agent', name: 'jcl-tips' });
  assert.strictEqual(bad.ok, false);
  const p = planDeletion({ tier: 'agent', name: 'jcl-tips', agentId: 'cobol-agent' });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.agentId, 'cobol-agent');
  assert.deepStrictEqual(p.permission, { needsSystemAdmin: true, teamAdminOf: [] });
});

test('planDeletion: rejects invalid names, tiers and missing teamId', () => {
  assert.strictEqual(planDeletion({ name: '../etc' }).ok, false);
  assert.strictEqual(planDeletion({ name: '' }).ok, false);
  assert.strictEqual(planDeletion({ tier: 'bogus', name: 'x' }).ok, false);
  assert.strictEqual(planDeletion({ tier: 'team', name: 'x' }).ok, false);
  assert.strictEqual(planDeletion({ tier: 'team', name: 'x', teamId: 'Bad_ID' }).ok, false);
  assert.strictEqual(planDeletion({ tier: 'agent', name: 'x', agentId: '../y' }).ok, false);
});

test('permitDeletion: global/agent need System Admin; team needs its Team Admin', () => {
  const globalPerm = requiredPermission({ tier: 'global' });
  assert.strictEqual(permitDeletion(globalPerm, { systemAdmin: false }).ok, false);
  assert.strictEqual(permitDeletion(globalPerm, { systemAdmin: true }).ok, true);

  const teamPerm = requiredPermission({ tier: 'team', teamId: 'payments' });
  // Not an admin of that team -> forbidden.
  assert.strictEqual(permitDeletion(teamPerm, { systemAdmin: false, isTeamAdmin: () => false }).ok, false);
  // Team Admin of the target team -> allowed WITHOUT System Admin (AC4).
  assert.strictEqual(
    permitDeletion(teamPerm, { systemAdmin: false, isTeamAdmin: (t) => t === 'payments' }).ok,
    true,
  );
  // System Admin is a superset -> allowed.
  assert.strictEqual(permitDeletion(teamPerm, { systemAdmin: true }).ok, true);

  const agentPerm = requiredPermission({ tier: 'agent', agentId: 'cobol-agent' });
  assert.strictEqual(permitDeletion(agentPerm, { systemAdmin: false }).ok, false);
  assert.strictEqual(permitDeletion(agentPerm, { systemAdmin: true }).ok, true);
});

test('tierSegment / archiveStamp: filesystem-safe, matches the move-archive layout', () => {
  assert.strictEqual(tierSegment({ tier: 'global' }), 'global');
  assert.strictEqual(tierSegment({ tier: 'team', teamId: 'payments' }), 'team-payments');
  assert.strictEqual(tierSegment({ tier: 'agent', agentId: 'cobol-agent' }), 'agent-cobol-agent');

  const s = archiveStamp({ tier: 'team', teamId: 'payments' }, 'jcl-tips', 'abc123', 1000);
  assert.strictEqual(s.seg, 'team-payments');
  assert.strictEqual(s.stamp, 'jcl-tips-abc123-1000');
  assert.strictEqual(s.id, 'team-payments/jcl-tips-abc123-1000');

  const noHash = archiveStamp({ tier: 'global' }, 'jcl-tips', null, 42);
  assert.strictEqual(noHash.stamp, 'jcl-tips-nohash-42');
});

test('parseArchiveId: round-trips a stamp and rejects traversal', () => {
  const p = parseArchiveId('team-payments/jcl-tips-abc123-1000');
  assert.deepStrictEqual(p, {
    seg: 'team-payments', stamp: 'jcl-tips-abc123-1000',
    name: 'jcl-tips', hash: 'abc123', ts: 1000,
  });
  // Hyphenated skill name survives the right-split.
  const h = parseArchiveId('global/db2-schema-map-deadbeef-99');
  assert.strictEqual(h.name, 'db2-schema-map');
  assert.strictEqual(h.hash, 'deadbeef');
  assert.strictEqual(h.ts, 99);
  // nohash sentinel -> null hash.
  assert.strictEqual(parseArchiveId('global/x-nohash-5').hash, null);
  // Rejections.
  assert.strictEqual(parseArchiveId('../evil'), null);
  assert.strictEqual(parseArchiveId('one/two/three'), null);
  assert.strictEqual(parseArchiveId('team-x/..'), null);
  assert.strictEqual(parseArchiveId(''), null);
});

test('planArchivePrune: removes only entries older than the retention window', () => {
  const now = 10 * 24 * 60 * 60 * 1000; // day 10
  const day = 24 * 60 * 60 * 1000;
  const entries = [
    { id: 'a', deletedAt: now - 1 * day },   // recent -> keep
    { id: 'b', deletedAt: now - 95 * day },  // old (ISO would also work)
    { id: 'c', deletedAt: new Date(now - 91 * day).toISOString() }, // old, ISO
    { id: 'd' },                              // no timestamp -> keep
    { id: 'e', deletedAt: 'not-a-date' },     // unparseable -> keep
  ];
  const remove = planArchivePrune(entries, { now, retentionDays: 90 });
  assert.deepStrictEqual(remove.sort(), ['b', 'c']);
});

test('planArchivePrune: default retention is 90 days and empty input is safe', () => {
  assert.strictEqual(DEFAULT_RETENTION_DAYS, 90);
  assert.deepStrictEqual(planArchivePrune(undefined), []);
  assert.deepStrictEqual(planArchivePrune([]), []);
  const now = Date.now();
  // Exactly at the boundary is kept (strict <), just past it is pruned.
  const boundary = now - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  assert.deepStrictEqual(planArchivePrune([{ id: 'x', deletedAt: boundary }], { now }), []);
  assert.deepStrictEqual(planArchivePrune([{ id: 'x', deletedAt: boundary - 1 }], { now }), ['x']);
});
