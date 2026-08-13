import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Drift guard (no pure module — the delete flow is inline component state, per the
// Briefings.jsx "logic lives inline, no unit tests" convention). Locks in the
// usability consistency fix: the draft-delete action must use the shared styled
// ConfirmDialog like every other delete in the console, NOT the native
// window.confirm (jarring, unstyled, inconsistent).
const src = readFileSync(
  fileURLToPath(new URL('./Briefings.jsx', import.meta.url)),
  'utf8',
);

test('Briefings adopts the shared ConfirmDialog for draft deletion', () => {
  assert.match(src, /import ConfirmDialog from '\.\.\/components\/ConfirmDialog'/);
  assert.match(src, /<ConfirmDialog\b/);
});

test('Briefings does not fall back to a native window.confirm', () => {
  assert.doesNotMatch(src, /window\.confirm/);
});
