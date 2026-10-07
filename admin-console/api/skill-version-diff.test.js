'use strict';

// Unit tests for the pure skill version diff (#2839).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const d = require('./skill-version-diff');

const f = (path, text) => ({ path, bytes: Buffer.from(text, 'utf8') });

test('splitLines: no phantom trailing line, CRLF tolerated', () => {
  assert.deepEqual(d.splitLines(''), []);
  assert.deepEqual(d.splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(d.splitLines('a\r\nb'), ['a', 'b']);
});

test('diffLines: markers, line numbers and counts', () => {
  const ops = d.diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
  assert.deepEqual(ops, [
    { t: ' ', a: 1, b: 1, s: 'a' },
    { t: '-', a: 2, b: null, s: 'b' },
    { t: '+', a: null, b: 2, s: 'x' },
    { t: ' ', a: 3, b: 3, s: 'c' },
    { t: '+', a: null, b: 4, s: 'd' },
  ]);
});

test('diffLines: a middle too big for the LCS table degrades to one replace block', () => {
  const n = Math.ceil(Math.sqrt(d.MAX_LCS_CELLS)) + 10;
  const a = Array.from({ length: n }, (_, i) => `a${i}`);
  const b = Array.from({ length: n }, (_, i) => `b${i}`);
  const ops = d.diffLines(a, b);
  assert.equal(ops.length, 2 * n);
  assert.equal(ops[0].t, '-');
  assert.equal(ops[n].t, '+');
});

test('diffSkillVersions: classifies added / removed / modified / unchanged with +/- counts', () => {
  const out = d.diffSkillVersions(
    [f('SKILL.md', 'a\nb\n'), f('gone.txt', 'x\n'), f('same.txt', 'same\n')],
    [f('SKILL.md', 'a\nB\nc\n'), f('new.txt', 'totally different\n'), f('same.txt', 'same\n')],
  );
  const by = Object.fromEntries(out.files.map(e => [e.path, e]));
  assert.equal(by['SKILL.md'].status, 'modified');
  assert.equal(by['SKILL.md'].added, 2);
  assert.equal(by['SKILL.md'].removed, 1);
  assert.equal(by['gone.txt'].status, 'removed');
  assert.equal(by['new.txt'].status, 'added');
  assert.equal(by['same.txt'].status, 'unchanged');
  assert.equal(by['same.txt'].ops, undefined, 'unchanged files carry no ops');
  assert.equal(out.identical, false);
  assert.deepEqual(out.summary, { added: 1, removed: 1, modified: 1, renamed: 0, unchanged: 1, linesAdded: 3, linesRemoved: 2 });
});

test('diffSkillVersions: identical content → no differences', () => {
  const files = [f('SKILL.md', 'a\n'), f('scripts/x.sh', 'echo\n')];
  const out = d.diffSkillVersions(files, files);
  assert.equal(out.identical, true);
  assert.ok(out.files.every(e => e.status === 'unchanged'));
});

test('diffSkillVersions: renames — exact, similar, and dissimilar stays remove + add', () => {
  const body = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const out = d.diffSkillVersions(
    [f('a.md', body), f('b.md', body.replace('line 3', 'line three')), f('c.md', 'one\ntwo\n')],
    [f('a2.md', body), f('b2.md', body), f('c2.md', 'nine\nten\n')],
  );
  const by = Object.fromEntries(out.files.map(e => [e.path, e]));
  assert.equal(by['a2.md'].status, 'renamed');
  assert.equal(by['a2.md'].fromPath, 'a.md');
  assert.equal(by['a2.md'].contentChanged, false);
  assert.equal(by['b2.md'].status, 'renamed');
  assert.equal(by['b2.md'].fromPath, 'b.md');
  assert.equal(by['b2.md'].contentChanged, true);
  assert.equal(by['b2.md'].added, 1);
  assert.equal(by['c.md'].status, 'removed');
  assert.equal(by['c2.md'].status, 'added');
});

test('diffSkillVersions: binary and too-large files are compared by bytes only', () => {
  const bin1 = { path: 'img.png', bytes: Buffer.from([0x89, 0, 1, 2]) };
  const bin2 = { path: 'img.png', bytes: Buffer.from([0x89, 0, 1, 3]) };
  const big = 'x'.repeat(d.MAX_DIFF_BYTES + 1);
  const out = d.diffSkillVersions([bin1, f('big.txt', big), f('big2.txt', big)], [bin2, f('big.txt', big + 'y'), f('big2.txt', big)]);
  const by = Object.fromEntries(out.files.map(e => [e.path, e]));
  assert.equal(by['img.png'].binary, true);
  assert.equal(by['img.png'].status, 'modified');
  assert.equal(by['img.png'].ops, undefined);
  assert.equal(by['img.png'].added, null);
  assert.equal(by['big.txt'].tooLarge, true);
  assert.equal(by['big.txt'].status, 'modified');
  assert.equal(by['big.txt'].ops, undefined);
  assert.equal(by['big2.txt'].status, 'unchanged');
});
