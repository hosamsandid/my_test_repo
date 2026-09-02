import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* Page-side guard for the E16 baseline-coverage work (#1891, epic #1870).

   Both pages this ticket covers are JSX with no unit-testable export, so — as
   `github-events-help-copy.test.js` established for E12 — the *copy* is the
   deliverable and the guard reads the source. The companion assertions live on
   the other side, in `admin-console/api/helper-chat/help-topics-content.test.js`
   (the concepts survived into the topic) and `help-coverage.test.js` (both routes
   resolve to their topic).

   Phrase-is-gone assertions run against the source with comments stripped: the
   comment this ticket added names what moved to the topic and would otherwise
   trip its own guard. */

function source(file) {
  return readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
}

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const about = source('./About.jsx');
const users = source('./Users.jsx');

// A page one-liner must stay a one-liner: short enough that the removed box
// cannot regrow inside it, and a single sentence.
function assertOneLiner(src, file) {
  const m = src.match(/^const PAGE_DESCRIPTION = '([^']+)';$/m);
  assert.ok(m, `${file}: the page description must be a named module-level constant`);
  const text = m[1];
  assert.ok(text.length <= 130, `${file}: page description is ${text.length} chars, expected a one-liner`);
  assert.equal(
    text.split('.').filter((s) => s.trim()).length, 1,
    `${file}: page description must be a single sentence`,
  );
  return text;
}

test('AC2: About carries a one-line description plus the shared PageHelpButton', () => {
  assert.match(about, /import PageHelpButton from '\.\.\/components\/PageHelpButton'/);
  assert.match(about, /<PageHelpButton\b/);
  assertOneLiner(about, 'About.jsx');
});

test('About stays the attribution page — no help prose grew onto it', () => {
  const prose = stripComments(about);
  // The version/contributor/attribution *facts* are explained in the topic; the
  // page shows the values and the licences it is legally required to show.
  for (const phrase of [
    'not a release number',
    'uncommitted changes',
    'commit count',
    'report a problem',
  ]) {
    assert.ok(!prose.includes(phrase), `"${phrase}" belongs to the about help topic, not the page`);
  }
  // The CC-BY-4.0 attribution is a licence obligation and must never move.
  assert.match(about, /NVIDIA Parakeet TDT 0\.6B v3/);
  assert.match(about, /CC-BY-4\.0/);
  assert.match(about, /No retraining or fine-tuning performed\./);
});

test('AC3: the Users intro box is gone, replaced by a one-liner plus the "?"', () => {
  assert.match(users, /import PageHelpButton from '\.\.\/components\/PageHelpButton'/);
  assert.match(users, /<PageHelpButton\b/);
  const text = assertOneLiner(users, 'Users.jsx');
  // The one thing that must survive on the page: a record alone grants nothing.
  assert.match(text, /Access page/);

  const prose = stripComments(users);
  for (const phrase of [
    'end-to-end',
    'set or clear a login password, and delete',
    'Team membership &amp; access scopes',
  ]) {
    assert.ok(!prose.includes(phrase), `"${phrase}" belongs to the users help topic now, not the page`);
  }
  // The bordered box itself is gone (the surviving line is a plain <p>).
  assert.doesNotMatch(prose, /background: 'var\(--eb-bg-surface\)'[\s\S]{0,200}lineHeight: 1\.6/);
});

test('the point-of-decision help on the Users page survives', () => {
  // E16 removes the intro box, not the live in-context hints: the self-lockout
  // warning, the delete dialog's consequence line and the teaching empty state
  // all stay where the decision is made.
  assert.match(users, /selfActionWarning\(/);
  assert.match(users, /personal credentials will be removed too/);
  assert.match(users, /No users yet\./);
  assert.match(users, /The orchestrator must be reachable for user management\./);
});
