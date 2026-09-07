import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CREATE_HELP_SECTIONS } from './create-help-sections.js';
import { topicSections, sectionSlug } from '../context/page-help-view.js';

// ─── #1992 (epic #1981) Create & Quickstart per-surface help guard ───────────
//
// The `create` topic is now a per-surface reference, and the launcher and the
// one-assistant form each carry "?" affordances that open the panel AT the
// chapter explaining the surface they sit on. Two things can rot silently and
// neither throws at runtime:
//
//   • a chapter heading reworded out from under the slug a call site names — the
//     panel then just renders the topic from the top, which still *looks* like
//     the "?" worked, and
//   • a surface losing its affordance, or gaining a hand-written slug instead of
//     the shared constant.
//
// Both are asserted from the real sources here. What makes this topic different
// from #1990's and #1995's is that ONE topic serves TWO routes (`/create` and
// `/quickstart`), so the chapters have to stay reachable from either page —
// asserted below rather than assumed.
//
// The JSX is otherwise uncovered per the #651 convention — this is a source-text
// guard, not a render test.

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

const launcherPage = sourceOf('Create.jsx');
const quickstartPage = sourceOf('QuickStart.jsx');
const launcherView = sourceOf('create-launcher-view.js');
const topicFile = readFileSync(
  join(here, '../../api/helper-chat/help-topics/create.md'), 'utf8',
);
// The body only — the front matter carries an `askPrompts` list whose questions
// echo the chapter titles, and a `## `-free summary line; neither is a heading.
const topicBody = topicFile.replace(/^---\n[\s\S]*?\n---\n/, '');

test('every chapter slug a call site names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(CREATE_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/create.md no longer has a heading for these chapters. Reword the '
    + 'heading back, or update CREATE_HELP_SECTIONS — a stale slug degrades '
    + `silently to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed its rule, the
  // constants would still "exist" as strings while matching nothing at runtime.
  assert.equal(sectionSlug('The entry paths'), CREATE_HELP_SECTIONS.entryPaths);
  assert.equal(sectionSlug('The repository fast lane'), CREATE_HELP_SECTIONS.fastLane);
  assert.equal(
    sectionSlug('What you need before you start'),
    CREATE_HELP_SECTIONS.prerequisites,
  );
});

test('the four areas the ticket names are top-level chapters, not sub-headings', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  // The team-of-one chapter is asserted by its heading rather than by a
  // constant: #2045 removed its only "?" surface (the footer note), so the
  // registry no longer names it — but the chapter must stay a chapter, because
  // the framing is now the topic's alone.
  const chapters = [
    CREATE_HELP_SECTIONS.entryPaths,
    sectionSlug('A single agent is a team of one'),
    CREATE_HELP_SECTIONS.fastLane,
    CREATE_HELP_SECTIONS.prerequisites,
  ];
  for (const slug of chapters) {
    assert.ok(
      h2.includes(slug),
      `"${slug}" must stay a "## " chapter — the panel scrolls to `
      + 'h2/h3, but the epic asks for one clearly-headed chapter per area',
    );
  }
  // The pre-#1992 topic was six ad-hoc `##` headings ("One front door", "The
  // five ways in", "One assistant, or one agent?", …). Those are `###`
  // sub-sections of the four chapters now, so a regression to the old flat
  // shape is what this line catches.
  assert.equal(h2.length, 4, `expected exactly the four chapters, got ${h2.join(' · ')}`);
});

test('one topic, both routes — a deep link works from either page', () => {
  // The chapters are shared across `/create` and `/quickstart`; if the topic
  // ever stopped claiming one of them, that page's "?" would resolve to the
  // Overview fallback and every `section` below would silently do nothing.
  const routes = /^routes:\s*(.+)$/m.exec(topicFile);
  assert.ok(routes, 'help-topics/create.md must declare its routes in front matter');
  for (const route of ['/create', '/quickstart']) {
    assert.ok(
      routes[1].includes(`"${route}"`),
      `the create topic must keep claiming ${route} — the per-surface "?" on that `
      + 'page deep-links into this topic',
    );
  }
});

