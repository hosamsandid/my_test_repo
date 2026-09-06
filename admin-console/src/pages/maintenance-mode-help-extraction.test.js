import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MAINTENANCE_HELP_SECTIONS } from './maintenance-mode-help-sections.js';
import { topicSections, sectionSlug } from '../context/page-help-view.js';

// ─── E13 (#1887, epic #1870) extraction drift guard ──────────────────────────
//
// MaintenanceMode.jsx's intro paragraph and its bordered "While active" box are
// gone; their content is the single-sourced help topic
// (api/helper-chat/help-topics/maintenance-mode.md, guarded for content by
// help-topics-content.test.js). This test reads the page source and asserts the
// *page side* of that move: the prose did not quietly grow back, and the two
// affordances that replaced it are still wired.
//
// The page's JSX is otherwise uncovered per the #651 convention — this is a
// source-text guard, not a render test.

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, 'MaintenanceMode.jsx'), 'utf8');
const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/maintenance-mode.md'), 'utf8',
);

// Strip comments before asserting on the copy: this extraction's own explanatory
// comments name what moved to the topic ("the cron catch-up / event queuing /
// nothing-force-stopped bullets"), and would otherwise false-positive the very
// guard they belong to.
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('the "While active" box and its bullets are gone from the page', () => {
  assert.ok(!/While active/.test(src), 'the bordered "While active" heading must be gone');
  for (const phrase of [
    "won't fire",
    'exactly one catch-up run',
    'keep queuing and drain once you end it',
    "they aren't dropped",
    'wind-down window for sessions still in flight',
  ]) {
    assert.ok(
      !src.includes(phrase),
      `"${phrase}" belongs to help-topics/maintenance-mode.md, not to the page`,
    );
  }
});

test('the intro paragraph no longer re-states what the flag does or does not lock', () => {
  // The page keeps a one-line description; the "does not stop, restart, or lock
  // anything" claim moved to the topic — and was corrected there, because the
  // console *does* lock every chat composer while the flag is up (#502).
  assert.ok(
    !/does not stop, restart, or lock anything/.test(src),
    'the topic carries this claim (in a form that accounts for the chat lock)',
  );
  assert.ok(
    /Signals an upcoming platform restart/.test(src),
    'the page keeps its one-line description',
  );
});

test('the countdown note keeps only the rule that qualifies the live figure', () => {
  // Same rule as copy above a required input: the sentence that says what the
  // number on screen does NOT do stays; the list of what remains suppressed in
  // the meantime is the topic's job.
  assert.ok(
    /does not end maintenance mode on its own/.test(src),
    'the remaining-grace note must still say the countdown does not end the mode',
  );
  assert.ok(
    !/Scheduled triggers stay suppressed and events keep queuing/.test(src),
    'the suppression/queuing detail moved to the topic',
  );
});

test('the "?" affordances that replaced the removed copy are wired', () => {
  assert.ok(
    /^import PageHelpButton from '\.\.\/components\/PageHelpButton';$/m.test(raw),
    'the page must import the shared PageHelpButton',
  );
  const uses = src.match(/<PageHelpButton/g) || [];
  assert.equal(
    uses.length, 3,
    'one "?" next to the page description, one next to the Activate form (where '
    + 'the removed "While active" box used to sit) and — since #1996 — one on the '
    + 'while-active card, so the mode being ON is no longer the one state of this '
    + 'page with no contextual help',
  );
});

// ─── #1996 (epic #1981) per-surface deep-link guard ──────────────────────────
//
// The topic is now a per-surface reference and each "?" opens it AT the chapter
// for the surface it sits on. A chapter heading reworded out from under a slug
// does not throw — the panel silently renders the topic from the top — so these
// are the only things that notice.

