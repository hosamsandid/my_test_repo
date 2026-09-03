import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CREDENTIALS_HELP_SECTIONS } from './credentials-help-sections.js';
import { topicSections, sectionSlug } from '../context/page-help-view.js';

// ─── #1993 (epic #1981) Credentials per-surface help guard ───────────────────
//
// The Credentials topic is the epic's first MULTI-ROUTE one: /ssh-keys,
// /github-tokens and /my-credentials all resolve to the same file, and each page
// now deep-links its "?" to the chapter written for it. Two things can rot
// silently and neither throws at runtime:
//
//   • a chapter heading reworded out from under the slug a page names — the
//     panel then just renders the topic from the top, which still *looks* like
//     the "?" worked (and on a shared topic it looks especially plausible), and
//   • a page losing its affordance, or gaining a hand-written slug instead of
//     the shared constant.
//
// Both are asserted from the real sources here. The JSX is otherwise uncovered
// per the #651 convention — this is a source-text guard, not a render test.
//
// Complements credentials-help-copy.test.js (#1884), which guards the E10
// extraction itself (the "why both" prose stayed removed, the wizard keeps one
// shared note). This file guards the chapter wiring #1993 added on top.

const here = dirname(fileURLToPath(import.meta.url));

// Comments are stripped before asserting on the source: this ticket's own
// comments name the very chapters and constants being checked, and would
// otherwise satisfy the matchers they merely explain.
function sourceOf(file) {
  return readFileSync(join(here, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

// page file → the chapter its "?" must land on (the ticket's surface table)
const PAGES = [
  ['SshKeys.jsx', 'sshKeys', 'the SSH Keys page header'],
  ['GithubTokens.jsx', 'githubTokens', 'the GitHub Tokens page header'],
  ['MyCredentials.jsx', 'myCredentials', 'the My Credentials page header'],
];

const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/credentials.md'), 'utf8',
);

test('every chapter slug a page names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(CREDENTIALS_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/credentials.md no longer has a heading for these chapters. Reword '
    + 'the heading back, or update CREDENTIALS_HELP_SECTIONS — a stale slug degrades '
    + `silently to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed its rule, the
  // constants would still "exist" as strings while matching nothing at runtime.
  assert.equal(
    sectionSlug('Why both an SSH key and a GitHub token'),
    CREDENTIALS_HELP_SECTIONS.whyBoth,
  );
  assert.equal(sectionSlug('My Credentials'), CREDENTIALS_HELP_SECTIONS.myCredentials);
  assert.equal(
    sectionSlug('Rotation and runtime resolution'),
    CREDENTIALS_HELP_SECTIONS.rotation,
  );
});

test('the six areas the ticket names are top-level chapters, not sub-headings', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const key of ['whyBoth', 'sshKeys', 'githubTokens', 'myCredentials', 'tiers', 'rotation']) {
    assert.ok(
      h2.includes(CREDENTIALS_HELP_SECTIONS[key]),
      `"${CREDENTIALS_HELP_SECTIONS[key]}" must stay a "## " chapter — the panel scrolls `
      + 'to h2/h3, but the ticket asks for one clearly-headed chapter per area',
    );
  }
  assert.equal(h2.length, 6, `expected exactly the six chapters, got ${h2.join(' · ')}`);
});

test('the three cross-page chapters keep their own heading, not a shared one', () => {
  // Chapters 1/5/6 carry no "?" (open question 1 — a page-header "?" per page is
  // the whole affordance set), so nothing else would notice if they were folded
  // into a neighbour. They are the shared story every page scrolls into, which
  // is why they must stay separately addressable.
  const slugs = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const key of ['whyBoth', 'tiers', 'rotation']) {
    assert.ok(slugs.includes(CREDENTIALS_HELP_SECTIONS[key]), `${key} chapter is gone`);
  }
});

for (const [file, key, what] of PAGES) {
  const page = sourceOf(file);

  test(`${what} mounts a "?" pointed at its own chapter`, () => {
    assert.ok(
      /import PageHelpButton from '\.\.\/components\/PageHelpButton'/.test(page),
      `${file} must import the shared PageHelpButton`,
    );
    assert.ok(
      /import \{ CREDENTIALS_HELP_SECTIONS \} from '\.\/credentials-help-sections\.js'/.test(page),
      'the slugs must come from the shared registry, never be written out inline',
    );
    assert.ok(
      page.includes(`CREDENTIALS_HELP_SECTIONS.${key}`),
      `${what} must deep-link to the ${key} chapter (never a hand-written slug)`,
    );
    // One page, one header affordance — a dropped button is invisible to the
    // includes() check above, and a second one would mean two competing entry
    // points into the same shared topic.
    const buttons = (page.match(/<PageHelpButton/g) || []).length;
    assert.equal(buttons, 1, `expected exactly one PageHelpButton in ${file}, found ${buttons}`);
  });

  test(`${file} inlines no chapter slug as a literal`, () => {
    for (const [name, slug] of Object.entries(CREDENTIALS_HELP_SECTIONS)) {
      assert.ok(
        !page.includes(`'${slug}'`) && !page.includes(`"${slug}"`),
        `${name}'s slug is inlined in ${file} — import it from `
        + 'credentials-help-sections.js so the drift guard above can see it',
      );
    }
  });
}

