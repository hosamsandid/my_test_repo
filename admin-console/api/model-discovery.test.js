'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readContextWindow, normalizeDiscoveredModel, normalizeDiscoveredModels,
} = require('./model-discovery');

test('readContextWindow: reads LiteLLM model_info.max_input_tokens', () => {
  assert.equal(readContextWindow({ id: 'x', model_info: { max_input_tokens: 1_000_000 } }), 1_000_000);
});

test('readContextWindow: reads a flattened max_input_tokens', () => {
  assert.equal(readContextWindow({ id: 'x', max_input_tokens: 200_000 }), 200_000);
});

test('readContextWindow: falls through to context_window / context_length', () => {
  assert.equal(readContextWindow({ id: 'x', context_window: 128_000 }), 128_000);
  assert.equal(readContextWindow({ id: 'x', context_length: 32_768 }), 32_768);
});

test('readContextWindow: max_input_tokens wins over context_length', () => {
  assert.equal(readContextWindow({ id: 'x', model_info: { max_input_tokens: 900_000 }, context_length: 8_000 }), 900_000);
});

test('readContextWindow: coerces a numeric string', () => {
  assert.equal(readContextWindow({ id: 'x', model_info: { max_input_tokens: '1000000' } }), 1_000_000);
});

test('readContextWindow: ignores non-positive / non-numeric / absent values', () => {
  assert.equal(readContextWindow({ id: 'x', model_info: { max_input_tokens: 0 } }), undefined);
  assert.equal(readContextWindow({ id: 'x', max_input_tokens: -1 }), undefined);
  assert.equal(readContextWindow({ id: 'x', max_input_tokens: 'lots' }), undefined);
  assert.equal(readContextWindow({ id: 'x' }), undefined);
  assert.equal(readContextWindow('bare-string'), undefined);
  assert.equal(readContextWindow(null), undefined);
});

test('normalizeDiscoveredModel: object with window + inferred kind', () => {
  assert.deepEqual(
    normalizeDiscoveredModel({ id: 'claude-opus-4-8', model_info: { max_input_tokens: 1_000_000 } }),
    { id: 'claude-opus-4-8', displayName: 'claude-opus-4-8', kind: 'opus', contextWindow: 1_000_000 },
  );
});

test('normalizeDiscoveredModel: no provider window → no contextWindow field', () => {
  const m = normalizeDiscoveredModel({ id: 'claude-sonnet-4-5' });
  assert.deepEqual(m, { id: 'claude-sonnet-4-5', displayName: 'claude-sonnet-4-5', kind: 'sonnet' });
  assert.ok(!('contextWindow' in m));
});

test('normalizeDiscoveredModel: bare string id (no window)', () => {
  assert.deepEqual(normalizeDiscoveredModel('gpt-ish'), { id: 'gpt-ish', displayName: 'gpt-ish' });
});

test('normalizeDiscoveredModel: unusable entry → null', () => {
  assert.equal(normalizeDiscoveredModel({}), null);
  assert.equal(normalizeDiscoveredModel({ id: '' }), null);
  assert.equal(normalizeDiscoveredModel(null), null);
});

test('normalizeDiscoveredModels: maps + filters an array, capturing windows', () => {
  const out = normalizeDiscoveredModels([
    { id: 'claude-opus-4-8', model_info: { max_input_tokens: 1_000_000 } },
    'plain-id',
    { id: '' },              // dropped
    { id: 'haiku-mini' },    // kind haiku, no window
  ]);
  assert.deepEqual(out, [
    { id: 'claude-opus-4-8', displayName: 'claude-opus-4-8', kind: 'opus', contextWindow: 1_000_000 },
    { id: 'plain-id', displayName: 'plain-id' },
    { id: 'haiku-mini', displayName: 'haiku-mini', kind: 'haiku' },
  ]);
});

test('normalizeDiscoveredModels: non-array → empty', () => {
  assert.deepEqual(normalizeDiscoveredModels(null), []);
  assert.deepEqual(normalizeDiscoveredModels(undefined), []);
});
