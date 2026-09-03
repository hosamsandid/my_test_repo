import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MCP_HELP_SECTIONS } from './mcp-help-sections.js';
import { topicSections, sectionSlug, OVERLAY_MCP_SERVER, OVERLAY_MCP_CREDENTIAL } from '../context/page-help-view.js';

// ─── #1989 (epic #1981) MCP Servers per-surface help guard ───────────────────
//
// E9 (#1883) left `help-topics/mcp.md` as one topic behind one page-level "?".
// This ticket split it into five chapters and pointed the server form, the
// credential form and the *required* column marker at the chapter written for
// each. Three things can rot silently, and none of them throws at runtime:
//
//   • a chapter heading reworded out from under the slug a surface names — the
//     panel then just renders the topic from the top, which still *looks* like
//     the "?" worked,
//   • a surface losing its affordance, or gaining a hand-written slug instead
//     of the shared constant, and
//   • a create panel losing its published help subject — the "?" still opens
//     the panel, but at z-index 50 it opens BEHIND the SidePanel (60/61) that
//     it is explaining, which reads as "the button does nothing".
//
// All three are asserted from the real sources here. The JSX is otherwise
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

const page = sourceOf('McpServers.jsx');
const rawPage = readFileSync(join(here, 'McpServers.jsx'), 'utf8');

const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/mcp.md'), 'utf8',
);

// The comment strip must not have eaten code: the page's own three-part-model
// intro is inside a JSX comment, so a naive strip that ran away would silently
// make every doesNotMatch below pass for the wrong reason.
test('the stripped source is still the page, not a hole', () => {
  for (const signature of [
    'export default function McpServers()',
    'function CreateServerForm(',
    'function CreateCredentialForm(',
    'const SERVER_COLUMNS',
    'const CRED_COLUMNS',
  ]) {
    assert.ok(page.includes(signature), `comment-stripping removed ${signature}`);
  }
});

