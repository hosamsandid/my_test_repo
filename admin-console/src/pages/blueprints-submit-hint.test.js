import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Drift guard for the Blueprints create/instance forms: the disabled primary
// submit buttons must explain WHY they are disabled via the shared
// missingFieldsHint helper (submit-hint.js). Blueprints.jsx carries its logic
// inline in JSX (no pure component to unit-test), so we assert against source.
const src = readFileSync(
  fileURLToPath(new URL('./Blueprints.jsx', import.meta.url)),
  'utf8',
);

test('Blueprints imports the shared missingFieldsHint helper', () => {
  assert.match(src, /import\s*\{\s*missingFieldsHint\s*\}\s*from\s*'\.\/submit-hint\.js'/);
});

test('PrimaryBtn forwards a title to its button element', () => {
  assert.match(src, /function PrimaryBtn\(\{[\s\S]*?\btitle\b[\s\S]*?\}\)\s*\{/);
  assert.match(src, /<button[\s\S]*?title=\{title\}/);
});

test('both submit buttons pass the computed hint as their title', () => {
  const matches = src.match(/disabled=\{!canSubmit\} title=\{submitHint \|\| undefined\}/g) || [];
  assert.equal(matches.length, 2, 'expected the hint wired on both Create buttons');
});

test('both forms compute submitHint from missingFieldsHint', () => {
  const computes = src.match(/const submitHint = missingFieldsHint\(/g) || [];
  assert.equal(computes.length, 2);
});
