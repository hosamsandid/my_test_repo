import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MODELS_HELP_SECTIONS } from './models-help-sections.js';
import { topicSections, sectionSlug, CONTEXT_KEYS } from '../context/page-help-view.js';

// ─── #1988 (epic #1981) Model Providers per-surface help guard ───────────────
//
// The Model Providers topic is now a per-surface reference, and each of the
// page's surfaces carries a "?" that opens the panel AT that surface's chapter.
// Three things can rot silently and none of them throws at runtime:
//
//   • a chapter heading reworded out from under the slug a call site names — the
//     panel then just renders the topic from the top, which still *looks* like
//     the "?" worked,
//   • a surface losing its affordance, or gaining a hand-written slug instead of
//     the shared constant, and
//   • the form's overlay subject disappearing, which would leave the three "?"
//     buttons inside the side panel opening the help *behind* it.
//
// All three are asserted from the real sources here. The JSX is otherwise
// uncovered per the #651 convention — this is a source-text guard, not a render
// test.

const here = dirname(fileURLToPath(import.meta.url));

// Comments are stripped before asserting on the source: this ticket's own
// comments name the very chapters, constants and surfaces being checked, and
// would otherwise satisfy the matchers they merely explain.
function sourceOf(file) {
  return readFileSync(join(here, file), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const page = sourceOf('ModelRegistry.jsx');
const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/models.md'), 'utf8',
);

// A mistyped path would make every absence check below pass vacuously against an
// empty string, so prove both sources actually arrived.
test('the sources this guard reads are really there', () => {
  assert.ok(page.length > 20000, `ModelRegistry.jsx read back as ${page.length} chars`);
  assert.ok(topicBody.length > 4000, `models.md read back as ${topicBody.length} chars`);
});

test('every chapter slug a call site names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(MODELS_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/models.md no longer has a heading for these chapters. Reword the '
    + 'heading back, or update MODELS_HELP_SECTIONS — a stale slug degrades '
    + `silently to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed its rule, the
  // constants would still "exist" as strings while matching nothing at runtime.
  assert.equal(sectionSlug('What a Model Provider is'), MODELS_HELP_SECTIONS.page);
  assert.equal(sectionSlug('API key / proxy authentication'), MODELS_HELP_SECTIONS.apiKeyAuth);
  assert.equal(
    sectionSlug('Health: the poller and the Health column'),
    MODELS_HELP_SECTIONS.health,
  );
});

test('the five areas the ticket names are top-level chapters', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const key of ['page', 'apiKeyAuth', 'oauthAuth', 'probes', 'health']) {
    assert.ok(
      h2.includes(MODELS_HELP_SECTIONS[key]),
      `"${MODELS_HELP_SECTIONS[key]}" must stay a "## " chapter — the panel scrolls to `
      + 'h2/h3, but the ticket asks for one clearly-headed chapter per area',
    );
  }
  // The single-user rule is deliberately a `###` INSIDE the subscription
  // chapter: it is one aspect of that auth type, and the OAuth box's "?" is
  // labelled for exactly that aspect. Promoting it to a sixth chapter would
  // split the auth type's explanation in two.
  const h3 = topicSections(topicBody).filter(s => s.level === 3).map(s => s.slug);
  assert.ok(
    h3.includes(MODELS_HELP_SECTIONS.oauthSingleUser),
    'the Consumer-Terms constraint must stay a "### " inside the subscription chapter',
  );
});

test('each Model Providers surface mounts a "?" pointed at its own chapter', () => {
  const wired = [
    ['the page header', 'page'],
    ['the auth-type row (api-key selected)', 'apiKeyAuth'],
    ['the auth-type row (subscription selected)', 'oauthAuth'],
    ['the OAuth single-user box', 'oauthSingleUser'],
    ['the Test / Discover row', 'probes'],
    ['the Health column header', 'health'],
    ['the Budget column header', 'budget'],
  ];
  assert.ok(
    /import PageHelpButton from '\.\.\/components\/PageHelpButton'/.test(page),
    'ModelRegistry must import the shared PageHelpButton',
  );
  assert.ok(
    /import \{ MODELS_HELP_SECTIONS \} from '\.\/models-help-sections\.js'/.test(page),
    'the slugs must come from the shared registry, never be written out inline',
  );
  for (const [what, key] of wired) {
    assert.ok(
      page.includes(`MODELS_HELP_SECTIONS.${key}`),
      `${what} must deep-link to the ${key} chapter (never a hand-written slug)`,
    );
  }
  // Five JSX sites, six chapter references: the auth-type site picks its chapter
  // from the current selection, so it names two. Counting sites is what notices
  // a dropped affordance — the includes() checks above cannot, because a single
  // surface could name every constant.
  const buttons = (page.match(/<PageHelpButton/g) || []).length;
  assert.equal(
    buttons, 5,
    `expected one PageHelpButton JSX site per surface (5), found ${buttons}`,
  );
});

