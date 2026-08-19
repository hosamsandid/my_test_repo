import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmptyState, noMatchText, filterPlaceholder, MAX_FILTER_HINT_COLUMNS } from './data-table-view.js';

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

test('filterPlaceholder: names visible column headers', () => {
  const p = filterPlaceholder([{ label: 'Name' }, { label: 'Environment' }]);
  assert.equal(p, 'Filter by Name, Environment');
});

test('filterPlaceholder: elides past the cap and appends an ellipsis', () => {
  const cols = [
    { label: 'Name' }, { label: 'Scope' }, { label: 'Token' }, { label: 'Added' },
  ];
  const p = filterPlaceholder(cols);
  assert.equal(p, 'Filter by Name, Scope, Token…');
  // exactly MAX_FILTER_HINT_COLUMNS labels are spelled out before the ellipsis
  assert.equal(p.split(',').length, MAX_FILTER_HINT_COLUMNS);
});

test('filterPlaceholder: no ellipsis when every label fits', () => {
  const p = filterPlaceholder([{ label: 'Name' }, { label: 'Status' }]);
  assert.ok(!p.endsWith('…'));
});

test('filterPlaceholder: skips hidden and blank/icon-only columns', () => {
  const cols = [
    { label: 'Name' },
    { label: '' },                       // action / icon-only column
    { label: 'Secret', hidden: true },   // search-only hidden column
    { label: '   ' },                    // whitespace-only label
    { label: 'Status' },
  ];
  assert.equal(filterPlaceholder(cols), 'Filter by Name, Status');
});

test('filterPlaceholder: de-duplicates repeated labels', () => {
  const p = filterPlaceholder([{ label: 'Name' }, { label: 'Name' }, { label: 'Type' }]);
  assert.equal(p, 'Filter by Name, Type');
});

test('filterPlaceholder: falls back to plain Filter… with no usable labels', () => {
  assert.equal(filterPlaceholder([]), 'Filter…');
  assert.equal(filterPlaceholder([{ label: '' }, { hidden: true, label: 'X' }]), 'Filter…');
  assert.equal(filterPlaceholder(), 'Filter…');
  assert.equal(filterPlaceholder(null), 'Filter…');
});
