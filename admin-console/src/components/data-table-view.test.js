import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEmptyState, noMatchText, filterPlaceholder, MAX_FILTER_HINT_COLUMNS,
  columnFilterText, rowMatchesFilter,
} from './data-table-view.js';

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

/* ── Filter predicate (#2442) ──────────────────────────────────────── */

test('columnFilterText: defaults to the raw row value, lower-cased', () => {
  assert.equal(columnFilterText({ key: 'name' }, { name: 'Widget' }), 'widget');
});

test('columnFilterText: null/undefined raw value yields empty string', () => {
  assert.equal(columnFilterText({ key: 'name' }, { name: null }), '');
  assert.equal(columnFilterText({ key: 'missing' }, { name: 'x' }), '');
  assert.equal(columnFilterText({ key: 'name' }, null), '');
  assert.equal(columnFilterText(null, { name: 'x' }), '');
});

test('columnFilterText: numeric raw value is stringified', () => {
  assert.equal(columnFilterText({ key: 'total' }, { total: 12345 }), '12345');
});

test('columnFilterText: filterValue override wins and is applied to (raw,row)', () => {
  const col = { key: 'key', filterValue: (raw, row) => `${row.name} ${raw}` };
  assert.equal(columnFilterText(col, { key: 'u_42', name: 'Maier' }), 'maier u_42');
});

test('columnFilterText: filterValue returning null → empty string (not the raw value)', () => {
  const col = { key: 'key', filterValue: () => null };
  assert.equal(columnFilterText(col, { key: 'u_42' }), '');
});

test('rowMatchesFilter: empty / whitespace query matches every row', () => {
  const cols = [{ key: 'name' }];
  assert.equal(rowMatchesFilter({ name: 'x' }, cols, ''), true);
  assert.equal(rowMatchesFilter({ name: 'x' }, cols, '   '), true);
  assert.equal(rowMatchesFilter({ name: 'x' }, cols, null), true);
});

// The core #2442 fix: a column whose render maps a raw id to a display name must
// filter on that displayed name. Model the Token Usage User column exactly:
// raw `key` is an account id, filterValue resolves it to "<name> <id>".
const userNames = new Map([['u_tmaier', 'Thorsten A. Maier'], ['u_hpoly', 'Harris Polychronakis']]);
const userCol = {
  key: 'key',
  filterValue: (raw) => [userNames.get(raw) || raw, raw].filter(Boolean).join(' '),
};
const numCols = [{ key: 'input' }, { key: 'output' }, { key: 'total' }];
const cols = [userCol, ...numCols];
const rows = [
  { key: 'u_tmaier', input: 100, output: 5, total: 105 },
  { key: 'u_hpoly', input: 999, output: 1, total: 1000 },
];

test('AC1: a displayed name matches its row (and only it)', () => {
  const hit = rows.filter((r) => rowMatchesFilter(r, cols, 'Maier'));
  assert.deepEqual(hit.map((r) => r.key), ['u_tmaier']);
  // partial name, other user
  assert.deepEqual(rows.filter((r) => rowMatchesFilter(r, cols, 'Harris')).map((r) => r.key), ['u_hpoly']);
});

test('AC1: the raw account id stays searchable too', () => {
  assert.deepEqual(rows.filter((r) => rowMatchesFilter(r, cols, 'tmaier')).map((r) => r.key), ['u_tmaier']);
});

// AC5 sweep: a synthetic column (`key: '_scope'` with no `row['_scope']`) whose
// render maps the row to an ownership label + a team-name detail. This models the
// GithubTokens / SshKeys / ModelRegistry `_scope` columns the #2442 sweep fixed:
// the raw value is undefined, so filtering must lean entirely on `filterValue(row)`.
const scopeCol = {
  key: '_scope',
  filterValue: (_, row) => (row.scope === 'team'
    ? `Team ${(row.teams || []).join(', ')}`
    : row.scope === 'global' ? 'Global' : 'Personal'),
};
const scopeRows = [
  { id: 'a', scope: 'team', teams: ['Payments Squad'] },
  { id: 'b', scope: 'personal' },
  { id: 'c', scope: 'global' },
];

test('AC5: a synthetic _scope column filters on the displayed team name, not the (undefined) raw key', () => {
  const cols2 = [scopeCol, { key: 'id' }];
  // raw row['_scope'] is undefined — without filterValue this would match nothing
  assert.deepEqual(scopeRows.filter((r) => rowMatchesFilter(r, cols2, 'Payments')).map((r) => r.id), ['a']);
  assert.deepEqual(scopeRows.filter((r) => rowMatchesFilter(r, cols2, 'Global')).map((r) => r.id), ['c']);
  assert.deepEqual(scopeRows.filter((r) => rowMatchesFilter(r, cols2, 'Personal')).map((r) => r.id), ['b']);
});

test('AC2: a name that matches nobody yields zero rows', () => {
  assert.deepEqual(rows.filter((r) => rowMatchesFilter(r, cols, 'Nonexistent')), []);
});

test('AC3: numeric columns still filter as before', () => {
  assert.deepEqual(rows.filter((r) => rowMatchesFilter(r, cols, '999')).map((r) => r.key), ['u_hpoly']);
  assert.deepEqual(rows.filter((r) => rowMatchesFilter(r, cols, '105')).map((r) => r.key), ['u_tmaier']);
});

test('case-insensitive matching on the displayed name', () => {
  assert.deepEqual(rows.filter((r) => rowMatchesFilter(r, cols, 'MAIER')).map((r) => r.key), ['u_tmaier']);
});
