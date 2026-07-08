import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveContextWindowTokens, computeContextFillLevel } from './context-window.js';

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