test('every chapter slug the page names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(MCP_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/mcp.md no longer has a heading for these chapters. Reword the '
    + 'heading back, or update MCP_HELP_SECTIONS — a stale slug degrades silently '
    + `to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed its rule, the
  // constants would still "exist" as strings while matching nothing at runtime.
  assert.equal(sectionSlug('The three-part model'), MCP_HELP_SECTIONS.model);
  assert.equal(
    sectionSlug('The server registry and its transports'),
    MCP_HELP_SECTIONS.servers,
  );
  assert.equal(
    sectionSlug('The credential store and `${credential}` substitution'),
    MCP_HELP_SECTIONS.credentials,
  );
  assert.equal(
    sectionSlug('Environment pairing and the seed-time merge'),
    MCP_HELP_SECTIONS.pairing,
  );
  assert.equal(
    sectionSlug('Deleting a server or a credential'),
    MCP_HELP_SECTIONS.deleting,
  );
});

test('the five areas the ticket names are top-level chapters, not sub-headings', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const key of ['model', 'servers', 'credentials', 'pairing', 'deleting']) {
    assert.ok(
      h2.includes(MCP_HELP_SECTIONS[key]),
      `"${MCP_HELP_SECTIONS[key]}" must stay a "## " chapter — the panel scrolls to `
      + 'h2/h3, but the ticket asks for one clearly-headed chapter per area',
    );
  }
  assert.equal(h2.length, 5, `expected exactly the five chapters, got ${h2.join(' · ')}`);
});

test('the two chapters with no "?" keep their own heading', () => {
  // The pairing chapter has no surface on this page (the Working Environments
  // form exposes no MCP picker) and the delete rules live in a ConfirmDialog, so
  // nothing else would notice if either were folded into a neighbour. They are
  // reached by scrolling the rendered topic, which is why they must stay
  // separately addressable.
  const slugs = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const key of ['pairing', 'deleting']) {
    assert.ok(slugs.includes(MCP_HELP_SECTIONS[key]), `${key} chapter is gone`);
  }
});

test('the page imports the shared registry and the shared button', () => {
  assert.ok(
    /import PageHelpButton from '\.\.\/components\/PageHelpButton'/.test(page),
    'McpServers.jsx must import the shared PageHelpButton',
  );
  assert.ok(
    /import \{ MCP_HELP_SECTIONS \} from '\.\/mcp-help-sections\.js'/.test(page),
    'the slugs must come from the shared registry, never be written out inline',
  );
});

test('all four surfaces from the ticket table render a deep-linked "?"', () => {
  // Four buttons, three distinct chapters: the page header (1), the server
  // panel (2), and the credential panel + the *required* marker (both 3).
  const buttons = page.match(/<PageHelpButton[\s\S]*?\n\s*\/>/g) || [];
  assert.equal(
    buttons.length, 4,
    `expected four PageHelpButtons (page header, server form, credential form, `
    + `the "required" marker), found ${buttons.length}`,
  );
  const sections = buttons.map((b) => {
    const m = /section=\{MCP_HELP_SECTIONS\.(\w+)\}/.exec(b);
    return m ? m[1] : null;
  });
  assert.ok(
    sections.every(Boolean),
    'every "?" on this page must name its chapter — a section-less button opens '
    + `the topic at the top, which is the bug this ticket closes. Got: ${sections}`,
  );
  // Source order, not reading order: the two form components are declared
  // before the page component, whose SERVER_COLUMNS (the marker) in turn comes
  // before the header paragraph it renders.
  assert.deepEqual(
    sections, ['servers', 'credentials', 'credentials', 'model'],
    'the surfaces must map to the ticket\'s table: server form → the '
    + 'registry/transports chapter, credential form and the "required" marker → '
    + 'the credential chapter, page header → the three-part model',
  );
});

test('no chapter slug is inlined as a literal', () => {
  for (const [name, slug] of Object.entries(MCP_HELP_SECTIONS)) {
    assert.ok(
      !page.includes(`'${slug}'`) && !page.includes(`"${slug}"`),
      `${name}'s slug is inlined in McpServers.jsx — import it from `
      + 'mcp-help-sections.js so the drift guard above can see it',
    );
  }
});

test('both create panels publish a help subject so the panel opens in front', () => {
  // Without these the "?" inside a SidePanel (z-index 60/61) opens the help
  // panel underneath the form it explains — a silent, entirely visual failure.
  assert.ok(
    /import \{ useHelpSubject \} from '\.\.\/context\/HelperChatContext'/.test(page),
    'McpServers.jsx must import useHelpSubject',
  );
  assert.ok(
    /useHelpSubject\(\{ overlay: OVERLAY_MCP_SERVER \}\)/.test(page),
    'the New MCP server panel must publish OVERLAY_MCP_SERVER',
  );
  assert.ok(
    /useHelpSubject\(\{ overlay: OVERLAY_MCP_CREDENTIAL \}\)/.test(page),
    'the New MCP credential panel must publish OVERLAY_MCP_CREDENTIAL',
  );
  // Each subject must be published by the component that owns the panel body,
  // not by the page — a page-level subject would stay active with no panel open
  // and lift the panel above every dialog on the route.
  const serverAt = page.indexOf('function CreateServerForm(');
  const credAt = page.indexOf('function CreateCredentialForm(');
  const pageAt = page.indexOf('export default function McpServers()');
  const serverSubjectAt = page.indexOf('useHelpSubject({ overlay: OVERLAY_MCP_SERVER })');
  const credSubjectAt = page.indexOf('useHelpSubject({ overlay: OVERLAY_MCP_CREDENTIAL })');
  assert.ok(serverAt < serverSubjectAt && serverSubjectAt < credAt, 'server subject moved out of CreateServerForm');
  assert.ok(credAt < credSubjectAt && credSubjectAt < pageAt, 'credential subject moved out of CreateCredentialForm');
});

