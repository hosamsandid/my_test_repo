import test from 'node:test';
import assert from 'node:assert/strict';

import { computeReorder, dropPosition } from './agent-list-dnd.js';

const KEYS = ['a', 'b', 'c', 'd'];

test('drop before a later item moves the item down', () => {
  // AC1/AC2/AC3 — a single drag relocates the item in one gesture.
  assert.deepEqual(computeReorder(KEYS, 'a', 'c', 'before'), ['b', 'a', 'c', 'd']);
});

test('drop after a later item moves the item just past it', () => {
  assert.deepEqual(computeReorder(KEYS, 'a', 'c', 'after'), ['b', 'c', 'a', 'd']);
});

test('drop before an earlier item moves the item up', () => {
  assert.deepEqual(computeReorder(KEYS, 'd', 'b', 'before'), ['a', 'd', 'b', 'c']);
});

test('promote the last item to the very top (the motivating case)', () => {
  assert.deepEqual(computeReorder(KEYS, 'd', 'a', 'before'), ['d', 'a', 'b', 'c']);
});

test('drop onto itself is a no-op (returns null)', () => {
  // "Dropping an item back onto its original position: no change, no churn."
  assert.equal(computeReorder(KEYS, 'b', 'b', 'before'), null);
  assert.equal(computeReorder(KEYS, 'b', 'b', 'after'), null);
});

test('a drop that resolves to the identical order returns null', () => {
  // Dropping `a` before `b` when `a` is already immediately before `b`, or
  // `a` after its own predecessor, must not churn localStorage (AC5 edge).
  assert.equal(computeReorder(KEYS, 'a', 'b', 'before'), null);
  assert.equal(computeReorder(KEYS, 'b', 'a', 'after'), null);
});

test('adjacent-swap drop matches the arrow "move one step" result', () => {
  // AC6 — a one-position drag is indistinguishable from an arrow press.
  assert.deepEqual(computeReorder(KEYS, 'b', 'c', 'after'), ['a', 'c', 'b', 'd']);
});

test('unknown from/to keys return null (nothing to reorder)', () => {
  assert.equal(computeReorder(KEYS, 'z', 'a', 'before'), null);
  assert.equal(computeReorder(KEYS, 'a', 'z', 'before'), null);
});

test('single-item and empty lists are no-ops', () => {
  // Edge case: a list with a single item / a group with a single member.
  assert.equal(computeReorder(['solo'], 'solo', 'solo', 'before'), null);
  assert.equal(computeReorder([], 'a', 'b', 'before'), null);
});

test('non-array input is tolerated', () => {
  assert.equal(computeReorder(null, 'a', 'b', 'before'), null);
  assert.equal(computeReorder(undefined, 'a', 'b', 'before'), null);
});

test('the source array is never mutated', () => {
  const original = [...KEYS];
  computeReorder(KEYS, 'a', 'd', 'after');
  assert.deepEqual(KEYS, original);
});

test('dropPosition splits a row at its vertical midpoint', () => {
  const rect = { top: 100, height: 40 }; // midpoint at y=120
  assert.equal(dropPosition(105, rect), 'before');
  assert.equal(dropPosition(119, rect), 'before');
  assert.equal(dropPosition(120, rect), 'after');
  assert.equal(dropPosition(135, rect), 'after');
});