test('the one-time-secret warnings still sit in the dialogs that need them', () => {
  // Scope — out: this ticket expands the topic and adds "?" links. A warning
  // about a value you can never read again belongs at the moment you create it,
  // not in a help panel the reader may not have open.
  const kept = [
    ['SshKeys.jsx', 'never returned by the API — only its fingerprint is displayed afterwards'],
    ['SshKeys.jsx', 'will never be shown again'],
    ['GithubTokens.jsx', 'Copy the token value immediately — GitHub will not show it again'],
    ['GithubTokens.jsx', 'never be shown again — only a preview and fingerprint remain'],
    ['MyCredentials.jsx', 'never shown again'],
  ];
  for (const [file, phrase] of kept) {
    assert.ok(
      sourceOf(file).includes(phrase),
      `"${phrase}" is point-of-decision copy and must stay in ${file}`,
    );
  }
});

test('the classic and fine-grained scope checklists stay on the GitHub Tokens page', () => {
  // The topic now lists these scopes too, but the checklist is a step you follow
  // *inside GitHub* with the create dialog open — summarising it in the panel
  // does not replace having it next to the field.
  const page = sourceOf('GithubTokens.jsx');
  for (const marker of [
    'Tokens (classic) — tick these scopes:',
    'scope="repo"',
    'scope="workflow"',
    'scope="read:org"',
    'Fine-grained token — Repository permissions',
    'scope="Contents"',
    'scope="Metadata"',
    'scope="Pull requests"',
    'scope="Workflows"',
  ]) {
    assert.ok(page.includes(marker), `the scope checklist lost "${marker}"`);
  }
});

test('the rotation warning stays on the panel whose button causes the restart', () => {
  // My Credentials is the only surface with a rotate-in-place action, and the
  // restart it triggers cuts off in-flight work — the consequence has to be next
  // to the button, per the E8/E11 rule the epic inherits.
  const page = sourceOf('MyCredentials.jsx');
  assert.ok(page.includes('interrupts any in-flight work'), 'the rotate restart warning is gone');
  assert.ok(page.includes('rotate at a quiet moment'), 'the rotate-when-quiet advice is gone');
});

test('the single-admin explanation stays on My Credentials, and its "?" still works there', () => {
  // The ticket's edge case: the env single-admin cannot own personal credentials
  // and sees a note instead of the tables. The note must stay, and the "?" must
  // NOT be inside the canOwn branch — that reader is exactly the one who needs
  // the chapter explaining why. Anchored on the ordering: the button appears in
  // the source before the `!canOwn ?` branch opens.
  const page = sourceOf('MyCredentials.jsx');
  assert.ok(
    page.includes('Personal credentials need a per-user account'),
    'the single-admin explanatory note is gone',
  );
  const buttonAt = page.indexOf('<PageHelpButton');
  const branchAt = page.indexOf('!canOwn ?');
  assert.ok(buttonAt > -1 && branchAt > -1, 'expected both the "?" and the canOwn branch');
  assert.ok(
    buttonAt < branchAt,
    'the "?" moved inside the canOwn branch — the single-admin, who cannot own '
    + 'personal credentials, would lose the chapter that explains why',
  );
});
