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

// #1922 promoted Reset Session to a primary toolbar button, so the menu now
// carries a single item (Clear History). Keyboard traversal must still behave:
// the lone item takes focus on open and every arrow key stays on it.
test('a single-item menu focuses and keeps focus on its one item', () => {
  const items = [CLEAR];
  assert.equal(firstEnabledIndex(items), 0);
  assert.equal(lastEnabledIndex(items), 0);
  assert.equal(nextEnabledIndex(items, -1, 1), 0);  // open → first
  assert.equal(nextEnabledIndex(items, -1, -1), 0); // End → last (same item)
  assert.equal(nextEnabledIndex(items, 0, 1), 0);   // wraps onto itself
  assert.equal(nextEnabledIndex(items, 0, -1), 0);
});

test('a single-item menu that is disabled offers no focus target', () => {
  const items = [{ ...CLEAR, disabled: true }];
  assert.equal(firstEnabledIndex(items), -1);
  assert.equal(lastEnabledIndex(items), -1);
  assert.equal(nextEnabledIndex(items, -1, 1), -1);
});

test('nextEnabledIndex returns -1 when nothing is enabled', () => {
  const items = [{ disabled: true }, { disabled: true }];
  assert.equal(nextEnabledIndex(items, 0, 1), -1);
  assert.equal(nextEnabledIndex([], 0, 1), -1);
});
