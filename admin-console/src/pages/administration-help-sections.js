// ─── Administration page help chapters (#1996, widened by #2085) ─────────────
//
// The "?" next to an Administration surface opens the /users help topic AT the
// chapter that explains that surface. A chapter is addressed by the slug of its
// heading (see sectionSlug in context/page-help-view.js), so this file is the
// one place the slugs are written down — Users.jsx imports from here, and
// administration-help-extraction.test.js asserts each value is really a heading
// in help-topics/users.md.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top.
//
// #1996 wrote the first three. #2085 (epic #2076 P6, D10) dissolved the Access
// page onto this one as tabs and added the other three, and this file was
// renamed with the page — `access-help-sections.js` went away entirely, its two
// chapters folded into this topic along with the rest of `access-users.md`.
//
// Why each tab's "?" sits on the tab's own toolbar rather than on the tab strip:
// the strip is one control serving three chapters, so a fixed chapter would be
// wrong two thirds of the time — the lesson #1988's auth-type radios taught,
// where one control's "?" had to follow the selection instead.
//
// The edit panel and the two delete confirmations are separate surfaces asking
// different questions — "what do these fields mean?" versus "what am I about to
// do?", the latter asked with a finger already over a destructive button — so
// each gets its own chapter rather than sharing one.
//
// It lives flat beside Users.jsx rather than in a one-file pages/administration/
// directory, matching skills-help-sections.js (#1990) and
// token-usage-help-sections.js (#1994).

export const ADMINISTRATION_HELP_SECTIONS = {
  // records vs memberships, the three tabs, and the empty-console failure
  page: 'what-this-page-manages',
  // the two independent halves of the edit panel, and self-edit warnings
  edit: 'creating-and-editing-a-user',
  // pause agents, delete personal credentials, drop memberships; and the three
  // things it deliberately does NOT do (incl. no last-admin guard)
  offboarding: 'deleting-a-user-is-an-offboarding',
  // the D5 cleanup view: what a row means, and why it lists Agent Teams
  allTeams: 'the-all-teams-tab',
  // the two cascades a team delete runs, and the one it cannot undo
  teamDelete: 'deleting-a-team',
  // the D7/D12 tiers, and why a shared environment is not a team dropdown
  resources: 'the-resources-tab',
};

export default ADMINISTRATION_HELP_SECTIONS;
