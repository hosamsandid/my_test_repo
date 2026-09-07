import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createEntries, entriesByTier, hasPreview, CREATE_COPY,
} from './create-launcher-view.js';

// ─── #2027 Create-launcher wiring guard ──────────────────────────────────────
//
// The launcher's ranking is a claim about the RENDERED page: a hero first, then
// exactly one grouped flow section, then a collapsed disclosure. The pure module
// can only assert the data; three things live in the JSX and each of them fails
// silently rather than loudly:
//
//   • a preview schematic named by an entry with no component behind it — the
//     reveal then renders nothing and looks like "this card has no preview";
//   • a card that genuinely has no preview (#2034: the hero and the advanced
//     entry) still rendering the reveal path — a hidden or inert eye control is
//     indistinguishable from a removed one until a screen reader or the tab key
//     reaches it;
//   • the eye affordance sliding INSIDE the entry's <Link>, which is invalid
//     HTML and makes the preview swallow the card's own tap (AC5);
//   • the tiers being rendered out of order, or the disclosure defaulting open,
//     which is exactly the flat five-option page the ticket removed.
//
// So this is a source-text guard over the JSX `node --test` cannot import (#651
// convention), and it asserts SURVIVAL of the neighbouring wiring too — the
// absence assertions below would otherwise pass just as well against a page
// that had lost the launcher entirely.

const here = dirname(fileURLToPath(import.meta.url));

