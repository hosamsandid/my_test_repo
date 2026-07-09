import test from 'node:test';
import assert from 'node:assert/strict';

import { formatVersionLabel } from './version-info.js';

test('formatVersionLabel: clean build returns the bare commit hash', () => {
  assert.equal(formatVersionLabel('a1b2c3d', ''), 'a1b2c3d');
});

test('formatVersionLabel: dirty build is suffixed', () => {
  assert.equal(formatVersionLabel('a1b2c3d', 'dirty'), 'a1b2c3d-dirty');
});

test('formatVersionLabel: missing commit falls back to "unknown"', () => {
  assert.equal(formatVersionLabel(undefined, ''), 'unknown');
  assert.equal(formatVersionLabel('', ''), 'unknown');
  assert.equal(formatVersionLabel('unknown', 'dirty'), 'unknown');
});
