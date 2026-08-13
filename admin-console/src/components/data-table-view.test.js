import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmptyState, noMatchText } from './data-table-view.js';

test('rows present → no empty state', () => {
  assert.equal(resolveEmptyState({ dataLength: 10, resultLength: 3, filter: 'foo' }), null);
});

test('empty dataset → caller emptyText, no clear affordance', () => {
  const s = resolveEmptyState({ dataLength: 0, resultLength: 0, filter: '', emptyText: 'No tokens yet.' });
  assert.deepEqual(s, { kind: 'empty', text: 'No tokens yet.', showClear: false });
});

test('empty dataset with a filter typed still shows emptyText (nothing to filter)', () => {
  // dataLength 0 means there is genuinely nothing — a stray filter string must
  // not flip this into a misleading "no matches" state.
  const s = resolveEmptyState({ dataLength: 0, resultLength: 0, filter: 'abc', emptyText: 'No tokens yet.' });
  assert.equal(s.kind, 'empty');
  assert.equal(s.showClear, false);
});

test('filter excludes every row → distinct no-match state with query + clear', () => {
  const s = resolveEmptyState({ dataLength: 10, resultLength: 0, filter: 'zzz', emptyText: 'No tokens yet.' });
  assert.equal(s.kind, 'no-match');
  assert.equal(s.showClear, true);
  assert.match(s.text, /zzz/);
  assert.notEqual(s.text, 'No tokens yet.'); // never the create-CTA copy
});

test('whitespace-only filter is treated as no filter', () => {
  const s = resolveEmptyState({ dataLength: 5, resultLength: 0, filter: '   ', emptyText: 'Empty.' });
  assert.equal(s.kind, 'empty');
});

test('no-match text is trimmed and quoted', () => {
  const s = resolveEmptyState({ dataLength: 5, resultLength: 0, filter: '  hi  ', emptyText: 'Empty.' });
  assert.equal(s.text, noMatchText('hi'));
  assert.match(s.text, /“hi”/);
});

test('missing/invalid filter defaults safely', () => {
  const s = resolveEmptyState({ dataLength: 0, resultLength: 0 });
  assert.equal(s.kind, 'empty');
  assert.equal(s.text, 'No data found');
});