test('the auth-type "?" follows the selection instead of guessing one chapter', () => {
  assert.match(
    page,
    /section=\{isOauth \? MODELS_HELP_SECTIONS\.oauthAuth : MODELS_HELP_SECTIONS\.apiKeyAuth\}/,
    'the auth-type row serves two chapters from one button, so it must branch on '
    + 'the selected auth type — a fixed chapter is wrong half the time',
  );
});

test('the Health column "?" cannot re-sort or re-open the row it sits in', () => {
  const start = page.indexOf("key: 'health'");
  assert.ok(start > 0, 'the Health column must still be declared');
  const strip = page.slice(start, start + 1200);
  assert.match(
    strip,
    /onClick=\{e => e\.stopPropagation\(\)\}[\s\S]{0,200}?<PageHelpButton/,
    'the Health "?" must sit inside an onClick stopPropagation wrapper — otherwise '
    + 'asking what a status means also drives the table header',
  );
});

test('the form publishes an overlay subject, so its help opens in front of it', () => {
  // Without this the three "?" buttons inside the side panel (auth type, OAuth
  // box, probes) open the help panel BEHIND the form they explain — the panel's
  // own z-index is 50, a SidePanel is 60/61, and panelZIndex only lifts it while
  // an overlay subject is active.
  assert.ok(
    /useHelpSubject\(\{ overlay: OVERLAY_MODEL_PROVIDER \}\)/.test(page),
    'EndpointForm must publish OVERLAY_MODEL_PROVIDER while it is mounted',
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(CONTEXT_KEYS, 'modal:model-provider'),
    'modal:model-provider must be a registered help context key on both sides',
  );
});

test('no chapter slug is written out as a literal anywhere on the page', () => {
  for (const [name, slug] of Object.entries(MODELS_HELP_SECTIONS)) {
    assert.ok(
      !page.includes(`'${slug}'`) && !page.includes(`"${slug}"`),
      `${name}'s slug is inlined in ModelRegistry.jsx — import it from `
      + 'models-help-sections.js so the drift guard above can see it',
    );
  }
});

test('the point-of-decision microcopy the ticket protects is still on the page', () => {
  // Scope — out: this ticket expands the topic and adds "?" links; it must not
  // strip a hint that sits next to the control it qualifies.
  const kept = [
    // The Base-URL contract, stated where the URL is typed.
    'Must speak the Anthropic Messages API',
    // The Consumer-Terms rule ITSELF — it guards a required tick, so only its
    // rationale moved to the topic.
    'Single-user operation only.',
    'Required confirmation',
    'single-user operation',
    // The setup-token instructions in the login block.
    'claude setup-token',
    'sk-ant-oat',
    // The probe's credential note, which the new chapter explains but does not
    // replace.
    'probeNote(probe)',
  ];
  for (const phrase of kept) {
    assert.ok(page.includes(phrase), `"${phrase}" is point-of-decision copy and must stay on the page`);
  }
  // The required tick is a real input, not prose — assert the control, not only
  // the label around it.
  assert.match(
    page,
    /checked=\{complianceOk\}/,
    'the OAuth box keeps its required single-user confirmation checkbox',
  );
  // Both auth options are still offered, with their short inline descriptions.
  assert.match(page, /value: 'api-key'/);
  assert.match(page, /value: 'oauth-token'/);
  // The restart-agents dialog is out of scope and must survive untouched.
  assert.match(page, /Restart agents to apply new credentials\?/);
});

test('the topic still answers what the page stopped saying', () => {
  // #1882 moved these off the page; expanding into chapters must not drop them
  // on the way. Complements the topic-side concept list in
  // help-topics-content.test.js by asserting from the page's own perspective.
  for (const phrase of [
    'per-seat Enterprise tokens',
    'Rate limits are shared',
    'bypasses any proxy',
    'Agent override',
  ]) {
    assert.ok(topicBody.includes(phrase), `models.md must still explain "${phrase}"`);
    assert.ok(
      !page.includes(phrase),
      `"${phrase}" belongs in the topic, not back on the page`,
    );
  }
});
