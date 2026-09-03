import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { KNOWLEDGE_HELP_SECTIONS } from './knowledge-help-sections.js';
import { topicSections, sectionSlug } from '../context/page-help-view.js';

// ─── #1985 (epic #1981) Knowledge per-surface help guard ─────────────────────
//
// The Knowledge topic is now a full per-surface reference, and each part of the
// page carries a "?" that opens the panel AT that surface's chapter. Two things
// can rot silently and neither throws at runtime:
//
//   • a chapter heading reworded out from under the slug a call site names — the
//     panel then renders the topic from the top, which still *looks* like the
//     "?" worked, and
//   • a surface losing its affordance, or gaining a hand-written slug instead of
//     the shared constant.
//
// Both are asserted from the real sources here, mirroring
// skills-help-extraction.test.js. The JSX is otherwise uncovered per the #651
// convention — this is a source-text guard, not a render test.

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

const page = sourceOf('KnowledgeFlow.jsx');
const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/knowledge.md'), 'utf8',
);

test('every chapter slug a call site names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(KNOWLEDGE_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/knowledge.md no longer has a heading for these chapters. Reword the '
    + 'heading back, or update KNOWLEDGE_HELP_SECTIONS — a stale slug degrades '
    + `silently to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed its rule, the
  // constants would still "exist" as strings while matching nothing at runtime.
  assert.equal(sectionSlug('Memory vs Knowledge vs Skills'), KNOWLEDGE_HELP_SECTIONS.page);
  assert.equal(
    sectionSlug('Configuration: forgetting, assist model and storage'),
    KNOWLEDGE_HELP_SECTIONS.configuration,
  );
});

test('the six areas the ticket names are top-level chapters, not sub-headings', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const key of ['page', 'learning', 'digest', 'autonomy', 'powerTools', 'configuration']) {
    assert.ok(
      h2.includes(KNOWLEDGE_HELP_SECTIONS[key]),
      `"${KNOWLEDGE_HELP_SECTIONS[key]}" must stay a "## " chapter — the panel scrolls to `
      + 'h2/h3, but the epic asks for one clearly-headed chapter per area',
    );
  }
  assert.equal(h2.length, 6, `expected exactly the six chapters, got ${h2.join(' · ')}`);
  // Forgetting used to be a `###` under "You stay in control" and is now a `###`
  // under the configuration chapter, next to the two subjects the topic never
  // had. Autonomy/Review/gates keep their sub-headings inside chapter 4 — the
  // deep-linked target is the chapter, so a regression that promotes one of
  // those to `##` would break the count above.
  const h3 = topicSections(topicBody).filter(s => s.level === 3).map(s => s.text);
  for (const sub of ['Forgetting', 'Assist model', 'Storage']) {
    assert.ok(h3.includes(sub), `"${sub}" must stay a sub-heading of the configuration chapter`);
  }
});

test('each Knowledge surface mounts a "?" pointed at its own chapter', () => {
  const wired = [
    ['the page header', 'page'],
    ['the team-knowledge list column', 'digest'],
    ['the domains panel primer', 'powerTools'],
    ['the consolidation panel primer', 'powerTools'],
    ['the skill inspector (distill)', 'powerTools'],
    ['the learning ladder in the configuration panel', 'autonomy'],
    ['the configuration panel itself', 'configuration'],
  ];
  assert.ok(
    /import PageHelpButton from '\.\.\/components\/PageHelpButton'/.test(page),
    'KnowledgeFlow must import the shared PageHelpButton',
  );
  assert.ok(
    /import \{ KNOWLEDGE_HELP_SECTIONS \} from '\.\/knowledge-help-sections\.js'/.test(page),
    'the slugs must come from the shared registry, never be written out inline',
  );
  for (const [what, key] of wired) {
    assert.ok(
      page.includes(`KNOWLEDGE_HELP_SECTIONS.${key}`),
      `${what} must deep-link to the ${key} chapter (never a hand-written slug)`,
    );
  }
  // Three surfaces share the `powerTools` chapter, so count the buttons rather
  // than the distinct keys — a dropped affordance is invisible to the includes()
  // checks above. `learning` (chapter 2) is deliberately not a landing target:
  // it is the narrative bridge between chapters 1 and 3 and has no surface of
  // its own, so it is exported for completeness and asserted as a real heading
  // by the first test rather than counted here.
  const buttons = (page.match(/<PageHelpButton/g) || []).length;
  assert.equal(
    buttons, wired.length,
    `expected one PageHelpButton per surface (${wired.length}), found ${buttons}`,
  );
});

