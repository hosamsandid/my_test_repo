import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLineDiff } from './edit-diff.js';

test('identical strings produce all-context rows and no changes', () => {
  const { rows, added, removed } = computeLineDiff('a\nb\nc', 'a\nb\nc');
  assert.equal(added, 0);
  assert.equal(removed, 0);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.type === 'context'));
  assert.deepEqual(rows.map((r) => [r.oldLineNo, r.newLineNo]), [[1, 1], [2, 2], [3, 3]]);
});

test('empty old string (Write, new file) is all additions', () => {
  const { rows, added, removed } = computeLineDiff('', 'x\ny');
  assert.equal(removed, 0);
  assert.equal(added, 2);
  assert.deepEqual(rows, [
    { type: 'add', oldLineNo: null, newLineNo: 1, text: 'x' },
    { type: 'add', oldLineNo: null, newLineNo: 2, text: 'y' },
  ]);
});

test('empty new string is all deletions', () => {
  const { rows, added, removed } = computeLineDiff('x\ny', '');
  assert.equal(added, 0);
  assert.equal(removed, 2);
  assert.deepEqual(rows, [
    { type: 'del', oldLineNo: 1, newLineNo: null, text: 'x' },
    { type: 'del', oldLineNo: 2, newLineNo: null, text: 'y' },
  ]);
});

test('a single changed line in the middle keeps its shared context', () => {
  const oldStr = 'one\ntwo\nthree\nfour';
  const newStr = 'one\ntwo-edited\nthree\nfour';
  const { rows, added, removed } = computeLineDiff(oldStr, newStr);
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.deepEqual(rows.map((r) => r.type), ['context', 'del', 'add', 'context', 'context']);
  assert.equal(rows[1].text, 'two');
  assert.equal(rows[2].text, 'two-edited');
  // Shared prefix/suffix line numbers advance normally on both sides.
  assert.deepEqual(rows[0], { type: 'context', oldLineNo: 1, newLineNo: 1, text: 'one' });
  assert.deepEqual(rows[3], { type: 'context', oldLineNo: 3, newLineNo: 3, text: 'three' });
  assert.deepEqual(rows[4], { type: 'context', oldLineNo: 4, newLineNo: 4, text: 'four' });
});

test('pure insertion in the middle produces no deletions', () => {
  const { rows, added, removed } = computeLineDiff('a\nb', 'a\nnew\nb');
  assert.equal(removed, 0);
  assert.equal(added, 1);
  assert.deepEqual(rows.map((r) => r.type), ['context', 'add', 'context']);
  assert.equal(rows[1].text, 'new');
});

test('pure deletion in the middle produces no additions', () => {
  const { rows, added, removed } = computeLineDiff('a\ngone\nb', 'a\nb');
  assert.equal(added, 0);
  assert.equal(removed, 1);
  assert.deepEqual(rows.map((r) => r.type), ['context', 'del', 'context']);
  assert.equal(rows[1].text, 'gone');
});

test('completely different content diffs without shared context', () => {
  const { rows, added, removed } = computeLineDiff('alpha\nbeta', 'gamma\ndelta\nepsilon');
  assert.equal(removed, 2);
  assert.equal(added, 3);
  assert.equal(rows.length, 5);
});

test('trims common prefix and suffix around a small edit in a large string', () => {
  const big = Array.from({ length: 50 }, (_, i) => `line${i}`);
  const oldLines = [...big.slice(0, 25), 'target', ...big.slice(25)];
  const newLines = [...big.slice(0, 25), 'target-changed', ...big.slice(25)];
  const { rows, added, removed } = computeLineDiff(oldLines.join('\n'), newLines.join('\n'));
  assert.equal(added, 1);
  assert.equal(removed, 1);
  // 50 shared context lines + one del + one add.
  assert.equal(rows.length, 52);
  const changed = rows.filter((r) => r.type !== 'context');
  assert.deepEqual(changed.map((r) => r.text), ['target', 'target-changed']);
});
