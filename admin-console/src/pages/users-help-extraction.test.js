import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { USERS_HELP_SECTIONS } from './users-help-sections.js';
import { topicSections, sectionSlug, CONTEXT_KEYS } from '../context/page-help-view.js';

// ─── #1996 (epic #1981) Users per-surface help guard ─────────────────────────
//
// The Users topic is now a fuller reference and the page's three help-bearing
// surfaces each deep-link into it. Three things can rot silently:
//
//   • a chapter heading reworded out from under a slug a call site names,
//   • an overlay subject dropped, which puts the help panel BEHIND the side
//     panel or (worse) behind the delete confirmation, and
//   • the delete dialog's message quietly going back to an inline JSX prop,
//     which cannot host the hook the subject needs.
//
// The JSX is otherwise uncovered per the #651 convention — this is a source-text
// guard, not a render test.

const here = dirname(fileURLToPath(import.meta.url));

// Comments are stripped before asserting on the source: this ticket's own
// comments name the very chapters and constants being checked.
function sourceOf(file) {
  return readFileSync(join(here, file), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const page = sourceOf('Users.jsx');
const raw = readFileSync(join(here, 'Users.jsx'), 'utf8');
const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/users.md'), 'utf8',
);

test('every chapter slug a call site names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(USERS_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/users.md no longer has a heading for these surfaces. Reword the '
    + 'heading back, or update USERS_HELP_SECTIONS — a stale slug degrades silently '
    + `to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  assert.equal(sectionSlug('What this page manages'), USERS_HELP_SECTIONS.page);
  assert.equal(sectionSlug('Creating and editing a user'), USERS_HELP_SECTIONS.edit);
  assert.equal(
    sectionSlug('Deleting a user is an offboarding'), USERS_HELP_SECTIONS.offboarding,
  );
});

test('the three deep-linked chapters are top-level and distinct', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const [name, slug] of Object.entries(USERS_HELP_SECTIONS)) {
    assert.ok(
      h2.includes(slug),
      `"${slug}" (${name}) must stay a "## " chapter — the panel scrolls to h2/h3, `
      + 'but a surface deep-link should land on a clearly-headed chapter',
    );
  }
  // The edit panel and the delete confirmation must NOT share a chapter: the
  // ticket's "Edit/offboarding dialog ?" is two surfaces asking two questions,
  // and one of them is asked over a destructive button.
  const slugs = Object.values(USERS_HELP_SECTIONS);
  assert.equal(
    new Set(slugs).size, slugs.length,
    'the edit panel and the delete confirmation need DIFFERENT chapters',
  );
});

test('the topic keeps the chapters AC1 names that carry no "?" of their own', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const slug of [
    'the-record',
    'system-admin-vs-team-admin',
    'how-signing-in-actually-works',
  ]) {
    assert.ok(h2.includes(slug), `the "${slug}" chapter must stay — AC1 names its subject`);
  }
});

test('each surface deep-links to its own chapter, never a hand-written slug', () => {
  assert.ok(
    /import \{ USERS_HELP_SECTIONS \} from '\.\/users-help-sections\.js'/.test(raw),
    'the slugs must come from the shared registry, never be written out inline',
  );
  for (const [what, key] of [
    ['the page description', 'page'],
    ['the edit panel', 'edit'],
    ['the delete confirmation', 'offboarding'],
  ]) {
    assert.ok(
      page.includes(`USERS_HELP_SECTIONS.${key}`),
      `${what} must deep-link to the ${key} chapter (never a hand-written slug)`,
    );
  }
  const buttons = (page.match(/<PageHelpButton/g) || []).length;
  assert.equal(
    buttons, 3,
    `one "?" per surface (page, edit panel, delete confirmation), found ${buttons}`,
  );
});

test('the edit "?" is inside the panel and the offboarding "?" inside the dialog', () => {
  // Counting three buttons would pass with all three on the page. Anchor each on
  // the component that actually renders it.
  const editStart = page.indexOf('function EditUserPanel(');
  assert.ok(editStart > 0, 'EditUserPanel must still be its own component');
  const editEnd = page.indexOf('\nfunction ', editStart + 1);
  assert.ok(editEnd > editStart, 'could not find the end of EditUserPanel');
  const editPanel = page.slice(editStart, editEnd);
  assert.ok(
    editPanel.includes('USERS_HELP_SECTIONS.edit'),
    'the edit chapter "?" must live inside EditUserPanel',
  );

  const delStart = page.indexOf('function DeleteUserMessage(');
  assert.ok(
    delStart > 0,
    'the delete confirmation body must stay its OWN component — a hook cannot live '
    + 'in a `message={<>…</>}` prop expression, and the overlay subject needs one',
  );
  const delEnd = page.indexOf('\nfunction ', delStart + 1);
  const delBody = page.slice(delStart, delEnd > delStart ? delEnd : undefined);
  assert.ok(
    delBody.includes('USERS_HELP_SECTIONS.offboarding'),
    'the offboarding chapter "?" must live inside the delete confirmation body',
  );
  assert.match(
    page,
    /message=\{<DeleteUserMessage /,
    'ConfirmDialog must render the extracted component, not an inline fragment',
  );
});

test('both overlay surfaces publish a subject so help lifts above them', () => {
  assert.match(
    raw,
    /useHelpSubject\(\{ overlay: OVERLAY_USER_EDIT, active: true \}\)/,
    'EditUserPanel must publish its overlay subject (SidePanel is 60/61)',
  );
  assert.match(
    raw,
    /useHelpSubject\(\{ overlay: OVERLAY_USER_DELETE, active: true \}\)/,
    'the delete confirmation must publish its overlay subject — ConfirmDialog is '
    + 'the shared Modal at 9999, so without the lift the help opens behind the '
    + 'decision it exists to inform',
  );
  for (const key of ['modal:user-edit', 'modal:user-delete']) {
    assert.ok(CONTEXT_KEYS[key], `${key} must be a registered context key`);
    assert.ok(
      !CONTEXT_KEYS[key].alias,
      `${key} must not alias another route — it falls through to /users`,
    );
  }
});

test('no chapter slug is written out as a literal on the page', () => {
  for (const [name, slug] of Object.entries(USERS_HELP_SECTIONS)) {
    assert.ok(
      !page.includes(`'${slug}'`) && !page.includes(`"${slug}"`),
      `${name}'s slug is inlined in Users.jsx — import it from `
      + 'users-help-sections.js so the drift guard above can see it',
    );
  }
});

test('the point-of-decision microcopy the ticket protects is still on the page', () => {
  // Scope — out: none of these may be traded for a "?". The delete sentence in
  // particular is the copy the confirmation is built around.
  for (const kept of [
    'Their team memberships and personal credentials will be removed too.',
    'and cannot be changed later',
    'System Admin (global access)',
    'This user has a login password set.',
    'No login password set.',
  ]) {
    assert.ok(page.includes(kept), `"${kept}" is point-of-decision copy and must stay`);
  }
  // The two self-action warnings are advisory and rendered from the shared pure
  // helper — the "?" is an addition beside them, never a replacement.
  assert.ok(page.includes('selfActionWarning'), 'the self-lockout warnings must stay');
  assert.ok(page.includes('<WarnNote>'), 'the edit panel keeps its warning note');
});