test('each launcher / one-assistant surface mounts a "?" pointed at its own chapter', () => {
  const wired = [
    ['Create.jsx', launcherPage, [
      ['the launcher header above the entry tiles', 'entryPaths'],
    ]],
    // #2045 removed the third QuickStart surface (the team-of-one footer note),
    // so this page is down to two "?" — and the button count below is what
    // catches a re-added one that nobody wired to a chapter.
    ['QuickStart.jsx', quickstartPage, [
      ['the one-assistant page header', 'fastLane'],
      ['the disabled-submit prerequisite checklist', 'prerequisites'],
    ]],
  ];
  for (const [name, src, surfaces] of wired) {
    assert.ok(
      /import PageHelpButton from '\.\.\/components\/PageHelpButton'/.test(src),
      `${name} must import the shared PageHelpButton`,
    );
    assert.ok(
      /import \{ CREATE_HELP_SECTIONS \} from '\.\/create-help-sections\.js'/.test(src),
      `${name} must take its slugs from the shared registry, never write them out inline`,
    );
    for (const [what, key] of surfaces) {
      assert.ok(
        src.includes(`CREATE_HELP_SECTIONS.${key}`),
        `${name}: ${what} must deep-link to the ${key} chapter (never a hand-written slug)`,
      );
    }
    // Count the buttons too — three of QuickStart's four checks would still pass
    // if a surface lost its affordance while another gained a duplicate.
    const buttons = (src.match(/<PageHelpButton/g) || []).length;
    assert.equal(
      buttons, surfaces.length,
      `${name}: expected one PageHelpButton per surface (${surfaces.length}), found ${buttons}`,
    );
  }
});

test('the prerequisite "?" sits on the checklist, not on a warning card', () => {
  // The three warning cards each carry their own direct fix-link ("Add
  // provider →" etc.) — point-of-decision microcopy the ticket protects. The
  // checklist is the one surface that enumerates EVERY outstanding requirement
  // for the submission as filled in, so that is where the chapter hangs off.
  const checklistAt = quickstartPage.indexOf('Before you can start, please:');
  const prereqAt = quickstartPage.indexOf('CREATE_HELP_SECTIONS.prerequisites');
  assert.ok(checklistAt > -1, 'the disabled-submit checklist lead must stay on the page');
  assert.ok(
    prereqAt > checklistAt && prereqAt - checklistAt < 600,
    'the prerequisites "?" must be rendered inside the checklist block, not floated '
    + 'to another surface',
  );
});

test('no chapter slug is written out as a literal on either page', () => {
  for (const [name, src] of [['Create.jsx', launcherPage], ['QuickStart.jsx', quickstartPage]]) {
    for (const [key, slug] of Object.entries(CREATE_HELP_SECTIONS)) {
      assert.ok(
        !src.includes(`'${slug}'`) && !src.includes(`"${slug}"`),
        `${name}: ${key}'s slug is inlined — import it from create-help-sections.js `
        + 'so the drift guard above can see it',
      );
    }
  }
});

test('AC5: the point-of-decision microcopy the chapters explain is still on the page', () => {
  // A "?" is an addition, never a trade: the prerequisite warning cards and the
  // disabled-submit checklist stay where the decision is made, and so do the
  // launcher's one-line tile intents.
  for (const card of [
    'No model provider configured',
    'No GitHub token configured',
    'No SSH key configured',
  ]) {
    assert.ok(
      quickstartPage.includes(card),
      `the "${card}" warning card is point-of-decision copy — it must not move to the topic`,
    );
  }
  assert.ok(
    quickstartPage.includes('Before you can start, please:'),
    'the disabled-submit checklist must not move to the topic',
  );
  // #2027 replaced the tile copy wholesale with its binding inventory (and
  // re-sorted the launcher into three tiers), so these are the current strings.
  // The rule they guard is unchanged: what each entry *is* stays on the entry;
  // only what it *produces in detail* lives in the topic.
  for (const tile of [
    'Tell us in plain language what you want done; we draft the team for you.',
    'Pick a proven setup and adjust it to fit.',
    "The fastest way in. Get a single assistant you can talk to right away",
  ]) {
    assert.ok(
      launcherView.includes(tile),
      `the launcher entry one-liner "${tile}" must stay on the entry`,
    );
  }
  // #2027 also put an outcome line and a "what you get" caption on every entry:
  // those are point-of-decision copy too — a reader must be able to tell a chat
  // from an editor from a canvas without opening the panel at all.
  for (const outcome of [
    '→ Opens a chat with your assistant',
    '→ Review the team, then launch it',
    '→ Opens an editable draft on the canvas',
    '→ Opens the canvas',
    '→ Opens the agent editor',
  ]) {
    assert.ok(
      launcherView.includes(outcome),
      `the outcome line "${outcome}" must stay on the entry, not move to the topic`,
    );
  }
});
