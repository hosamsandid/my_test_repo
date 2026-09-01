import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstEnabledIndex,
  lastEnabledIndex,
  nextEnabledIndex,
} from './header-overflow-menu.js';

const RESET = { key: 'reset' };
const CLEAR = { key: 'clear' };

test('firstEnabledIndex finds the first enabled item', () => {
  assert.equal(firstEnabledIndex([RESET, CLEAR]), 0);
  assert.equal(firstEnabledIndex([{ ...RESET, disabled: true }, CLEAR]), 1);
});

test('firstEnabledIndex is -1 when all disabled or empty', () => {
  assert.equal(firstEnabledIndex([{ disabled: true }, { disabled: true }]), -1);
  assert.equal(firstEnabledIndex([]), -1);
  assert.equal(firstEnabledIndex(null), -1);
});

test('lastEnabledIndex finds the last enabled item', () => {
  assert.equal(lastEnabledIndex([RESET, CLEAR]), 1);
  assert.equal(lastEnabledIndex([RESET, { ...CLEAR, disabled: true }]), 0);
  assert.equal(lastEnabledIndex([{ disabled: true }, { disabled: true }]), -1);
});

test('nextEnabledIndex moves down and wraps', () => {
  const items = [RESET, CLEAR];
  assert.equal(nextEnabledIndex(items, 0, 1), 1);
  assert.equal(nextEnabledIndex(items, 1, 1), 0); // wrap to top
});

test('nextEnabledIndex moves up and wraps', () => {
  const items = [RESET, CLEAR];
  assert.equal(nextEnabledIndex(items, 1, -1), 0);
  assert.equal(nextEnabledIndex(items, 0, -1), 1); // wrap to bottom
});

test('nextEnabledIndex from unfocused (-1) lands on the edge', () => {
  const items = [RESET, CLEAR];
  assert.equal(nextEnabledIndex(items, -1, 1), 0);  // first
  assert.equal(nextEnabledIndex(items, -1, -1), 1); // last
});

test('nextEnabledIndex skips disabled items', () => {
  const items = [RESET, { ...CLEAR, disabled: true }, { key: 'x' }];
  assert.equal(nextEnabledIndex(items, 0, 1), 2); // skip the disabled middle
  assert.equal(nextEnabledIndex(items, 2, -1), 0);
});

test('nextEnabledIndex returns -1 when nothing is enabled', () => {
  const items = [{ disabled: true }, { disabled: true }];
  assert.equal(nextEnabledIndex(items, 0, 1), -1);
  assert.equal(nextEnabledIndex([], 0, 1), -1);
});
