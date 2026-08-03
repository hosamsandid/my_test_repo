'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  resolveAutonomy,
  canApplyAtAutonomy,
  buildAppliedPatch,
  buildBaseline,
} = require('./hill-climb-apply');

const triggerCard = (over = {}) => ({
  id: 'card-1',
  class: 'trigger-hygiene',
  object: { kind: 'trigger', id: 'agent-x/nightly' },
  proposedChange: { action: 'delete-or-rescope', agentId: 'agent-x', triggerId: 'nightly' },
  targetMetric: 'waste.wasteRuns',
  status: 'open',
  ...over,
});

test('resolveAutonomy: 0/1 pass through, 3 clamps to 2, default 2', () => {
  assert.equal(resolveAutonomy({ autonomy: 0 }), 0);
  assert.equal(resolveAutonomy({ autonomy: 1 }), 1);
  assert.equal(resolveAutonomy({ autonomy: 2 }), 2);
  assert.equal(resolveAutonomy({ autonomy: 3 }), 2, '3 is not authored — ceiling is 2');
  assert.equal(resolveAutonomy({}), 2);
  assert.equal(resolveAutonomy(null), 2);
  assert.equal(resolveAutonomy({ autonomy: 'x' }), 2);
});

test('canApplyAtAutonomy: apply requires level 2', () => {
  assert.equal(canApplyAtAutonomy(0), false);
  assert.equal(canApplyAtAutonomy(1), false);
  assert.equal(canApplyAtAutonomy(2), true);
});

test('buildAppliedPatch: stamps status/timestamp/baseline/undo/cooldown', () => {
  const now = Date.parse('2026-08-03T12:00:00.000Z');
  const snapshot = {
    generatedAt: '2026-08-03T00:00:00.000Z',
    window: { from: '2026-07-27', to: '2026-08-03' },
    metrics: { waste: { wasteRuns: 4 } },
  };
  const undo = { kind: 'restore-trigger', agentId: 'agent-x', trigger: { id: 'nightly', type: 'cron' } };
  const patch = buildAppliedPatch(triggerCard(), {
    now, appliedBy: 'alice', snapshot, undo,
    configVersionRef: { kind: 'trigger-delete', agentId: 'agent-x', triggerId: 'nightly', at: '2026-08-03T12:00:00.000Z' },
    windowDays: 7,
  });
  assert.equal(patch.status, 'applied');
  assert.equal(patch.appliedAt, '2026-08-03T12:00:00.000Z');
  assert.equal(patch.appliedBy, 'alice');
  assert.equal(patch.configVersionRef.kind, 'trigger-delete');
  assert.deepEqual(patch.undo, undo);
  assert.equal(patch.baseline.targetMetric, 'waste.wasteRuns');
  assert.deepEqual(patch.baseline.metrics, { waste: { wasteRuns: 4 } });
  // cooldown = now + 7 days
  assert.equal(patch.cooldownUntil, '2026-08-10T12:00:00.000Z');
});

test('buildAppliedPatch: tolerates a missing snapshot (null baseline metrics)', () => {
  const patch = buildAppliedPatch(triggerCard(), { now: Date.parse('2026-08-03T12:00:00.000Z') });
  assert.equal(patch.status, 'applied');
  assert.equal(patch.baseline.targetMetric, 'waste.wasteRuns');
  assert.equal(patch.baseline.metrics, null);
  assert.equal(patch.appliedBy, null);
  assert.equal(patch.undo, null);
});

test('buildBaseline: names the target metric even with no snapshot', () => {
  assert.deepEqual(buildBaseline(triggerCard(), null), {
    targetMetric: 'waste.wasteRuns', generatedAt: null, window: null, metrics: null,
  });
});
