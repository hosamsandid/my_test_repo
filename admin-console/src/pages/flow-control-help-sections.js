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
  // 1 — evidence-not-labels, the read-only rule, and the empty/degraded states
  page: 'what-the-flow-control-board-shows',
  // 2 — the nine columns, and that they are graph positions rather than labels
  states: 'the-lifecycle-stages',
  // 3 — the ten reason codes, who clears each, and the two decline-on-doubt rules
  blockers: 'blockers-and-what-to-do-about-them',
  // 4 — the four mutually exclusive buckets and why they always sum to the total
  epics: 'the-epic-roll-up',
  // 5 — pause/drain a pooled role, force-dispatch a held ticket (#2250 Phase 5)
  poolControls: 'pool-controls',
};

export default FLOW_CONTROL_HELP_SECTIONS;
