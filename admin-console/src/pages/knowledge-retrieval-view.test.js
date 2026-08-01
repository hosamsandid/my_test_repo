import test from 'node:test';
import assert from 'node:assert/strict';

import { lastUsedLabel, compareLastUsed } from './knowledge-retrieval-view.js';

const NOW = Date.parse('2026-08-01T12:00:00Z');

test('lastUsedLabel: relative tiers + count prefix', () => {
  assert.equal(lastUsedLabel({ lastUsedAt: '2026-08-01T11:30:00Z' }, NOW), 'used just now');
  assert.equal(lastUsedLabel({ lastUsedAt: '2026-08-01T07:00:00Z' }, NOW), 'used 5h ago');
  assert.equal(lastUsedLabel({ lastUsedAt: '2026-07-29T12:00:00Z' }, NOW), 'used 3d ago');
  assert.equal(lastUsedLabel({ lastUsedAt: '2026-05-01T12:00:00Z' }, NOW), 'used 2026-05-01');
  assert.equal(lastUsedLabel({ lastUsedAt: '2026-07-29T12:00:00Z', usageCount: 5 }, NOW), 'used 5× · 3d ago');
  // a single use shows no count prefix
  assert.equal(lastUsedLabel({ lastUsedAt: '2026-07-29T12:00:00Z', usageCount: 1 }, NOW), 'used 3d ago');
});

test('lastUsedLabel: never-used only claimed when telemetry answered', () => {
  assert.equal(lastUsedLabel({}, NOW, true), 'never used');
  assert.equal(lastUsedLabel({}, NOW, false), '');
  assert.equal(lastUsedLabel({ lastUsedAt: 'garbage' }, NOW, false), '');
});

test('compareLastUsed: most recent first, never-used last', () => {
  const a = { id: 'a', lastUsedAt: '2026-08-01T10:00:00Z' };
  const b = { id: 'b', lastUsedAt: '2026-07-01T10:00:00Z' };
  const c = { id: 'c' };
  assert.deepEqual([c, b, a].sort(compareLastUsed).map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(compareLastUsed(a, a), 0);
});