test('the autonomy ladder "?" is NOT inside the shared learning component', () => {
  // KnowledgeLearningConfig.jsx is rendered by the Agent Team wizard's Knowledge
  // step as well, where openHelpFor() resolves against /team-setup and would land
  // on a different topic. So the affordance belongs to this page's render site.
  const shared = sourceOf('../components/KnowledgeLearningConfig.jsx');
  assert.ok(
    !shared.includes('PageHelpButton'),
    'the shared learning component must stay affordance-free — the wizard renders it too '
    + '(#1991 owns the wizard step)',
  );
  // ...and on this page the ladder's button has to precede the component it
  // introduces, otherwise it is a "?" about the section above it.
  const btn = page.indexOf('KNOWLEDGE_HELP_SECTIONS.autonomy');
  const ladder = page.indexOf('<KnowledgeLearningSections');
  assert.ok(btn > 0 && ladder > 0 && btn < ladder, 'the ladder "?" must render just above the ladder');
});

test('no chapter slug is written out as a literal anywhere on the page', () => {
  for (const [name, slug] of Object.entries(KNOWLEDGE_HELP_SECTIONS)) {
    assert.ok(
      !page.includes(`'${slug}'`) && !page.includes(`"${slug}"`),
      `${name}'s slug is inlined in KnowledgeFlow.jsx — import it from `
      + 'knowledge-help-sections.js so the drift guard above can see it',
    );
  }
});

test('both overlay surfaces publish a registered help subject', () => {
  // A "?" inside a SidePanel (backdrop z-index 60, body 61) would open the help
  // panel BEHIND it: panelZIndex only lifts the panel above the modal layer while
  // an overlay subject is active. So the affordance is only non-broken if the
  // subject is published — and the key has to be one help-routes.js knows.
  assert.ok(
    /useHelpSubject\(\{ overlay: OVERLAY_KNOWLEDGE_CONFIG \}\)/.test(page),
    'the Team knowledge configuration panel must publish its overlay while open',
  );
  assert.ok(
    /useHelpSubject\(\{ overlay: OVERLAY_KNOWLEDGE_SKILL, active: !!open \}\)/.test(page),
    'the skill inspector must publish its overlay only while it is open',
  );
  for (const key of ['modal:knowledge-config', 'modal:knowledge-skill']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(CONTEXT_KEYS, key),
      `${key} is published by the Knowledge page but not registered in CONTEXT_KEYS`,
    );
  }
});

test('the point-of-decision microcopy the ticket protects is still on the page', () => {
  // Scope — out: this ticket expands the topic and adds "?" links; it must not
  // strip a hint that sits next to the control it qualifies.
  const kept = [
    // the three kind chips' plain-language explanations (KIND_EXPLAIN)
    'Fact — something an agent found to be true',
    'Entity — a named thing',
    'Convention — how the team does things',
    // the domains primer and the consolidation primer
    'is a theme this team’s',
    'Consolidation collapses the many small skills',
    // the three ConfigurePanel field blurbs
    'Propose retiring lessons nobody has used for a while',
    'Which registered Model Provider this team’s automatic knowledge synthesis is billed against',
    'Where this team’s shared knowledge base is kept',
  ];
  for (const phrase of kept) {
    assert.ok(page.includes(phrase), `"${phrase}" is point-of-decision copy and must stay on the page`);
  }
});