// Comments are stripped first: this ticket's own comments name the very strings,
// tiers and rules being checked, and would satisfy matchers they merely explain.
function sourceOf(file) {
  return readFileSync(join(here, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const page = sourceOf('Create.jsx');
const previews = sourceOf('create-previews.jsx');
const rawPage = readFileSync(join(here, 'Create.jsx'), 'utf8');

test('the comment strip really strips (a vacuous guard is worse than none)', () => {
  assert.ok(rawPage.includes('//'), 'Create.jsx is expected to carry comments');
  assert.ok(
    rawPage.length > page.length,
    'the strip removed nothing — every absence assertion below would be vacuous',
  );
  assert.ok(page.includes('export default function Create'), 'the strip ate the code');
});

test('every schematic an entry names has a component behind it', () => {
  for (const entry of createEntries().filter(hasPreview)) {
    const name = entry.preview.schematic;
    assert.match(
      previews,
      new RegExp(`\\n\\s{2}${name}:\\s*\\w+Schematic,`),
      `create-previews.jsx has no CREATE_PREVIEWS["${name}"] for the ${entry.key} entry — `
      + 'the reveal would render nothing at all',
    );
  }
  // And nothing in the map is unreachable: a schematic no entry claims is dead
  // weight that reads as coverage. This is what made #2034 delete the chat and
  // form drawings rather than leave them behind their removed entries.
  const claimed = new Set(createEntries().filter(hasPreview).map((e) => e.preview.schematic));
  const mapped = [...previews.matchAll(/\n\s{2}(\w+):\s*\w+Schematic,/g)].map((m) => m[1]);
  assert.deepEqual(
    mapped.filter((k) => !claimed.has(k)), [],
    'CREATE_PREVIEWS holds a schematic no launcher entry names',
  );
  assert.equal(mapped.length, claimed.size);
});

test('the schematics are theme-token drawings, and decorative to a screen reader', () => {
  // A hard-coded colour survives a theme switch as an unreadable smudge; the
  // whole reason these are hand-drawn is that they cost nothing to keep
  // theme-aware. (The one rgba() is the reveal panel's shadow, in Create.jsx.)
  assert.doesNotMatch(previews, /#[0-9a-fA-F]{3,8}\b/, 'no literal hex colours in a schematic');
  assert.match(previews, /var\(--eb-accent-primary\)/);
  assert.match(previews, /var\(--eb-border-default\)/);
  // The caption carries the meaning; the drawing must not be announced.
  assert.match(previews, /aria-hidden="true"/);
  assert.match(previews, /role="presentation"/);
  // A screenshot would drift silently — assert the medium stays vector.
  assert.doesNotMatch(previews, /<img\b/, 'previews must stay schematic SVG, never screenshots');
});

test('the three tiers are rendered in order: hero, flow group, advanced', () => {
  const heroAt = page.indexOf('variant="hero"');
  const flowAt = page.indexOf('CREATE_COPY.flowHeading');
  const advancedAt = page.indexOf('CREATE_COPY.advancedToggle');
  assert.ok(heroAt > -1, 'the hero card must be rendered');
  assert.ok(flowAt > -1, 'the flow group heading must be rendered');
  assert.ok(advancedAt > -1, 'the Advanced disclosure toggle must be rendered');
  assert.ok(heroAt < flowAt, 'the hero must be rendered above the flow group (AC1)');
  assert.ok(
    flowAt < advancedAt,
    'the Advanced disclosure must come last — it may never precede, let alone hide, '
    + 'the hero or the flow section',
  );
  // The hero is the ONLY card drawn full-width/primary.
  assert.equal((page.match(/variant="hero"/g) || []).length, 1);
});

test('the flow group is one bordered section holding exactly the flow tier', () => {
  assert.match(page, /<section\b/, 'the three flow cards must sit in one grouping element');
  // They are rendered from the tier, not hand-listed — a hand-listed set is how
  // a fourth card ends up in the group without a heading that admits it.
  assert.match(page, /entriesByTier\('flow'\)/);
  assert.match(page, /flowCards\.map\(/);
  assert.equal(entriesByTier('flow').length, 3, 'AC1 — exactly three cards');
  // Narrow widths stack them while they stay inside the one group (edge case).
  assert.match(page, /repeat\(auto-fit, minmax\(/);
});

test('the Advanced disclosure starts collapsed and is never persisted', () => {
  assert.match(
    page, /useState\(ADVANCED_DEFAULT_OPEN\)/,
    'the disclosure default must come from the pure module, not a literal',
  );
  assert.doesNotMatch(
    page, /localStorage/,
    'open question 3 answered: the expanded state is deliberately not remembered, '
    + 'so "collapsed on first load for every user" holds on every load',
  );
  assert.match(page, /aria-expanded=\{advancedOpen\}/);
  // The advanced entry is rendered only inside the open branch.
  assert.match(page, /advancedOpen && advanced\.map\(/);
});

test('AC5 — the preview affordance is a sibling of the card link, not a child', () => {
  const linkOpen = page.indexOf('<Link');
  const linkClose = page.indexOf('</Link>');
  assert.ok(linkOpen > -1 && linkClose > linkOpen, 'the entry card must stay a <Link>');
  const previewBtn = page.indexOf('data-testid={`create-preview-');
  assert.ok(previewBtn > -1, 'each entry must carry its own preview control');
  assert.ok(
    previewBtn > linkClose,
    'the preview <button> is inside the <Link>: that is invalid HTML and its tap '
    + "would be swallowed by (or would swallow) the card's own navigation",
  );
  // It is independently focusable and labelled (touch edge case), and reports
  // its state.
  assert.match(page, /aria-label=\{previewToggleLabel\(entry, shown\)\}/);
  assert.match(page, /aria-expanded=\{shown\}/);
  // Exactly one <Link> per card, and the card is still the click target (AC7):
  // the hero's "Start chatting" is a <span> inside it, never a nested button.
  assert.equal((page.match(/<Link\b/g) || []).length, 1);
  const actionAt = page.indexOf('{entry.action}');
  assert.ok(actionAt > linkOpen && actionAt < linkClose, 'the hero CTA stays inside the link');
});

test('#2034 — the reveal path is absent from a preview-less card, not hidden', () => {
  // The whole edge case of #2034: a card with no preview must render no
  // schematic, no eye control and no hover/focus state — so it leaves behind no
  // orphan focus target and no screen-reader label for a preview that does not
  // exist. CSS-hiding, or a rendered-but-disabled control, would pass the pure
  // tests and fail the ticket.
  const cardAt = page.indexOf('function EntryCard');
  const previewCardAt = page.indexOf('function PreviewableEntryCard');
  assert.ok(cardAt > -1, 'EntryCard must stay the one entry-point every tier renders');
  assert.ok(
    previewCardAt > cardAt,
    'the preview-bearing card must be its own component, so its state exists only '
    + 'where a reveal does',
  );

  // The gate is the pure helper, not a tier or a key list: the tier is only
  // where the previews happen to live today.
  assert.match(page, /if \(!hasPreview\(entry\)\)/);
  assert.doesNotMatch(page, /entry\.tier === 'flow'/, 'the gate must not key on the tier');

  // The preview-less branch renders the card and nothing else.
  const plainBranch = page.slice(cardAt, previewCardAt);
  assert.match(plainBranch, /<EntryLink entry=\{entry\} variant=\{variant\} \/>/);
  for (const banned of ['setHovered', 'setPinned', 'create-preview-', 'PreviewReveal', '<Eye']) {
    assert.ok(
      !plainBranch.includes(banned),
      `the preview-less branch still carries "${banned}" — the reveal path has to be `
      + 'absent from the hero and the advanced entry, not merely inert',
    );
  }

  // Exactly one of each affordance in the whole page: two copies would mean the
  // preview-less branch grew its own.
  assert.equal((page.match(/data-testid=\{`create-preview-/g) || []).length, 1);
  assert.equal((page.match(/<PreviewReveal\b/g) || []).length, 1);
  assert.equal((page.match(/<Eye\b/g) || []).length, 1);

  // And the entries themselves still divide the way the ticket says.
  assert.deepEqual(
    createEntries().filter(hasPreview).map((e) => e.key),
    ['template', 'describe', 'build'],
    'AC3 — the three flow cards keep their preview; AC1/AC2 — the other two have none',
  );
});

test('AC5 — the reveal is hover AND keyboard focus, with no animation at all', () => {
  // Parity per the shared-tooltip standard (#1850): a keyboard user gets the
  // same preview as a mouse user, and the eye control is the touch path.
  assert.match(page, /onMouseEnter=\{\(\) => setHovered\(true\)\}/);
  assert.match(page, /onMouseLeave=\{\(\) => setHovered\(false\)\}/);
  assert.match(page, /onFocus=\{\(\) => setHovered\(true\)\}/);
  assert.match(page, /onBlur=\{\(\) => setHovered\(false\)\}/);
  // A pinned (tapped) preview must not be closed by the mouse leaving, or the
  // touch affordance would be useless on a device that also reports hover.
  assert.match(page, /const shown = hovered \|\| pinned/);

  // The reveal mounts and unmounts, full stop. That is why there is no separate
  // prefers-reduced-motion branch: there is no motion to reduce. If an
  // animation is ever added, this fails and the media query becomes required.
  const revealAt = page.indexOf('function PreviewReveal');
  const revealEnd = page.indexOf('\nfunction EntryCard');
  assert.ok(revealAt > -1 && revealEnd > revealAt, 'PreviewReveal must stay its own component');
  const reveal = page.slice(revealAt, revealEnd);
  for (const banned of ['transition', 'animation', '@keyframes', 'transform']) {
    assert.ok(
      !reveal.includes(banned),
      `the preview reveal uses "${banned}" — either drop it or add a `
      + 'prefers-reduced-motion fallback, which the plain show/hide made unnecessary',
    );
  }
  // It also must not steal the pointer from what sits under it.
  assert.match(reveal, /pointerEvents: 'none'/);
});

test('every visible string comes from the pure module, never inlined in the JSX', () => {
  // AC4 makes the copy binding, so it lives in one asserted place. An inlined
  // duplicate is what makes a "binding inventory" quietly stop being one.
  for (const [key, value] of Object.entries(CREATE_COPY)) {
    assert.ok(
      !page.includes(value),
      `CREATE_COPY.${key} is written out as a literal in Create.jsx — render `
      + 'CREATE_COPY instead',
    );
    assert.ok(page.includes(`CREATE_COPY.${key}`), `CREATE_COPY.${key} is never rendered`);
  }
  for (const entry of createEntries()) {
    // `badge` is deliberately NOT in this list: its value doubles as the tone
    // key the renderer compares against ("Advanced" → muted), so the string has
    // to appear here. It is still rendered from the entry, asserted below.
    for (const field of ['title', 'description', 'outcome']) {
      if (!entry[field]) continue;
      assert.ok(
        !page.includes(entry[field]),
        `the ${entry.key} entry's ${field} is inlined in Create.jsx`,
      );
    }
    if (hasPreview(entry)) {
      assert.ok(!page.includes(entry.preview.caption), `${entry.key}'s caption is inlined`);
    }
  }
  for (const rendered of ['{entry.title}', '{entry.description}', '{entry.outcome}', '{entry.badge}']) {
    assert.ok(page.includes(rendered), `Create.jsx never renders ${rendered}`);
  }
  // The badge TONE is a rendering decision and may live here — but it must key
  // on the entry's own badge, so a new badge cannot silently render as accent.
  assert.match(page, /entry\.badge === 'Advanced' \? 'muted' : 'accent'/);
});

test('AC8 — the header "?" carries the inventory tooltip and its own chapter', () => {
  assert.match(page, /label=\{CREATE_COPY\.headerHelp\}/);
  assert.match(page, /section=\{CREATE_HELP_SECTIONS\.entryPaths\}/);
  // One page-level affordance, not one per card: the preview is the per-entry
  // explanation, and a "?" on every card would be a second entry point into the
  // same chapter.
  assert.equal((page.match(/<PageHelpButton/g) || []).length, 1);
});

test('survival — the launcher still hosts the direct create form unchanged', () => {
  // Every absence assertion above would also pass against a Create.jsx that had
  // lost the #1956 panel, so pin what must still be here.
  assert.match(page, /<SidePanel/);
  assert.match(page, /<AgentCreateForm/);
  assert.match(page, /isSingleAgentFormOpen\(searchParams\)/);
  assert.match(page, /apiCall\('POST', '\/api\/agents', form\)/);
  assert.match(page, /createdAgentDestination\(/);
  // ...and that each entry is still a real navigation to its own route (AC7).
  assert.match(page, /to=\{entry\.to\}/);
  assert.match(page, /data-testid=\{`create-entry-\$\{entry\.key\}`\}/);
});
