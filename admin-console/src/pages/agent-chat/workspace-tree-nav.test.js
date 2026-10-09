import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { visibleTreeRows, effectiveCursor, navigateTree, TREE_NAV_KEYS } from './workspace-tree-nav.js';

// A workspace like the issue's example (#2950):
//   memory/              (collapsed, loaded)
//   reports/             (expanded)
//     shots/             (expanded)
//       01-providers-list.png
//       02-env-provider.png
//     empty/             (expanded, no entries)
//     broken/            (expanded, listing failed)
//     pending/           (expanded, still loading)
//   README.md
const dir = (name) => ({ name, type: 'dir' });
const file = (name) => ({ name, type: 'file', size: 1 });

function fixture() {
  const dirCache = new Map([
    ['', { items: [dir('memory'), dir('reports'), file('README.md')], loading: false, error: null }],
    ['memory', { items: [file('log.md')], loading: false, error: null }],
    ['reports', { items: [dir('shots'), dir('empty'), dir('broken'), dir('pending')], loading: false, error: null }],
    ['reports/shots', { items: [file('01-providers-list.png'), file('02-env-provider.png')], loading: false, error: null }],
    ['reports/empty', { items: [], loading: false, error: null }],
    ['reports/broken', { items: [], loading: false, error: 'HTTP 500' }],
    ['reports/pending', { loading: true, error: null }],
  ]);
  const expanded = new Set(['', 'reports', 'reports/shots', 'reports/empty', 'reports/broken', 'reports/pending']);
  return { dirCache, expanded };
}

const keys = (rows) => rows.map(r => r.key);

test('visible rows follow render order and skip collapsed / unloaded contents', () => {
  const { dirCache, expanded } = fixture();
  const rows = visibleTreeRows(dirCache, expanded, null);
  assert.deepEqual(keys(rows), [
    'memory',
    'reports',
    'reports/shots',
    'reports/shots/01-providers-list.png',
    'reports/shots/02-env-provider.png',
    'reports/empty',
    'reports/broken',
    'reports/pending',
    'README.md',
  ]);
  const shot = rows.find(r => r.key === 'reports/shots/01-providers-list.png');
  assert.deepEqual(shot, { key: 'reports/shots/01-providers-list.png', type: 'file', parent: 'reports/shots', depth: 2 });
  assert.equal(rows[0].parent, '');
});

test('visible rows: nothing before the root listing has loaded', () => {
  assert.deepEqual(visibleTreeRows(new Map(), new Set(['']), null), []);
  assert.deepEqual(visibleTreeRows(new Map([['', { loading: true }]]), new Set(['']), null), []);
});

test('visible rows include the virtual context root and its expanded children', () => {
  const dirCache = new Map([
    ['', { items: [file('a.md')], loading: false, error: null }],
    ['/context', { items: [file('notes.md')], loading: false, error: null }],
  ]);
  const rows = visibleTreeRows(dirCache, new Set(['', '/context']), { enabled: true, hostPath: '/h' });
  assert.deepEqual(keys(rows), ['/context', '/context/notes.md', 'a.md']);
  assert.equal(rows[1].parent, '/context');
});

test('AC1: ↓/↑ step through visible rows without wrapping', () => {
  const { dirCache, expanded } = fixture();
  const rows = visibleTreeRows(dirCache, expanded, null);
  assert.deepEqual(navigateTree(rows, 'reports/shots/01-providers-list.png', 'ArrowDown', expanded),
    { cursor: 'reports/shots/02-env-provider.png', toggle: null });
  assert.deepEqual(navigateTree(rows, 'reports/shots/02-env-provider.png', 'ArrowUp', expanded),
    { cursor: 'reports/shots/01-providers-list.png', toggle: null });
  assert.deepEqual(navigateTree(rows, 'reports/shots/02-env-provider.png', 'ArrowDown', expanded),
    { cursor: 'reports/empty', toggle: null });
  assert.equal(navigateTree(rows, 'memory', 'ArrowUp', expanded), null, 'first row: no wrap');
  assert.equal(navigateTree(rows, 'README.md', 'ArrowDown', expanded), null, 'last row: no wrap');
});

test('without a cursor, ↓/↑ enter the tree at the first row; ←/→ do nothing', () => {
  const { dirCache, expanded } = fixture();
  const rows = visibleTreeRows(dirCache, expanded, null);
  assert.deepEqual(navigateTree(rows, null, 'ArrowDown', expanded), { cursor: 'memory', toggle: null });
  assert.deepEqual(navigateTree(rows, null, 'ArrowUp', expanded), { cursor: 'memory', toggle: null });
  assert.equal(navigateTree(rows, null, 'ArrowRight', expanded), null);
  assert.equal(navigateTree(rows, null, 'ArrowLeft', expanded), null);
  assert.equal(navigateTree([], null, 'ArrowDown', expanded), null);
});

test('AC4: → expands a collapsed dir, enters an expanded one, else no-op', () => {
  const { dirCache, expanded } = fixture();
  const rows = visibleTreeRows(dirCache, expanded, null);
  assert.deepEqual(navigateTree(rows, 'memory', 'ArrowRight', expanded), { cursor: 'memory', toggle: 'memory' });
  assert.deepEqual(navigateTree(rows, 'reports', 'ArrowRight', expanded), { cursor: 'reports/shots', toggle: null });
  assert.equal(navigateTree(rows, 'reports/empty', 'ArrowRight', expanded), null, 'empty dir');
  assert.equal(navigateTree(rows, 'reports/broken', 'ArrowRight', expanded), null, 'listing error: stay');
  assert.equal(navigateTree(rows, 'reports/pending', 'ArrowRight', expanded), null, 'still loading: stay');
  assert.equal(navigateTree(rows, 'README.md', 'ArrowRight', expanded), null, 'file');
});

