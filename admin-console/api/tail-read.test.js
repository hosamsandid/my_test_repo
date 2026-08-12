'use strict';

// Unit tests for the bounded tail-line reader (#1684).
// Run: node --test admin-console/api/tail-read.test.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { readLastLines, readLastLinesAcross } = require('./tail-read');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-read-test-'));
function write(name, content) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content);
  return p;
}

test('readLastLines returns the last N lines in file order', () => {
  const p = write('a.txt', 'l1\nl2\nl3\nl4\nl5\n');
  assert.deepEqual(readLastLines(p, 2), ['l4', 'l5']);
  assert.deepEqual(readLastLines(p, 3), ['l3', 'l4', 'l5']);
});

test('readLastLines returns all lines when N exceeds line count', () => {
  const p = write('b.txt', 'x\ny\nz\n');
  assert.deepEqual(readLastLines(p, 100), ['x', 'y', 'z']);
});

test('readLastLines handles a file with no trailing newline', () => {
  const p = write('c.txt', 'one\ntwo\nthree');
  assert.deepEqual(readLastLines(p, 2), ['two', 'three']);
  assert.deepEqual(readLastLines(p, 5), ['one', 'two', 'three']);
});

test('readLastLines skips blank lines', () => {
  const p = write('d.txt', 'a\n\n\nb\n\n');
  assert.deepEqual(readLastLines(p, 10), ['a', 'b']);
});

test('readLastLines works when lines span many chunks (tiny chunkSize)', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
  const p = write('e.txt', lines.join('\n') + '\n');
  assert.deepEqual(readLastLines(p, 3, { chunkSize: 4 }), ['line-47', 'line-48', 'line-49']);
  assert.deepEqual(readLastLines(p, 50, { chunkSize: 7 }), lines);
});

test('readLastLines preserves multibyte UTF-8 split across chunk boundaries', () => {
  // Each line has multibyte characters; a tiny chunk forces boundary splits.
  const lines = ['héllo-☃', 'wörld-→', 'ünïcödé-😀'];
  const p = write('f.txt', lines.join('\n') + '\n');
  // chunkSize 3 will slice through multibyte sequences (emoji is 4 bytes).
  assert.deepEqual(readLastLines(p, 3, { chunkSize: 3 }), lines);
});

test('readLastLines returns [] for a missing file or bad args', () => {
  assert.deepEqual(readLastLines(path.join(TMP, 'nope.txt'), 5), []);
  const p = write('g.txt', 'a\nb\n');
  assert.deepEqual(readLastLines(p, 0), []);
  assert.deepEqual(readLastLines(p, -1), []);
});

test('readLastLines returns [] for an empty file', () => {
  const p = write('empty.txt', '');
  assert.deepEqual(readLastLines(p, 5), []);
});

test('readLastLinesAcross reads newest-file-first, chronological result', () => {
  const f1 = write('day1.txt', 'a1\na2\n');
  const f2 = write('day2.txt', 'b1\nb2\nb3\n');
  // Ask for 4 → all of day2 (3) + last 1 of day1, in chronological order.
  assert.deepEqual(readLastLinesAcross([f1, f2], 4), ['a2', 'b1', 'b2', 'b3']);
});

test('readLastLinesAcross does not exceed maxLines and caps within newest file', () => {
  const f1 = write('h1.txt', 'a1\na2\na3\n');
  const f2 = write('h2.txt', 'b1\nb2\nb3\n');
  assert.deepEqual(readLastLinesAcross([f1, f2], 2), ['b2', 'b3']);
});

test('readLastLinesAcross skips empty newer files and continues to older ones', () => {
  const f1 = write('i1.txt', 'a1\na2\n');
  const f2 = write('i2.txt', ''); // empty newest file
  assert.deepEqual(readLastLinesAcross([f1, f2], 3), ['a1', 'a2']);
});

test('readLastLinesAcross handles empty inputs', () => {
  assert.deepEqual(readLastLinesAcross([], 5), []);
  assert.deepEqual(readLastLinesAcross(['/no/such/file'], 5), []);
  assert.deepEqual(readLastLinesAcross(['x'], 0), []);
});
