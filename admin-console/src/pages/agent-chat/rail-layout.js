/**
 * Pure width resolution for the agent-chat three-pane layout
 * (agent list | chat | right rail).
 *
 * Extracted from AgentChat.jsx when the right rail moved from
 * "unmount on collapse" to the left-navigation-sidebar pattern
 * ("animate down to a slim icon rail", #905): the rail now always
 * occupies space, so the clamp has to budget for the collapsed rail
 * instead of treating it as zero-width.
 *
 * The stored (drag-resized) `rightWidth` is never rewritten here — a
 * collapse/expand cycle must restore exactly the width the user dragged
 * to, so the collapsed width is only ever a *rendered* value.
 */

/**
 * Rendered width of the collapsed rail, in px.
 *
 * The rail itself is styled with `var(--eb-sidebar-collapsed)` so it stays
 * visually identical to the left nav's collapsed rail; this constant is the
 * matching layout *budget* used to clamp the other panes. Keep the two in
 * sync (tokens.css: `--eb-sidebar-collapsed: 56px`).
 */
export const COLLAPSED_RAIL_WIDTH = 56;

/**
 * Width reserved (px) for the overflow "⋯" toggle when it is shown.
 *
 * Only a layout *budget* for the fit computation — the button sizes itself.
 */
export const OVERFLOW_BTN_WIDTH = 40;

/**
 * How many of the rail's tabs fit in the tab strip, left to right.
 *
 * Whatever doesn't fit belongs in the overflow "⋯" menu, so the answer has to
 * account for the toggle's own width — but only once we know an overflow menu
 * is needed at all, otherwise a strip that fits exactly would spill its last
 * tab for no reason.
 *
 * At least one tab is always kept: a strip too narrow for even the first tab
 * still reads as "one tab plus ⋯" rather than as a bare ⋯ button.
 *
 * @param {object}   opts
 * @param {number}   opts.stripWidth     measured width of the tab strip
 * @param {number[]} opts.tabWidths      natural width of each tab, in tab order
 * @param {number}   opts.closeWidth     width of the collapse button sharing the strip
 * @param {number}   opts.overflowWidth  budget for the "⋯" toggle
 * @returns {number} count of leading tabs to render inline (0 when there are no tabs)
 */
export function fitTabCount({
  stripWidth,
  tabWidths,
  closeWidth = 0,
  overflowWidth = OVERFLOW_BTN_WIDTH,
}) {
  const widths = Array.isArray(tabWidths) ? tabWidths : [];
  if (widths.length === 0) return 0;

  const total = widths.reduce((a, b) => a + b, 0);
  // Everything fits alongside the close button → no overflow menu, no budget
  // for a toggle that won't be rendered.
  if (total <= stripWidth - closeWidth) return widths.length;

  const budget = stripWidth - closeWidth - overflowWidth;
  let used = 0;
  let count = 0;
  for (const w of widths) {
    if (used + w > budget) break;
    used += w;
    count += 1;
  }
  return Math.max(1, count);
}

/**
 * Clamp the stored panel widths so that
 * `left + rail + dividers + chatMin` never exceeds the container.
 *
 * The right rail gives way first, then the left one — the stored
 * preferences stay untouched, so the layout springs back when space
 * returns.
 *
 * @param {object}  opts
 * @param {?number} opts.containerW  measured container width, or null before the first measure
 * @param {number}  opts.leftWidth   stored agent-list width
 * @param {number}  opts.rightWidth  stored (drag-resized) rail width
 * @param {boolean} opts.collapsed   rail collapsed to the icon rail?
 * @returns {{left: number, right: number}} widths to render
 */
export function resolveRailWidths({
  containerW,
  leftWidth,
  rightWidth,
  collapsed = false,
  chatMin = 280,
  leftMin = 160,
  rightMin = 200,
  dividersW = 24,
}) {
  // A collapsed rail is a fixed-width strip: it is not resizable and never
  // shrinks below the icon rail, so it drops out of the give-way order.
  let right = collapsed ? COLLAPSED_RAIL_WIDTH : rightWidth;
  let left = leftWidth;

  if (containerW != null) {
    const available = Math.max(0, containerW - dividersW - chatMin);
    if (left + right > available) {
      if (!collapsed) {
        right = Math.max(rightMin, available - left);
      }
      if (left + right > available) {
        left = Math.max(leftMin, available - right);
      }
    }
  }

  return { left, right };
}
