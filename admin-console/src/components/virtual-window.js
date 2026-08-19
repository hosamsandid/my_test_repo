/**
 * Pure windowing math for list virtualization (#1685).
 *
 * Given the per-row heights of a list (measured where known, estimated
 * otherwise), the current scroll offset and the viewport height, decide which
 * contiguous slice of rows is actually on screen (plus a small overscan) and
 * how much empty space to reserve above and below that slice so the scrollbar
 * geometry stays identical to a fully-rendered list.
 *
 * This module is deliberately DOM-free so it can be unit-tested under
 * `node --test` in the `admin-console-src` CI job; the React glue that measures
 * rows and renders the window lives in VirtualList.jsx.
 */

/**
 * Prefix-sum of row heights. `offsets[i]` is the distance from the top of the
 * list to the top of row `i`; `offsets[n]` is the total list height.
 * @param {number[]} heights
 * @returns {number[]} length heights.length + 1
 */
export function prefixOffsets(heights) {
  const n = heights.length;
  const offsets = new Array(n + 1);
  offsets[0] = 0;
  for (let i = 0; i < n; i++) {
    const h = heights[i];
    offsets[i + 1] = offsets[i] + (h > 0 ? h : 0);
  }
  return offsets;
}

/**
 * Largest index `i` such that `offsets[i] <= value` (binary search over the
 * monotonic prefix-sum). Returns the row that contains the pixel at `value`.
 * @param {number[]} offsets prefix-sum array (length n+1, non-decreasing)
 * @param {number} value
 * @returns {number} index in [0, offsets.length - 1]
 */
export function itemAtOffset(offsets, value) {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Compute the visible window.
 *
 * @param {object} p
 * @param {number[]} p.heights        per-row heights (measured or estimated)
 * @param {number}   p.scrollTop      list-relative scroll offset (>= 0 at top)
 * @param {number}   p.viewportHeight visible height of the scroller
 * @param {number}  [p.overscan=4]    extra rows to render above/below the window
 * @returns {{startIndex:number, endIndex:number, topPad:number, bottomPad:number, totalHeight:number}}
 *   `endIndex` is exclusive; render rows `[startIndex, endIndex)`.
 */
export function computeWindow({ heights, scrollTop, viewportHeight, overscan = 4 }) {
  const n = heights.length;
  if (n === 0) {
    return { startIndex: 0, endIndex: 0, topPad: 0, bottomPad: 0, totalHeight: 0 };
  }
  const offsets = prefixOffsets(heights);
  const totalHeight = offsets[n];
  const vp = viewportHeight > 0 ? viewportHeight : 0;
  const top = Math.min(Math.max(scrollTop, 0), totalHeight);
  const bottom = Math.min(Math.max(scrollTop + vp, 0), totalHeight);

  let start = itemAtOffset(offsets, top);
  // First row whose top is at or past the viewport bottom is one beyond the
  // last visible row; itemAtOffset(bottom) gives the row containing `bottom`,
  // so +1 makes the slice exclusive of the first fully-below row.
  let end = itemAtOffset(offsets, bottom) + 1;

  start = Math.max(0, start - overscan);
  end = Math.min(n, end + overscan);

  return {
    startIndex: start,
    endIndex: end,
    topPad: offsets[start],
    bottomPad: totalHeight - offsets[end],
    totalHeight,
  };
}
