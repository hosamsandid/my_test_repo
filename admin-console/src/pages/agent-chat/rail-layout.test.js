import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLLAPSED_RAIL_WIDTH,
  OVERFLOW_BTN_WIDTH,
  fitTabCount,
  resolveRailWidths,
} from './rail-layout.js';

// Roomy container: nothing needs clamping.
const WIDE = 2000;

test('expanded: stored widths render unchanged when they fit', () => {
  const { left, right } = resolveRailWidths({ containerW: WIDE, leftWidth: 260, rightWidth: 380 });
  assert.equal(left, 260);
  assert.equal(right, 380);
});

test('collapsed: the rail renders at the icon-rail width', () => {
  const { right } = resolveRailWidths({
    containerW: WIDE, leftWidth: 260, rightWidth: 380, collapsed: true,
  });
  assert.equal(right, COLLAPSED_RAIL_WIDTH);
});

test('collapsed: an extreme drag-resized width is not carried into the render', () => {
  // AC6 — expanding restores the stored width, so collapsing must ignore it
  // entirely rather than scale it down.
  for (const rightWidth of [200, 380, 1600]) {
    const { right } = resolveRailWidths({
      containerW: WIDE, leftWidth: 260, rightWidth, collapsed: true,
    });
    assert.equal(right, COLLAPSED_RAIL_WIDTH, `rightWidth=${rightWidth}`);
  }
});

test('collapse then expand round-trips to exactly the stored width', () => {
  const stored = { containerW: WIDE, leftWidth: 260, rightWidth: 512 };
  const collapsed = resolveRailWidths({ ...stored, collapsed: true });
  const expanded = resolveRailWidths({ ...stored, collapsed: false });
  assert.equal(collapsed.right, COLLAPSED_RAIL_WIDTH);
  assert.equal(expanded.right, 512);
  assert.equal(expanded.left, 260);
});

test('expanded + narrow container: the rail gives way first, down to its minimum', () => {
  // 900 - 24 dividers - 280 chat = 596 available for both rails.
  const { left, right } = resolveRailWidths({ containerW: 900, leftWidth: 260, rightWidth: 800 });
  assert.equal(left, 260);
  assert.equal(right, 596 - 260);
});

test('expanded + very narrow container: the left rail gives way after the right one', () => {
  // 700 - 24 - 280 = 396 available; right floors at 200 → left gets 196,
  // which is still above LEFT_MIN (160).
  const { left, right } = resolveRailWidths({ containerW: 700, leftWidth: 400, rightWidth: 800 });
  assert.equal(right, 200);
  assert.equal(left, 196);
});

test('expanded: both rails floor at their minimums when nothing fits', () => {
  const { left, right } = resolveRailWidths({ containerW: 300, leftWidth: 400, rightWidth: 800 });
  assert.equal(right, 200);
  assert.equal(left, 160);
});

test('collapsed + narrow container: the icon rail keeps its width, the left rail gives way', () => {
  // Edge case "narrow viewports": the 56px icon rail plus chat must still fit,
  // so the agent list is what shrinks. 560 - 24 - 280 = 256 available.
  const { left, right } = resolveRailWidths({
    containerW: 560, leftWidth: 400, rightWidth: 800, collapsed: true,
  });
  assert.equal(right, COLLAPSED_RAIL_WIDTH);
  assert.equal(left, 256 - COLLAPSED_RAIL_WIDTH);
});

test('collapsed: the left rail still floors at its minimum', () => {
  const { left, right } = resolveRailWidths({
    containerW: 320, leftWidth: 400, rightWidth: 800, collapsed: true,
  });
  assert.equal(right, COLLAPSED_RAIL_WIDTH);
  assert.equal(left, 160);
});

test('collapsing frees space, so a clamped left rail can grow back', () => {
  const narrow = { containerW: 700, leftWidth: 400, rightWidth: 800 };
  const expanded = resolveRailWidths(narrow);
  const collapsed = resolveRailWidths({ ...narrow, collapsed: true });
  assert.ok(collapsed.left > expanded.left);
  assert.equal(collapsed.left, 396 - COLLAPSED_RAIL_WIDTH);
});

test('before the first measure (containerW null) the stored widths pass through', () => {
  const { left, right } = resolveRailWidths({ containerW: null, leftWidth: 260, rightWidth: 380 });
  assert.equal(left, 260);
  assert.equal(right, 380);
});

test('before the first measure the collapsed rail still renders collapsed', () => {
  const { right } = resolveRailWidths({
    containerW: null, leftWidth: 260, rightWidth: 380, collapsed: true,
  });
  assert.equal(right, COLLAPSED_RAIL_WIDTH);
});

