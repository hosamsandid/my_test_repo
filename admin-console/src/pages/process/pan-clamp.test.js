import test from 'node:test';
import assert from 'node:assert/strict';

import { PAN_MARGIN, clampPan } from './pan-clamp.js';

// A 4000×2000 graph in a 1000×600 viewport — roughly the real proportions.
const content = { minX: 0, minY: 0, maxX: 4000, maxY: 2000 };
const view = (over = {}) => ({ zoom: 1, viewportW: 1000, viewportH: 600, content, ...over });

test('a pan that keeps the graph on screen is left untouched', () => {
  assert.deepEqual(clampPan({ x: -500, y: -200 }, view()), { x: -500, y: -200 });
  assert.deepEqual(clampPan({ x: 0, y: 0 }, view()), { x: 0, y: 0 });
});

test('dragging the graph off to the right stops at the margin', () => {
  // Content left edge may reach viewportW - margin = 920
  assert.equal(clampPan({ x: 5000, y: 0 }, view()).x, 920);
  assert.equal(clampPan({ x: 1e6, y: 0 }, view()).x, 920);
});

test('dragging the graph off to the left stops at the margin', () => {
  // Content right edge (4000) may come back to margin = 80 → pan >= 80 - 4000
  assert.equal(clampPan({ x: -1e6, y: 0 }, view()).x, 80 - 4000);
});

test('the runaway offset that repeated same-direction dragging produced is bounded', () => {
  // measured in the real app before the clamp: translate(1236205px)
  const out = clampPan({ x: 1236205, y: 101 }, view());
  assert.equal(out.x, 920);
  assert.ok(Math.abs(out.x) < 4000 + 1000, 'bounded by content + one viewport');
});

test('the bound scales with zoom, since the content grows on screen', () => {
  assert.equal(clampPan({ x: -1e6, y: 0 }, view({ zoom: 3 })).x, 80 - 4000 * 3);
  assert.equal(clampPan({ x: -1e6, y: 0 }, view({ zoom: 0.1 })).x, 80 - 400);
  // zoomed far out the whole graph is small, but it still cannot leave the screen
  assert.equal(clampPan({ x: 1e6, y: 0 }, view({ zoom: 0.1 })).x, 920);
});

test('both axes are clamped independently', () => {
  const out = clampPan({ x: 1e6, y: -1e6 }, view());
  assert.equal(out.x, 920);
  assert.equal(out.y, PAN_MARGIN - 2000);
});

test('content smaller than the viewport can still be moved around freely inside it', () => {
  const small = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
  const v = view({ content: small });
  assert.deepEqual(clampPan({ x: 300, y: 200 }, v), { x: 300, y: 200 }, 'a normal offset is kept');
  assert.equal(clampPan({ x: 1e6, y: 0 }, v).x, 920, 'but it cannot be pushed off screen');
  assert.equal(clampPan({ x: -1e6, y: 0 }, v).x, 80 - 200);
});

test('a content box that is not at the origin is handled', () => {
  const shifted = { minX: -1500, minY: -400, maxX: 500, maxY: 600 };
  const v = view({ content: shifted });
  assert.equal(clampPan({ x: 1e6, y: 0 }, v).x, 1000 - 80 - (-1500), 'left edge stops at viewportW - margin');
  assert.equal(clampPan({ x: -1e6, y: 0 }, v).x, 80 - 500);
});

test('no measurable content means no clamping (fail open)', () => {
  assert.deepEqual(clampPan({ x: 1e6, y: 1e6 }, view({ content: null })), { x: 1e6, y: 1e6 });
  assert.deepEqual(clampPan({ x: 1e6, y: 1e6 }, view({ content: undefined })), { x: 1e6, y: 1e6 });
  const nan = { minX: 0, minY: 0, maxX: NaN, maxY: 10 };
  assert.deepEqual(clampPan({ x: 1e6, y: 5 }, view({ content: nan })), { x: 1e6, y: 5 });
});

test('a non-finite pan degrades to the origin rather than propagating NaN', () => {
  assert.deepEqual(clampPan({ x: NaN, y: Infinity }, view()), { x: 0, y: 0 });
  assert.deepEqual(clampPan(null, view()), { x: 0, y: 0 });
});

test('a zero or negative zoom is treated as 1 instead of collapsing the bounds', () => {
  assert.equal(clampPan({ x: -1e6, y: 0 }, view({ zoom: 0 })).x, 80 - 4000);
  assert.equal(clampPan({ x: -1e6, y: 0 }, view({ zoom: -2 })).x, 80 - 4000);
});

test('a viewport smaller than twice the margin does not invert the range', () => {
  const out = clampPan({ x: 1e6, y: 1e6 }, view({ viewportW: 100, viewportH: 60 }));
  assert.ok(Number.isFinite(out.x) && Number.isFinite(out.y));
  assert.ok(out.x <= 100, 'still pulled back onto the tiny viewport');
});

test('the clamp is idempotent — re-clamping a clamped value changes nothing', () => {
  const once = clampPan({ x: 1e6, y: -1e6 }, view());
  assert.deepEqual(clampPan(once, view()), once);
});

test('a custom margin moves the stop line', () => {
  assert.equal(clampPan({ x: 1e6, y: 0 }, view({ margin: 0 })).x, 1000);
  assert.equal(clampPan({ x: 1e6, y: 0 }, view({ margin: 300 })).x, 700);
});
