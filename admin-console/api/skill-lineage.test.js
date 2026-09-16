'use strict';

// Unit tests for the pure lineage assembler (#632, epic #624 phase 5). The
// module is fs-free — it turns already-read manifest / provenance / per-copy
// drift into the single view the Skills detail panel renders (Versions +
// Lineage tabs), so these tests are plain data assertions with no tmpdir.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const lineage = require('./skill-lineage');

test('normalizeVersionHistory: missing/!object manifest yields an empty view', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    const v = lineage.normalizeVersionHistory(bad);
    assert.deepEqual(v.current, { version: null, contentHash: null, updatedAt: null, updatedBy: null });
    assert.deepEqual(v.history, []);
  }
});

test('normalizeVersionHistory: coerces current + flags the live revision', () => {
  const manifest = {
    version: 3,
    contentHash: 'abc123def456',
    updatedAt: '2026-07-16T10:00:00Z',
    updatedBy: 'curator',
    history: [
      { version: 3, hash: 'abc123def456', at: '2026-07-16T10:00:00Z', by: 'curator', action: 'edited', note: 'tweak' },
      { version: 2, hash: 'old2', at: '2026-07-15T10:00:00Z', by: 'dev', action: 'imported' },
      { version: 1, hash: 'old1', at: '2026-07-14T10:00:00Z', by: 'dev', action: 'created', note: '' },
    ],
  };
  const v = lineage.normalizeVersionHistory(manifest);
  assert.deepEqual(v.current, {
    version: 3, contentHash: 'abc123def456', updatedAt: '2026-07-16T10:00:00Z', updatedBy: 'curator',
  });
  assert.equal(v.history.length, 3);
  // The current version (3) is flagged; older ones are not.
  assert.equal(v.history[0].current, true);
  assert.equal(v.history[1].current, false);
  assert.equal(v.history[2].current, false);
  // Non-empty note is carried; empty-string note is dropped to undefined.
  assert.equal(v.history[0].note, 'tweak');
  assert.equal(v.history[2].note, undefined);
});

test('normalizeVersionHistory: drops non-object history entries + coerces bad fields to null', () => {
  const manifest = {
    version: 1,
    contentHash: 'h',
    history: [null, 'x', { version: 'nope', hash: 5, at: null, by: null, action: null }],
  };
  const v = lineage.normalizeVersionHistory(manifest);
  assert.equal(v.history.length, 1);
  assert.deepEqual(v.history[0], {
    version: null, hash: null, at: null, by: null, action: null, note: undefined, current: false,
  });
});

test('copyKey: stable identity across tier/team/agent; junk yields "::"', () => {
  assert.equal(lineage.copyKey({ tier: 'global' }), 'global::');
  assert.equal(lineage.copyKey({ tier: 'team', teamId: 't1' }), 'team:t1:');
  assert.equal(lineage.copyKey({ tier: 'agent', teamId: 't1', agentId: 'a1' }), 'agent:t1:a1');
  assert.equal(lineage.copyKey(null), '::');
  assert.equal(lineage.copyKey('nope'), '::');
});

test('sortCopies: global -> team -> agent, then by teamId/agentId; input not mutated', () => {
  const input = [
    { tier: 'agent', teamId: 't1', agentId: 'a2' },
    { tier: 'team', teamId: 't2' },
    { tier: 'global' },
    { tier: 'agent', teamId: 't1', agentId: 'a1' },
    { tier: 'team', teamId: 't1' },
  ];
  const snapshot = JSON.stringify(input);
  const sorted = lineage.sortCopies(input);
  assert.deepEqual(sorted.map(c => [c.tier, c.teamId || '', c.agentId || '']), [
    ['global', '', ''],
    ['team', 't1', ''],
    ['team', 't2', ''],
    ['agent', 't1', 'a1'],
    ['agent', 't1', 'a2'],
  ]);
  assert.equal(JSON.stringify(input), snapshot, 'sortCopies must not mutate its argument');
});

test('summarizeCopies: counts by tier + worst drift via rollup + resyncable', () => {
  const copies = [
    { tier: 'global', drift: 'in-sync' },
    { tier: 'team', teamId: 't1', drift: 'outdated' },
    { tier: 'agent', teamId: 't1', agentId: 'a1', drift: 'conflict' },
    { tier: 'agent', teamId: 't1', agentId: 'a2', drift: 'outdated' },
    { tier: 'team', teamId: 't2' }, // no drift recorded
  ];
  const s = lineage.summarizeCopies(copies);
  assert.equal(s.total, 5);
  assert.deepEqual(s.byTier, { global: 1, team: 2, agent: 2 });
  // conflict outranks outdated/in-sync as the single worst state.
  assert.equal(s.worstDrift, 'conflict');
  // Only the two `outdated` copies are auto-resyncable.
  assert.equal(s.resyncable, 2);
});

