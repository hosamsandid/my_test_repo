// Pure view helpers for a DIRECT HAND-OFF row in the GitHub Event Log
// (#2032, docs/direct-agent-handoff-concept.md §7). React-free so they
// unit-test under `node --test` (the JSX page itself is only parse-checked in
// this repo, per the #651 convention).
//
// A `wakeAgent` hand-off is written into the same day-bucketed JSONL as every
// polled GitHub event, through the same GitHub-event-shaped `buildEventEntry`
// (`orchestrator/github-event-log.js`). That shape has no slot for a repo, a
// label or a work item — a hand-off has none of those — so those columns
// honestly render `—`, and the whole row used to read as dashes with the
// `source` that distinguishes it never rendered at all.
//
// What makes the row readable is threaded through three cells:
//   * Event   — the `handoff.wake` key, rendered in plain language by the
//               shared `eventLabel` helper (`agent-chat/trigger-summary.js`).
//   * Outcomes— the single `{agentId: <target>, status: 'delivered'}` outcome
//               the writer records, so the TARGET lands there unchanged.
//   * Title   — otherwise `—`; this is where the producer's note goes.
//
// The producer/target pair is read from the writer's own `handoff` block
// (`buildWakeLogFields` in `orchestrator/wake-agent.js`) rather than by
// stripping the `agent:` prefix off `actor` or reaching into `outcomes[0]`:
// both of those are a consequence of synthesizing a GitHub-shaped event, not a
// contract. Every helper degrades to null/'' on a legacy or malformed row —
// this log is best-effort by design and must never break the table.

// The one event key the platform synthesizes for a direct hand-off. Kept
// byte-identical to `WAKE_EVENT_KEY` in `orchestrator/wake-agent.js`.
export const HANDOFF_WAKE_EVENT = 'handoff.wake';

// Whether a log row is a direct hand-off. Keyed on the event key, NOT on
// `source: 'internal'` — an `aee-emit` internal label channel (#1173) carries
// that same source and is an ordinary labelled row.
export function isHandoffRow(row) {
  return !!row && typeof row === 'object' && row.event === HANDOFF_WAKE_EVENT;
}

// `{from, to}` for a hand-off row, or null when the row is not a hand-off or
// predates the `handoff` block. Either side may be null on a partial row, so a
// caller must not assume both are present just because the object is.
export function handoffPair(row) {
  if (!isHandoffRow(row)) return null;
  const h = row.handoff;
  if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
  const from = typeof h.from === 'string' && h.from.trim() ? h.from.trim() : null;
  const to = typeof h.to === 'string' && h.to.trim() ? h.to.trim() : null;
  if (!from && !to) return null;
  return { from, to };
}

// The producer's note, or '' when there is none. `''` rather than null so the
// caller can flatten it straight onto the row's `workItemTitle` key — which is
// what makes the Title column's text filter and sort reach the note, since
// DataTable filters and sorts by key, not by rendered cell.
export function handoffNote(row) {
  if (!isHandoffRow(row)) return '';
  const h = row.handoff;
  if (!h || typeof h !== 'object' || Array.isArray(h)) return '';
  return typeof h.note === 'string' ? h.note.trim() : '';
}

// How much of the note the Title CELL renders. A note is capped at 1024 code
// points, four times what GitHub allows a PR/issue title — and this column
// opts into DataTable `wrap` (#1898), so an uncapped note wraps into ~20 lines
// and one hand-off row dominates the table. The full note stays on the row's
// filter key and in the cell's hover, so nothing is hidden, only folded.
//
// Cut in CODE POINTS, like every other cut this feature makes: `String#slice`
// can land between a surrogate pair, and the lone surrogate renders as a
// replacement character.
export const HANDOFF_NOTE_DISPLAY_MAX = 180;

export function handoffNoteDisplay(row) {
  const note = handoffNote(row);
  if (!note) return '';
  const chars = Array.from(note);
  if (chars.length <= HANDOFF_NOTE_DISPLAY_MAX) return note;
  return `${chars.slice(0, HANDOFF_NOTE_DISPLAY_MAX).join('')}…`;
}

// Hover text for the Title cell, so a note is not mistaken for a PR/issue
// title (the only other thing that column ever holds). Returns null when the
// row is not a hand-off, leaving the existing behaviour untouched.
export function handoffTitleHint(row) {
  if (!isHandoffRow(row)) return null;
  const pair = handoffPair(row);
  const who = pair && pair.from ? pair.from : 'the producer';
  return `Note handed over by ${who}`;
}
