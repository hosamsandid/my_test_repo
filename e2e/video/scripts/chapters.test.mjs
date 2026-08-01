// Unit tests for the walkthrough chapter selection (#749). Dependency-free: runs
// via `node --test scripts/*.test.mjs` without installing the @revideo toolchain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAPTERS,
  chapterIds,
  parseSelection,
  resolveChapters,
} from './chapters.mjs';

test('registry: every chapter has an id and a render:<id> script', () => {
  assert.ok(CHAPTERS.length >= 2);
  for (const c of CHAPTERS) {
    assert.equal(typeof c.id, 'string');
    assert.equal(c.script, `render:${c.id}`);
  }
});

test('parseSelection: all / empty / blank mean every chapter (null)', () => {
  assert.equal(parseSelection('all'), null);
  assert.equal(parseSelection('ALL'), null);
  assert.equal(parseSelection(' All '), null);
  assert.equal(parseSelection(''), null);
  assert.equal(parseSelection('   '), null);
  assert.equal(parseSelection(undefined), null);
});

test('parseSelection: splits on commas and whitespace, drops blanks', () => {
  assert.deepEqual(parseSelection('team-setup'), ['team-setup']);
  assert.deepEqual(parseSelection('team-setup,iban-story'), [
    'team-setup',
    'iban-story',
  ]);
  assert.deepEqual(parseSelection('team-setup, iban-story'), [
    'team-setup',
    'iban-story',
  ]);
  assert.deepEqual(parseSelection(' team-setup ,, iban-story '), [
    'team-setup',
    'iban-story',
  ]);
});

test('resolveChapters: all → every chapter in registry order', () => {
  assert.deepEqual(
    resolveChapters('all').map((c) => c.id),
    chapterIds(),
  );
  assert.deepEqual(
    resolveChapters('').map((c) => c.id),
    chapterIds(),
  );
});

test('resolveChapters: a subset returns only those, in registry order', () => {
  // Even reversed input keeps registry order.
  assert.deepEqual(
    resolveChapters('iban-story,team-setup').map((c) => c.id),
    ['team-setup', 'iban-story'],
  );
  assert.deepEqual(
    resolveChapters('iban-story').map((c) => c.id),
    ['iban-story'],
  );
});

test('resolveChapters: duplicate ids are de-duplicated', () => {
  assert.deepEqual(
    resolveChapters('team-setup team-setup').map((c) => c.id),
    ['team-setup'],
  );
});

test('resolveChapters: an unknown id fails loudly, listing valid ids', () => {
  assert.throws(() => resolveChapters('nope'), /Unknown journey id\(s\): nope/);
  assert.throws(() => resolveChapters('team-setup,bogus'), /bogus/);
  assert.throws(() => resolveChapters('bogus'), /Valid ids:/);
});

test('resolveChapters: each resolved chapter carries its render script', () => {
  for (const c of resolveChapters('all')) {
    assert.equal(c.script, `render:${c.id}`);
  }
});
