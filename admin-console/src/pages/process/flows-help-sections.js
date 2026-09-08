// ─── Flows help chapters (#1984, epic #1981) ─────────────────────────────────
//
// E2 (#1876) gave `help-topics/flows.md` one page-level "?" on the flows-list
// header. Flows is the busiest screen in the console — a canvas, six side
// panels, a docked Copilot rail and a family of edge dialogs — so a reader who
// pressed the "?" inside the label registry got the whole topic from the top and
// had to find the two paragraphs about gates themselves. The topic is now ten
// headed chapters and each surface opens the one written for it.
//
// A chapter is addressed by the slug of its heading (see sectionSlug in
// context/page-help-view.js), so this file is the one place the slugs are
// written down — every call site imports from here, and
// flows-help-extraction.test.js asserts each value is really a heading in the
// topic.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top. That is also the deliberate behaviour for a surface the current
// scope does not have — Anomalies, Improvements and the live/draft halves of the
// toolbar only exist in one mode, so their "?" simply is not rendered rather
// than rendering a button onto a missing chapter.
//
// This one lives in `pages/process/` rather than flat in `pages/` — the opposite
// of the call #1990/#1993/#1994/#1989 made, and for the reason those tickets
// gave: they would have created a ONE-FILE directory. `pages/process/` already
// holds two dozen of this page's pure modules (flow-anomalies-view.js,
// flow-canvas-hints.js, label-flags.js, hill-climb-view.js, …), and eight of the
// ten call sites are in it, so flat would be the odd one out here. It is also
// the path the ticket's Scope-in names.

export const FLOWS_HELP_SECTIONS = {
  // 1 — what a flow graph is; Draft vs live Team; Materialize.
  //     The flows-list header opens HERE rather than at chapter 2, even though
  //     the button sits in the list: chapter 2 is the very next heading, so
  //     landing on 1 gives the reader the definition *and* the list, while
  //     landing on 2 would hide the definition above the fold — and scrolling
  //     up is the direction people do not try.
  overview: 'what-flows-is',
  // 2 — Teams / Drafts / Role templates, and the four header create actions.
  //     Reached by scrolling down one heading from `overview`; see above.
  list: 'the-flows-left-list',
  // 3 — nodes, edges, the computed layout, the view controls, the toolbar.
  canvas: 'the-canvas',
  // 4 — the edge chooser: the hand-off kinds, and internal vs poller delivery.
  handoffs: 'wiring-hand-offs-the-edge-chooser',
  // 5 — the label registry's three kinds, delivery, and named human roles.
  //     Two surfaces share it (the label registry and the human registry) —
  //     they are the two halves of one story and reading either alone misleads.
  humans: 'human-gates-brakes-and-named-human-roles',
  // 6 — the Routing tab: Inputs, and Outcomes with `exactly one` / `any of`.
  routing: 'outcomes-and-inputs-per-agent',
  // 7 — the ordered stage list that partitions the flow axis.
  stages: 'stages',
  // 8 — the observe-only stall detector (live teams only).
  anomalies: 'anomalies',
  // 9 — the run-metrics + improvement-card panel (live teams only).
  improvements: 'improvements',
  // 10 — plain language in, a reviewable proposal out.
  copilot: 'describe-the-flow-the-copilot',
  // 11 — who can see a draft, and what sharing one actually hands over (#2068).
  //      Its one surface is the Share side panel itself, so unlike the chapters
  //      above there is no page-level route into it — which is exactly why it
  //      needs a slug: the panel is where the irreversibility has to be read.
  sharingDrafts: 'sharing-a-draft',
};

export default FLOWS_HELP_SECTIONS;
