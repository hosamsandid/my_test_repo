import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SETTINGS_HELP_SECTIONS } from './settings-help-sections.js';
import { SETTINGS_SECTIONS } from './settings-modal-view.js';
import { topicSections, sectionSlug, CONTEXT_KEYS } from '../context/page-help-view.js';

// ─── #1996 (epic #1981) Settings dialog per-section help guard ───────────────
//
// The Settings topic is now a per-section reference, and the dialog's "?" opens
// the panel AT the chapter for the section you are on. Two things can rot
// silently and neither throws at runtime:
//
//   • a chapter heading reworded out from under the slug the dialog names — the
//     panel then renders the topic from the top, which still *looks* like the
//     "?" worked, and
//   • a section gaining/losing a chapter, or the "?" losing its `section` prop
//     and going back to always opening the topic top.
//
// Both are asserted from the real sources here. The JSX is otherwise uncovered
// per the #651 convention — this is a source-text guard, not a render test.

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

const dialog = sourceOf('SettingsModal.jsx');
const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/settings.md'), 'utf8',
);

test('every chapter slug the dialog names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(SETTINGS_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/settings.md no longer has a heading for these sections. Reword the '
    + 'heading back, or update SETTINGS_HELP_SECTIONS — a stale slug degrades '
    + `silently to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed its rule, the
  // constants would still "exist" as strings while matching nothing at runtime.
  assert.equal(
    sectionSlug('Behavior — how the composer sends'), SETTINGS_HELP_SECTIONS.behavior,
  );
  assert.equal(
    sectionSlug('Model — which provider AI helpers bill against'), SETTINGS_HELP_SECTIONS.model,
  );
  assert.equal(
    sectionSlug('Display — theme and transcript size'), SETTINGS_HELP_SECTIONS.display,
  );
});

test('every section the dialog renders has a chapter of its own', () => {
  // The registry is keyed on the dialog's own section ids, so this is what
  // notices a fourth section shipping without a chapter (it would silently open
  // the topic from the top) — and equally an orphaned chapter key left behind by
  // a removed section.
  assert.deepEqual(
    SETTINGS_SECTIONS.map(s => s.id).sort(),
    Object.keys(SETTINGS_HELP_SECTIONS).sort(),
    'SETTINGS_HELP_SECTIONS must have exactly one entry per section in '
    + 'settings-modal-view.js — the "?" resolves its chapter by section id',
  );
  // Three distinct chapters: a copy-paste that pointed two sections at the same
  // slug would still satisfy every check above.
  const slugs = Object.values(SETTINGS_HELP_SECTIONS);
  assert.equal(new Set(slugs).size, slugs.length, 'each section needs its OWN chapter');
});

test('the three section chapters are top-level, and the topic keeps its other two', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const [id, slug] of Object.entries(SETTINGS_HELP_SECTIONS)) {
    assert.ok(
      h2.includes(slug),
      `"${slug}" (${id}) must stay a "## " chapter — the panel scrolls to h2/h3, `
      + 'but a section deep-link should land on a clearly-headed chapter',
    );
  }
  // The framing chapter and the browser-vs-user-record table are deliberately
  // *not* deep-link targets: every "?" in this dialog is inside a section, so
  // there is no affordance that would point at them. They must still exist —
  // "Where these preferences live" is the answer to the dialog's most-asked
  // question and is what AC1 asks this topic to deepen.
  assert.ok(h2.includes('what-this-dialog-is'), 'the framing chapter must stay');
  assert.ok(
    h2.includes('where-these-preferences-live'),
    'the browser-vs-user-record chapter must stay — it is the topic\'s load-bearing section',
  );
});

test('the dialog deep-links its "?" by section id, never a hand-written slug', () => {
  assert.ok(
    /import PageHelpButton from '\.\/PageHelpButton\.jsx'/.test(dialog),
    'SettingsModal must import the shared PageHelpButton',
  );
  assert.ok(
    /import \{ SETTINGS_HELP_SECTIONS \} from '\.\/settings-help-sections\.js'/.test(dialog),
    'the slugs must come from the shared registry, never be written out inline',
  );
  assert.match(
    dialog,
    /section=\{SETTINGS_HELP_SECTIONS\[active\.id\]/,
    'the "?" must resolve its chapter from the ACTIVE section id — hard-coding one '
    + 'chapter would make it disagree with the section under it the moment you '
    + 'switch tabs',
  );
  // One JSX site, three rendered targets: the "?" lives inside the section pane,
  // so it re-renders per section. Counting sites is what notices a dropped
  // affordance — the matchers above cannot.
  const buttons = (dialog.match(/<PageHelpButton/g) || []).length;
  assert.equal(
    buttons, 1,
    `the section pane hosts exactly one "?" that follows the active section, found ${buttons}`,
  );
});

test('no chapter slug is written out as a literal in the dialog', () => {
  for (const [name, slug] of Object.entries(SETTINGS_HELP_SECTIONS)) {
    assert.ok(
      !dialog.includes(`'${slug}'`) && !dialog.includes(`"${slug}"`),
      `${name}'s slug is inlined in SettingsModal.jsx — import it from `
      + 'settings-help-sections.js so the drift guard above can see it',
    );
  }
});

test('the overlay subject still carries the section, so the panel lifts and follows', () => {
  // The dialog is the shared Modal at z-index 9999; the help panel's own 50 would
  // open it BEHIND the dialog. Publishing the overlay subject is what lifts it —
  // and `step: active.id` is what makes the published context name the section.
  assert.match(
    dialog,
    /useHelpSubject\(\{ overlay: OVERLAY_SETTINGS, step: active\.id, active: open \}\)/,
    'the dialog must keep publishing its overlay subject with the active section — '
    + 'without it the help panel opens behind the dialog it is explaining',
  );
  // The section context keys are registered (E17 #1892), so the published subject
  // is never an unknown key. They claim no topic of their own: resolution falls
  // through to `modal:settings`, whose chapters the "?" deep-links into.
  for (const id of Object.keys(SETTINGS_HELP_SECTIONS)) {
    assert.ok(
      CONTEXT_KEYS[`modal:settings#${id}`],
      `modal:settings#${id} must stay a registered context key`,
    );
  }
});

test('the point-of-decision microcopy the ticket protects is still in the dialog', () => {
  // Scope — out: this ticket deepens the topic and deep-links the "?"; it must
  // not strip a hint that sits next to the control it qualifies.
  for (const kept of [
    'Assist model',
    'Which model AI helpers bill against',
    'Choose the console colour scheme.',
    'Send on Enter',
    'Applies immediately to the message transcript.',
  ]) {
    assert.ok(dialog.includes(kept), `"${kept}" is point-of-decision copy and must stay`);
  }
  // The per-section blurbs are rendered from the section descriptor, not inlined.
  assert.match(dialog, /\{active\.blurb\}/, 'the section blurb must still be rendered');
});
