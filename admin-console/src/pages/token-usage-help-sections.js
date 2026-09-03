// ─── Token Usage help chapters (#1994, epic #1981) ───────────────────────────
//
// The "?" next to a Token Usage surface opens the /token-usage help topic AT the
// chapter that explains that surface. A chapter is addressed by the slug of its
// heading (see sectionSlug in context/page-help-view.js), so this file is the
// one place the slugs are written down — every call site imports from here, and
// token-usage-help-extraction.test.js asserts each value is really a heading in
// help-topics/token-usage.md.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top. That is also the deliberate behaviour for a surface that is not
// on screen — the attribution "?" only exists once a Work-items row is open, and
// the chapter documents the signals generally, so the "?" is never empty.
//
// It lives beside TokenUsage.jsx rather than in a pages/token-usage/ directory
// of its own (which the ticket sketched): the page's other pure modules
// (token-usage-view.js and its tests) sit flat here too, and a one-file
// directory would split the page across two locations for no gain. Same call
// as skills-help-sections.js (#1990).

export const TOKEN_USAGE_HELP_SECTIONS = {
  // 1 — what produces a record at all, who may look, and tokens-not-costs
  page: 'what-the-page-shows',
  // 2 — the aggregate view, the Group-by-model fan-out, the `unknown` bucket
  statistics: 'the-statistics-tab',
  // 3 — the issue ↔ PR chains, the Ø-per-work-item averages, the remainder
  workItems: 'the-work-items-tab',
  // 4 — strongest-signal-wins, the shared / flow-mismatch flags, day filing
  attribution: 'how-runs-are-attributed',
};

export default TOKEN_USAGE_HELP_SECTIONS;
