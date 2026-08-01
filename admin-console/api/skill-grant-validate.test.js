'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { validateGrantNames, normalizeNames } = require('./skill-grant-validate');

test('accepts a set of all-known names', () => {
  const r = validateGrantNames(['a', 'b'], ['a', 'b', 'c'], []);
  assert.deepStrictEqual(r, { ok: true, unknown: [] });
});

test('rejects a newly introduced unknown name', () => {
  const r = validateGrantNames(['a', 'typo'], ['a', 'b'], []);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.unknown, ['typo']);
});

test('preserves a pre-existing unknown name (not newly added)', () => {
  // `legacy` is not a known skill but was already in the prior grant, so it
  // must not block the save (AC4 — flagged in the UI, not dropped/rejected).
  const r = validateGrantNames(['a', 'legacy'], ['a', 'b'], ['legacy']);
  assert.deepStrictEqual(r, { ok: true, unknown: [] });
});

test('still rejects a new unknown even when a prior grant exists', () => {
  const r = validateGrantNames(['legacy', 'newtypo'], ['a'], ['legacy']);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.unknown, ['newtypo']);
});

test('accepts Set inputs for known and previous', () => {
  const r = validateGrantNames(['a', 'legacy'], new Set(['a']), new Set(['legacy']));
  assert.deepStrictEqual(r, { ok: true, unknown: [] });
});

test('empty submitted is always ok', () => {
  assert.deepStrictEqual(validateGrantNames([], ['a'], []), { ok: true, unknown: [] });
  assert.deepStrictEqual(validateGrantNames(undefined, ['a'], undefined), { ok: true, unknown: [] });
});

test('trims and de-duplicates unknowns in the error list', () => {
  const r = validateGrantNames([' x ', 'x', 'y'], ['a'], []);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.unknown, ['x', 'y']);
});

test('ignores non-string / blank entries', () => {
  const r = validateGrantNames(['a', '', '  ', null, 5, 'b'], ['a', 'b'], []);
  assert.deepStrictEqual(r, { ok: true, unknown: [] });
});

test('normalizeNames trims, filters blanks and non-strings', () => {
  assert.deepStrictEqual(normalizeNames([' a ', 'b', '', null, 3, '  ']), ['a', 'b']);
  assert.deepStrictEqual(normalizeNames('nope'), []);
});
