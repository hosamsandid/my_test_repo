import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { SKILLS_HELP_SECTIONS } from './skills-help-sections.js';
import { topicSections, sectionSlug } from '../context/page-help-view.js';

// ─── #1990 (epic #1981) Skills per-surface help guard ────────────────────────
//
// The Skills topic is now a full per-surface reference, and each of the page's
// action surfaces carries a "?" that opens the panel AT that surface's chapter.
// Two things can rot silently and neither throws at runtime:
//
//   • a chapter heading reworded out from under the slug a call site names — the
//     panel then just renders the topic from the top, which still *looks* like
//     the "?" worked, and
//   • a surface losing its affordance, or gaining a hand-written slug instead of
//     the shared constant.
//
// Both are asserted from the real sources here. The JSX is otherwise uncovered
// per the #651 convention — this is a source-text guard, not a render test.

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const { CONTEXT_KEYS } = require_('../../api/helper-chat/help-routes.js');

// Comments are stripped before asserting on the source: this ticket's own
// comments name the very chapters and constants being checked, and would
// otherwise satisfy the matchers they merely explain.
function sourceOf(file) {
  return readFileSync(join(here, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const page = sourceOf('SkillsRegistry.jsx');
const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/skills.md'), 'utf8',
);

test('every chapter slug a call site names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(SKILLS_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/skills.md no longer has a heading for these chapters. Reword the '
    + 'heading back, or update SKILLS_HELP_SECTIONS — a stale slug degrades '
    + `silently to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed its rule, the
  // constants would still "exist" as strings while matching nothing at runtime.
  assert.equal(sectionSlug('What a skill is'), SKILLS_HELP_SECTIONS.page);
  assert.equal(
    sectionSlug('The actions: promote, move, adopt, distill, merge, import and export'),
    SKILLS_HELP_SECTIONS.actions,
  );
});

test('the six areas the ticket names are top-level chapters, not sub-headings', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const key of ['page', 'tiers', 'grants', 'actions', 'overwrite', 'vsKnowledge']) {
    assert.ok(
      h2.includes(SKILLS_HELP_SECTIONS[key]),
      `"${SKILLS_HELP_SECTIONS[key]}" must stay a "## " chapter — the panel scrolls to h2/h3, `
      + 'but the epic asks for one clearly-headed chapter per area',
    );
  }
  // Overwrite + merge used to be two `###` under the action table; the ticket
  // asks for them as one chapter of their own, so a regression to sub-headings
  // is what this line catches.
  assert.equal(h2.length, 6, `expected exactly the six chapters, got ${h2.join(' · ')}`);
});

test('each Skills surface mounts a "?" pointed at its own chapter', () => {
  const wired = [
    ['the page header import/export controls', 'actions'],
    ['the tier filter strip', 'tiers'],
    ['the skill action toolbar', 'actions'],
    ['the Adopt-as-team-skill panel', 'actions'],
    ['the Install-into-agent panel', 'grants'],
    ['the Merge skills dialog', 'overwrite'],
  ];
  assert.ok(
    /import PageHelpButton from '\.\.\/components\/PageHelpButton'/.test(page),
    'SkillsRegistry must import the shared PageHelpButton',
  );
  assert.ok(
    /import \{ SKILLS_HELP_SECTIONS \} from '\.\/skills-help-sections\.js'/.test(page),
    'the slugs must come from the shared registry, never be written out inline',
  );
  for (const [what, key] of wired) {
    assert.ok(
      page.includes(`SKILLS_HELP_SECTIONS.${key}`),
      `${what} must deep-link to the ${key} chapter (never a hand-written slug)`,
    );
  }
  // Six surfaces, and three of them share the `actions` chapter, so count the
  // buttons rather than the distinct keys — a dropped affordance is invisible
  // to the includes() checks above.
  const buttons = (page.match(/<PageHelpButton/g) || []).length;
  assert.equal(
    buttons, wired.length,
    `expected one PageHelpButton per surface (${wired.length}), found ${buttons}`,
  );
});

test('no chapter slug is written out as a literal anywhere on the page', () => {
  for (const [name, slug] of Object.entries(SKILLS_HELP_SECTIONS)) {
    assert.ok(
      !page.includes(`'${slug}'`) && !page.includes(`"${slug}"`),
      `${name}'s slug is inlined in SkillsRegistry.jsx — import it from `
      + 'skills-help-sections.js so the drift guard above can see it',
    );
  }
});

test('the two overlay surfaces publish a registered help subject', () => {
  // A "?" inside the side panel (backdrop z-index 60) or the merge dialog
  // (z-index 1000) would open the help panel BEHIND it: panelZIndex only lifts
  // the panel above the modal layer while an overlay subject is active. So the
  // affordance is only non-broken if the subject is published — and the key has
  // to be one help-routes.js knows.
  assert.ok(
    /useHelpSubject\(\{ overlay: OVERLAY_SKILL_DETAIL, active: !!selectedSkill \}\)/.test(page),
    'the skill detail side panel must publish its overlay while open',
  );
  assert.ok(
    /useHelpSubject\(\{ overlay: OVERLAY_SKILLS_MERGE \}\)/.test(page),
    'the merge dialog must publish its overlay while mounted',
  );
  for (const key of ['modal:skill-detail', 'modal:skills-merge']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(CONTEXT_KEYS, key),
      `${key} is published by the Skills page but not registered in CONTEXT_KEYS`,
    );
  }
});

test('the point-of-decision microcopy the ticket protects is still on the page', () => {
  // Scope — out: this ticket expands the topic and adds "?" links; it must not
  // strip a hint that sits next to the control it qualifies.
  const kept = [
    // the agent-skill "unmodified granted copy" hint (#2180 — an unchanged seed
    // copy still cannot be published directly; a diverged one now can)
    'This is an unmodified copy of a granted skill',
    // the Adopt-vs-Move-to-team blurb
    'relocates it and retires the global copy',
    // the Retire-source-skills checkbox hint
    'Retire source skills',
    // the Distill dialog primer
    'Distilling re-synthesises the whole skill',
    // the overwrite confirmations
    'Skill already exists at destination',
    'Skill already installed',
    'Target skill already exists',
  ];
  for (const phrase of kept) {
    assert.ok(page.includes(phrase), `"${phrase}" is point-of-decision copy and must stay on the page`);
  }
});
