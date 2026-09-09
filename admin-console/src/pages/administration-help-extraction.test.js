import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ADMINISTRATION_HELP_SECTIONS } from './administration-help-sections.js';
import { ADMIN_TABS } from './administration-view.js';
import { topicSections, sectionSlug, CONTEXT_KEYS } from '../context/page-help-view.js';

// ─── Administration per-surface help guard (#1996, widened by #2085) ─────────
//
// The Administration topic is the console's biggest single-page reference — it
// absorbed `access-users.md` when #2085 dissolved the Access page — and the
// page's six help-bearing surfaces each deep-link into it. Three things can rot
// silently:
//
//   • a chapter heading reworded out from under a slug a call site names,
//   • an overlay subject dropped, which puts the help panel BEHIND the side
//     panel or (worse) behind one of the two delete confirmations, and
//   • a delete dialog's message quietly going back to an inline JSX prop,
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
  const missing = Object.entries(ADMINISTRATION_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/users.md no longer has a heading for these surfaces. Reword the '
    + 'heading back, or update ADMINISTRATION_HELP_SECTIONS — a stale slug degrades '
    + `silently to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  assert.equal(sectionSlug('What this page manages'), ADMINISTRATION_HELP_SECTIONS.page);
  assert.equal(sectionSlug('Creating and editing a user'), ADMINISTRATION_HELP_SECTIONS.edit);
  assert.equal(
    sectionSlug('Deleting a user is an offboarding'), ADMINISTRATION_HELP_SECTIONS.offboarding,
  );
  assert.equal(sectionSlug('The All Teams tab'), ADMINISTRATION_HELP_SECTIONS.allTeams);
  assert.equal(sectionSlug('Deleting a team'), ADMINISTRATION_HELP_SECTIONS.teamDelete);
  assert.equal(sectionSlug('The Resources tab'), ADMINISTRATION_HELP_SECTIONS.resources);
});

test('the deep-linked chapters are top-level and distinct', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const [name, slug] of Object.entries(ADMINISTRATION_HELP_SECTIONS)) {
    assert.ok(
      h2.includes(slug),
      `"${slug}" (${name}) must stay a "## " chapter — the panel scrolls to h2/h3, `
      + 'but a surface deep-link should land on a clearly-headed chapter',
    );
  }
  // No two surfaces may share a chapter: an edit panel, a user offboarding and a
  // team deletion ask three different questions, and two of them are asked with
  // a finger already over a destructive button.
  const slugs = Object.values(ADMINISTRATION_HELP_SECTIONS);
  assert.equal(new Set(slugs).size, slugs.length, 'each surface needs its OWN chapter');
});

test('each of the three tabs has a chapter of its own', () => {
  // A tab added later without a chapter would render with no "?" at all, which
  // is the failure this ratchet exists to catch.
  const byTab = { users: 'page', teams: 'allTeams', resources: 'resources' };
  for (const t of ADMIN_TABS) {
    assert.ok(byTab[t.id], `tab "${t.id}" has no chapter mapped — author one in the topic`);
    assert.ok(ADMINISTRATION_HELP_SECTIONS[byTab[t.id]], `no slug registered for tab "${t.id}"`);
  }
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

test('the folded Access material survived the merge rather than being dropped', () => {
  // #2085 folded `access-users.md` into this topic. The concepts it carried
  // describe surfaces that still exist (the scope a resource is stamped with,
  // what ownership gates, the Agent-Team-vs-scope collision), so losing them in
  // the merge would leave the console's only explanation of them nowhere.
  for (const kept of ['access scope', 'Agent Team', 'personal', 'Share']) {
    assert.ok(topicBody.includes(kept), `the folded topic must still explain "${kept}"`);
  }
  const h3 = topicSections(topicBody).filter(s => s.level === 3).map(s => s.slug);
  for (const slug of ['an-access-scope-is-not-an-agent-team', 'what-ownership-still-gates']) {
    assert.ok(h3.includes(slug), `the "${slug}" section must survive the fold`);
  }
});

test('each surface deep-links to its own chapter, never a hand-written slug', () => {
  assert.ok(
    /import \{ ADMINISTRATION_HELP_SECTIONS \} from '\.\/administration-help-sections\.js'/.test(raw),
    'the slugs must come from the shared registry, never be written out inline',
  );
  for (const [what, key] of [
    ['the page description', 'page'],
    ['the edit panel', 'edit'],
    ['the delete-user confirmation', 'offboarding'],
    ['the All Teams tab', 'allTeams'],
    ['the delete-team confirmation', 'teamDelete'],
    ['the Resources tab', 'resources'],
  ]) {
    assert.ok(
      page.includes(`ADMINISTRATION_HELP_SECTIONS.${key}`),
      `${what} must deep-link to the ${key} chapter (never a hand-written slug)`,
    );
  }
  // Six surfaces, five literal buttons: the two tab leads render the shared
  // `TabLead`, which owns the sixth `<PageHelpButton` once. Counting both is what
  // keeps this exact rather than "at least five".
  const buttons = (page.match(/<PageHelpButton/g) || []).length;
  assert.equal(
    buttons, 5,
    'one "?" each for the page description, the edit panel, the two delete '
    + `confirmations and the shared TabLead, found ${buttons}`,
  );
  const leads = (page.match(/<TabLead\b/g) || []).length;
  assert.equal(
    leads, 2,
    `the All Teams and Resources tabs each render one TabLead, found ${leads}`,
  );
});

test('each "?" lives inside the component that renders its surface', () => {
  // Counting six buttons would pass with all six on the page shell. Anchor each
  // on the component that actually renders it.
  function bodyOf(name) {
    const start = page.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} must still be its own component`);
    const end = page.indexOf('\nfunction ', start + 1);
    return page.slice(start, end > start ? end : undefined);
  }

  assert.ok(
    bodyOf('EditUserPanel').includes('ADMINISTRATION_HELP_SECTIONS.edit'),
    'the edit chapter "?" must live inside EditUserPanel',
  );
  assert.ok(
    bodyOf('DeleteUserMessage').includes('ADMINISTRATION_HELP_SECTIONS.offboarding'),
    'the offboarding chapter "?" must live inside the delete-user confirmation body',
  );
  assert.ok(
    bodyOf('DeleteTeamMessage').includes('ADMINISTRATION_HELP_SECTIONS.teamDelete'),
    'the delete-team chapter "?" must live inside the delete-team confirmation body',
  );
  assert.ok(
    bodyOf('AllTeamsTab').includes('ADMINISTRATION_HELP_SECTIONS.allTeams'),
    'the All Teams chapter "?" must live inside AllTeamsTab',
  );
  assert.ok(
    bodyOf('ResourcesTab').includes('ADMINISTRATION_HELP_SECTIONS.resources'),
    'the Resources chapter "?" must live inside ResourcesTab',
  );

  // Both confirmations must stay extracted components: a hook cannot live in a
  // `message={<>…</>}` prop expression, and the overlay subject needs one.
  assert.match(page, /message=\{<DeleteUserMessage /);
  assert.match(page, /message=\{<DeleteTeamMessage /);
});

