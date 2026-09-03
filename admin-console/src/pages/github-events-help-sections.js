// ─── GitHub Event Log help chapters (#1995, epic #1981) ──────────────────────
//
// The "?" next to a GitHub-Event-Log surface opens the /github-events help
// topic AT the chapter that explains that surface. A chapter is addressed by
// the slug of its heading (see sectionSlug in context/page-help-view.js), so
// this file is the one place the slugs are written down — every call site
// imports from here, and github-events-help-copy.test.js asserts each value is
// really a heading in help-topics/github-events.md.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top. That is also the deliberate behaviour for a surface that is not
// on screen — the page-level "?" is always the whole topic — so a chapter-less
// "?" can never be empty or broken.
//
// It lives beside GithubEventLog.jsx rather than in a pages/github-events/
// directory of its own: the page's other pure modules (pending-queue-view.js,
// event-outcome-view.js, github-event-log-type.js) sit flat here too, and a
// one-file directory would be the odd one out. Same call made in #1990 for
// skills-help-sections.js.

export const GITHUB_EVENTS_HELP_SECTIONS = {
  // 1 — what the log is: observational, not team-scoped, 7-day retention
  page: 'what-the-github-event-log-is',
  // 2 — the Processed events table, its columns and who writes rows into it
  processed: 'processed-events',
  // 3 — the outcome chips, the "never woke up" path, polled vs never polled
  outcomes: 'outcomes',
  // 4 — the actionable backlog and why it stops draining
  pending: 'pending-queue',
};

export default GITHUB_EVENTS_HELP_SECTIONS;
