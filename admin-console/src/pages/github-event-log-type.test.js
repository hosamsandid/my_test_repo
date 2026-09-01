import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workItemTypeLabel } from './github-event-log-type.js';

/* Pure Type-column helper (#1848) — the label the Type column renders for a
   PR row, an issue row, and a work-item-less/legacy row (AC7b). */

test('AC1/AC2: a pr work item reads "PR"', () => {
  assert.equal(workItemTypeLabel({ kind: 'pr', number: 7 }), 'PR');
  // Correct even for an un-enriched PR (title/url null) — driven by kind alone.
  assert.equal(workItemTypeLabel({ kind: 'pr', number: 7, title: null, url: null }), 'PR');
});

test('AC1: an issue work item reads "Issue"', () => {
  assert.equal(workItemTypeLabel({ kind: 'issue', number: 42 }), 'Issue');
});

test('AC4: a work-item-less row (null) has no type', () => {
  assert.equal(workItemTypeLabel(null), null);
  assert.equal(workItemTypeLabel(undefined), null);
});

test('AC6: a legacy work item with no kind degrades to no type, never a guess', () => {
  assert.equal(workItemTypeLabel({ number: 5 }), null);
  assert.equal(workItemTypeLabel({ kind: 'other', number: 5 }), null);
  // Non-object input is tolerated without throwing.
  assert.equal(workItemTypeLabel('pr'), null);
});

/* Drift guard: the Type column is wired into the Processed-events table with
   its own flat 'workItemType' sort/filter key (AC1) rendered via TypeCell. */
const src = readFileSync(
  fileURLToPath(new URL('./GithubEventLog.jsx', import.meta.url)),
  'utf8',
);

test('AC1: a Type column renders via TypeCell', () => {
  assert.match(src, /key: 'workItemType', label: 'Type', render: \(_v, row\) => <TypeCell workItem={row\.workItem} \/>/);
});

test('AC1: the Type column has its own flat row key for sort/filter', () => {
  assert.match(src, /workItemType: workItemTypeLabel\(e\.workItem\)/);
});
