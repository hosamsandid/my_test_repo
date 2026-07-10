import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveContextWindowTokens, computeContextFillLevel, sumContextTokens, formatTokenCountK,
} from './context-window.js';

test('resolveContextWindowTokens: explicit contextWindow wins over the known-model table', () => {
  assert.equal(resolveContextWindowTokens({ id: 'claude-sonnet-4-6', contextWindow: 500_000 }), 500_000);
});

test('resolveContextWindowTokens: falls back to the known Claude family window', () => {
  assert.equal(resolveContextWindowTokens({ id: 'claude-sonnet-4-6' }), 200_000);
  assert.equal(resolveContextWindowTokens({ id: 'claude-haiku-4-5' }), 200_000);
  assert.equal(resolveContextWindowTokens({ id: 'claude-opus-4-7' }), 200_000);
});

test('resolveContextWindowTokens: unknown model with no explicit value resolves to null', () => {
  assert.equal(resolveContextWindowTokens({ id: 'some-custom-model' }), null);
});

test('resolveContextWindowTokens: ignores a non-positive explicit value', () => {
  assert.equal(resolveContextWindowTokens({ id: 'claude-sonnet-4-6', contextWindow: 0 }), 200_000);
  assert.equal(resolveContextWindowTokens({ id: 'some-custom-model', contextWindow: -1 }), null);
});

test('resolveContextWindowTokens: handles missing/malformed input', () => {
  assert.equal(resolveContextWindowTokens(null), null);
  assert.equal(resolveContextWindowTokens({}), null);
  assert.equal(resolveContextWindowTokens({ id: '' }), null);
});

test('computeContextFillLevel: normal below the warning threshold', () => {
  assert.deepEqual(computeContextFillLevel(40_000, 200_000), { pct: 20, level: 'normal' });
});

test('computeContextFillLevel: warning at and above 70%', () => {
  assert.deepEqual(computeContextFillLevel(140_000, 200_000), { pct: 70, level: 'warning' });
  assert.deepEqual(computeContextFillLevel(160_000, 200_000), { pct: 80, level: 'warning' });
});

test('computeContextFillLevel: critical at and above 90%', () => {
  assert.deepEqual(computeContextFillLevel(180_000, 200_000), { pct: 90, level: 'critical' });
});

test('computeContextFillLevel: clamps at 100% when input exceeds the window', () => {
  assert.deepEqual(computeContextFillLevel(250_000, 200_000), { pct: 100, level: 'critical' });
});

test('computeContextFillLevel: invalid inputs return null instead of a misleading value', () => {
  assert.equal(computeContextFillLevel(null, 200_000), null);
  assert.equal(computeContextFillLevel(1000, null), null);
  assert.equal(computeContextFillLevel(1000, 0), null);
  assert.equal(computeContextFillLevel(-1, 200_000), null);
});

test('sumContextTokens: sums input, cache-creation and cache-read tokens (#490)', () => {
  assert.equal(sumContextTokens({ input: 100, cacheCreationInput: 20, cacheReadInput: 3000 }), 3120);
});

test('sumContextTokens: missing cache fields default to 0 (legacy events without them)', () => {
  assert.equal(sumContextTokens({ input: 100 }), 100);
});

test('sumContextTokens: a session running mostly on cache reads is no longer undercounted', () => {
  // The scenario from #490: input_tokens alone would report "0%"/"0K" even
  // though the session already carries substantial cached history.
  assert.equal(sumContextTokens({ input: 50, cacheCreationInput: 0, cacheReadInput: 190_000 }), 190_050);
});

test('sumContextTokens: invalid/missing input returns null', () => {
  assert.equal(sumContextTokens(null), null);
  assert.equal(sumContextTokens({}), null);
  assert.equal(sumContextTokens({ cacheCreationInput: 5 }), null);
});

test('formatTokenCountK: rounds to whole thousands with a "K" suffix', () => {
  assert.equal(formatTokenCountK(34_300), '34K');
  assert.equal(formatTokenCountK(34_700), '35K');
  assert.equal(formatTokenCountK(200_000), '200K');
});

test('formatTokenCountK: values under 1000 tokens show as "0K"', () => {
  assert.equal(formatTokenCountK(0), '0K');
  assert.equal(formatTokenCountK(999), '0K');
});

test('formatTokenCountK: no "M" abbreviation, even at six-figure-plus limits', () => {
  assert.equal(formatTokenCountK(1_000_000), '1000K');
});

test('formatTokenCountK: invalid input returns null', () => {
  assert.equal(formatTokenCountK(null), null);
  assert.equal(formatTokenCountK(-1), null);
});
