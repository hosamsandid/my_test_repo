// ─── Access page help chapters (#1996, epic #1981) ───────────────────────────
//
// The "?" next to an Access surface opens the /teams help topic AT the chapter
// that explains that surface. A chapter is addressed by the slug of its heading
// (see sectionSlug in context/page-help-view.js), so this file is the one place
// the slugs are written down — Teams.jsx imports from here, and
// access-help-extraction.test.js asserts each value is really a heading in
// help-topics/access-users.md.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top. That is also the behaviour for a surface that is not on screen —
// the Manage panel's "?" only exists while a row is open.
//
// Two of the topic's seven chapters are deep-link targets, which is what the
// ticket asks for ("Manage panel gets its own '?' if a second surface is
// clear"). The others are the cross-cutting story — the Agent-Team distinction,
// the roles table, what a scope gates, the create/delete rules — and the panel
// renders the WHOLE topic and merely scrolls, so they are one scroll from
// wherever a link lands. **Resource ownership** is deliberately NOT among them
// despite being a real third surface: it renders no header of its own (just two
// bare `Section`s), so a "?" there would need a heading invented for it to sit
// on, and this ticket's Scope-out excludes changing the page's appearance. It
// still gets its own deepened chapter, reachable by scrolling.
//
// It lives flat beside Teams.jsx rather than in a one-file pages/teams/
// directory, matching skills-help-sections.js (#1990) and
// token-usage-help-sections.js (#1994).

export const ACCESS_HELP_SECTIONS = {
  // 1 — what an access scope is, the `default` scope, the three surfaces
  page: 'what-this-page-manages',
  // 5 — the Manage/View panel: details vs members, and its two deliberate gaps
  manage: 'managing-a-scope-and-its-members',
};

export default ACCESS_HELP_SECTIONS;
