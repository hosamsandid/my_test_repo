// pan-clamp.js — pure pan bounds for the Flows canvas.
//
// Pan and zoom are one CSS `transform: translate() scale()` on the canvas that
// holds the whole graph, and until now nothing bounded the translation. Dragging
// the board the SAME way repeatedly — grab, sweep right, release, grab again,
// sweep right again, which is exactly how you scroll a board that is wider than
// the screen — therefore accumulates the offset without limit: measured against
// the real 81-BP pack, 8 s of that gesture reached translate(354 225px) and 20 s
// reached translate(1 236 205px). Two consequences:
//
//   • the graph is simply gone, and only "Fit to view" brings it back, and
//   • the compositor is handed a layer positioned a million-plus pixels away,
//     which is far outside what a tiling rasteriser is built for.
//
// So the pan is clamped to the content: you may drag until the last `margin`
// pixels of the graph reach the opposite edge of the viewport, and no further.
// That is the same "no over-scroll past the content" rule every map and canvas
// UI uses, and it bounds the offset to roughly the content size plus one
// viewport at any zoom level.
//
// Pure and DOM-free so it can be unit-tested; the renderer supplies the measured
// content box and the viewport size.

// How much of the graph must stay on screen, in CSS px. Small enough that you can
// still park the board at the edge to work on one corner, large enough that it
// can never be lost.
const PAN_MARGIN = 80;

/**
 * Clamp a pan offset so the content stays reachable.
 *
 * Screen position of the content is `content * zoom + pan`, so keeping its right
 * edge at or past `margin` and its left edge at or before `viewportW - margin`
 * gives the two bounds below. When the content is smaller than the viewport the
 * range is simply wider — the formulas need no special case.
 *
 * @param {{x:number,y:number}} pan            desired offset
 * @param {object} opts
 * @param {number} opts.zoom                   current scale (<= 0 is treated as 1)
 * @param {number} opts.viewportW
 * @param {number} opts.viewportH
 * @param {?{minX:number,minY:number,maxX:number,maxY:number}} opts.content
 *        measured content box in canvas coordinates; null/absent → no clamping
 *        (fail open: never fight a layout we could not measure)
 * @param {number} [opts.margin]
 * @returns {{x:number,y:number}} the clamped offset
 */
function clampPan(pan, { zoom, viewportW, viewportH, content, margin = PAN_MARGIN } = {}) {
  const x = pan && Number.isFinite(pan.x) ? pan.x : 0;
  const y = pan && Number.isFinite(pan.y) ? pan.y : 0;
  if (!content) return { x, y };
  const { minX, minY, maxX, maxY } = content;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return { x, y };

  const z = zoom > 0 ? zoom : 1;
  // Keep the margin below half the viewport, so the allowed range never inverts
  // on a very small viewport.
  const mx = Math.min(margin, Math.max(0, viewportW / 2 - 1));
  const my = Math.min(margin, Math.max(0, viewportH / 2 - 1));

  return {
    x: clamp(x, mx - maxX * z, viewportW - mx - minX * z),
    y: clamp(y, my - maxY * z, viewportH - my - minY * z),
  };
}

function clamp(v, lo, hi) {
  if (!(hi > lo)) return v;          // degenerate range → leave the value alone
  return v < lo ? lo : (v > hi ? hi : v);
}

export { PAN_MARGIN, clampPan };
