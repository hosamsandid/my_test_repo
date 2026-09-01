/**
 * Pure geometry helpers for the shared Tooltip component (Tooltip.jsx).
 *
 * Kept React-free and node:test-covered per the #651 pure-module convention:
 * the placement/clamp math is the only non-trivial logic in the tooltip, so it
 * lives here where it can be unit-tested; Tooltip.jsx stays a thin JSX shell.
 *
 * All inputs are plain numbers (pixels), so these functions never touch the DOM
 * and are deterministic.
 */

/**
 * Decide whether the tooltip sits above ('top') or below ('bottom') its
 * trigger. Prefer 'top' (matches the composer's original look); flip to
 * 'bottom' only when the tooltip would not fully fit above the trigger within
 * the viewport.
 *
 * @param {{top:number, bottom:number}} rect  trigger bounding rect
 * @param {number} tooltipHeight  measured tooltip height
 * @param {number} viewportHeight window.innerHeight
 * @param {number} [gap]          space between trigger and tooltip
 * @param {number} [margin]       min distance to keep from the viewport edge
 * @returns {'top'|'bottom'}
 */
export function resolveTooltipPlacement(rect, tooltipHeight, viewportHeight, gap = 6, margin = 8) {
  const fitsAbove = rect.top - gap - tooltipHeight >= margin;
  if (fitsAbove) return 'top';
  // Only flip below if there is actually more room there; otherwise keep 'top'
  // (better clipped at the top than pushed off the bottom on a tiny viewport).
  const roomBelow = viewportHeight - (rect.bottom + gap);
  const roomAbove = rect.top - gap;
  return roomBelow > roomAbove ? 'bottom' : 'top';
}

/**
 * Clamp the tooltip's horizontal centre so the (centred, translate(-50%))
 * tooltip stays fully inside the viewport with a margin on both sides.
 *
 * @param {number} centerX       desired centre X (trigger centre)
 * @param {number} tooltipWidth  measured tooltip width
 * @param {number} viewportWidth window.innerWidth
 * @param {number} [margin]      min distance to keep from the viewport edge
 * @returns {number} adjusted centre X
 */
export function clampTooltipLeft(centerX, tooltipWidth, viewportWidth, margin = 8) {
  const half = tooltipWidth / 2;
  // If the tooltip is wider than the available space, centre it as best we can.
  if (tooltipWidth + margin * 2 >= viewportWidth) return viewportWidth / 2;
  let x = centerX;
  const minX = margin + half;
  const maxX = viewportWidth - margin - half;
  if (x < minX) x = minX;
  if (x > maxX) x = maxX;
  return x;
}

/**
 * Vertical anchor Y for the tooltip given a placement. With placement 'top' the
 * tooltip is translated up by 100% of its own height, so the anchor is the
 * trigger's top edge minus the gap; with 'bottom' it is the trigger's bottom
 * edge plus the gap.
 *
 * @param {{top:number, bottom:number}} rect
 * @param {'top'|'bottom'} placement
 * @param {number} [gap]
 * @returns {number}
 */
export function tooltipAnchorTop(rect, placement, gap = 6) {
  return placement === 'bottom' ? rect.bottom + gap : rect.top - gap;
}
