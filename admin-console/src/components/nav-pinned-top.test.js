import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Source-reading drift guard over `Shell.jsx` (the #651 convention — the JSX
 * itself stays uncovered, so the wiring is asserted by reading the source, the
 * same shape as `error-boundary-wiring.test.js`).
 *
 * #2035 moved the NAV_TOP tier (Agent Chat) OUT of the scrolling <nav> so it is
 * pinned under "+ Create" and never scrolls out of view. Nothing about that is
 * visible to `nav-model.js`'s pure tests: the fix is purely a render-tree
 * position, and a later refactor that folded the block back into <nav> would
 * leave every existing test green while the bug returned. This file pins the
 * position instead.
 */

function read(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

/**
 * Strip comments before asserting — the comment explaining WHY the block moved
 * out of <nav> names the very tokens being located and would otherwise be found
 * instead of the code.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SHELL = stripComments(read('./Shell.jsx'));

/** Index of the single occurrence of `needle`, asserted to be unambiguous. */
function onlyIndex(src, needle, label) {
  const first = src.indexOf(needle);
  assert.ok(first > -1, `${label} not found in Shell.jsx`);
  assert.equal(
    src.indexOf(needle, first + 1), -1,
    `${label} appears more than once — this guard's position assertions would be ambiguous`,
  );
  return first;
}

/* ─── AC1 / AC2: the pinned tier sits between "+ Create" and the <nav> ─── */

test('the NAV_TOP block renders outside the scrolling <nav> (AC1)', () => {
  const topRow = onlyIndex(SHELL, '{topItems.map(renderNavItem)}', 'the NAV_TOP render');
  const navOpen = onlyIndex(SHELL, '<nav style=', 'the <nav> element');
  const navClose = onlyIndex(SHELL, '</nav>', 'the </nav> close');

  assert.ok(navOpen < navClose, 'sanity: <nav> must open before it closes');
  assert.ok(
    topRow < navOpen,
    'the NAV_TOP tier must render BEFORE the <nav> opens — inside it, it scrolls away with the groups',
  );
});

test('the pinned tier sits below "+ Create" and above the <nav> (AC2)', () => {
  const create = onlyIndex(SHELL, "navigate('/create')", 'the "+ Create" button');
  const topRow = SHELL.indexOf('{topItems.map(renderNavItem)}');
  const navOpen = SHELL.indexOf('<nav style=');

  assert.ok(create < topRow, '"+ Create" must stay above the pinned Agent Chat entry');
  assert.ok(topRow < navOpen, 'the pinned entry must sit directly above the scrolling nav');
});

test('the pinned container is flexShrink: 0 so the flex column never squeezes it (AC1)', () => {
  const topRow = SHELL.indexOf('{topItems.map(renderNavItem)}');
  // Assert on the element IMMEDIATELY wrapping the render — the last opening
  // <div> before it. Scanning a window of preceding source would instead find
  // the `flexShrink: 0` on the "+ Create" container above and pass regardless.
  const before = SHELL.slice(0, topRow);
  const container = before.slice(before.lastIndexOf('<div style='));
  assert.match(
    container, /flexShrink:\s*0/,
    'the <div> wrapping the pinned NAV_TOP tier must declare flexShrink: 0',
  );
});

test('the <nav> renders the accordion groups and nothing else (AC2, AC5)', () => {
  const navOpen = SHELL.indexOf('<nav style=');
  const navClose = SHELL.indexOf('</nav>');
  const nav = SHELL.slice(navOpen, navClose);

  assert.match(nav, /allGroups\.map\(/, '<nav> must still render the accordion groups');
  assert.ok(
    !nav.includes('topItems'),
    'no part of the NAV_TOP tier may render inside the scrolling <nav>',
  );
  // The group machinery the move must not disturb (AC5).
  assert.match(nav, /GroupHeader/, 'the accordion headers must still render inside <nav>');
  assert.match(nav, /toggleGroup\(group\.key\)/, 'collapse/expand must still be wired');
  assert.match(nav, /overflowY:\s*'auto'/, '<nav> must remain the scroll container');
});

/* ─── AC3 / AC4: badge, rail dot and active highlight are untouched ────── */

test('the pinned entry is rendered by the shared renderNavItem (AC3, AC4)', () => {
  // `renderNavItem` is what carries the unread/busy badge, the collapsed-rail
  // dot and the active-route highlight. Rendering the pinned row through a
  // bespoke copy is exactly how those would silently drift apart.
  assert.match(
    SHELL, /\{topItems\.map\(renderNavItem\)\}/,
    'the pinned tier must render through renderNavItem, not a bespoke button',
  );
  assert.match(SHELL, /const isChat = path === '\/chats'/, 'renderNavItem must still special-case Agent Chat');
  assert.match(SHELL, /isChat && collapsed && dotColor/, 'the collapsed-rail dot must survive');
  assert.match(SHELL, /isChat && !collapsed && \(/, 'the expanded-mode badges must survive');
  assert.match(SHELL, /const isActive = path === activePath/, 'active-route highlighting must survive');
});

test('collapsed (rail) mode still routes the pinned entry through the same render (AC4)', () => {
  // Rail mode is a styling branch INSIDE renderNavItem, so pinning must not
  // introduce a `!collapsed` gate around the tier itself — that would make the
  // entry disappear from the rail entirely.
  const topRow = SHELL.indexOf('{topItems.map(renderNavItem)}');
  const gate = onlyIndex(SHELL, '{topItems.length > 0 && (', 'the NAV_TOP visibility gate');
  assert.ok(gate < topRow, 'the gate must open before the tier renders');
  // Everything between the gate and the render — i.e. the block's own
  // condition and container, not whatever precedes it in the file.
  const block = SHELL.slice(gate, topRow);
  assert.ok(
    !/collapsed/.test(block),
    'the pinned tier must not be gated on expanded mode — it renders icon-only in the rail',
  );
});

/* ─── AC6: a render-tree move only — the data model is untouched ───────── */

test('the NAV_TOP / NAV_GROUPS data model and its gating are unchanged (AC6)', () => {
  assert.match(SHELL, /const NAV_TOP = \[/, 'NAV_TOP must still be declared in Shell.jsx');
  assert.match(SHELL, /const topItems = filterItems\(NAV_TOP, gate\)/, 'role gating of NAV_TOP is unchanged');
  // #2360: the NAV_GROUPS data model is still the source and the gate is still
  // filterSections — the only change is the v2 credential consolidation transform
  // wrapped around NAV_GROUPS before filtering (My Credentials dissolved, SSH/GitHub
  // opened under the flag; a no-op off it).
  assert.match(SHELL, /const groups = filterSections\(consolidateCredentialNav\(NAV_GROUPS, \{ v2: resourceAccessV2 \}\), gate\)/, 'role gating of NAV_GROUPS is unchanged (now via consolidateCredentialNav under v2)');
  // activePath must still consider BOTH tiers, or the pinned entry loses its
  // highlight the moment a group route is longer/more specific.
  assert.match(SHELL, /\.\.\.topItems\.map\(i => i\.path\)/, 'topItems paths must stay in the activePath candidates');
});
