import test from 'node:test';
import assert from 'node:assert/strict';

import { COLLAPSED_RAIL_WIDTH, resolveRailWidths } from './rail-layout.js';

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
