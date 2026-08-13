/**
 * Pure scroll-threshold helpers for the Agent Chat transcript (#1710).
 *
 * The transcript is virtualized (#1685): rows outside the viewport are not
 * mounted and fall back to an estimated height, so the scroller's `scrollHeight`
 * under-reports the true content height until the off-screen rows are measured.
 * The *decision* of whether the viewport currently counts as "at the bottom"
 * (stick-to-bottom) or "near the top" (older-history backfill) is nonetheless a
 * pure function of the scroller geometry, so it lives here — DOM-free, unit-
 * tested under `node --test` in the `admin-console-src` CI job — while the
 * imperative "keep pinning until the estimated rows settle" loop stays in the
 * VirtualList glue (JSX, uncovered per #651).
 *
 * The 100 px threshold is a single shared constant so the two edges (bottom and
 * top) can never drift apart; the issue keeps its semantics unchanged.
 */

/** Distance in px between the bottom of the viewport and the bottom of the list. */
export const STICK_TO_BOTTOM_THRESHOLD_PX = 100;

/**
 * @param {{scrollHeight:number, scrollTop:number, clientHeight:number}} m
 * @returns {number} pixels of content still below the fold (>= 0 when there is
 *   more to scroll; ~0 at the true bottom). Never negative.
 */
export function distanceFromBottom({ scrollHeight, scrollTop, clientHeight }) {
  const d = scrollHeight - scrollTop - clientHeight;
  return d > 0 ? d : 0;
}

/**
 * True when the viewport is within `threshold` px of the bottom — i.e. the
 * transcript should stay pinned to the newest message and no "↓ new messages"
 * pill is shown.
 * @param {{scrollHeight:number, scrollTop:number, clientHeight:number}} m
 * @param {number} [threshold=STICK_TO_BOTTOM_THRESHOLD_PX]
 * @returns {boolean}
 */
export function isAtBottom(m, threshold = STICK_TO_BOTTOM_THRESHOLD_PX) {
  return distanceFromBottom(m) < threshold;
}

/**
 * True when the viewport is within `threshold` px of the top — the edge that
 * triggers older-history backfill on scroll-up.
 * @param {{scrollTop:number}} m
 * @param {number} [threshold=STICK_TO_BOTTOM_THRESHOLD_PX]
 * @returns {boolean}
 */
export function isNearTop({ scrollTop }, threshold = STICK_TO_BOTTOM_THRESHOLD_PX) {
  return scrollTop < threshold;
}
