import test from 'node:test';
import assert from 'node:assert/strict';

import { applyMemberOrder, orderAfterMove, normalizeMemberOrder } from './member-order-ops.js';

const ids = (list) => list.map((m) => m.id);

test('applyMemberOrder: orders members by the stored id list', () => {
  const members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(ids(applyMemberOrder(members, ['c', 'a', 'b'])), ['c', 'a', 'b']);
});

test('applyMemberOrder: unlisted members keep their incoming order and are appended', () => {
  const members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  // only b and d are pinned; a and c fall through in their original order
  assert.deepEqual(ids(applyMemberOrder(members, ['d', 'b'])), ['d', 'b', 'a', 'c']);
});

test('applyMemberOrder: ids no longer matching a member are ignored', () => {
  const members = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(ids(applyMemberOrder(members, ['ghost', 'b', 'a', 'gone'])), ['b', 'a']);
});

test('applyMemberOrder: never drops or duplicates a member', () => {
  const members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const out = applyMemberOrder(members, ['b', 'b', 'x']);
  assert.equal(out.length, 3);
  assert.deepEqual(ids(out).slice().sort(), ['a', 'b', 'c']);
});

test('applyMemberOrder: empty / missing order falls back to incoming order', () => {
  const members = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(ids(applyMemberOrder(members, [])), ['a', 'b']);
  assert.deepEqual(ids(applyMemberOrder(members, undefined)), ['a', 'b']);
  assert.deepEqual(ids(applyMemberOrder(members, null)), ['a', 'b']);
});

test('applyMemberOrder: tolerates non-array / falsy members', () => {
  assert.deepEqual(applyMemberOrder(null, ['a']), []);
  assert.deepEqual(ids(applyMemberOrder([{ id: 'a' }, null, undefined], ['a'])), ['a']);
});

test('orderAfterMove: moves an id up (earlier)', () => {
  assert.deepEqual(orderAfterMove(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
});

test('orderAfterMove: moves an id down (later)', () => {
  assert.deepEqual(orderAfterMove(['a', 'b', 'c'], 'a', 1), ['b', 'a', 'c']);
});

test('orderAfterMove: boundary moves are a no-op', () => {
  assert.deepEqual(orderAfterMove(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(orderAfterMove(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
});

test('orderAfterMove: unknown id is a no-op', () => {
  assert.deepEqual(orderAfterMove(['a', 'b'], 'z', -1), ['a', 'b']);
});

test('orderAfterMove: returns a fresh array (does not mutate input)', () => {
  const input = ['a', 'b', 'c'];
  const out = orderAfterMove(input, 'a', 1);
  assert.deepEqual(input, ['a', 'b', 'c']);
  assert.notEqual(out, input);
});

test('normalizeMemberOrder: trims, drops blanks/non-strings, de-dupes, preserves order', () => {
  assert.deepEqual(
    normalizeMemberOrder([' b ', 'a', 'b', '', '  ', 3, null, 'a', 'c']),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(normalizeMemberOrder('nope'), []);
  assert.deepEqual(normalizeMemberOrder(undefined), []);
});
