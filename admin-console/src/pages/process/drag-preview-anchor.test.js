import test from 'node:test';
import assert from 'node:assert/strict';

import {
  previewStrokeColor,
  screenPointToCanvas,
  portRectAnchor,
  PREVIEW_ACCENT,
  PREVIEW_AMBER,
} from './drag-preview-anchor.js';

// ── preview colour by port kind (AC6) ──────────────────────────────────────
test('outcome and artifact ports are amber; ● / unknown is accent', () => {
  assert.equal(previewStrokeColor('outcome'), PREVIEW_AMBER);
  assert.equal(previewStrokeColor('artifact'), PREVIEW_AMBER);
  assert.equal(previewStrokeColor('handoff'), PREVIEW_ACCENT);
  assert.equal(previewStrokeColor(undefined), PREVIEW_ACCENT);
  assert.equal(previewStrokeColor('anything-else'), PREVIEW_ACCENT);
});

test('the amber preview colour matches the yellow port glyph colour #eab308', () => {
  // Guards AC6: the amber preview must equal the outcome dot / badge colour used
  // in flow-graph-render.js so a yellow-port drag no longer reads as purple.
  assert.equal(PREVIEW_AMBER, '#eab308');
});

// ── screen → canvas transform ───────────────────────────────────────────────
const VP = { left: 100, top: 50 }; // viewport origin on screen

test('at zoom 1 / no pan, canvas point is screen point minus viewport origin', () => {
  const p = screenPointToCanvas(300, 250, VP, { x: 0, y: 0 }, 1);
  assert.deepEqual(p, { x: 200, y: 200 });
});

test('pan and zoom are inverted correctly', () => {
  // canvasX = (clientX - vp.left - pan.x) / zoom
  const p = screenPointToCanvas(300, 250, VP, { x: 40, y: 20 }, 2);
  assert.deepEqual(p, { x: (300 - 100 - 40) / 2, y: (250 - 50 - 20) / 2 });
});

// ── canvas anchor is pan/zoom invariant (AC7) ───────────────────────────────
// The SAME physical port (fixed canvas position) is rendered at different screen
// rects as the user pans/zooms; converting each screen rect back to canvas coords
// must yield the same anchor — that is why we store the anchor in canvas space.
test('same canvas port yields the same anchor across pan/zoom states', () => {
  const canvasAnchor = { x: 640, y: 360 }; // where the port lives in canvas coords
  const states = [
    { pan: { x: 0, y: 0 }, zoom: 1 },
    { pan: { x: -120, y: 75 }, zoom: 1.5 },
    { pan: { x: 300, y: -40 }, zoom: 0.6 },
  ];
  for (const { pan, zoom } of states) {
    // Forward-project the canvas anchor to the screen rect it would occupy...
    const cx = canvasAnchor.x * zoom + VP.left + pan.x;
    const cy = canvasAnchor.y * zoom + VP.top + pan.y;
    const size = 14 * zoom; // a 14px port scales with zoom on screen
    const rect = { left: cx - size / 2, top: cy - size / 2, width: size, height: size };
    // ...then recover it via portRectAnchor.
    const got = portRectAnchor(rect, VP, pan, zoom);
    assert.ok(Math.abs(got.x - canvasAnchor.x) < 1e-9, `x @zoom${zoom}: ${got.x}`);
    assert.ok(Math.abs(got.y - canvasAnchor.y) < 1e-9, `y @zoom${zoom}: ${got.y}`);
  }
});

// ── rect anchor uses the rect centre ────────────────────────────────────────
test('portRectAnchor anchors at the rect centre', () => {
  const rect = { left: 200, top: 150, width: 12, height: 12 };
  const got = portRectAnchor(rect, VP, { x: 0, y: 0 }, 1);
  // centre = (206, 156) on screen → minus viewport origin (100, 50)
  assert.deepEqual(got, { x: 106, y: 106 });
});

// ── distinct ports on one card get distinct anchors (AC2) ───────────────────
test('two outcome dots at different y give visibly distinct anchors', () => {
  const top = portRectAnchor({ left: 300, top: 100, width: 12, height: 12 }, VP, { x: 0, y: 0 }, 1);
  const bot = portRectAnchor({ left: 300, top: 140, width: 12, height: 12 }, VP, { x: 0, y: 0 }, 1);
  assert.notEqual(top.y, bot.y);
  assert.equal(bot.y - top.y, 40);
});
