import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Drift guard for the E10 extraction (#1884, epic #1870). No pure module — the
// copy being removed was inline JSX — so this locks in the two properties the
// ticket actually buys:
//
//   1. The "why both an SSH key and a GitHub token" rationale, which used to be
//      restated in five places, is gone from the pages and lives once in
//      api/helper-chat/help-topics/credentials.md (guarded there by
//      help-topics-content.test.js). Each page keeps title + one-line
//      description + the shared PageHelpButton.
//   2. The SetupWizard's two credential steps read ONE shared summary
//      (TwoCredentialsNote), so the wizard cannot drift back into two
//      differently-worded boxes.
//
// The one-time-secret warnings and the SAML-SSO steps deliberately stay inline
// in the create/rotate dialogs — they are point-of-decision instructions, not
// concept prose — so this guard asserts they survive.

const read = (name) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');

const PAGES = ['SshKeys.jsx', 'GithubTokens.jsx', 'MyCredentials.jsx'];

for (const page of PAGES) {
  const src = read(page);

  test(`${page} offers the shared PageHelpButton`, () => {
    assert.match(src, /import PageHelpButton from '\.\.\/components\/PageHelpButton'/);
    assert.match(src, /<PageHelpButton\s/);
  });

  test(`${page} no longer restates the "why both" rationale`, () => {
    // The removed sub-note opened with a bolded "Why both …?" heading. The
    // phrase surviving as a PageHelpButton tooltip label is the point — it
    // points at the topic instead of repeating it.
    assert.doesNotMatch(src, /<strong>Why both/);
    assert.doesNotMatch(src, /[Dd]efense-in-depth/);
    assert.doesNotMatch(src, /blast radius/i);
  });
}

test('the create dialogs keep their SAML-SSO instructions at the point of decision', () => {
  for (const page of PAGES) {
    assert.match(read(page), /Configure SSO/, `${page} must keep the SSO authorisation step`);
  }
});

test('the SetupWizard credential steps share one rationale note', () => {
  const src = read('SetupWizard.jsx');
  // Exactly one definition …
  assert.equal((src.match(/function TwoCredentialsNote\(\)/g) || []).length, 1);
  // … rendered by both steps (SSH key + GitHub token).
  assert.equal((src.match(/<TwoCredentialsNote \/>/g) || []).length, 2);
  // … and no hand-written second wording left behind.
  assert.doesNotMatch(src, /Companion to the SSH key/);
  assert.doesNotMatch(src, /defense-in-depth/);
});
