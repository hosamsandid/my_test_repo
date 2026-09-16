'use strict';

// Unit tests for the pure recurring-analysis binding core (#2248, epic #2251
// Phase 3).

const { test } = require('node:test');
const assert = require('node:assert');

const src = require('./recurring-pool-source');

// ─── normalizeWorkSource ────────────────────────────────────────────────────

test('normalizeWorkSource: absent/malformed reads as no work source', () => {
  assert.equal(src.normalizeWorkSource(undefined), null);
  assert.equal(src.normalizeWorkSource(null), null);
  assert.equal(src.normalizeWorkSource('nope'), null);
  assert.equal(src.normalizeWorkSource({}), null);
});

test('normalizeWorkSource: items missing/empty/non-string-only reads as no work source', () => {
  assert.equal(src.normalizeWorkSource({ outputDir: '/out' }), null);
  assert.equal(src.normalizeWorkSource({ items: [], outputDir: '/out' }), null);
  assert.equal(src.normalizeWorkSource({ items: [1, 2, ''], outputDir: '/out' }), null);
});

test('normalizeWorkSource: a missing outputDir reads as no work source (the completion signal is required)', () => {
  assert.equal(src.normalizeWorkSource({ items: ['ds-1'] }), null);
  assert.equal(src.normalizeWorkSource({ items: ['ds-1'], outputDir: '' }), null);
  assert.equal(src.normalizeWorkSource({ items: ['ds-1'], outputDir: '   ' }), null);
});

test('normalizeWorkSource: valid config is trimmed and deduplicated, order preserved', () => {
  assert.deepEqual(
    src.normalizeWorkSource({ items: [' ds-2 ', 'ds-1', 'ds-2'], outputDir: '/out/', inputDir: '/in/' }),
    { items: ['ds-2', 'ds-1'], outputDir: '/out/', inputDir: '/in/' },
  );
});

test('normalizeWorkSource: inputDir is optional — null for `none` workspaces (concept Insight B)', () => {
  assert.deepEqual(
    src.normalizeWorkSource({ items: ['ds-1'], outputDir: '/out' }),
    { items: ['ds-1'], outputDir: '/out', inputDir: null },
  );
});

// ─── selectRecurringDispatch ────────────────────────────────────────────────

test('selectRecurringDispatch: an empty/default call picks nothing', () => {
  assert.deepEqual(src.selectRecurringDispatch(), []);
  assert.deepEqual(src.selectRecurringDispatch({ items: [] }), []);
});

test('selectRecurringDispatch: picks items that are neither completed nor already running, in list order', () => {
  assert.deepEqual(
    src.selectRecurringDispatch({ items: ['a', 'b', 'c', 'd'], completedItemIds: ['b'], existingItemIds: ['d'] }),
    ['a', 'c'],
  );
});

test('selectRecurringDispatch: a completed item is never re-spawned this cycle (the "already done?" check, D11)', () => {
  assert.deepEqual(
    src.selectRecurringDispatch({ items: ['a', 'b'], completedItemIds: ['a', 'b'] }),
    [],
  );
});

test('selectRecurringDispatch: an item already running is skipped, not duplicated (D11)', () => {
  assert.deepEqual(
    src.selectRecurringDispatch({ items: ['a', 'b'], existingItemIds: ['a'] }),
    ['b'],
  );
});

test('selectRecurringDispatch: contention = none — full parallelism up to `limit` (concept §6)', () => {
  assert.deepEqual(
    src.selectRecurringDispatch({ items: ['a', 'b', 'c'], limit: 2 }),
    ['a', 'b'],
  );
});

test('selectRecurringDispatch: an unset limit (Infinity) never caps', () => {
  const items = Array.from({ length: 50 }, (_, i) => `item-${i}`);
  assert.deepEqual(src.selectRecurringDispatch({ items }), items);
});

test('selectRecurringDispatch: limit 0 picks nothing', () => {
  assert.deepEqual(src.selectRecurringDispatch({ items: ['a', 'b'], limit: 0 }), []);
});
