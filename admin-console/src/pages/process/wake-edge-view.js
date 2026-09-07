// wake-edge-view.js — pure display decisions for the direct agent-to-agent
// hand-off edge (`on: 'wake'`, #2031 / concept §10).
//
// A `wakeAgent` outcome action wakes a wired same-team role inside the platform:
// no label token, no issue, no PR, no GitHub trace. That is exactly why it needs
// its own visual language — every neighbouring edge type carries something the
// reader can name, and this one carries nothing:
//
//   label hand-off (#3b82f6)  blue,   solid,  label chip  → the label IS the name
//   internal label (#1174)    family hue, dotted `2 3`    → dotted = internal
//                                                            transport OF A LABEL
//   outcome-keyed  (#828)     amber #eab308               → the ◇ switch badge
//   data flow / dependency    green #22c55e / red #ef4444 dashed
//   gate: 'human'             red #dc2626, solid
//   human decision / brake    rose #e11d48, dashed `6 4`
//
// Hence: INDIGO and SOLID. Solid because dotted is already spoken for — it means
// "the internal transport of a label", and a direct hand-off is not a label at
// all, so borrowing the dash would say the wrong thing rather than nothing.
// Indigo (#6366f1) is the free slot the concept names, but it sits close to
// label-blue, so the colour is deliberately NOT what carries the distinction —
// the chip glyph is.
export const WAKE_EDGE_COLOR = '#6366f1';
export const WAKE_EDGE_LEGEND = 'direct hand-off';

// The glyph. Concept §10 proposes `⇥`, and this deviates: `⇥` is ALREADY the
// claim marker (`CLAIM_MARKER` in src/pages/agent-chat/trigger-summary.js),
// rendered on this very canvas inside `labelChipText` as the `⇥ wip` badge of a
// claiming label listener. Reusing it would put two different meanings on one
// glyph on one screen — `ready ⇥ wip` (a label listener claiming its wake label)
// next to `⇥ Reviewer` (a direct hand-off) — which is the opposite of the
// distinction the concept asked the glyph to carry. `↪` is unused anywhere in
// the console and reads as "hands off to", so it takes the job.
export const WAKE_GLYPH = '↪';

// ── the hand-off note cap ───────────────────────────────────────────────────
//
// Mirrors `api/outcomes.js` (WAKE_NOTE_MAX / WAKE_NOTE_TRUNCATION_MARK /
// clampWakeNote) so a field cannot submit a value the server would silently
// truncate behind the author's back. #2030 put a copy in RoutingSection.jsx;
// #2031 adds a second editor (the Edit-hand-off dialog), and a third copy of a
// cap is how caps drift — so it lives here once and both import it. The marker
// matters as much as the number: a bare slice would drop the tail of a
// hand-authored note on the next Save with nothing to show it happened.
export const WAKE_NOTE_MAX = 1024;
export const WAKE_NOTE_TRUNCATION_MARK = ' […truncated]';

export function clampWakeNote(s) {
  // Code points, not UTF-16 units: a cut inside a surrogate pair yields a lone
  // surrogate that is not encodable as UTF-8 downstream.
  const chars = Array.from(String(s == null ? '' : s));
  if (chars.length <= WAKE_NOTE_MAX) return String(s == null ? '' : s);
  const mark = Array.from(WAKE_NOTE_TRUNCATION_MARK).length;
  return chars.slice(0, WAKE_NOTE_MAX - mark).join('') + WAKE_NOTE_TRUNCATION_MARK;
}

/**
 * The chip text for a wake edge.
 *
 * Normally `↪ <Target>` (concept §10). But the pair (producer, target) does NOT
 * identify a hand-off — the outcome option does, which is why `edgeId` keys on
 * it — so a producer with two hand-offs to the SAME target draws two parallel
 * edges. Titling both `↪ Reviewer` would make them indistinguishable at exactly
 * the moment the reader needs to tell them apart, so the outcome's own title is
 * appended in that case and only in that case: the common single-hand-off edge
 * keeps the short form the concept specifies.
 *
 * @param {object} e - the wake edge ({ to, outcome })
 * @param {(id: string) => string} nameOf - target id → display name
 * @param {(from: string, outcome: string) => string} titleOf - the producer's
 *   outcome-option title (falls back to the option id; '' when unresolvable)
 * @param {boolean} ambiguous - does the producer hand off to this target more
 *   than once? (see `wakeEdgeIsAmbiguous`)
 * @returns {string}
 */
export function wakeChipText(e, nameOf, titleOf, ambiguous) {
  const target = (nameOf && e && e.to ? nameOf(e.to) : '') || (e && e.to) || '';
  const base = `${WAKE_GLYPH} ${target}`.trim();
  if (!ambiguous) return base;
  const title = (titleOf && e && e.from && e.outcome ? titleOf(e.from, e.outcome) : '') || '';
  return title ? `${base} · ${title}` : base;
}

/**
 * Does this producer hand off to this target more than once? Counted over the
 * whole wake-edge set rather than read off the producer's outcomes, so the chip
 * disambiguates exactly when the canvas actually draws two lines — a hand-off
 * the graph builder withheld (unknown target, self-wake) must not make a
 * surviving sibling look ambiguous.
 *
 * @param {Array} edges - every edge in the graph (non-wake entries ignored)
 * @param {object} e - the wake edge to judge
 */
export function wakeEdgeIsAmbiguous(edges, e) {
  if (!e || !e.from || !e.to) return false;
  let n = 0;
  for (const x of (Array.isArray(edges) ? edges : [])) {
    if (x && x.on === 'wake' && x.from === e.from && x.to === e.to) n += 1;
    if (n > 1) return true;
  }
  return false;
}

// Deliberately NOT here: a hover tooltip for the edge. Edge hit paths carry no
// title anywhere on this canvas (`addEdgeHit` in flow-graph-render.js attaches a
// click handler only), so giving one edge type alone a hover affordance would
// read as a bug rather than a feature. The producer's note is shown where it is
// editable — the Edit-hand-off dialog.
