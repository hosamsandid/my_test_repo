'use strict';

// Unit tests for the auto-activation delivery verdict (#750 AC7).
// Run: node --test orchestrator/skill-delivery.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { deliveryVerdict, buildDeliveryFailureEvent } = require('./skill-delivery');

test('all members synced → delivered', () => {
  const v = deliveryVerdict([{ status: 'seeded' }, { status: 'seeded' }]);
  assert.equal(v.delivered, true);
  assert.equal(v.synced, 2);
  assert.equal(v.syncable, 2);
  assert.equal(v.failed, 0);
});

test('AC7: zero synced while members were expected → NOT delivered', () => {
  const members = Array.from({ length: 10 }, () => ({ status: 'error', reason: 'source-missing' }));
  const v = deliveryVerdict(members);
  assert.equal(v.delivered, false);
  assert.equal(v.synced, 0);
  assert.equal(v.syncable, 10);
  assert.equal(v.allSourceMissing, true);
});

test('a partial success still counts as delivered (at least one member got it)', () => {
  const v = deliveryVerdict([
    { status: 'seeded' },
    { status: 'error', reason: 'copy-failed', error: 'EACCES' },
  ]);
  assert.equal(v.delivered, true);
  assert.equal(v.synced, 1);
  assert.equal(v.failed, 1);
  assert.equal(v.allSourceMissing, false);
});

test('neutral-only run (all stubs / overrides) is delivered — nobody to sync, not a failure', () => {
  const v = deliveryVerdict([{ status: 'stub' }, { status: 'skipped-override' }]);
  assert.equal(v.delivered, true);
  assert.equal(v.syncable, 0);
  assert.equal(v.synced, 0);
  assert.equal(v.failed, 0);
});

test('a stub + a real failure → not delivered (the syncable member failed)', () => {
  const v = deliveryVerdict([{ status: 'stub' }, { status: 'error', reason: 'source-missing' }]);
  assert.equal(v.delivered, false);
  assert.equal(v.syncable, 1);
  assert.equal(v.allSourceMissing, true);
});

test('empty result → delivered (nothing to do)', () => {
  const v = deliveryVerdict([]);
  assert.equal(v.delivered, true);
  assert.equal(v.syncable, 0);
});

test('infers source-missing from the error text when no reason code', () => {
  const v = deliveryVerdict([{ status: 'error', error: 'skill not found in pool: x' }]);
  assert.equal(v.delivered, false);
  assert.equal(v.allSourceMissing, true);
});

test('buildDeliveryFailureEvent renders an error-kind feed record with counts', () => {
  const v = deliveryVerdict([{ status: 'error', reason: 'source-missing' }]);
  const ev = buildDeliveryFailureEvent({ teamId: 'agent-studio', skillName: 'reviewing-prs', verdict: v, ts: '2026-07-20T00:00:00.000Z' });
  assert.equal(ev.type, 'skill-delivery-failed');
  assert.equal(ev.kind, 'error');
  assert.equal(ev.teamId, 'agent-studio');
  assert.equal(ev.skillName, 'reviewing-prs');
  assert.equal(ev.auto, true);
  assert.equal(ev.synced, 0);
  assert.equal(ev.syncable, 1);
  assert.equal(ev.reason, 'source-missing');
  assert.equal(ev.ts, '2026-07-20T00:00:00.000Z');
});

test('buildDeliveryFailureEvent flags a generic sync failure distinctly', () => {
  const v = deliveryVerdict([{ status: 'error', reason: 'copy-failed', error: 'EACCES' }]);
  const ev = buildDeliveryFailureEvent({ teamId: 't', skillName: 's', verdict: v, ts: '2026-07-20T00:00:00.000Z' });
  assert.equal(ev.reason, 'sync-failed');
});
