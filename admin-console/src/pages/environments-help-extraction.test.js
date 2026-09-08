import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ENVIRONMENTS_HELP_SECTIONS } from './environments-help-sections.js';
import {
  topicSections,
  sectionSlug,
  OVERLAY_ENVIRONMENT_FORM,
  OVERLAY_TOOLCHAINS,
} from '../context/page-help-view.js';

// ─── #1987 (epic #1981) Working Environments per-surface help guard ──────────
//
// E6 (#1880) left `help-topics/environments.md` as one topic behind one
// page-level "?" — on a page whose actual decision surfaces all live inside a
// side panel. This ticket split the topic into seven chapters and pointed the
// repositories area, the token select, the Sync action and the Toolchains panel
// at the chapter written for each. Four things can rot silently, and none of
// them throws at runtime:
//
//   • a chapter heading reworded out from under the slug a surface names — the
//     panel then just renders the topic from the top, which still *looks* like
//     the "?" worked,
//   • a surface losing its affordance, or gaining a hand-written slug instead
//     of the shared constant,
//   • a side panel losing its published help subject — the "?" still opens the
//     panel, but at z-index 50 it opens BEHIND the SidePanel (60/61) that it is
//     explaining, which reads as "the button does nothing", and
//   • a per-field hint being traded away for a "?" (AC5 says none may go).
//
// All four are asserted from the real sources here. The JSX is otherwise
// uncovered per the #651 convention — this is a source-text guard, not a render
// test.

const here = dirname(fileURLToPath(import.meta.url));

