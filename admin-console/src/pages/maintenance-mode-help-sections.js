// ─── Maintenance Mode help chapters (#1996, epic #1981) ──────────────────────
//
// The "?" next to a Maintenance Mode surface opens the /maintenance-mode help
// topic AT the chapter that explains that surface. A chapter is addressed by the
// slug of its heading (see sectionSlug in context/page-help-view.js), so this
// file is the one place the slugs are written down — MaintenanceMode.jsx imports
// from here, and maintenance-mode-help-extraction.test.js asserts each value is
// really a heading in help-topics/maintenance-mode.md.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top.
//
// Note the page shows the activate form and the while-active card in *mutually
// exclusive* branches, so two of these three "?" are on screen at a time — one
// page-level, one for whichever state the page is in. That is the pairing the
// ticket asks for ("Activate form vs While active"): before you commit, the
// question is "what am I about to switch on?"; afterwards it is "what is this
// doing to my platform right now?", and those are different chapters.
//
// It lives flat beside MaintenanceMode.jsx rather than in a one-file
// pages/maintenance-mode/ directory, matching skills-help-sections.js (#1990)
// and token-usage-help-sections.js (#1994).

export const MAINTENANCE_HELP_SECTIONS = {
  // 1 — signal-not-action, the cooperative-pause model and its honest limits
  page: 'what-maintenance-mode-is',
  // 2 — minutes vs the cap, and the "it is not an enforcement timer" rule
  activating: 'activating-it-and-the-grace-period',
  // 3 — the per-trigger table, the chat lock, the skipped background passes
  whileActive: 'while-active',
};

export default MAINTENANCE_HELP_SECTIONS;
