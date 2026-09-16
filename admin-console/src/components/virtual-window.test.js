import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefixOffsets, itemAtOffset, computeWindow, computeCenteredScrollTop } from './virtual-window.js';

test('prefixOffsets builds a monotonic prefix sum and clamps negatives to 0', () => {
  assert.deepEqual(prefixOffsets([]), [0]);
  assert.deepEqual(prefixOffsets([10, 20, 5]), [0, 10, 30, 35]);
  // negative / NaN row heights are treated as 0 so offsets never go backwards
  assert.deepEqual(prefixOffsets([10, -5, 20]), [0, 10, 10, 30]);
});

test('itemAtOffset returns the row containing a pixel', () => {
  const offsets = [0, 10, 30, 35]; // rows of height 10, 20, 5
  assert.equal(itemAtOffset(offsets, 0), 0);
  assert.equal(itemAtOffset(offsets, 9), 0);
  assert.equal(itemAtOffset(offsets, 10), 1); // exactly on a boundary -> next row
  assert.equal(itemAtOffset(offsets, 29), 1);
  assert.equal(itemAtOffset(offsets, 30), 2);
  assert.equal(itemAtOffset(offsets, 999), 3); // clamps to last index
});

test('computeWindow on an empty list renders nothing', () => {
  assert.deepEqual(
    computeWindow({ heights: [], scrollTop: 0, viewportHeight: 500 }),
    { startIndex: 0, endIndex: 0, topPad: 0, bottomPad: 0, totalHeight: 0 },
  );
});

test('computeWindow at the top mounts only the visible slice + overscan', () => {
  const heights = new Array(100).fill(50); // total 5000
  const w = computeWindow({ heights, scrollTop: 0, viewportHeight: 200, overscan: 2 });
  assert.equal(w.startIndex, 0);
  // viewport 200 / 50 = rows 0..3 visible -> containing row of bottom(200) is 4,
  // +1 exclusive = 5, +2 overscan = 7
  assert.equal(w.endIndex, 7);
  assert.equal(w.topPad, 0);
  assert.equal(w.totalHeight, 5000);
  assert.equal(w.bottomPad, 5000 - 7 * 50);
});

test('computeWindow in the middle reserves space above and below', () => {
  const heights = new Array(100).fill(50);
  const w = computeWindow({ heights, scrollTop: 2500, viewportHeight: 200, overscan: 3 });
  // row at 2500 is index 50; overscan 3 -> start 47
  assert.equal(w.startIndex, 47);
  assert.equal(w.topPad, 47 * 50);
  // bottom pixel 2700 -> row 54, +1 exclusive = 55, +3 overscan = 58
  assert.equal(w.endIndex, 58);
  assert.equal(w.bottomPad, 5000 - 58 * 50);
  // the reserved space plus the rendered slice always equals the full height
  const rendered = w.totalHeight - w.topPad - w.bottomPad;
  assert.equal(w.topPad + rendered + w.bottomPad, 5000);
});

test('computeWindow clamps the window at the bottom edge', () => {
  const heights = new Array(20).fill(100); // total 2000
  const w = computeWindow({ heights, scrollTop: 1800, viewportHeight: 200, overscan: 2 });
  assert.equal(w.endIndex, 20); // never exceeds the item count
  assert.equal(w.bottomPad, 0); // nothing left below the last row
});

test('computeWindow tolerates variable row heights', () => {
  const heights = [100, 50, 300, 25, 75, 200]; // offsets 0,100,150,450,475,550,750
  const w = computeWindow({ heights, scrollTop: 160, viewportHeight: 300, overscan: 0 });
  // scrollTop 160 is inside row 2 (offset 150..450)
  assert.equal(w.startIndex, 2);
  assert.equal(w.topPad, 150);
  // bottom pixel 460 is inside row 3 (offset 450..475) -> +1 exclusive = 4
  assert.equal(w.endIndex, 4);
  assert.equal(w.totalHeight, 750);
  assert.equal(w.bottomPad, 750 - 475);
});

test('computeWindow with a zero-height viewport still yields a valid slice', () => {
  const heights = new Array(10).fill(40);
  const w = computeWindow({ heights, scrollTop: 0, viewportHeight: 0, overscan: 1 });
  assert.equal(w.startIndex, 0);
  assert.ok(w.endIndex >= 1 && w.endIndex <= 10);
  assert.equal(w.totalHeight, 400);
  assert.equal(w.topPad + w.bottomPad + (w.totalHeight - w.topPad - w.bottomPad), 400);
});

test('computeCenteredScrollTop centers a mid-list row in the viewport', () => {
  const heights = new Array(100).fill(50); // total 5000
  const offsets = prefixOffsets(heights);
  // row 50 top = 2500; viewport 200 -> center offset = 2500 - (200-50)/2 = 2425
  const top = computeCenteredScrollTop({ offsets, heights, index: 50, viewportHeight: 200, scrollHeight: 5000 });
  assert.equal(top, 2425);
});

test('computeCenteredScrollTop clamps to 0 for a row near the top', () => {
  const heights = new Array(20).fill(50); // total 1000
  const offsets = prefixOffsets(heights);
  const top = computeCenteredScrollTop({ offsets, heights, index: 0, viewportHeight: 300, scrollHeight: 1000 });
  assert.equal(top, 0);
});

test('computeCenteredScrollTop clamps to the max scrollTop for the last row', () => {
  const heights = new Array(20).fill(50); // total 1000
  const offsets = prefixOffsets(heights);
  const top = computeCenteredScrollTop({ offsets, heights, index: 19, viewportHeight: 300, scrollHeight: 1000 });
  assert.equal(top, 700); // 1000 - 300
});

test('computeCenteredScrollTop is a no-op for an out-of-range index or empty list', () => {
  assert.equal(computeCenteredScrollTop({ offsets: [0], heights: [], index: 0, viewportHeight: 200, scrollHeight: 0 }), 0);
  const heights = [50, 50];
  const offsets = prefixOffsets(heights);
  assert.equal(computeCenteredScrollTop({ offsets, heights, index: -1, viewportHeight: 200, scrollHeight: 100 }), 0);
  assert.equal(computeCenteredScrollTop({ offsets, heights, index: 5, viewportHeight: 200, scrollHeight: 100 }), 0);
});
