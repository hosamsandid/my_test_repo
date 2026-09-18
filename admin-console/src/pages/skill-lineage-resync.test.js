import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  copyResyncKind,
  planLineageResync,
  summarizeResyncResults,
} from './skill-lineage-resync.js';

test('copyResyncKind: outdated is a safe update', () => {
  assert.equal(copyResyncKind('outdated'), 'update');
});

test('copyResyncKind: diverged/conflict/unknown are force-only overwrites', () => {
  for (const d of ['diverged', 'conflict', 'unknown']) {
    assert.equal(copyResyncKind(d), 'overwrite', d);
  }
});

test('copyResyncKind: orphaned is blocked (source gone — nothing to push)', () => {
  assert.equal(copyResyncKind('orphaned'), 'blocked');
});

test('copyResyncKind: in-sync / null / unrecognised have no action', () => {
  for (const d of ['in-sync', null, undefined, 'weird']) {
    assert.equal(copyResyncKind(d), null, String(d));
  }
});

test('planLineageResync: groups agent copies by action, ignoring non-agent tiers', () => {
  const copies = [
    { tier: 'global' },
    { tier: 'team', teamId: 't1', drift: 'outdated' }, // team tier is a source, not a copy to push
    { tier: 'agent', agentId: 'a-outdated-1', drift: 'outdated' },
    { tier: 'agent', agentId: 'a-outdated-2', drift: 'outdated' },
    { tier: 'agent', agentId: 'a-conflict', drift: 'conflict' },
    { tier: 'agent', agentId: 'a-diverged', drift: 'diverged' },
    { tier: 'agent', agentId: 'a-unknown', drift: 'unknown' },
    { tier: 'agent', agentId: 'a-orphaned', drift: 'orphaned' },
    { tier: 'agent', agentId: 'a-insync', drift: 'in-sync' },
    { tier: 'agent', agentId: 'a-nodrift' },
  ];
  const plan = planLineageResync(copies);
  assert.deepEqual(plan.updatable, ['a-outdated-1', 'a-outdated-2']);
  assert.deepEqual(plan.overwritable, ['a-conflict', 'a-diverged', 'a-unknown']);
  assert.deepEqual(plan.blocked, ['a-orphaned']);
});

test('planLineageResync: tolerates malformed input', () => {
  assert.deepEqual(planLineageResync(null), { updatable: [], overwritable: [], blocked: [] });
  assert.deepEqual(planLineageResync([{ tier: 'agent' }, null, {}]), { updatable: [], overwritable: [], blocked: [] });
});

test('summarizeResyncResults: sums the per-agent tallies into one report', () => {
  const s = summarizeResyncResults([
    { resynced: 1, overwritten: 0, refused: 0 },
    { resynced: 0, overwritten: 1, refused: 0 },
    { resynced: 0, overwritten: 0, refused: 1 },
  ]);
  assert.equal(s.updated, 1);
  assert.equal(s.overwritten, 1);
  assert.equal(s.refused, 1);
  assert.equal(s.failed, 0);
  assert.equal(s.ok, false); // a refusal is not a clean result
  assert.equal(s.text, '1 updated · 1 overwritten · 1 need manual resolution');
});

test('summarizeResyncResults: a client-side error counts as failed', () => {
  const s = summarizeResyncResults([{ resynced: 2 }, { error: 'HTTP 502' }]);
  assert.equal(s.updated, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.ok, false);
  assert.equal(s.text, '2 updated · 1 failed');
});

test('summarizeResyncResults: an all-in-sync fan-out reads as up to date', () => {
  const s = summarizeResyncResults([{ resynced: 0, overwritten: 0, refused: 0 }]);
  assert.equal(s.ok, true);
  assert.equal(s.text, 'already up to date');
});

test('summarizeResyncResults: empty / malformed input is a clean no-op', () => {
  assert.equal(summarizeResyncResults([]).text, 'already up to date');
  assert.equal(summarizeResyncResults(null).ok, true);
});
