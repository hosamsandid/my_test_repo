// ─── Working Environments help chapters (#1987, epic #1981) ──────────────────
//
// `help-topics/environments.md` (E6 #1880) was one topic behind one page-level
// "?", on a page whose real decision surfaces are all *inside* a side panel: the
// repository rows, the token select, the Sync action and the System-Admin
// toolchain registry. A reader in the middle of the credential select does not
// want the top of the environment explanation — they want the chapter about
// credentials. The topic is now seven headed chapters and each surface opens the
// one written for it.
//
// A chapter is addressed by the slug of its heading (see sectionSlug in
// context/page-help-view.js), so this file is the one place the slugs are
// written down — every call site imports from here, and
// environments-help-extraction.test.js asserts each value is really a heading in
// the topic. A slug that no longer matches is not a crash: the panel just opens
// the topic from the top, which still *looks* like the "?" worked, so the guard
// is the only thing that notices.
//
// All seven chapters are exported (plus two `###` sub-sections inside chapter
// 2), including the two with no "?" of their own
// (`provider`, `context`) — the sibling registries (mcp 5/5, credentials 6/6)
// do the same, it keeps every chapter addressable, and the export is what puts
// its heading under the page-side guard. (`mcp` joined the addressed set in
// #2051, when the form gained the picker its chapter describes.)
//
// It lives flat beside the page's other pure modules (working-env-submit-state.js,
// toolchain-select-view.js) rather than in the `pages/environments/` directory
// the ticket's Scope-in names — that directory does not exist, and a one-file
// directory would be the odd one out here. The call #1990 (Skills), #1993
// (Credentials), #1994 (Token Usage) and #1989 (MCP) all made; AC3 only requires
// the module to export one slug per chapter.

export const ENVIRONMENTS_HELP_SECTIONS = {
  // 1 — the recipe, what an agent inherits, and what an edit does NOT reach
  whatIs: 'what-a-working-environment-is',
  // 2 — cloned at creation, branch, read-only, repo-less, and how a later edit
  // reaches the agents that already exist
  repositories: 'repositories',
  // 2b — the propagation's own sub-section inside chapter 2, deep-linked from
  // the save-time offer dialog. #2066 replaced the manual **Sync all agents**
  // button with that dialog, so the slug moved with the heading: the surface
  // did not disappear, it became a modal, and the "?" moved onto it (which is
  // also why `modal:env-propagation` had to be registered as an overlay — a
  // full-screen dialog at 9999 would otherwise open the help behind itself).
  sync: 'bringing-existing-agents-up-to-date',
  // 2c — the persistent out-of-date badge on the environment list and the
  // catch-up behind it (#2066 D4). Its own `###` inside chapter 2 rather than a
  // chapter, because it is the same story read from the list instead of the
  // form; no "?" of its own — the badge IS the affordance, and it opens the
  // dialog whose "?" lands two headings above.
  outOfDate: 'the-agents-not-up-to-date-badge',
  // 3 — SSH-URL-needs-a-key vs HTTPS-URL-needs-the-token, and what rotation does
  credentials: 'credentials',
  // 4 — the MCP server/credential picker (#2051). Until then this form had no
  // MCP surface at all, so the chapter deliberately carried no "?"; the picker
  // is the control that finally makes one sit honestly here.
  mcp: 'mcp-server-references',
  // 5 — no "?": the provider select carries its own point-of-decision hint, and
  // the precedence story belongs to the Model Providers page
  provider: 'model-provider-binding',
  // 6 — no "?": the CLAUDE.md field's own hint is the decision copy
  context: 'additional-context',
  // 7 — the System-Admin Toolchains panel
  toolchains: 'toolchains',
};

export default ENVIRONMENTS_HELP_SECTIONS;
