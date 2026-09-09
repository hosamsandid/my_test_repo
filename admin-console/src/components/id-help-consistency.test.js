import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guards that the single-sourced id-format rule (ID_FORMAT_HINT in
// id-field-view.js) is the one phrasing shown wherever a form explains the
// id/slug character set. Before this was unified the same rule was worded four
// different ways across the create/edit forms ("digits, hyphens" vs "digits and
// hyphens only" vs "digits, dashes" vs "…; must start alphanumeric") — the
// literal "explanations are inconsistent" usability complaint. Each id field
// now interpolates ID_FORMAT_HINT, so its helpText can no longer drift from the
// inline live-region notice (which already uses the same constant).

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = join(here, '..', 'pages');

// Every page that renders an <IdField> (or a bespoke id input with a format
// hint) must reference the shared constant rather than a hard-coded sentence.
const ID_HINT_PAGES = [
  'Blueprints.jsx',
  // The Access page dropped its only id field with the create-scope form in
  // #2081: `POST /api/admin/teams` is retired and a team is created through
  // `POST /api/teams`, whose id field lives in the Agent Team wizard.
  // The Agents page itself no longer renders an id field: its create form —
  // the only one it had — moved into the shared `agent-lifecycle/` module in
  // #1956, and the edit form has none (an id is immutable after creation).
  join('agent-lifecycle', 'AgentCreateForm.jsx'),
  'ModelRegistry.jsx',
  'SshKeys.jsx',
  'GithubTokens.jsx',
  'McpServers.jsx',
  'MyCredentials.jsx',
  'WorkingEnvironments.jsx',
  join('process', 'NodeInspector.jsx'),
];

test('every id-hint form references the shared ID_FORMAT_HINT constant', () => {
  for (const rel of ID_HINT_PAGES) {
    const src = readFileSync(join(pagesDir, rel), 'utf8');
    assert.ok(
      src.includes('ID_FORMAT_HINT'),
      `${rel} should render the shared ID_FORMAT_HINT, not a hard-coded id-format sentence`,
    );
  }
});

// Walk every .jsx under src/pages and assert the drift variants this unification
// removed — and which have no legitimate remaining use — never reappear.
function collectJsx(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsx(full));
    else if (entry.name.endsWith('.jsx')) out.push(full);
  }
  return out;
}

const FORBIDDEN = ['digits, dashes', 'must start alphanumeric'];

test('retired id-format phrasings do not reappear under src/pages', () => {
  for (const file of collectJsx(pagesDir)) {
    const src = readFileSync(file, 'utf8');
    for (const phrase of FORBIDDEN) {
      assert.ok(
        !src.includes(phrase),
        `${file} contains the retired id-format phrasing "${phrase}" — use ID_FORMAT_HINT`,
      );
    }
  }
});