// Comments are stripped before asserting on the source: this ticket's own
// comments name the very chapters, constants and hooks being checked, and would
// otherwise satisfy the matchers they merely explain.
function sourceOf(file) {
  return readFileSync(join(here, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const page = sourceOf('WorkingEnvironments.jsx');
// #2067 extracted the repository card into the console-wide shared component
// this page renders (so the agent-scoped attach form cannot drift from it).
// The card's own field copy is therefore no longer IN this file — but it is
// still at the point of decision, which is what AC5 protects. Read both and
// assert against the surface the reader actually sees.
const card = sourceOf('../components/RepositoryCard.jsx');
const surface = page + card;

const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/environments.md'), 'utf8',
);

// The comment strip must not have eaten code: several of this page's blocks are
// introduced by a JSX comment, so a naive strip that ran away would silently
// make every assertion below pass for the wrong reason.
test('the stripped source is still the page, not a hole', () => {
  for (const signature of [
    'export default function WorkingEnvironments()',
    'function EnvironmentForm(',
    'function ToolchainRegistryPanel(',
    'const COLUMNS',
  ]) {
    assert.ok(page.includes(signature), `comment-stripping removed ${signature}`);
  }
  // The card moved out in #2067; the page's render site is what stayed.
  assert.ok(page.includes('<RepositoryCard'), 'comment-stripping removed <RepositoryCard');
  for (const signature of ['export default function RepositoryCard(', 'export function useRepoCheck(']) {
    assert.ok(card.includes(signature), `comment-stripping removed ${signature}`);
  }
});

test('every chapter slug the page names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(ENVIRONMENTS_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/environments.md no longer has a heading for these chapters. '
    + 'Reword the heading back, or update ENVIRONMENTS_HELP_SECTIONS — a stale '
    + 'slug degrades silently to "open the topic at the top". Known headings: '
    + `${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed its rule, the
  // constants would still "exist" as strings while matching nothing at runtime.
  assert.equal(sectionSlug('What a Working Environment is'), ENVIRONMENTS_HELP_SECTIONS.whatIs);
  assert.equal(sectionSlug('Repositories'), ENVIRONMENTS_HELP_SECTIONS.repositories);
  assert.equal(sectionSlug('Sync all agents'), ENVIRONMENTS_HELP_SECTIONS.sync);
  assert.equal(sectionSlug('Credentials'), ENVIRONMENTS_HELP_SECTIONS.credentials);
  assert.equal(sectionSlug('MCP server references'), ENVIRONMENTS_HELP_SECTIONS.mcp);
  assert.equal(sectionSlug('Model provider binding'), ENVIRONMENTS_HELP_SECTIONS.provider);
  assert.equal(sectionSlug('Additional context'), ENVIRONMENTS_HELP_SECTIONS.context);
  assert.equal(sectionSlug('Toolchains'), ENVIRONMENTS_HELP_SECTIONS.toolchains);
});

test('the seven areas the ticket names are top-level chapters, not sub-headings', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const key of ['whatIs', 'repositories', 'credentials', 'mcp', 'provider', 'context', 'toolchains']) {
    assert.ok(
      h2.includes(ENVIRONMENTS_HELP_SECTIONS[key]),
      `"${ENVIRONMENTS_HELP_SECTIONS[key]}" must stay a "## " chapter — the panel `
      + 'scrolls to h2/h3, but the ticket asks for one clearly-headed chapter per area',
    );
  }
  assert.equal(h2.length, 7, `expected exactly the seven chapters, got ${h2.join(' · ')}`);
});

test('the Sync sub-section lives inside the repositories chapter', () => {
  // The ticket's table maps the Sync surface to chapter 2, and this is how that
  // is honoured precisely: the deep link lands on Sync's own `###` heading,
  // which sits between the Repositories chapter and the next `##`.
  const sections = topicSections(topicBody);
  const repoAt = sections.findIndex(s => s.slug === ENVIRONMENTS_HELP_SECTIONS.repositories);
  const syncAt = sections.findIndex(s => s.slug === ENVIRONMENTS_HELP_SECTIONS.sync);
  assert.ok(repoAt >= 0 && syncAt > repoAt, 'the Sync sub-section must follow the Repositories chapter');
  assert.equal(sections[syncAt].level, 3, 'Sync is a sub-section of chapter 2, not a chapter of its own');
  const nextChapterAt = sections.findIndex((s, i) => i > repoAt && s.level === 2);
  assert.ok(syncAt < nextChapterAt, 'the Sync sub-section drifted out of the Repositories chapter');
});

test('the two chapters with no "?" keep their own heading', () => {
  // #2051 moved `mcp` out of this set: the form now HAS an MCP picker, so a "?"
  // naming that chapter finally sits honestly on a real control. The provider /
  // additional-context sections keep their existing point-of-decision hints
  // instead. Nothing else would notice if either were folded into a neighbour —
  // they are reached by scrolling the rendered topic, which is why they must
  // stay separately addressable. (All seven headings, `mcp` included, are
  // asserted by the exactly-seven-chapters test above.)
  const slugs = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const key of ['provider', 'context']) {
    assert.ok(slugs.includes(ENVIRONMENTS_HELP_SECTIONS[key]), `${key} chapter is gone`);
  }
  for (const key of ['provider', 'context']) {
    assert.ok(
      !page.includes(`ENVIRONMENTS_HELP_SECTIONS.${key}`),
      `${key} has no surface on this page — a "?" naming it would duplicate a `
      + 'field hint that is already at the point of decision',
    );
  }
});

test('the page imports the shared registry and the shared button', () => {
  assert.ok(
    /import PageHelpButton from '\.\.\/components\/PageHelpButton'/.test(page),
    'WorkingEnvironments.jsx must import the shared PageHelpButton',
  );
  assert.ok(
    /import \{ ENVIRONMENTS_HELP_SECTIONS \} from '\.\/environments-help-sections\.js'/.test(page),
    'the slugs must come from the shared registry, never be written out inline',
  );
});

test('all five surfaces from the ticket table render a deep-linked "?"', () => {
  const buttons = page.match(/<PageHelpButton[\s\S]*?\/>/g) || [];
  assert.equal(
    buttons.length, 6,
    'expected six PageHelpButtons (repositories area, Sync action, GitHub token, '
    + `MCP servers section, Toolchains panel, page header), found ${buttons.length}`,
  );
  const sections = buttons.map((b) => {
    const m = /section=\{ENVIRONMENTS_HELP_SECTIONS\.(\w+)\}/.exec(b);
    return m ? m[1] : null;
  });
  assert.ok(
    sections.every(Boolean),
    'every "?" on this page must name its chapter — a section-less button opens '
    + `the topic at the top, which is the bug this ticket closes. Got: ${sections}`,
  );
  // Source order, not reading order: EnvironmentForm and ToolchainRegistryPanel
  // are declared before the page component that renders the header paragraph.
  assert.deepEqual(
    sections, ['repositories', 'sync', 'credentials', 'mcp', 'toolchains', 'whatIs'],
    "the surfaces must map to the ticket's table: repositories area → the "
    + 'Repositories chapter, Sync all agents → its sub-section inside that '
    + 'chapter, GitHub token → Credentials, the MCP servers section → MCP '
    + 'server references (#2051), the Toolchains panel → Toolchains, '
    + 'page header → what a Working Environment is',
  );
});

