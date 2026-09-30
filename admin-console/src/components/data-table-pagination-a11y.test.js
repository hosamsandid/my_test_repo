import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAGINATION_LABELS } from './data-table-view.js';

/**
 * Source-reading drift guard over DataTable.jsx, which `node --test` cannot
 * load (the #651 convention). #2617: the prev/next pagination buttons are
 * icon-only and must carry an accessible name (aria-label) and a tooltip
 * (title); the decorative chevrons are hidden from assistive tech.
 */

const src = readFileSync(fileURLToPath(new URL('./DataTable.jsx', import.meta.url)), 'utf8');

function paginationBtnBody() {
  const start = src.indexOf('function PaginationBtn(');
  assert.ok(start >= 0, 'PaginationBtn is defined in DataTable.jsx');
  return src.slice(start);
}

test('pagination labels are human-readable names', () => {
  assert.equal(PAGINATION_LABELS.prev, 'Previous page');
  assert.equal(PAGINATION_LABELS.next, 'Next page');
});

test('PaginationBtn takes a label and renders it as aria-label and title', () => {
  const body = paginationBtnBody();
  assert.match(body, /function PaginationBtn\(\{[^}]*\blabel\b[^}]*\}\)/);
  assert.match(body, /aria-label=\{label\}/);
  assert.match(body, /title=\{label\}/);
  assert.match(body, /type="button"/);
});

test('every PaginationBtn call site passes a label', () => {
  const usages = src.match(/<PaginationBtn\b.*$/gm) || [];
  assert.equal(usages.length, 2, 'prev and next buttons');
  assert.match(usages[0], /label=\{PAGINATION_LABELS\.prev\}/);
  assert.match(usages[1], /label=\{PAGINATION_LABELS\.next\}/);
});

test('chevron icons inside the buttons are aria-hidden', () => {
  assert.match(src, /<ChevronLeft size=\{14\} aria-hidden="true" \/>/);
  assert.match(src, /<ChevronRight size=\{14\} aria-hidden="true" \/>/);
});