test('summarizeCopies: empty / non-array input is a zeroed summary', () => {
  for (const bad of [undefined, null, 'x', 7]) {
    const s = lineage.summarizeCopies(bad);
    assert.equal(s.total, 0);
    assert.deepEqual(s.byTier, { global: 0, team: 0, agent: 0 });
    assert.equal(s.worstDrift, null);
    assert.equal(s.resyncable, 0);
  }
});

test('assembleLineage: dedups copies, marks the viewed one, sorts + summarizes', () => {
  const viewed = { tier: 'team', teamId: 't1' };
  const out = lineage.assembleLineage({
    name: 'my-skill',
    viewed,
    manifest: {
      version: 2, contentHash: 'hash2', updatedAt: 'now', updatedBy: 'me',
      origin: { tier: 'global' },
      history: [
        { version: 2, hash: 'hash2', at: 'now', by: 'me', action: 'adopted' },
        { version: 1, hash: 'hash1', at: 'then', by: 'me', action: 'created' },
      ],
    },
    provenance: { entryIds: ['e1', 'e2'], originTeamId: 't0' },
    copies: [
      { tier: 'global', drift: 'in-sync' },
      { tier: 'team', teamId: 't1', drift: 'diverged' },
      { tier: 'team', teamId: 't1', drift: 'diverged' }, // duplicate of the viewed copy
      { tier: 'agent', teamId: 't1', agentId: 'a1', drift: 'outdated' },
      null,                       // skipped (not an object)
      { teamId: 'x' },            // skipped (no tier)
    ],
  });

  assert.equal(out.name, 'my-skill');
  assert.deepEqual(out.viewed, viewed);
  assert.deepEqual(out.origin, { tier: 'global' });
  assert.deepEqual(out.provenance, { entryIds: ['e1', 'e2'], originTeamId: 't0' });

  // Versions view is assembled from the manifest.
  assert.equal(out.versions.current.version, 2);
  assert.equal(out.versions.history[0].current, true);

  // Duplicate + invalid copies are dropped; 3 real copies remain, sorted.
  assert.equal(out.copies.length, 3);
  assert.deepEqual(out.copies.map(c => c.tier), ['global', 'team', 'agent']);

  // Exactly the viewed copy is flagged.
  const viewedCopies = out.copies.filter(c => c.viewed);
  assert.equal(viewedCopies.length, 1);
  assert.equal(viewedCopies[0].tier, 'team');
  assert.equal(viewedCopies[0].teamId, 't1');

  // Summary reflects the deduped set.
  assert.equal(out.summary.total, 3);
  assert.deepEqual(out.summary.byTier, { global: 1, team: 1, agent: 1 });
});

test('assembleLineage: tolerates a fully empty call (no throw, null-ish shape)', () => {
  const out = lineage.assembleLineage();
  assert.equal(out.name, null);
  assert.equal(out.viewed, null);
  assert.equal(out.origin, null);
  assert.equal(out.provenance, null);
  assert.deepEqual(out.copies, []);
  assert.deepEqual(out.versions.current, { version: null, contentHash: null, updatedAt: null, updatedBy: null });
  assert.equal(out.summary.total, 0);
});

test('assembleLineage: provenance must be an object or null (bad values -> null)', () => {
  const out = lineage.assembleLineage({ name: 'x', provenance: 'not-an-object' });
  assert.equal(out.provenance, null);
});

/* ─── summarizeDownstreamDrift (#2317) ──────────────────────────────────── */

test('summarizeDownstreamDrift: empty/junk input yields null (no indicator)', () => {
  for (const bad of [null, undefined, [], 'x', 42]) {
    assert.equal(lineage.summarizeDownstreamDrift(bad), null);
  }
});

test('summarizeDownstreamDrift: all in-sync (or falsy) yields null (AC2 — no new noise)', () => {
  assert.equal(lineage.summarizeDownstreamDrift(['in-sync', 'in-sync']), null);
  assert.equal(lineage.summarizeDownstreamDrift(['in-sync', null, undefined]), null);
});

test('summarizeDownstreamDrift: excludes in-sync from the count, keeps everything else', () => {
  const out = lineage.summarizeDownstreamDrift(['outdated', 'outdated', 'diverged', 'in-sync']);
  assert.equal(out.total, 3);
  assert.deepEqual(out.counts, { outdated: 2, diverged: 1 });
  assert.equal(out.worst, 'diverged');
});

test('summarizeDownstreamDrift: unknown drift is surfaced, not silently dropped (edge case)', () => {
  const out = lineage.summarizeDownstreamDrift(['unknown']);
  assert.equal(out.total, 1);
  assert.deepEqual(out.counts, { unknown: 1 });
  assert.equal(out.worst, 'unknown');
});

test('summarizeDownstreamDrift: worst state wins regardless of input order (conflict > diverged > orphaned > outdated > unknown)', () => {
  const out = lineage.summarizeDownstreamDrift(['outdated', 'conflict', 'unknown']);
  assert.equal(out.worst, 'conflict');
});
