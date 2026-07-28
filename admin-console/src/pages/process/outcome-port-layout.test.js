import test from 'node:test';
import assert from 'node:assert/strict';

import {
  outcomeColumnHeight,
  outcomeCardMinHeight,
  OUTCOME_ROW_H,
  OUTCOME_ROW_GAP,
  OUTCOME_COL_BOTTOM,
  OUTCOME_PORT_CLEARANCE,
  OUTCOME_GROW_MIN,
} from './outcome-port-layout.js';

// ── column height ────────────────────────────────────────────────────────
test('column height: empty / single', () => {
  assert.equal(outcomeColumnHeight(0), 0);
  assert.equal(outcomeColumnHeight(1), OUTCOME_ROW_H);
});

test('column height: n rows = n*rowH + (n-1)*gap', () => {
  for (const n of [2, 3, 4, 6, 8]) {
    assert.equal(outcomeColumnHeight(n), n * OUTCOME_ROW_H + (n - 1) * OUTCOME_ROW_GAP);
  }
});

// ── min-height gating (AC2: 0/1 outcome unchanged) ─────────────────────────
test('no min-height override for 0 or 1 outcome', () => {
  assert.equal(outcomeCardMinHeight(0), 0);
  assert.equal(outcomeCardMinHeight(1), 0);
  assert.equal(OUTCOME_GROW_MIN, 2);
});

test('min-height kicks in from 2 outcomes upward', () => {
  for (const n of [2, 3, 4, 5, 6, 8]) {
    assert.ok(outcomeCardMinHeight(n) > 0, `n=${n} should grow the card`);
  }
});

// ── containment + port clearance invariant (AC1, AC7) ──────────────────────
// For a card of the returned min-height H, the bottom-pinned column
// [H-bottom-colH, H-bottom] must sit fully inside the card AND entirely below
// the centred ● connect port (centre H/2). We assert both, for realistic counts.
test('grown card contains the column and clears the centred ● port', () => {
  for (const n of [2, 3, 4, 5, 6, 8]) {
    const H = outcomeCardMinHeight(n);
    const colH = outcomeColumnHeight(n);
    const colTop = H - OUTCOME_COL_BOTTOM - colH;
    const colBottom = H - OUTCOME_COL_BOTTOM;
    // fully inside the card borders
    assert.ok(colTop >= 0, `n=${n}: column top ${colTop} spills above card`);
    assert.ok(colBottom <= H, `n=${n}: column bottom ${colBottom} spills below card`);
    // entirely below the ● port centred at H/2 (+ its clearance)
    assert.ok(colTop >= H / 2 + OUTCOME_PORT_CLEARANCE - 1e-9,
      `n=${n}: column top ${colTop} overlaps the ● port at ${H / 2}`);
  }
});

// ── monotonic: more outcomes never make the card shorter ───────────────────
test('min-height is monotonic in the outcome count', () => {
  let prev = 0;
  for (let n = 2; n <= 12; n++) {
    const h = outcomeCardMinHeight(n);
    assert.ok(h >= prev, `n=${n}: height ${h} < previous ${prev}`);
    prev = h;
  }
});
