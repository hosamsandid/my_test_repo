// Chapter slugs of the `flow-control` help topic, single-sourced so a call site
// never inlines one (#2116, epic #2112 · the #1990/#1994 registry convention).
// Flat beside the page's other modules rather than in a one-file
// `pages/flow-control/` directory — the call every #1981 child made.
//
// The values are `sectionSlug(<heading text>)`, not the heading itself.
// `flow-control-help-extraction.test.js` asserts each one is a real `##`
// heading in `api/helper-chat/help-topics/flow-control.md`, because a reworded
// heading breaks the deep link SILENTLY (the panel just renders from the top).

export const FLOW_CONTROL_HELP_SECTIONS = {
  // 1 — what appears on the board and what does not; refresh; degraded states
  page: 'what-the-flow-control-board-shows',
  // 2 — area ①: running sessions and pool occupancy
  working: 'who-is-working-right-now',
  // 3 — Pause vs Drain vs Switch on, and Force dispatch
  poolControls: 'pause-drain-and-switch-on',
  // 4 — area ②: the human-block reasons and what to do about each
  needsYou: 'where-you-are-needed',
  // 5 — area ③: stages derived from the flow graph, one row per work item
  states: 'the-stages',
  // 6 — the optional per-team column configuration and done retention
  columns: 'changing-the-columns',
};

export default FLOW_CONTROL_HELP_SECTIONS;
