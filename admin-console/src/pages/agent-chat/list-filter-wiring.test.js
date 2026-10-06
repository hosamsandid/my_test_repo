import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the #2740 multi-select team filter wiring (the #651
 * convention): every decision lives in `list-selection.js` (unit-tested), the
 * wiring in `AgentChat.jsx` / `AgentList.jsx` / `ListFilterControl.jsx`, which
 * `node --test` cannot load.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const code = rel => fs.readFileSync(path.join(HERE, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const chat = code('../AgentChat.jsx');
const list = code('AgentList.jsx');
const control = code('ListFilterControl.jsx');

test('AC9 — the selection is read from and saved to the user record, not localStorage', () => {
  assert.match(chat, /useState\(\(\) => normalizeSelection\(user\?\.chatListFilter\)\)/);
  assert.match(chat, /apiCall\('PUT', '\/api\/me\/preferences', \{ chatListFilter: next \}\)/);
  assert.match(chat, /patchUser\(\{ chatListFilter: next \}\)/);
  assert.doesNotMatch(chat, /function saveFilter/);
  assert.doesNotMatch(chat, /FilterSelect/);
});

test('AC9 — the legacy localStorage filter is migrated once, only when nothing is saved yet', () => {
  assert.match(chat, /const legacy = loadLegacyFilter\(\);/);
  assert.match(chat, /clearLegacyFilter\(\);\s*if \(user\?\.chatListFilter\) return;\s*persistFilter\(migrateLegacyFilter\(legacy, filterEntries, railSingles\)\);/);
});

test('every control action goes through the pure reducer (pruned on write, AC8)', () => {
  assert.match(chat, /persistFilter\(applySelectionAction\(listFilterRef\.current, action, entriesRef\.current, membershipCtxRef\.current\)\)/);
  assert.match(chat, /<ListFilterControl[\s\S]*?entries=\{filterEntries\}[\s\S]*?onAction=\{handleFilterAction\}/);
  assert.match(chat, /quickFiltersDisabledReason=\{quickFiltersDisabledReason\(\{ membershipsLoaded, viewerId \}\)\}/);
});

test('AC3/AC11/AC12 — the list derives its reorder gates and empty hint from the selection', () => {
  assert.match(list, /reorderAllowed\(selectionEntryList, filter\)/);
  assert.match(list, /nothingSelected \? NO_SELECTION_HINT : 'No agents match this filter\.'/);
  // The disabled toggle still filters alongside the selection.
  assert.match(list, /filterModel\(orderedGroups, orderedSingles, filter, showDisabled\)/);
  assert.doesNotMatch(list, /filter\.kind/);
});

test('#2846 — every shown team gets the member gate; each keeps its ≥2-members guard', () => {
  assert.match(list, /const \{ groups: canReorder, members: canReorderMembers \} = useMemo\(/);
  assert.match(list, /memberReorder=\{canReorderMembers\}/);
  assert.match(list, /const memberDragEnabled = memberReorder && group\.children\.length > 1;/);
  assert.match(list, /dragEnabled=\{memberDragEnabled\}/);
  // Group grips stay on the stricter everything-shown gate.
  assert.match(list, /dragEnabled=\{canReorder && visibleGroups\.length > 1\}/);
});

test('AC13 — labelled checkboxes, Escape closes and returns focus', () => {
  assert.match(control, /type="checkbox"[\s\S]*?aria-label=\{entry\.subtitle \? `\$\{entry\.label\} \(\$\{entry\.subtitle\}\)` : entry\.label\}/);
  assert.match(control, /if \(e\.key === 'Escape'\) \{[\s\S]*?close\(\);/);
  assert.match(control, /buttonRef\.current\?\.focus\(\)/);
  assert.match(control, /aria-label="Search teams"/);
});

test('AC4/AC5 — Select all / Deselect all act on the listed keys; quick filters disable with a reason', () => {
  assert.match(control, /onAction\(\{ type: 'set', keys: listedKeys, shown: true \}\)/);
  assert.match(control, /onAction\(\{ type: 'set', keys: listedKeys, shown: false \}\)/);
  assert.match(control, /disabled=\{!!quickFiltersDisabledReason\}/);
  assert.match(control, /title=\{quickFiltersDisabledReason \|\| /);
});
