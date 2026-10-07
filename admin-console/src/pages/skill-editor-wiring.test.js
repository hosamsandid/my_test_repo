// #2837 — source-reading guards that the JSX actually uses the pure skill
// editor model and the atomic batch save (JSX itself stays uncovered, #651).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODAL = fs.readFileSync(path.join(here, 'SkillEditorModal.jsx'), 'utf8');
const REGISTRY = fs.readFileSync(path.join(here, 'SkillsRegistry.jsx'), 'utf8');

function viewerSrc() {
  const start = REGISTRY.indexOf('function SkillViewer(');
  const end = REGISTRY.indexOf('\nfunction ', start + 1);
  assert.ok(start > 0 && end > start, 'SkillViewer not found — re-point this guard');
  return REGISTRY.slice(start, end);
}

test('editor builds tree, pending changes and save payload from the pure model', () => {
  for (const fn of ['createModel(', 'buildFileTree(', 'visibleRows(', 'listChanges(', 'changeMarks(', 'compileChanges(', 'splitFrontmatter(']) {
    assert.ok(MODAL.includes(fn), `SkillEditorModal must call ${fn}`);
  }
  for (const op of ['editFile(', 'createFile(', 'createFolder(', 'renamePath(', 'deletePath(', 'uploadFile(', 'uploadConflicts(']) {
    assert.ok(MODAL.includes(op), `SkillEditorModal must route ${op} through the model`);
  }
});

test('one Save posts every change to the batch endpoint against the loaded hash (AC11, AC16)', () => {
  assert.match(MODAL, /\/files\/batch\?/);
  assert.match(MODAL, /method: 'POST'/);
  assert.match(MODAL, /baseHash, \.\.\.compileChanges\(model\)/);
  assert.match(MODAL, /saveError\?\.conflict[\s\S]*?Reload/);
  assert.doesNotMatch(MODAL, /method: 'PUT'/, 'no per-file PUT from the editor');
});

test('guards: Ctrl/Cmd+S, unsaved-changes confirm on close / back / unload (AC14, AC15)', () => {
  assert.match(MODAL, /\(e\.ctrlKey \|\| e\.metaKey\)/);
  assert.match(MODAL, /'beforeunload'/);
  assert.match(MODAL, /'popstate'/);
  assert.match(MODAL, /kind: 'confirm-close'/);
  assert.match(MODAL, /kind: 'confirm-discard'/);
  assert.doesNotMatch(MODAL, /window\.confirm\(/);
});

test('accessible modal: dialog role, tree roles, focus restore (AC26)', () => {
  assert.match(MODAL, /role="dialog"/);
  assert.match(MODAL, /aria-modal="true"/);
  assert.match(MODAL, /role="tree"/);
  assert.match(MODAL, /role="treeitem"/);
  assert.match(MODAL, /case 'F2'/);
  assert.match(MODAL, /opener\.focus\(\)/);
});

test('the editor overlay stacks below the row context menu (1200) and ConfirmDialog', () => {
  const m = /zIndex: (\d+), display: 'flex', alignItems: 'center'/.exec(MODAL);
  assert.ok(m, 'overlay zIndex not found');
  assert.ok(Number(m[1]) < 1200, `overlay zIndex ${m[1]} would hide RowContextMenu`);
  // The numbers only compare at the document root: the editor is portaled out
  // of the SidePanel (z 61), so its New file / New folder / Rename
  // ConfirmDialog must be portaled too, or it paints behind the editor.
  const CONFIRM = fs.readFileSync(path.join(here, '..', 'components', 'ConfirmDialog.jsx'), 'utf8');
  assert.match(CONFIRM, /createPortal\(overlay, document\.body\)/, 'ConfirmDialog must portal to <body>');
  const c = /zIndex: (\d+)/.exec(CONFIRM);
  assert.ok(c && Number(c[1]) > Number(m[1]), 'ConfirmDialog must stack above the editor overlay');
});

test('side panel: Edit skill / Open buttons replace the inline "Edit file" mode (AC1, AC25)', () => {
  const src = viewerSrc();
  assert.match(src, /skillEditPermission\(skill, caller\)/);
  assert.match(src, />\s*Edit skill\s*</);
  assert.match(src, />\s*Open\s*</);
  assert.match(src, /<SkillEditorModal[\s\S]*?readOnly=\{!editPerm\.editable\}/);
  assert.doesNotMatch(src, /handleSaveFile|setEditing|editContent/, 'inline edit mode must be gone');
  assert.doesNotMatch(src, /<textarea/);
  assert.match(src, /<MarkdownWithFrontmatter /, 'side panel preview shows frontmatter as a block (AC6)');
  assert.match(REGISTRY, /<SkillViewer[\s\S]*?caller=\{caller\}/);
});

test('opening a different file from the tree resets the view to preview (AC5)', () => {
  assert.match(MODAL, /const openPath = \(p\) => \{ if \(p !== selected\) setMode\('preview'\); selectPath\(p\); \};/);
  assert.match(MODAL, /onSelect=\{r => openPath\(r\.path\)\}/, 'row click must go through openPath');
  assert.match(MODAL, /case ' ':\s*e\.preventDefault\(\);\s*openPath\(row\.path\);/, 'Enter/Space must go through openPath');
  // New file deliberately opens in edit mode.
  assert.match(MODAL, /selectPath\(r\.path\); if \(!readOnly\) setMode\('edit'\);/);
});

test('upload commit keeps the setModel call free of side effects', () => {
  const start = MODAL.indexOf('function commitUploads(');
  const body = MODAL.slice(start, MODAL.indexOf('\n  }\n', start));
  assert.doesNotMatch(body, /setModel\(m =>/, 'compute the new state first, then set model and notice');
});
