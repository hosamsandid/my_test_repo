// flow-legend.js — pure decisions behind the Flow canvas legend (#2707).
//
// Two things the renderer (flow-graph-render.js, DOM code — #651) cannot test
// itself:
//
// 1. The outcome-keyed label edge (#828) is amber, the same hue as the ◇ switch
//    badge, the yellow outcome ports and the drag preview. It had no legend
//    entry, and the legend used that very amber for the dashed *webhook* edge,
//    so a solid amber outcome edge read as "webhook". The outcome edge now has
//    its own key, and webhooks move to lime so every legend hue is unique.
//
// 2. The expanded legend floats over the bottom-left of the canvas. Fit used
//    the whole viewport height, so nodes there ended up underneath it. Fit now
//    reserves the band the legend occupies (`fitTransform`'s `reserveBottom`).

export const OUTCOME_EDGE_COLOR = '#eab308';   // amber — matches the ◇ switch badge (#828)
export const OUTCOME_EDGE_LEGEND = 'outcome → label';
export const WEBHOOK_EDGE_COLOR = '#84cc16';   // lime — was amber, clashed with outcome edges

// Gap between the legend and the viewport's bottom edge (its CSS `bottom`), and
// the breathing room kept between the fitted graph and the legend's top edge.
export const LEGEND_BOTTOM_OFFSET = 12;
export const LEGEND_GAP = 8;

// Pixels Fit must keep free at the bottom of the viewport for the legend.
// `legendHeight` is the legend's rendered height (0 / missing when it is not
// laid out). Capped at half the viewport so a very tall, wrapped legend on a
// short canvas can never squeeze the graph to nothing.
export function legendReserve(legendHeight, viewportHeight) {
  const h = Number(legendHeight);
  if (!Number.isFinite(h) || h <= 0) return 0;
  const reserve = h + LEGEND_BOTTOM_OFFSET + LEGEND_GAP;
  const cap = Math.max(0, Number(viewportHeight) || 0) / 2;
  return Math.min(reserve, cap);
}

// Zoom + pan that fit `bounds` (canvas coordinates) into a `vw`×`vh` viewport,
// leaving `reserveBottom` pixels free at the bottom. `pad` is the canvas-space
// margin around the content on every side. Same maths the renderer always used
// when `reserveBottom` is 0.
export function fitTransform({ bounds, vw, vh, reserveBottom = 0, pad = 50, maxZoom = 1.5, minZoom = 0.1 }) {
  const { minX, minY, maxX, maxY } = bounds;
  const availH   = Math.max(1, vh - Math.max(0, reserveBottom));
  const contentW = maxX - minX + 2 * pad;
  const contentH = maxY - minY + 2 * pad;
  let zoom = Math.min(vw / contentW, availH / contentH, maxZoom);
  zoom = Math.max(zoom, minZoom);
  return {
    zoom,
    panX: (vw - contentW * zoom) / 2 - minX * zoom + pad * zoom,
    panY: (availH - contentH * zoom) / 2 - minY * zoom + pad * zoom,
  };
}
