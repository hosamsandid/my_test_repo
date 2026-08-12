import test from 'node:test';
import assert from 'node:assert/strict';

import { plainModelLabel, isRowSelected, clampPopoverLeft } from './model-selector-view.js';

test('plainModelLabel prefers displayName, falls back to id, never adds a kind suffix', () => {
  assert.equal(plainModelLabel({ id: 'claude-opus-4-8', displayName: 'Opus 4.8', kind: 'opus' }), 'Opus 4.8');
  assert.equal(plainModelLabel({ id: 'claude-opus-4-8', kind: 'opus' }), 'claude-opus-4-8');
  assert.equal(plainModelLabel(null), '');
  assert.equal(plainModelLabel({}), '');
  // AC9: the family/kind suffix must never appear.
  assert.ok(!plainModelLabel({ id: 'x', displayName: 'Sonnet 5', kind: 'sonnet' }).includes('·'));
  assert.ok(!plainModelLabel({ id: 'x', displayName: 'Sonnet 5', kind: 'sonnet' }).includes('sonnet'));
});

test('isRowSelected matches only on both endpoint and model', () => {
  const sel = { endpointId: 'ep1', modelId: 'm1' };
  assert.equal(isRowSelected(sel, 'ep1', 'm1'), true);
  assert.equal(isRowSelected(sel, 'ep1', 'm2'), false);
  assert.equal(isRowSelected(sel, 'ep2', 'm1'), false);
  assert.equal(isRowSelected(null, 'ep1', 'm1'), false);
});

test('clampPopoverLeft right-aligns under the trigger when it fits', () => {
  // trigger right edge at 900, width 300, viewport 1200 → 600, within bounds.
  const left = clampPopoverLeft({ right: 900 }, 300, 1200);
  assert.equal(left, 600);
});

test('clampPopoverLeft clamps to the left margin in a narrow viewport', () => {
  // trigger right edge at 250, width 300 → rightAligned -50, clamped to 8.
  const left = clampPopoverLeft({ right: 250 }, 300, 400);
  assert.equal(left, 8);
});

test('clampPopoverLeft never runs off the right edge', () => {
  // trigger right edge far right; must not exceed viewportWidth - width - margin.
  const left = clampPopoverLeft({ right: 1190 }, 300, 1000);
  assert.equal(left, 1000 - 300 - 8);
});

test('clampPopoverLeft falls back to the margin without a rect', () => {
  assert.equal(clampPopoverLeft(null, 300, 1200), 8);
});
