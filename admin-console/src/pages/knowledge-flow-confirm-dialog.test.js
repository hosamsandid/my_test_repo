import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Drift guard for the Knowledge/Flows page confirmation dialogs.
//
// KnowledgeFlow.jsx used to fire native browser prompts for the four
// retire / un-retire / delete-cascade confirmations while every other
// delete-style flow on the page used the shared, styled ConfirmDialog.
// These asserts keep the page consistent: no native prompt may creep
// back in, and each confirmation must be routed through ConfirmDialog.
//
// Mirrors the #651 source-reading guard used where there is no pure
// helper module to unit-test (the confirmations are inline JSX state).

const src = readFileSync(
  fileURLToPath(new URL('./KnowledgeFlow.jsx', import.meta.url)),
  'utf8',
);

test('KnowledgeFlow uses no native window.confirm/alert/prompt', () => {
  assert.doesNotMatch(src, /window\.(confirm|alert|prompt)\s*\(/);
});

test('KnowledgeFlow imports the shared ConfirmDialog', () => {
  assert.match(src, /import ConfirmDialog from '\.\.\/components\/ConfirmDialog'/);
});

test('KnowledgeFlow renders a ConfirmDialog for each of the four confirmations', () => {
  // single-item retire (top-level), bulk retire/un-retire (OverviewTable),
  // delete-cascade (SkillCard) — one <ConfirmDialog per confirmation surface.
  const dialogs = src.match(/<ConfirmDialog\b/g) || [];
  assert.ok(
    dialogs.length >= 3,
    `expected at least 3 ConfirmDialog usages (retire, bulk, cascade), found ${dialogs.length}`,
  );
});
