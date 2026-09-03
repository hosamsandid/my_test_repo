import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldWrapTooltip, TOOLTIP_WRAP_CHARS } from './tooltip-wrap.js';

test('short labels stay on one line', () => {
  assert.equal(shouldWrapTooltip('Fit'), false);
  assert.equal(shouldWrapTooltip('Export this flow as a JSON file'), false);
});

test('labels longer than the threshold wrap', () => {
  assert.equal(
    shouldWrapTooltip('Accept or discard the Copilot proposal first — the canvas is previewing it, not your draft.'),
    true,
  );
});

test('the threshold is exclusive — exactly TOOLTIP_WRAP_CHARS stays on one line', () => {
  assert.equal(shouldWrapTooltip('x'.repeat(TOOLTIP_WRAP_CHARS)), false);
  assert.equal(shouldWrapTooltip('x'.repeat(TOOLTIP_WRAP_CHARS + 1)), true);
});

test('non-string labels are never auto-wrapped', () => {
  assert.equal(shouldWrapTooltip(null), false);
  assert.equal(shouldWrapTooltip(undefined), false);
  assert.equal(shouldWrapTooltip({ type: 'span' }), false);
});

test('the threshold is overridable', () => {
  assert.equal(shouldWrapTooltip('abcde', 3), true);
  assert.equal(shouldWrapTooltip('abcde', 10), false);
});