test('every overlay surface publishes a subject so help lifts above it', () => {
  for (const [key, why] of [
    ['OVERLAY_USER_EDIT', 'EditUserPanel — SidePanel is 60/61'],
    ['OVERLAY_USER_DELETE', 'the delete-user confirmation — ConfirmDialog is the shared Modal at 9999'],
    ['OVERLAY_TEAM_DELETE', 'the delete-team confirmation — same 9999 Modal, same reason'],
  ]) {
    assert.ok(
      new RegExp(`useHelpSubject\\(\\{ overlay: ${key}, active: true \\}\\)`).test(raw),
      `${why} must publish its overlay subject, or the help opens behind it`,
    );
  }
  for (const key of ['modal:user-edit', 'modal:user-delete', 'modal:team-delete']) {
    assert.ok(CONTEXT_KEYS[key], `${key} must be a registered context key`);
    assert.ok(
      !CONTEXT_KEYS[key].alias,
      `${key} must not alias another route — it falls through to /users`,
    );
  }
  // The panel that carried `modal:team-manage` is deleted, so the key must not
  // linger: a registered key for a surface nobody renders reads as coverage.
  assert.ok(!CONTEXT_KEYS['modal:team-manage'], 'modal:team-manage retires with ManageTeamPanel');
});

test('no chapter slug is written out as a literal on the page', () => {
  for (const [name, slug] of Object.entries(ADMINISTRATION_HELP_SECTIONS)) {
    assert.ok(
      !page.includes(`'${slug}'`) && !page.includes(`"${slug}"`),
      `${name}'s slug is inlined in Users.jsx — import it from `
      + 'administration-help-sections.js so the drift guard above can see it',
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
  // #2085's own: the delete-team confirmation must name BOTH cascades, and it
  // gets them from the pure helper rather than a second hand-written sentence.
  assert.ok(page.includes('teamDeleteImpact'), 'the team delete confirmation states its impact');
});

/* ── the mutation proof ─────────────────────────────────────────────────── */

test('the slug guard fires on a reworded heading', () => {
  const sabotaged = topicBody.replace('## The Resources tab', '## Resource ownership');
  assert.notEqual(sabotaged, topicBody, 'the sabotage must change the source');
  const known = new Set(topicSections(sabotaged).map(s => s.slug));
  assert.ok(
    !known.has(ADMINISTRATION_HELP_SECTIONS.resources),
    'the first test above would catch a reworded chapter heading',
  );
});

test('the "?" placement guard fires when a button moves out of its component', () => {
  const moved = page.replace('ADMINISTRATION_HELP_SECTIONS.allTeams', 'ADMINISTRATION_HELP_SECTIONS.page');
  assert.notEqual(moved, page, 'the sabotage must change the source');
  const start = moved.indexOf('function AllTeamsTab(');
  const end = moved.indexOf('\nfunction ', start + 1);
  assert.ok(
    !moved.slice(start, end).includes('ADMINISTRATION_HELP_SECTIONS.allTeams'),
    'the placement check would catch a "?" pointed at the wrong chapter',
  );
});
