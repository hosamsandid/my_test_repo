import test from 'node:test';
import assert from 'node:assert/strict';

import { formatVersionLabel, formatCommitTimestamp } from './version-info.js';

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

test('formatCommitTimestamp: positive offset preserved as the commit authored it', () => {
  assert.equal(
    formatCommitTimestamp('2026-08-13T17:52:03+02:00', ''),
    '2026-08-13 17:52 +0200',
  );
});

test('formatCommitTimestamp: negative offset preserved (no Date rebasing)', () => {
  assert.equal(
    formatCommitTimestamp('2026-01-02T09:05:00-05:00', ''),
    '2026-01-02 09:05 -0500',
  );
});

test('formatCommitTimestamp: Z (UTC) renders as +0000', () => {
  assert.equal(
    formatCommitTimestamp('2026-08-13T17:52:03Z', ''),
    '2026-08-13 17:52 +0000',
  );
});

test('formatCommitTimestamp: dirty build is signalled', () => {
  assert.equal(
    formatCommitTimestamp('2026-08-13T17:52:03+02:00', 'dirty'),
    '2026-08-13 17:52 +0200 (dirty)',
  );
});

test('formatCommitTimestamp: missing / unparseable timestamp falls back to "unknown"', () => {
  assert.equal(formatCommitTimestamp(undefined, ''), 'unknown');
  assert.equal(formatCommitTimestamp('', ''), 'unknown');
  assert.equal(formatCommitTimestamp('unknown', 'dirty'), 'unknown');
  assert.equal(formatCommitTimestamp('not-a-timestamp', ''), 'unknown');
  // A bare date with no time/zone is ambiguous → fail safe, not a partial render.
  assert.equal(formatCommitTimestamp('2026-08-13', ''), 'unknown');
});
