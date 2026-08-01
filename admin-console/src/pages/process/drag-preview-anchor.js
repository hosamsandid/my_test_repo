// Pure helpers for the drag-to-connect PREVIEW line's start anchor + colour
// (#1029). The live preview (`tempEdge` in flow-graph-render.js) used to always
// start at the card's right-edge vertical centre (the ● port) and always stroke
// the accent (purple) colour, so a drag started on a yellow outcome port — or a
// draggable GitHub PR/Issue badge — drew a purple line that visibly left the
// wrong port. The completed edge was always correct; only the transient preview
// was misleading.
//
// The two decisions the renderer needs are pure and live here so they can be
// unit-tested; the DOM reads (a port's bounding rect, the viewport rect) stay in
// the renderer:
//   1. which colour the preview should be, given the grabbed port's type;
//   2. the port's anchor point in CANVAS coordinates (zoom/pan-invariant), so an
//      anchor captured at drag-start stays glued to the port while the user keeps
//      zooming/panning mid-drag (AC7).

// Preview stroke colours, mirroring the port glyph colours in flow-graph-render.js:
// the plain ● hand-off port is accent/purple; the yellow outcome ports and the
// draggable GitHub PR/Issue badge/artifact ports are amber.
export const PREVIEW_ACCENT = 'var(--eb-accent-primary)';
export const PREVIEW_AMBER = '#eab308';

// The colour the preview line should take for the grabbed port. `kind` is one of
// 'handoff' (the ● port), 'outcome' (a yellow outcome port) or 'artifact' (a
// draggable GitHub PR/Issue badge). Anything else (or undefined) falls back to
// the accent colour, matching the ● port.
export function previewStrokeColor(kind) {
  return kind === 'outcome' || kind === 'artifact' ? PREVIEW_AMBER : PREVIEW_ACCENT;
}

// Convert a screen-space point (clientX/clientY) into canvas coordinates — the
// same transform flow-graph-render.js's toCanvas() applies: subtract the viewport
// origin + current pan, divide by zoom. Canvas coordinates are invariant to later
// pan/zoom, so an anchor captured at drag-start with this stays on the port while
// the user pans/zooms.
export function screenPointToCanvas(clientX, clientY, viewportRect, pan, zoom) {
  return {
    x: (clientX - viewportRect.left - pan.x) / zoom,
    y: (clientY - viewportRect.top - pan.y) / zoom,
  };
}

// The canvas-coordinate anchor for a grabbed port, from its bounding rect. Uses
// the rect centre so the preview emanates from the visible dot/badge regardless
// of which port layout produced it: the centre-right ● port, a single or
// bottom-pinned-column outcome dot, or a top-row GitHub badge.
export function portRectAnchor(rect, viewportRect, pan, zoom) {
  return screenPointToCanvas(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
    viewportRect, pan, zoom,
  );
}
