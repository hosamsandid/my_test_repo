import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { filterPlaceholder } from '../components/data-table-view.js';

// #2405: the Model Providers table was decluttered. The COLUMNS array lives
// inline in ModelRegistry.jsx's render (JSX is uncovered by unit tests per the
// #651 convention), so this wiring test parses the source to pin the structural
// acceptance criteria — the column set, and which cell each badge renders in.
// The behavioural decisions (badge placement, ownership-detail suppression) are
// unit-tested via the pure helpers in assist-selector-exclusion.test.js and
// provider-ownership-view.test.js.

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'ModelRegistry.jsx'), 'utf8');

// Slice out just the COLUMNS array definition (up to the next top-level fn).
const columnsSlice = (() => {
  const start = SRC.indexOf('const COLUMNS = [');
  assert.ok(start >= 0, 'COLUMNS array not found in ModelRegistry.jsx');
  const end = SRC.indexOf('async function handleCreate', start);
  assert.ok(end > start, 'end of COLUMNS array not found');
  return SRC.slice(start, end);
})();

// Split the slice into per-column chunks keyed by each column's `key:` value.
function columnChunks() {
  const parts = columnsSlice.split(/key: '/).slice(1);
  const chunks = {};
  const order = [];
  for (const part of parts) {
    const key = part.slice(0, part.indexOf("'"));
    order.push(key);
    chunks[key] = part;
  }
  return { chunks, order };
}

test('AC1: the table renders no ID column — columns are Name, Ownership, Base URL, Token, Models, Health, Added', () => {
  const { order } = columnChunks();
  assert.deepEqual(order, [
    'name', '_scope', 'baseUrl', 'tokenPreview', 'models', 'health', 'createdAt', '_actions',
  ]);
  assert.equal(order.includes('id'), false, 'the ID column must be gone');
});

test('AC2: the filter placeholder, derived from visible column labels, does not name "ID"', () => {
  // Mirror the real (label-carrying, non-hidden) columns after the ID removal.
  const columns = [
    { label: 'Name' }, { label: 'Ownership' }, { label: 'Base URL' },
    { label: 'Token' }, { label: 'Models' }, { label: 'Health' }, { label: 'Added' },
  ];
  const hint = filterPlaceholder(columns);
  assert.equal(/\bID\b/.test(hint), false, `placeholder must not name ID: "${hint}"`);
  assert.ok(hint.startsWith('Filter by Name'));
});

test('AC3: the provider id is no longer a filter target (no id-keyed column for DataTable to match)', () => {
  // DataTable filters by iterating every column's `key` (data-table-view + the
  // component's own predicate). With no `id` column, `row.id` is never matched.
  const { chunks } = columnChunks();
  assert.equal('id' in chunks, false);
});

test('AC5/AC7: the "Agents only" badge lives in the Base URL cell, not the Name cell', () => {
  const { chunks } = columnChunks();
  // Match the JSX text node (`>Agents only<`), not the string in explanatory comments.
  assert.ok(chunks.baseUrl.includes('>Agents only<'), '"Agents only" must render in the Base URL cell');
  assert.ok(chunks.baseUrl.includes('Subscription (OAuth)'), 'Base URL cell keeps the Subscription (OAuth) label');
  assert.equal(chunks.name.includes('>Agents only<'), false, '"Agents only" must no longer render in the Name cell');
  // The team-scope badge stays by the name.
  assert.ok(chunks.name.includes('>Not your teams<'), '"Not your teams" stays in the Name cell');
  assert.ok(chunks.name.includes('assistExclusionInName'), 'Name cell gates its badge on assistExclusionInName');
});

test('AC6: the read-only badge stays in the Name cell', () => {
  const { chunks } = columnChunks();
  assert.ok(chunks.name.includes('>read-only<'), 'the .env "read-only" badge stays next to the name');
});

test('AC4: the Ownership cell suppresses its detail for Personal via providerScopeShowsDetail', () => {
  const { chunks } = columnChunks();
  assert.ok(chunks._scope.includes('providerScopeShowsDetail'), 'Ownership cell gates its detail on providerScopeShowsDetail');
});
