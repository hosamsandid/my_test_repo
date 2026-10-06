import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the #2859 Flows rail filter wiring (the #651 convention):
 * every decision lives in `flows-rail-filter.js` (unit-tested), the wiring in
 * `Briefings.jsx` and the shared `ListFilterControl.jsx`, which `node --test`
 * cannot load.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const code = rel => fs.readFileSync(path.join(HERE, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const page = code('../Briefings.jsx');
const control = code('../agent-chat/ListFilterControl.jsx');

test('the rail renders the shared filter control with the flows copy, quick filters and summary', () => {
  assert.match(page, /import ListFilterControl from '\.\/agent-chat\/ListFilterControl\.jsx'/);
  const el = page.match(/<ListFilterControl[\s\S]*?\/>/);
  assert.ok(el, 'ListFilterControl is rendered');
  assert.match(el[0], /entries=\{filterEntries\}/);
  assert.match(el[0], /selection=\{flowsFilter\}/);
  assert.match(el[0], /onAction=\{handleFilterAction\}/);
  assert.match(el[0], /copy=\{FLOWS_FILTER_COPY\}/);
  assert.match(el[0], /quickFilters=\{FLOWS_QUICK_FILTERS\}/);
  assert.match(el[0], /summary=\{flowsSelectionSummary\(filterEntries, flowsFilter\)\}/);
  assert.match(el[0], /quickFiltersDisabledReason=\{quickFiltersDisabledReason\(\{ membershipsLoaded, viewerId \}\)\}/);
});

test('the control takes copy, quick filters and a summary override, and renders group headings', () => {
  assert.match(control, /copy:\s*copyOverrides/);
  assert.match(control, /quickFilters\s*=\s*QUICK_FILTERS/);
  assert.match(control, /summaryOverride \?\? selectionSummary\(entries, selection\)/);
  assert.match(control, /entry\.group !== listed\[i - 1\]\?\.group/);
});

test('the rail lists flowsRailView rows, with section and nothing-selected hints', () => {
  assert.match(page, /flowsRailView\(\{ teams, drafts, selection: flowsFilter \}\)/);
  assert.match(page, /railView\.teams\.map\(/);
  assert.match(page, /railView\.drafts\.map\(/);
  assert.match(page, /railView\.teamsHint/);
  assert.match(page, /railView\.draftsHint/);
  assert.match(page, /NO_FLOWS_SELECTED_HINT/);
  assert.doesNotMatch(page, /[^.]\b(teams|drafts)\.map\([td] => \(/, 'rows must come from the filtered view');
});

test('the selection starts from the user preference and is saved as flowsListFilter', () => {
  assert.match(page, /useState\(\(\) => normalizeSelection\(user\?\.flowsListFilter\)\)/);
  assert.match(page, /apiCall\('PUT', '\/api\/me\/preferences', \{ flowsListFilter: next \}\)/);
  assert.match(page, /patchUser\(\{ flowsListFilter: next \}\)/);
  assert.match(page, /applyFlowsFilterAction\(/);
});

test('opening a hidden flow reveals it (AC11)', () => {
  assert.match(page, /revealKeyForProc\(proc,/);
  assert.match(page, /type: 'reveal'/);
});
