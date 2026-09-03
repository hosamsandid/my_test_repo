import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOKEN_USAGE_HELP_SECTIONS } from './token-usage-help-sections.js';
import { topicSections, sectionSlug } from '../context/page-help-view.js';

// ─── #1994 (epic #1981) Token Usage per-surface help guard ───────────────────
//
// The Token Usage topic is now a per-surface reference, and each of the page's
// surfaces carries a "?" that opens the panel AT that surface's chapter. Two
// things can rot silently and neither throws at runtime:
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

// Comments are stripped before asserting on the source: this ticket's own
// comments name the very chapters and constants being checked, and would
// otherwise satisfy the matchers they merely explain.
function sourceOf(file) {
  return readFileSync(join(here, file), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const page = sourceOf('TokenUsage.jsx');
const topicBody = readFileSync(
  join(here, '../../api/helper-chat/help-topics/token-usage.md'), 'utf8',
);

test('every chapter slug a call site names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(TOKEN_USAGE_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/token-usage.md no longer has a heading for these chapters. Reword the '
    + 'heading back, or update TOKEN_USAGE_HELP_SECTIONS — a stale slug degrades '
    + `silently to "open the topic at the top". Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed its rule, the
  // constants would still "exist" as strings while matching nothing at runtime.
  assert.equal(sectionSlug('What the page shows'), TOKEN_USAGE_HELP_SECTIONS.page);
  assert.equal(sectionSlug('How runs are attributed'), TOKEN_USAGE_HELP_SECTIONS.attribution);
});

test('the four areas the ticket names are top-level chapters, not sub-headings', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const key of ['page', 'statistics', 'workItems', 'attribution']) {
    assert.ok(
      h2.includes(TOKEN_USAGE_HELP_SECTIONS[key]),
      `"${TOKEN_USAGE_HELP_SECTIONS[key]}" must stay a "## " chapter — the panel scrolls to `
      + 'h2/h3, but the epic asks for one clearly-headed chapter per area',
    );
  }
  // Tokens-not-costs, the four token classes, the unattributed remainder and the
  // day-filing rule are deliberately `###` *inside* those four — this is what
  // catches a fifth top-level chapter creeping in and splitting a deep-link
  // target in two.
  assert.equal(h2.length, 4, `expected exactly the four chapters, got ${h2.join(' · ')}`);
});

test('each Token Usage surface mounts a "?" pointed at its own chapter', () => {
  const wired = [
    ['the page header', 'page'],
    ['the Statistics tab', 'statistics'],
    ['the Work items tab', 'workItems'],
    ['the attribution Signals / Tier columns', 'attribution'],
  ];
  assert.ok(
    /import PageHelpButton from '\.\.\/components\/PageHelpButton'/.test(page),
    'TokenUsage must import the shared PageHelpButton',
  );
  assert.ok(
    /import \{ TOKEN_USAGE_HELP_SECTIONS \} from '\.\/token-usage-help-sections\.js'/.test(page),
    'the slugs must come from the shared registry, never be written out inline',
  );
  for (const [what, key] of wired) {
    assert.ok(
      page.includes(`TOKEN_USAGE_HELP_SECTIONS.${key}`),
      `${what} must deep-link to the ${key} chapter (never a hand-written slug)`,
    );
  }
  // Four JSX sites, five rendered buttons: the tab strip's site is inside
  // TABS.map, so it mounts once per tab. Counting sites is what notices a
  // dropped affordance — the includes() checks above cannot, because the tab
  // slugs also appear in the TABS descriptor.
  const buttons = (page.match(/<PageHelpButton/g) || []).length;
  assert.equal(
    buttons, 4,
    `expected one PageHelpButton JSX site per surface group (4), found ${buttons}`,
  );
});

test('both tabs carry a chapter, and the tab "?" does not switch tabs', () => {
  const start = page.indexOf('{TABS.map(');
  assert.ok(start > 0, 'the tab strip must still be rendered from TABS.map');
  const end = page.indexOf('))}', start);
  assert.ok(end > start, 'could not find the end of the TABS.map block');
  const strip = page.slice(start, end);

  assert.ok(
    /section=\{t\.help\}/.test(strip),
    'the tab "?" must take its chapter from the tab descriptor, so a third tab '
    + 'cannot be added without one',
  );
  // The tab <div> switches tabs on click. A bare button inside it would both
  // open the help AND yank you to a tab you were only asking about, so the
  // affordance is wrapped in the same stopPropagation span the sortable Signals
  // header already uses. Anchor on the sequence, not on either half alone.
  assert.match(
    strip,
    /onClick=\{\(e\) => e\.stopPropagation\(\)\}[\s\S]{0,200}?<PageHelpButton/,
    'the tab "?" must sit inside an onClick stopPropagation wrapper — otherwise '
    + 'asking what the other tab shows silently navigates you to it',
  );
  // Both tabs, each with its own chapter — a copy-paste that pointed both at the
  // same slug would still satisfy the section={t.help} check above.
  const decl = page.slice(page.indexOf('const TABS = ['));
  assert.ok(decl.includes('TOKEN_USAGE_HELP_SECTIONS.statistics'), 'the Statistics tab needs its chapter');
  assert.ok(decl.includes('TOKEN_USAGE_HELP_SECTIONS.workItems'), 'the Work items tab needs its chapter');
});

test('no chapter slug is written out as a literal anywhere on the page', () => {
  for (const [name, slug] of Object.entries(TOKEN_USAGE_HELP_SECTIONS)) {
    assert.ok(
      !page.includes(`'${slug}'`) && !page.includes(`"${slug}"`),
      `${name}'s slug is inlined in TokenUsage.jsx — import it from `
      + 'token-usage-help-sections.js so the drift guard above can see it',
    );
  }
});

test('the point-of-decision microcopy the ticket protects is still on the page', () => {
  // Scope — out: this ticket expands the topic and adds "?" links; it must not
  // strip a hint that sits next to the figure it qualifies. The four signal
  // names stay in the InfoTip (its size is guarded in token-usage-view.test.js).
  for (const kept of ['{COST_NOTE}', 'STAT_TILE_HELP', 'WORK_ITEM_TILE_HELP', 'TIER_SIGNAL_HELP']) {
    assert.ok(page.includes(kept), `${kept} is point-of-decision copy and must stay on the page`);
  }
  // Both InfoTip mounts survive: the Work-items table column and the per-run
  // detail. A "?" beside them is an addition, never a replacement.
  assert.equal(
    (page.match(/<InfoTip title="(Tier|Signals)"/g) || []).length, 2,
    'both attribution InfoTips (Tier in the run detail, Signals in the table) must stay',
  );
  // The tabs are still named on the page — the topic describes them, it does
  // not replace them.
  assert.match(page, /label: 'Statistics'/);
  assert.match(page, /label: 'Work items'/);
});