test('AC4 edge: a second → after the listing loads moves to the first child', () => {
  const { dirCache, expanded } = fixture();
  dirCache.set('reports/pending', { items: [file('x.txt')], loading: false, error: null });
  const rows = visibleTreeRows(dirCache, expanded, null);
  assert.deepEqual(navigateTree(rows, 'reports/pending', 'ArrowRight', expanded),
    { cursor: 'reports/pending/x.txt', toggle: null });
});

test('AC5: ← collapses an expanded dir, else goes to the parent; top level is a no-op', () => {
  const { dirCache, expanded } = fixture();
  const rows = visibleTreeRows(dirCache, expanded, null);
  assert.deepEqual(navigateTree(rows, 'reports/shots', 'ArrowLeft', expanded), { cursor: 'reports/shots', toggle: 'reports/shots' });
  assert.deepEqual(navigateTree(rows, 'reports/shots/02-env-provider.png', 'ArrowLeft', expanded), { cursor: 'reports/shots', toggle: null });
  const collapsed = new Set(expanded); collapsed.delete('reports/shots');
  const rows2 = visibleTreeRows(dirCache, collapsed, null);
  assert.deepEqual(navigateTree(rows2, 'reports/shots', 'ArrowLeft', collapsed), { cursor: 'reports', toggle: null });
  assert.equal(navigateTree(rows, 'memory', 'ArrowLeft', expanded), null, 'collapsed top-level dir');
  assert.equal(navigateTree(rows, 'README.md', 'ArrowLeft', expanded), null, 'top-level file');
  assert.deepEqual(navigateTree(rows, 'reports', 'ArrowLeft', expanded), { cursor: 'reports', toggle: 'reports' }, 'expanded top-level dir collapses');
});

test('non-arrow keys are never handled', () => {
  const { dirCache, expanded } = fixture();
  const rows = visibleTreeRows(dirCache, expanded, null);
  for (const k of ['Enter', ' ', 'Home', 'End', 'a']) assert.equal(navigateTree(rows, 'memory', k, expanded), null);
  assert.deepEqual([...TREE_NAV_KEYS].sort(), ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']);
});

test('AC10: a vanished cursor row falls back to its nearest visible ancestor', () => {
  const { dirCache, expanded } = fixture();
  const rows = visibleTreeRows(dirCache, expanded, null);
  assert.equal(effectiveCursor(rows, 'reports/shots/02-env-provider.png'), 'reports/shots/02-env-provider.png');
  assert.equal(effectiveCursor(rows, 'reports/shots/03-deleted.png'), 'reports/shots', 'deleted file');
  const collapsed = new Set(expanded); collapsed.delete('reports');
  assert.equal(effectiveCursor(visibleTreeRows(dirCache, collapsed, null), 'reports/shots/01-providers-list.png'), 'reports', 'collapsed with the mouse');
  assert.equal(effectiveCursor(rows, 'gone/deep/file.txt'), null, 'no visible ancestor');
  assert.equal(effectiveCursor([], 'memory'), null, 'tree reloading');
  assert.equal(effectiveCursor(rows, null), null);
  const ctxRows = [{ key: '/context', type: 'dir', parent: '', depth: 0 }];
  assert.equal(effectiveCursor(ctxRows, '/context/a/b.md'), '/context');
});

// ── Wiring guard (#651): JSX is not unit-tested, so pin that the component
//    actually uses the pure helper and scopes the keys to the tree. ─────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'WorkspaceBrowser.jsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('WorkspaceBrowser wires the tree to workspace-tree-nav', () => {
  assert.match(SRC, /import \{[^}]*navigateTree[^}]*\} from '\.\/workspace-tree-nav\.js'/);
  assert.match(SRC, /visibleTreeRows\(dirCache, expanded, contextStatus\)/);
  assert.match(SRC, /effectiveCursor\(treeRows, cursor\)/);
  assert.match(SRC, /navigateTree\(treeRows, cursorKey, e\.key, expanded\)/);
});

test('arrow keys are handled on the tree container only, and suppress scrolling', () => {
  const handlers = SRC.match(/onKeyDown=\{/g) || [];
  assert.equal(handlers.length, 1, 'exactly one keydown handler in WorkspaceBrowser');
  assert.match(SRC, /ref=\{treeRef\}\s*tabIndex=\{0\}[\s\S]{0,200}onKeyDown=\{onTreeKeyDown\}/);
  assert.match(SRC, /e\.preventDefault\(\);/);
  assert.doesNotMatch(SRC, /document\.addEventListener\('keydown', onTreeKeyDown/);
});

test('a click moves the cursor, a file landing opens the viewer, rows are scrollable targets', () => {
  assert.match(SRC, /const handleSelectFile = useCallback\(\(p\) => \{\s*setCursor\(p\);\s*setSelectedFile\(\{ path: p \}\);/);
  assert.match(SRC, /const handleToggleDir = useCallback\(\(p\) => \{\s*setCursor\(p\);\s*toggleDir\(p\);/);
  assert.match(SRC, /onSelectFile=\{handleSelectFile\}/);
  assert.match(SRC, /onToggleDir=\{handleToggleDir\}/);
  assert.match(SRC, /row\.type === 'file'\) setSelectedFile\(\{ path: row\.key \}\)/);
  assert.equal((SRC.match(/data-tree-key=\{relPath\}/g) || []).length, 2, 'dir and file rows both carry data-tree-key');
  assert.match(SRC, /scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.match(SRC, /setCursor\(null\);/, 'agent switch resets the cursor');
});