test('every chapter slug the page names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(MAINTENANCE_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} \u2192 "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/maintenance-mode.md no longer has a heading for these surfaces. '
    + 'Reword the heading back, or update MAINTENANCE_HELP_SECTIONS \u2014 a stale slug '
    + `degrades silently. Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed its rule the constants
  // would still "exist" as strings while matching nothing at runtime.
  assert.equal(sectionSlug('What maintenance mode is'), MAINTENANCE_HELP_SECTIONS.page);
  assert.equal(
    sectionSlug('Activating it and the grace period'), MAINTENANCE_HELP_SECTIONS.activating,
  );
  assert.equal(sectionSlug('While active'), MAINTENANCE_HELP_SECTIONS.whileActive);
});

test('the three deep-linked chapters are top-level, and each surface has its own', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const [name, slug] of Object.entries(MAINTENANCE_HELP_SECTIONS)) {
    assert.ok(
      h2.includes(slug),
      `"${slug}" (${name}) must stay a "## " chapter \u2014 the panel scrolls to h2/h3, `
      + 'but a surface deep-link should land on a clearly-headed chapter',
    );
  }
  // Three DISTINCT chapters: the ticket's split is precisely that the activate
  // form and the while-active card answer different questions, so a copy-paste
  // pointing both at one chapter would erase the thing being asked for.
  const slugs = Object.values(MAINTENANCE_HELP_SECTIONS);
  assert.equal(
    new Set(slugs).size, slugs.length,
    'the Activate form and the while-active card must deep-link to DIFFERENT '
    + 'chapters \u2014 that split is the point of the ticket',
  );
});

test('each surface deep-links to its own chapter, never a hand-written slug', () => {
  assert.ok(
    /import \{ MAINTENANCE_HELP_SECTIONS \} from '\.\/maintenance-mode-help-sections\.js'/
      .test(raw),
    'the slugs must come from the shared registry, never be written out inline',
  );
  for (const [what, key] of [
    ['the page description', 'page'],
    ['the Activate form', 'activating'],
    ['the while-active card', 'whileActive'],
  ]) {
    assert.ok(
      src.includes(`MAINTENANCE_HELP_SECTIONS.${key}`),
      `${what} must deep-link to the ${key} chapter (never a hand-written slug)`,
    );
  }
});

test('the while-active "?" really sits in the active branch, not the form', () => {
  // The two state-specific "?" are in mutually exclusive branches. A guard that
  // only counted three buttons would pass even if both had landed in the form,
  // which is exactly the mistake that would leave the active state help-less
  // again \u2014 so anchor on the branch each one is inside.
  const branch = src.indexOf('data && data.active ? (');
  assert.ok(branch > 0, 'the active/inactive branch must still be an inline ternary');
  const elseAt = src.indexOf(') : (', branch);
  assert.ok(elseAt > branch, 'could not find the end of the active branch');
  const activeBranch = src.slice(branch, elseAt);
  const formBranch = src.slice(elseAt);

  assert.ok(
    activeBranch.includes('MAINTENANCE_HELP_SECTIONS.whileActive'),
    'the while-active chapter "?" must be inside the active branch \u2014 the page has '
    + 'no other affordance while the mode is on',
  );
  assert.ok(
    !activeBranch.includes('MAINTENANCE_HELP_SECTIONS.activating'),
    'the activating chapter belongs to the form you press Activate on, not to the '
    + 'card shown once it is already active',
  );
  assert.ok(
    formBranch.includes('MAINTENANCE_HELP_SECTIONS.activating'),
    'the Activate form must keep its own "?"',
  );
});

test('the corrected claims are not restated on the page', () => {
  // #1996 corrected two things the topic asserted that the code does not do:
  // Reset Session is NOT maintenance-gated (only the composer and the quick
  // replies are), and the grace countdown never reaches an agent container. If a
  // future edit re-states either claim on the page, the page and the topic
  // disagree again.
  assert.ok(
    !/[Ss]tarting a new session is blocked/.test(src),
    'Reset Session is not gated on maintenance mode \u2014 do not claim it is',
  );
});
