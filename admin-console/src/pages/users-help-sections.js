// ─── Users page help chapters (#1996, epic #1981) ────────────────────────────
//
// The "?" next to a Users surface opens the /users help topic AT the chapter
// that explains that surface. A chapter is addressed by the slug of its heading
// (see sectionSlug in context/page-help-view.js), so this file is the one place
// the slugs are written down — Users.jsx imports from here, and
// users-help-extraction.test.js asserts each value is really a heading in
// help-topics/users.md.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top.
//
// The ticket asks for an "Edit/offboarding dialog ?" — which is two surfaces,
// not one, because they answer different questions. The edit panel's question is
// "what do these fields mean, and why can I not change the Subject?"; the delete
// confirmation's is "what am I about to do to this person's agents and
// credentials?", and that one is asked with a finger already over a destructive
// button. They get separate chapters for that reason.
//
// It lives flat beside Users.jsx rather than in a one-file pages/users/
// directory, matching skills-help-sections.js (#1990) and
// token-usage-help-sections.js (#1994).

export const USERS_HELP_SECTIONS = {
  // 1 — records vs memberships, and the empty-console failure it explains
  page: 'what-this-page-manages',
  // 5 — the two independent halves of the edit panel, and self-edit warnings
  edit: 'creating-and-editing-a-user',
  // 6 — pause agents, delete personal credentials, drop memberships; and the
  //     three things it deliberately does NOT do (incl. no last-admin guard)
  offboarding: 'deleting-a-user-is-an-offboarding',
};

export default USERS_HELP_SECTIONS;
