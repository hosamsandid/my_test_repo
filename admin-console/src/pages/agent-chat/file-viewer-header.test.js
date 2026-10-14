import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  splitHeaderPath, headerNameStyle, headerDirStyle, headerFileStyle, headerFixedStyle,
} from './file-viewer-header.js';

const LONG = '0008-assign-flyway-migration-versions-at-merge-time-and-enforce-them-with-a-ci-gate.md';

test('splits a nested path into directory (with trailing slash) and file name', () => {
  assert.deepEqual(splitHeaderPath(`docs/adr/${LONG}`), { dir: 'docs/adr/', file: LONG });
});

test('a file at the workspace root has no directory part', () => {
  assert.deepEqual(splitHeaderPath('README.md'), { dir: '', file: 'README.md' });
});

test('the name area takes the leftover width and clips instead of painting over the buttons (AC1)', () => {
  assert.equal(headerNameStyle.flex, 1);
  assert.equal(headerNameStyle.minWidth, 0);
  assert.equal(headerNameStyle.overflow, 'hidden');
});

for (const [label, style] of [['directory', headerDirStyle], ['file name', headerFileStyle]]) {
  test(`the ${label} stays on one line and clips with an ellipsis (AC2)`, () => {
    assert.equal(style.whiteSpace, 'nowrap');
    assert.equal(style.overflow, 'hidden');
    assert.equal(style.textOverflow, 'ellipsis');
    assert.equal(style.minWidth, 0);
  });
}

test('the directory shrinks first; the file name only clips once it alone exceeds the width (AC3)', () => {
  assert.equal(headerDirStyle.flexShrink, 1);
  assert.equal(headerFileStyle.flexShrink, 0);
  assert.equal(headerFileStyle.maxWidth, '100%');
});

test('short names keep today\'s colours and weight (AC5)', () => {
  assert.equal(headerDirStyle.color, 'var(--eb-text-muted)');
  assert.equal(headerFileStyle.color, 'var(--eb-text-primary)');
  assert.equal(headerFileStyle.fontWeight, 'var(--eb-font-medium)');
  assert.equal(headerNameStyle.fontSize, 'var(--eb-text-xs)');
  assert.equal(headerNameStyle.fontFamily, 'var(--eb-font-mono)');
});

test('header siblings never shrink', () => {
  assert.equal(headerFixedStyle.flexShrink, 0);
});

// #651: the JSX is not rendered in tests — pin that the one header component
// (used by the rail viewer, the expanded modal and the chat @<path> preview)
// is wired to these styles and keeps the full-path tooltip (AC4, AC6).
test('FileViewerHeader is wired to the shared layout', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'WorkspaceBrowser.jsx'), 'utf8');
  const start = src.indexOf('function FileViewerHeader(');
  assert.ok(start >= 0, 'FileViewerHeader not found');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(body, /const \{ dir, file \} = splitHeaderPath\(relPath\);/);
  assert.match(body, /<div title=\{relPath\} style=\{headerNameStyle\}>/);
  assert.match(body, /<span style=\{headerDirStyle\}>\{dir\}<\/span>/);
  assert.match(body, /<span style=\{headerFileStyle\}>\{file\}<\/span>/);
  assert.equal((src.match(/<FileViewerHeader\b/g) || []).length, 2, 'rail viewer + modal both render FileViewerHeader');
});
