import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Drift guard for the empty-state-consistency usability fix.
//
// Every CRUD list page tells a first-time user how to add the first row —
// e.g. GitHub Tokens: "No GitHub tokens stored yet. Click 'New Token' to add one."
// McpServers (both tables) and ModelRegistry used to dead-end with a bare
// "No X yet." that named no next action. This asserts those empty states now
// carry a call-to-action referencing the page's own create button, so a future
// edit can't silently regress them back to a dead end.

function emptyTextsOf(jsxFile) {
  const src = readFileSync(fileURLToPath(new URL(jsxFile, import.meta.url)), 'utf8');
  // emptyText="…" — double-quoted string literal props only (the CRUD pages
  // pass a literal; a dynamic emptyText={expr} is out of scope here).
  return [...src.matchAll(/emptyText="([^"]*)"/g)].map(m => m[1]);
}

// The create-button label each page's empty state must point the user at.
const CASES = [
  { file: './McpServers.jsx', label: 'New server' },
  { file: './McpServers.jsx', label: 'New credential' },
  { file: './ModelRegistry.jsx', label: 'New provider' },
];

for (const { file, label } of CASES) {
  test(`${file} empty state guides the user to '${label}'`, () => {
    const texts = emptyTextsOf(file);
    const match = texts.find(t => t.includes(label));
    assert.ok(
      match,
      `expected an emptyText in ${file} mentioning the '${label}' button; got: ${JSON.stringify(texts)}`,
    );
    // A guiding empty state both states the empty condition and offers the next
    // step; the sibling CRUD pages use the shared "… to add one." tail.
    assert.match(match, /^No /, `empty state should open with "No …": ${JSON.stringify(match)}`);
    assert.match(match, /to add one\.$/, `empty state should end with the "to add one." CTA: ${JSON.stringify(match)}`);
  });
}
