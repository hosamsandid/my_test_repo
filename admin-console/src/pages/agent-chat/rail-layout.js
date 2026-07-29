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
