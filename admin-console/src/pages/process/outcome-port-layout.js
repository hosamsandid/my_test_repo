// Pure geometry for the multi-outcome node's right-edge outcome-port column
// (#857). The outcome ports added in #828 are an absolutely-positioned column
// on the node card's right edge; because the column is out of normal flow it
// contributes nothing to the card's content-driven height, so with 3+ outcomes
// the column spilled below the card's bottom border.
//
// The fix (see flow-graph-render.js, the outcome-column block) pins the column
// to the card's *bottom* and grows the card via a computed `min-height` so every
// outcome row sits inside the borders and clears the centred ● connect port.
// The height math lives here, fs-/DOM-free, so it can be unit-tested and kept in
// sync with the CSS it mirrors. Presentational rendering stays in the renderer.

// Per-row footprint of one outcome row in the column, in px. A row is
// `[title tag][gap][12×12 port dot w/ 2px border]`; the dot's border box is 16px
// and the tag is ~14px, so the row is 16px tall. Rows are separated by a 5px gap.
// Keep these in sync with the `.outcomes column` row CSS in flow-graph-render.js.
export const OUTCOME_ROW_H = 16;
export const OUTCOME_ROW_GAP = 5;

// Distance the column is pinned above the card's bottom border (matches the
// `bottom:` offset used on the column when it is grown), plus the clearance the
// card must keep between the column's top and the centred ● connect port.
export const OUTCOME_COL_BOTTOM = 10;
export const OUTCOME_PORT_CLEARANCE = 24; // ● port half-height + breathing room

// The outcome column only grows the card once there are at least two outcomes.
// A single outcome (or none) keeps today's centre-anchored placement so 0/1
// outcome nodes are byte-for-byte unchanged (#857 AC2).
export const OUTCOME_GROW_MIN = 2;

// Total height of the stacked outcome column for `count` outcome rows.
export function outcomeColumnHeight(count) {
  if (!count || count < 1) return 0;
  return count * OUTCOME_ROW_H + (count - 1) * OUTCOME_ROW_GAP;
}

// The `min-height` (px) the node card needs so a bottom-pinned outcome column of
// `count` rows is fully contained AND sits clear below the vertically-centred ●
// connect port. Returns 0 when no override is needed (0/1 outcome) — callers must
// treat 0 as "leave the card's natural height alone".
//
// The column occupies [H - bottom - colH, H - bottom]; the ● port occupies the
// card's vertical centre. Keeping the column below the port needs
//   H - bottom - colH >= H/2 + clearance   ⟺   H >= 2*(colH + bottom + clearance).
export function outcomeCardMinHeight(count) {
  if (!count || count < OUTCOME_GROW_MIN) return 0;
  const colH = outcomeColumnHeight(count);
  return 2 * (colH + OUTCOME_COL_BOTTOM + OUTCOME_PORT_CLEARANCE);
}