test('the Sync "?" is mounted by the page, not inside the shared SyncReposPanel', () => {
  // SyncReposPanel is also rendered by the agent settings form, where
  // openHelpFor() resolves against a different route and would land on another
  // topic — the same trap #1985 hit with KnowledgeLearningConfig.
  const shared = sourceOf('../components/SyncReposPanel.jsx');
  assert.ok(
    !shared.includes('PageHelpButton'),
    'the shared SyncReposPanel must stay affordance-free — mount the "?" at the '
    + 'call site on this page instead',
  );
  const syncAt = page.indexOf('actionLabel="Sync all agents"');
  assert.ok(syncAt > 0, 'the Sync all agents panel is gone');
  const before = page.slice(0, syncAt);
  assert.ok(
    /section=\{ENVIRONMENTS_HELP_SECTIONS\.sync\}[\s\S]*$/.test(before),
    'the Sync "?" must sit immediately above the panel it explains',
  );
});

test('no chapter slug is inlined as a literal', () => {
  // Every `section=` must be fed from the registry, never a string. This is the
  // precise form of the check, because two of this page's slugs are ordinary
  // single words (`repositories` is also a DataTable column key and a form
  // field) — matching those as bare literals would flag unrelated code.
  assert.ok(
    !/section=\s*(['"]|\{\s*['"])/.test(page),
    'a "?" on this page passes its chapter as a string literal — import it from '
    + 'environments-help-sections.js so the drift guard above can see it',
  );
  for (const [name, slug] of Object.entries(ENVIRONMENTS_HELP_SECTIONS)) {
    if (!slug.includes('-')) continue; // a single word is not distinctive here
    assert.ok(
      !page.includes(`'${slug}'`) && !page.includes(`"${slug}"`),
      `${name}'s slug is inlined in WorkingEnvironments.jsx — import it from `
      + 'environments-help-sections.js so the drift guard above can see it',
    );
  }
});

test('both side panels publish a help subject so the panel opens in front', () => {
  // Without these a "?" inside a SidePanel (z-index 60/61) opens the help panel
  // underneath the surface it explains — a silent, entirely visual failure.
  assert.ok(
    /import \{ useHelpSubject \} from '\.\.\/context\/HelperChatContext'/.test(page),
    'WorkingEnvironments.jsx must import useHelpSubject',
  );
  assert.ok(
    /useHelpSubject\(\{ overlay: OVERLAY_ENVIRONMENT_FORM \}\)/.test(page),
    'the create/edit panel must publish OVERLAY_ENVIRONMENT_FORM',
  );
  assert.ok(
    /useHelpSubject\(\{ overlay: OVERLAY_TOOLCHAINS \}\)/.test(page),
    'the Toolchains panel must publish OVERLAY_TOOLCHAINS',
  );
  // Each subject must be published by the component that owns the panel body,
  // not by the page — a page-level subject would stay active with no panel open
  // and lift the help panel above every dialog on the route.
  const formAt = page.indexOf('function EnvironmentForm(');
  const toolchainAt = page.indexOf('function ToolchainRegistryPanel(');
  const pageAt = page.indexOf('export default function WorkingEnvironments()');
  const formSubjectAt = page.indexOf('useHelpSubject({ overlay: OVERLAY_ENVIRONMENT_FORM })');
  const toolchainSubjectAt = page.indexOf('useHelpSubject({ overlay: OVERLAY_TOOLCHAINS })');
  assert.ok(formAt < formSubjectAt && formSubjectAt < toolchainAt, 'form subject moved out of EnvironmentForm');
  assert.ok(toolchainAt < toolchainSubjectAt && toolchainSubjectAt < pageAt, 'toolchain subject moved out of ToolchainRegistryPanel');
});

test('the overlay ids the page publishes are the registered constants', () => {
  assert.equal(OVERLAY_ENVIRONMENT_FORM, 'modal:environment-form');
  assert.equal(OVERLAY_TOOLCHAINS, 'modal:toolchains');
  const helpRoutes = readFileSync(
    join(here, '../../api/helper-chat/help-routes.js'), 'utf8',
  );
  for (const key of [OVERLAY_ENVIRONMENT_FORM, OVERLAY_TOOLCHAINS]) {
    // An unregistered key resolves to no context, so panelZIndex never lifts —
    // the exact failure the subject was published to avoid. The parity test in
    // page-help-view.test.js diffs CONTEXT_KEYS; OVERLAY_KEYS is asserted
    // separately there, so both mentions have to be present here.
    assert.ok(
      helpRoutes.includes(`'${key}'`),
      `${key} must be registered in help-routes.js (OVERLAY_KEYS + CONTEXT_KEYS)`,
    );
  }
});

test('no point-of-decision microcopy was traded for a "?"', () => {
  // Scope — out: the ticket expands the topic and adds "?" links. AC5 says no
  // per-field hint may be removed; every hint below sits at the moment a
  // decision is made and must stay on the page.
  const kept = [
    // repositories: what a row is for, the SSH-vs-token pointer, read-only
    "cloned into the agent's workspace when the agent is first created",
    'select an SSH key on the repository card',
    'Mark a repository',
    'it must not commit or push to it',
    // the URL probe's own wording
    'Reachable, but the repository is empty',
    // the GitHub token field
    'open pull requests, create issues, or push via HTTPS',
    'Only needed if agents use the',
    // model provider
    'Leave the model blank to inherit',
    // the toolchain select + its restart warning
    'The default image carries Python and Node',
    // additional instructions
    "appended to the agent's CLAUDE.md",
    'You can use Markdown formatting.',
    // the toolchain registry form's own field hints
    'The image tag as the runtime resolves it',
    'Where this image is actually pullable',
    // the id help, which must keep referencing the shared constant
    '{ID_FORMAT_HINT}',
  ];
  for (const phrase of kept) {
    assert.ok(
      surface.includes(phrase),
      `"${phrase}" is point-of-decision copy and must stay on the page or its repository card`,
    );
  }
});

test('the Description hint no longer claims the agent never sees it', () => {
  // A factual correction, not a rewording: prompt-assembly.js writes the
  // environment name AND description into the agent's CLAUDE.md, so the old
  // "Shown only in this console — not passed to the agent." invited a reader to
  // put a private note in a field the agent reads.
  assert.ok(
    !page.includes('not passed to the agent'),
    'the Description hint still claims the agent does not see it',
  );
  assert.match(
    page,
    /written into the agent's CLAUDE\.md next to the/,
    'the Description hint must say the description reaches the agent',
  );
});

test('the topic states the form pairs MCP servers, with the seed-time caveat', () => {
  // #2051 inverted this guard's subject rather than deleting it. The form now
  // HAS an MCP picker, so "no picker" would be a lie; the load-bearing claim is
  // the seed-time one, because a reader who expects an edit to reach agents that
  // already exist is the one this page misleads. Both halves are asserted so a
  // reword cannot restore the absence OR quietly drop the caveat.
  assert.doesNotMatch(
    topicBody,
    /no MCP picker/,
    'the topic still claims this form has no MCP picker — #2051 added one',
  );
  assert.match(
    topicBody,
    /\*\*Pair them on this form\.\*\*/,
    'the topic must say the pairs are chosen on this form',
  );
  assert.match(
    topicBody,
    /\*\*A change here reaches only agents created afterwards\.\*\*/,
    'the topic must keep the seed-time caveat — an edit does not reach existing agents',
  );
});

test('the page keeps exactly one page-level "?" in its header line', () => {
  // A second entry point in the header would compete with the one the epic
  // standardised on; the other four buttons live inside the two side panels.
  const headerLine = page.slice(
    page.indexOf('A reusable workspace recipe'),
    page.indexOf('{actionError'),
  );
  assert.equal(
    (headerLine.match(/<PageHelpButton/g) || []).length, 1,
    'expected exactly one page-level "?" next to the page description',
  );
});
