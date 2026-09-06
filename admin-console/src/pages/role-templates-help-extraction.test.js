import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ROLE_TEMPLATES_HELP_SECTIONS } from './role-templates-help-sections.js';
import { topicSections, sectionSlug, CONTEXT_KEYS } from '../context/page-help-view.js';

// ─── #1996 (epic #1981) Agent Templates per-surface help guard ───────────────
//
// The topic is now a fuller reference and the page's three help-bearing
// surfaces deep-link into it. What can rot silently: a reworded chapter heading
// (the panel then renders from the top, which still looks like the "?" worked),
// a dropped `section` prop, and — new on this page — the editor losing its
// overlay subject, which would put the help panel behind the side panel it is
// explaining.
//
// The JSX is otherwise uncovered per the #651 convention — this is a source-text
// guard, not a render test.

const here = dirname(fileURLToPath(import.meta.url));

function sourceOf(file) {
  return readFileSync(join(here, file), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const page = sourceOf('RoleTemplates.jsx');
const raw = readFileSync(join(here, 'RoleTemplates.jsx'), 'utf8');
const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/role-templates.md'), 'utf8',
);

test('every chapter slug a call site names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(ROLE_TEMPLATES_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/role-templates.md no longer has a heading for these surfaces. '
    + 'Reword the heading back, or update ROLE_TEMPLATES_HELP_SECTIONS — a stale '
    + `slug degrades silently. Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  assert.equal(
    sectionSlug('What an Agent Template is'), ROLE_TEMPLATES_HELP_SECTIONS.page,
  );
  assert.equal(sectionSlug('Invocation mode'), ROLE_TEMPLATES_HELP_SECTIONS.invocation);
  assert.equal(sectionSlug('Prompt and Advanced'), ROLE_TEMPLATES_HELP_SECTIONS.advanced);
});

test('the three deep-linked chapters are top-level and distinct', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const [name, slug] of Object.entries(ROLE_TEMPLATES_HELP_SECTIONS)) {
    assert.ok(
      h2.includes(slug),
      `"${slug}" (${name}) must stay a "## " chapter — the panel scrolls to h2/h3, `
      + 'but a surface deep-link should land on a clearly-headed chapter',
    );
  }
  const slugs = Object.values(ROLE_TEMPLATES_HELP_SECTIONS);
  assert.equal(new Set(slugs).size, slugs.length, 'each surface needs its OWN chapter');
});

test('the topic keeps the chapters AC1 names that carry no "?" of their own', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const slug of [
    'built-in-edited-custom',
    'an-edit-only-reaches-future-agents',
    'role-type',
  ]) {
    assert.ok(h2.includes(slug), `the "${slug}" chapter must stay — AC1 names its subject`);
  }
});

test('each surface deep-links to its own chapter, never a hand-written slug', () => {
  assert.ok(
    /import \{ ROLE_TEMPLATES_HELP_SECTIONS \} from '\.\/role-templates-help-sections\.js'/
      .test(raw),
    'the slugs must come from the shared registry, never be written out inline',
  );
  for (const [what, key] of [
    ['the page description', 'page'],
    ['the Invocation mode field', 'invocation'],
    ['the Advanced JSON field', 'advanced'],
  ]) {
    assert.ok(
      page.includes(`ROLE_TEMPLATES_HELP_SECTIONS.${key}`),
      `${what} must deep-link to the ${key} chapter (never a hand-written slug)`,
    );
  }
  const buttons = (page.match(/<PageHelpButton/g) || []).length;
  assert.equal(
    buttons, 3,
    `one "?" beside the page description and two in the editor, found ${buttons}`,
  );
});

test('both editor "?" are inside the Editor, on the field they explain', () => {
  const start = page.indexOf('function Editor(');
  assert.ok(start > 0, 'Editor must still be its own component');
  // The next top-level declaration is `export default function RoleTemplates`, so
  // a bare '\nfunction ' scan runs off the end of the file and swallows the page —
  // which would make the "page-level ? is not in here" assertion below vacuous.
  const rest = page.slice(start + 1);
  const nextDecl = rest.search(/^(?:export default )?function /m);
  assert.ok(nextDecl > 0, 'could not find the declaration after Editor');
  const editor = rest.slice(0, nextDecl);
  for (const key of ['invocation', 'advanced']) {
    assert.ok(
      editor.includes(`ROLE_TEMPLATES_HELP_SECTIONS.${key}`),
      `the ${key} "?" must live inside Editor, not on the page behind the panel`,
    );
  }
  assert.ok(
    !editor.includes('ROLE_TEMPLATES_HELP_SECTIONS.page'),
    'the page-level "?" belongs on the page, not inside the editor',
  );
  // Each "?" must ride its OWN field's label slot. Both landing on one field
  // would satisfy every check above while leaving the other field unexplained.
  const invAt = editor.indexOf('label="Invocation mode"');
  const advAt = editor.indexOf('label="Advanced (triggers');
  assert.ok(invAt > 0 && advAt > invAt, 'both Fields must still be rendered, in order');
  const invField = editor.slice(invAt, advAt);
  assert.ok(
    invField.includes('ROLE_TEMPLATES_HELP_SECTIONS.invocation')
    && !invField.includes('ROLE_TEMPLATES_HELP_SECTIONS.advanced'),
    'the invocation "?" must sit on the Invocation mode field, and only it',
  );
  assert.ok(
    editor.slice(advAt).includes('ROLE_TEMPLATES_HELP_SECTIONS.advanced'),
    'the advanced "?" must sit on the Advanced field',
  );
});

test('the editor publishes an overlay subject so help lifts above the panel', () => {
  // This page had NO useHelpSubject before #1996 — harmless only while the panel
  // hosted no "?". With two inside it, the lift is what keeps the help panel
  // (z-index 50) from opening behind the SidePanel (60/61).
  assert.match(
    raw,
    /useHelpSubject\(\{ overlay: OVERLAY_AGENT_TEMPLATE, active: true \}\)/,
    'Editor must publish its overlay subject',
  );
  assert.ok(
    CONTEXT_KEYS['modal:agent-template'],
    'modal:agent-template must be a registered context key',
  );
  assert.ok(
    !CONTEXT_KEYS['modal:agent-template'].alias,
    'modal:agent-template must not alias another route — it falls through to /role-templates',
  );
});

test('no chapter slug is written out as a literal on the page', () => {
  for (const [name, slug] of Object.entries(ROLE_TEMPLATES_HELP_SECTIONS)) {
    assert.ok(
      !page.includes(`'${slug}'`) && !page.includes(`"${slug}"`),
      `${name}'s slug is inlined in RoleTemplates.jsx — import it from `
      + 'role-templates-help-sections.js so the drift guard above can see it',
    );
  }
});

test('the point-of-decision microcopy the ticket protects is still on the page', () => {
  // Scope — out names the select labels and the built-in-override warning
  // explicitly. The "?" beside a field is an addition, never a replacement.
  for (const kept of [
    'chat — always-on companion; responds to direct messages',
    'reactive — event-driven; wakes on GitHub events or label triggers',
    '(default: persistent)',
    'persistent — triggered runs resume the last conversation',
    'per-invocation — each triggered run starts fresh (no --resume)',
    'This is a built-in template. Saving creates an editable override',
    'Reusable agent definitions the Team-Setup wizard',
  ]) {
    assert.ok(page.includes(kept), `"${kept}" is point-of-decision copy and must stay`);
  }
  assert.ok(page.includes('Reset to default?'), 'the reset confirmation copy must stay');
  assert.ok(page.includes('Delete template?'), 'the delete confirmation copy must stay');
});