test('the overlay ids the page publishes are the registered constants', () => {
  assert.equal(OVERLAY_MCP_SERVER, 'modal:mcp-server');
  assert.equal(OVERLAY_MCP_CREDENTIAL, 'modal:mcp-credential');
  const helpRoutes = readFileSync(
    join(here, '../../api/helper-chat/help-routes.js'), 'utf8',
  );
  for (const key of [OVERLAY_MCP_SERVER, OVERLAY_MCP_CREDENTIAL]) {
    // An unregistered key resolves to no context, so panelZIndex never lifts —
    // the exact failure the subject was published to avoid.
    assert.ok(
      helpRoutes.includes(`'${key}'`),
      `${key} must be registered in help-routes.js (OVERLAY_KEYS + CONTEXT_KEYS)`,
    );
  }
});

test('the "required" marker keeps its stopPropagation wrapper', () => {
  // The Credential column is sortable. Both the InfoTip and the new "?" sit in
  // the header, so each needs its own wrapper or asking the question re-sorts
  // the table. Anchored on the raw source so the JSX-comment strip cannot hide
  // a missing wrapper.
  const header = rawPage.slice(
    rawPage.indexOf("key: 'requiresCredential'"),
    rawPage.indexOf("key: '_actions'"),
  );
  assert.ok(header.includes('<InfoTip'), 'the requiresCredential header lost its InfoTip');
  assert.ok(header.includes('<PageHelpButton'), 'the requiresCredential header has no "?"');
  const wrappers = (header.match(/onClick=\{e => e\.stopPropagation\(\)\}/g) || []).length;
  assert.equal(
    wrappers, 2,
    'both the InfoTip and the "?" in the sortable Credential header need their '
    + `own stopPropagation wrapper, found ${wrappers}`,
  );
});

test('no point-of-decision microcopy was traded for a "?"', () => {
  // Scope — out: the ticket expands the topic and adds "?" links. Every hint
  // below sits at the moment a decision is made and must stay on the page.
  const kept = [
    // the ${credential} template hint (server form)
    'as the placeholder for the bound credential',
    'the orchestrator substitutes it per-agent at seed time',
    'become HTTP request headers',
    "they're injected as process environment variables",
    // the transport option labels
    'stdio (local subprocess)',
    'http (remote endpoint, streamable HTTP)',
    'sse (remote endpoint, Server-Sent Events)',
    // the 0600 secret-storage note (credential form)
    'with mode 0600',
    'never returned by the API — only its fingerprint',
    // the id help in the two create forms
    'Used as the key in',
    'Used as the filename of the stored secret',
    // and the Default-server hint, which the topic now also explains
    'A hint only. Environments may pair this credential with any compatible server.',
  ];
  for (const phrase of kept) {
    assert.ok(page.includes(phrase), `"${phrase}" is point-of-decision copy and must stay on the page`);
  }
  // The id hint must keep referencing the shared constant (id-help-consistency).
  assert.ok(page.includes('{ID_FORMAT_HINT}'), 'the id help stopped using ID_FORMAT_HINT');
});

test('the topic states the Working Environments form has no MCP picker', () => {
  // The ticket's edge case: a "?" on this page must not imply a control that
  // does not exist. E9 flagged it; a reword must not quietly drop it.
  assert.match(
    topicBody,
    /Working Environments \*\*form exposes no MCP picker\*\*/,
    'the topic must keep saying the Working Environments form exposes no MCP picker',
  );
});

test('the page keeps exactly one page-level "?" in its header line', () => {
  // A second entry point in the header would compete with the one the epic
  // standardised on; the other three buttons live inside the two panels and the
  // table header, not in this paragraph.
  const headerLine = page.slice(page.indexOf('Runtime knowledge sources'), page.indexOf('{actionError'));
  assert.equal(
    (headerLine.match(/<PageHelpButton/g) || []).length, 1,
    'expected exactly one page-level "?" next to the page description',
  );
});