test('the icon-rail budget matches the --eb-sidebar-collapsed token', () => {
  assert.equal(COLLAPSED_RAIL_WIDTH, 56);
});

// --- fitTabCount -----------------------------------------------------------
// The five real tabs, roughly to scale (icon + label + padding); Sessions is
// the widest because it can carry a count badge.
const TABS = [104, 108, 96, 82, 108];
const CLOSE = 40;
const TOTAL = TABS.reduce((a, b) => a + b, 0); // 498

test('every tab is shown when the strip has room for all of them plus the close button', () => {
  assert.equal(fitTabCount({ stripWidth: 800, tabWidths: TABS, closeWidth: CLOSE }), TABS.length);
});

test('an exact fit does not spill a tab into the overflow menu', () => {
  // No overflow menu is needed, so no budget is reserved for the toggle.
  assert.equal(fitTabCount({ stripWidth: TOTAL + CLOSE, tabWidths: TABS, closeWidth: CLOSE }), TABS.length);
});

test('one pixel short of an exact fit spills, and pays for the overflow toggle', () => {
  const count = fitTabCount({ stripWidth: TOTAL + CLOSE - 1, tabWidths: TABS, closeWidth: CLOSE });
  assert.ok(count < TABS.length, 'expected at least one tab to spill');
  // budget = 497 - 40 - 40 = 417 → 104+108+96 = 308 fit, +82 = 390 fit, +108 over.
  assert.equal(count, 4);
});

test('a narrow strip keeps only the tabs that fit inside the reserved budget', () => {
  // budget = 300 - 40 - 40 = 220 → 104 + 108 = 212 fits, +96 would be 308.
  assert.equal(fitTabCount({ stripWidth: 300, tabWidths: TABS, closeWidth: CLOSE }), 2);
});

test('AC1: a strip too narrow for even one tab still reports one, so a "..." toggle appears', () => {
  // The regression in #924 showed every tab clipped with no overflow access;
  // the fit must always leave a real tab beside the toggle, never zero.
  for (const stripWidth of [0, 40, 90, 120]) {
    const count = fitTabCount({ stripWidth, tabWidths: TABS, closeWidth: CLOSE });
    assert.equal(count, 1, `stripWidth=${stripWidth}`);
    assert.ok(count < TABS.length, `stripWidth=${stripWidth} must still overflow`);
  }
});

test('a strip measured before layout (width 0) overflows rather than rendering every tab', () => {
  assert.ok(fitTabCount({ stripWidth: 0, tabWidths: TABS, closeWidth: CLOSE }) < TABS.length);
});

test('the collapsed rail width cannot fit the tab strip, so expanding always re-measures wider', () => {
  // Mirrors the expand animation: the first measure happens at the collapsed
  // width and must converge upwards as the transition advances.
  const atCollapsed = fitTabCount({ stripWidth: COLLAPSED_RAIL_WIDTH, tabWidths: TABS, closeWidth: CLOSE });
  const atExpanded = fitTabCount({ stripWidth: 520, tabWidths: TABS, closeWidth: CLOSE });
  assert.equal(atCollapsed, 1);
  assert.ok(atExpanded > atCollapsed);
});

test('a wider close button eats into the tab budget', () => {
  const roomy = fitTabCount({ stripWidth: 400, tabWidths: TABS, closeWidth: 0 });
  const tight = fitTabCount({ stripWidth: 400, tabWidths: TABS, closeWidth: 120 });
  assert.ok(tight < roomy, `expected ${tight} < ${roomy}`);
});

test('a growing tab (the Sessions badge appearing) can push a tab into overflow', () => {
  const strip = TOTAL + CLOSE; // exactly fits today
  assert.equal(fitTabCount({ stripWidth: strip, tabWidths: TABS, closeWidth: CLOSE }), TABS.length);
  const withBadge = [TABS[0] + 22, ...TABS.slice(1)];
  assert.ok(fitTabCount({ stripWidth: strip, tabWidths: withBadge, closeWidth: CLOSE }) < TABS.length);
});

test('no tabs at all means nothing to show and nothing to overflow', () => {
  assert.equal(fitTabCount({ stripWidth: 400, tabWidths: [], closeWidth: CLOSE }), 0);
  assert.equal(fitTabCount({ stripWidth: 400, tabWidths: undefined, closeWidth: CLOSE }), 0);
});

test('the overflow toggle budget is a positive width', () => {
  assert.ok(OVERFLOW_BTN_WIDTH > 0);
});
