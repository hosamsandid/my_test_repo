import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  UNTITLED_FLOW,
  BLANK_RENAME_HINT,
  canSubmitRename,
  nextUntitledName,
} from './draft-names.js';

test('canSubmitRename refuses an empty or whitespace-only name', () => {
  assert.equal(canSubmitRename(''), false);
  assert.equal(canSubmitRename('   '), false);
  assert.equal(canSubmitRename('\t\n'), false);
  assert.equal(canSubmitRename(undefined), false);
  assert.equal(canSubmitRename(null), false);
});

test('canSubmitRename accepts any non-blank name', () => {
  assert.equal(canSubmitRename('a'), true);
  assert.equal(canSubmitRename('  Release flow  '), true);
});

test('nextUntitledName returns the plain default when it is free', () => {
  assert.equal(nextUntitledName([]), UNTITLED_FLOW);
  assert.equal(nextUntitledName(null), UNTITLED_FLOW);
  assert.equal(nextUntitledName([{ name: 'Release flow' }]), UNTITLED_FLOW);
});

test('nextUntitledName numbers the second and later defaults', () => {
  assert.equal(nextUntitledName([{ name: 'Untitled flow' }]), 'Untitled flow 2');
  assert.equal(
    nextUntitledName([{ name: 'Untitled flow' }, { name: 'Untitled flow 2' }]),
    'Untitled flow 3',
  );
});

test('nextUntitledName reuses the lowest free number', () => {
  assert.equal(
    nextUntitledName([{ name: 'Untitled flow' }, { name: 'Untitled flow 3' }]),
    'Untitled flow 2',
  );
  // The plain name frees up again once that draft is renamed or deleted.
  assert.equal(nextUntitledName([{ name: 'Untitled flow 2' }]), UNTITLED_FLOW);
});

test('nextUntitledName compares names trimmed and case-insensitively', () => {
  assert.equal(nextUntitledName([{ name: '  untitled FLOW ' }]), 'Untitled flow 2');
  assert.equal(
    nextUntitledName([{ name: 'Untitled flow' }, { name: 'UNTITLED FLOW 2' }]),
    'Untitled flow 3',
  );
});

test('nextUntitledName ignores malformed entries', () => {
  assert.equal(nextUntitledName([null, {}, { name: 42 }, { name: '' }]), UNTITLED_FLOW);
});

// JSX source guards (#651 — the component itself has no DOM tests).
const briefings = readFileSync(
  fileURLToPath(new URL('../Briefings.jsx', import.meta.url)),
  'utf8',
);

test('Briefings creates New flow and Describe flow drafts with a unique default name', () => {
  assert.doesNotMatch(briefings, /apiCall\('POST', '\/api\/process\/drafts', \{ name: 'Untitled flow' \}\)/);
  const uses = briefings.match(/apiCall\('POST', '\/api\/process\/drafts', \{ name: nextUntitledName\(drafts\) \}\)/g) || [];
  assert.equal(uses.length, 2);
});

test('Briefings disables the rename confirm button and explains why while the name is blank', () => {
  assert.match(briefings, /confirmDisabled=\{!canSubmitRename\(renameValue\)\}/);
  assert.match(briefings, /if \(!d \|\| !canSubmitRename\(name\) \|\| renameBusy\) return;/);
  assert.match(briefings, /onKeyDown=\{e => \{ if \(e\.key === 'Enter' && canSubmitRename\(renameValue\)\) confirmRenameDraft\(\); \}\}/);
  assert.match(briefings, /\{!canSubmitRename\(renameValue\) && \(\s*<p[^>]*>\s*\{BLANK_RENAME_HINT\}\s*<\/p>\s*\)\}/);
});

const confirmDialog = readFileSync(
  fileURLToPath(new URL('../../components/ConfirmDialog.jsx', import.meta.url)),
  'utf8',
);

test('ConfirmDialog disables only its confirm button for confirmDisabled', () => {
  assert.match(confirmDialog, /confirmDisabled = false,/);
  assert.match(confirmDialog, /onClick=\{onConfirm\}\s*disabled=\{busy \|\| confirmDisabled\}/);
  assert.match(confirmDialog, /\.\.\.\(busy \|\| confirmDisabled \? disabledStyle : null\)/);
});
