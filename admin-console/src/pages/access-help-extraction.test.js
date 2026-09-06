import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ACCESS_HELP_SECTIONS } from './access-help-sections.js';
import { topicSections, sectionSlug, CONTEXT_KEYS } from '../context/page-help-view.js';

// ─── #1996 (epic #1981) Access per-surface help guard ────────────────────────
//
// The Access topic is now a fuller reference, and the page's two help-bearing
// surfaces each deep-link into it. Two things can rot silently and neither
// throws at runtime:
//
//   • a chapter heading reworded out from under a slug a call site names — the
//     panel then renders the topic from the top, which still *looks* like the
//     "?" worked, and
//   • the Manage panel losing its overlay subject, which would put the help
//     panel BEHIND the side panel it is explaining.
//
// Both are asserted from the real sources. The JSX is otherwise uncovered per
// the #651 convention — this is a source-text guard, not a render test.

const here = dirname(fileURLToPath(import.meta.url));

// Comments are stripped before asserting on the source: this ticket's own
// comments name the very chapters and constants being checked, and would
// otherwise satisfy the matchers they merely explain.
function sourceOf(file) {
  return readFileSync(join(here, file), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const page = sourceOf('Teams.jsx');
const raw = readFileSync(join(here, 'Teams.jsx'), 'utf8');
const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/access-users.md'), 'utf8',
);

test('every chapter slug a call site names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(ACCESS_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/access-users.md no longer has a heading for these surfaces. Reword '
    + 'the heading back, or update ACCESS_HELP_SECTIONS — a stale slug degrades '
    + `silently to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  assert.equal(sectionSlug('What this page manages'), ACCESS_HELP_SECTIONS.page);
  assert.equal(
    sectionSlug('Managing a scope and its members'), ACCESS_HELP_SECTIONS.manage,
  );
});

test('both deep-linked chapters are top-level and distinct', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const [name, slug] of Object.entries(ACCESS_HELP_SECTIONS)) {
    assert.ok(
      h2.includes(slug),
      `"${slug}" (${name}) must stay a "## " chapter — the panel scrolls to h2/h3, `
      + 'but a surface deep-link should land on a clearly-headed chapter',
    );
  }
  const slugs = Object.values(ACCESS_HELP_SECTIONS);
  assert.equal(new Set(slugs).size, slugs.length, 'each surface needs its OWN chapter');
});

test('the topic keeps the chapters that carry no "?" of their own', () => {
  // AC1 asks the topic to deepen the Team-vs-Agent-Team distinction, the three
  // roles, what a scope gates and the delete rules. None of those is a deep-link
  // target (they are the cross-cutting story, one scroll from wherever a link
  // lands), so nothing else in this file would notice if one disappeared.
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const slug of [
    'this-is-not-an-agent-team',
    'the-three-roles',
    'what-a-scope-actually-gates',
    'resource-ownership',
    'creating-and-deleting-a-scope',
  ]) {
    assert.ok(h2.includes(slug), `the "${slug}" chapter must stay — AC1 names its subject`);
  }
});

test('each surface deep-links to its own chapter, never a hand-written slug', () => {
  assert.ok(
    /import PageHelpButton from '\.\.\/components\/PageHelpButton'/.test(page),
    'Teams.jsx must import the shared PageHelpButton',
  );
  assert.ok(
    /import \{ ACCESS_HELP_SECTIONS \} from '\.\/access-help-sections\.js'/.test(raw),
    'the slugs must come from the shared registry, never be written out inline',
  );
  for (const [what, key] of [
    ['the page description', 'page'],
    ['the Manage panel', 'manage'],
  ]) {
    assert.ok(
      page.includes(`ACCESS_HELP_SECTIONS.${key}`),
      `${what} must deep-link to the ${key} chapter (never a hand-written slug)`,
    );
  }
  const buttons = (page.match(/<PageHelpButton/g) || []).length;
  assert.equal(
    buttons, 2,
    `one "?" beside the page description and one in the Manage panel, found ${buttons}`,
  );
});

test('the Manage panel\'s "?" is inside the panel, not on the page behind it', () => {
  // A guard that only counted two buttons would pass with both on the page. The
  // manage chapter's "?" has to be inside ManageTeamPanel, which is what the
  // SidePanel renders — anchor on the component's own source span.
  const start = page.indexOf('function ManageTeamPanel(');
  assert.ok(start > 0, 'ManageTeamPanel must still be its own component');
  const end = page.indexOf('\nfunction ', start + 1);
  assert.ok(end > start, 'could not find the end of ManageTeamPanel');
  const panel = page.slice(start, end);
  assert.ok(
    panel.includes('ACCESS_HELP_SECTIONS.manage'),
    'the manage-chapter "?" must live inside ManageTeamPanel',
  );
  assert.ok(
    !panel.includes('ACCESS_HELP_SECTIONS.page'),
    'the page-level "?" belongs on the page, not inside the panel',
  );
});

test('the Manage panel publishes an overlay subject so help lifts above it', () => {
  // SidePanel is backdrop 60 / panel 61 and the help panel's own z-index is 50.
  // Without a published overlay subject `panelZIndex` never lifts it, so the "?"
  // above would open the help BEHIND the panel it explains.
  assert.match(
    raw,
    /useHelpSubject\(\{ overlay: OVERLAY_TEAM_MANAGE, active: true \}\)/,
    'ManageTeamPanel must publish its overlay subject',
  );
  assert.ok(
    CONTEXT_KEYS['modal:team-manage'],
    'modal:team-manage must be a registered context key (help-routes.js + this mirror)',
  );
  // It must NOT claim a topic — resolution falls through to /teams, whose
  // chapters the "?" deep-links into.
  assert.ok(
    !CONTEXT_KEYS['modal:team-manage'].alias,
    'modal:team-manage must not alias another route — it falls through to /teams',
  );
});

test('no chapter slug is written out as a literal on the page', () => {
  for (const [name, slug] of Object.entries(ACCESS_HELP_SECTIONS)) {
    assert.ok(
      !page.includes(`'${slug}'`) && !page.includes(`"${slug}"`),
      `${name}'s slug is inlined in Teams.jsx — import it from `
      + 'access-help-sections.js so the drift guard above can see it',
    );
  }
});

test('the point-of-decision microcopy the ticket protects is still on the page', () => {
  // Scope — out: the ROLE_HINTS legend sits next to the role dropdown it
  // qualifies and must not be traded for a "?".
  assert.ok(page.includes('ROLE_HINTS'), 'the ROLE_HINTS legend must stay');
  for (const kept of [
    'manages this team’s members and details',
    'sees this team’s resources, no management',
    'Users are managed on the',
    'You have read-only access to this team. Team Admins can manage members.',
    'The default team cannot be deleted',
  ]) {
    assert.ok(page.includes(kept), `"${kept}" is point-of-decision copy and must stay`);
  }
});
