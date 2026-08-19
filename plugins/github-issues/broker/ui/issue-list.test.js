'use strict';

// Tests for the pure issue-list view helpers (#1658): the search-vs-list switch,
// the Previous/Next pager rules, and the distinct empty-state copy. Mirrors
// ui/markdown.test.js (node:test, requires the UMD module as CommonJS).

const test = require('node:test');
const assert = require('node:assert');
const il = require('./issue-list');

test('normalizeQuery trims; whitespace-only is treated as no search (AC9)', () => {
  assert.equal(il.normalizeQuery('  fix login  '), 'fix login');
  assert.equal(il.normalizeQuery('   '), '');
  assert.equal(il.normalizeQuery(''), '');
  assert.equal(il.normalizeQuery(null), '');
  assert.equal(il.isSearching('  x '), true);
  assert.equal(il.isSearching('   '), false);
});

test('pagerState: Previous only past page 1, Next only while more pages exist (AC2)', () => {
  assert.deepEqual(il.pagerState(1, true), { page: 1, hasPrev: false, hasNext: true, label: 'Page 1' });
  assert.deepEqual(il.pagerState(3, false), { page: 3, hasPrev: true, hasNext: false, label: 'Page 3' });
  assert.deepEqual(il.pagerState(2, true), { page: 2, hasPrev: true, hasNext: true, label: 'Page 2' });
  // defensive clamp
  assert.deepEqual(il.pagerState(0, false), { page: 1, hasPrev: false, hasNext: false, label: 'Page 1' });
  assert.deepEqual(il.pagerState('x', true), { page: 1, hasPrev: false, hasNext: true, label: 'Page 1' });
});

test('emptyMessage: a matchless search is DISTINCT from an empty listing (AC10)', () => {
  assert.equal(il.emptyMessage('backup', 'open'), 'No issues match “backup”.');
  assert.equal(il.emptyMessage('  spaces  ', 'all'), 'No issues match “spaces”.');
  // no query → the listing empty state, state-aware
  assert.equal(il.emptyMessage('', 'open'), 'No open issues in this repository.');
  assert.equal(il.emptyMessage('', 'closed'), 'No closed issues in this repository.');
  assert.equal(il.emptyMessage('', 'all'), 'No issues in this repository.');
  assert.equal(il.emptyMessage('   ', 'open'), 'No open issues in this repository.');
});
