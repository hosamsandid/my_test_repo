// ─── Create & Quickstart help chapters (#1992, epic #1981) ───────────────────
//
// The "?" next to a launcher or one-assistant surface opens the `create` help
// topic AT the chapter that explains that surface. A chapter is addressed by the
// slug of its heading (see sectionSlug in context/page-help-view.js), so this
// file is the one place the slugs are written down — every call site imports
// from here, and create-help-extraction.test.js asserts each value is really a
// heading in help-topics/create.md.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top. That is also the deliberate behaviour for a surface that is not
// on screen — the prerequisite checklist only renders while something is
// outstanding — so a chapter-less "?" can never be empty or broken.
//
// One topic, two routes: `create.md` claims both `/create` and `/quickstart`, so
// the same four chapters are reachable from either page and the constants are
// shared rather than split per page. It lives beside Create.jsx / QuickStart.jsx
// rather than in a pages/create/ directory of its own: the pages' other pure
// modules (create-launcher-view.js, quickstart-view.js, agent-create-submit-
// state.js) sit flat here too, and a one-file directory would be the odd one
// out. Same call made in #1990 for skills-help-sections.js and #1995 for
// github-events-help-sections.js.

export const CREATE_HELP_SECTIONS = {
  // 1 — the launcher tiles and what each one produces (draft / wizard / fast
  //     lane / direct form), plus one-assistant vs one-agent
  entryPaths: 'the-entry-paths',
  // 2 — the team-of-one framing, and that growing creates a NEW team
  teamOfOne: 'a-single-agent-is-a-team-of-one',
  // 3 — the SSH probe, environment reuse, agent reuse, and why Name / Model
  //     Provider are unused once a repository URL is entered
  fastLane: 'the-repository-fast-lane',
  // 4 — model provider / SSH key / GitHub token, and how the warning cards and
  //     the submit checklist differ
  prerequisites: 'what-you-need-before-you-start',
};

export default CREATE_HELP_SECTIONS;
