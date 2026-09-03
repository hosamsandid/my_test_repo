// ─── MCP Servers help chapters (#1989, epic #1981) ───────────────────────────
//
// `help-topics/mcp.md` (E9 #1883) was one topic behind one page-level "?", but
// the page it explains has a three-part model that is easy to get wrong: a
// catalog of servers whose template marks a secret slot, a separate credential
// store, and a Working Environment that pairs the two. A reader in the middle of
// the credential form does not want the top of that explanation — they want the
// chapter about credentials. The topic is now five headed chapters and each
// surface opens the one written for it.
//
// A chapter is addressed by the slug of its heading (see sectionSlug in
// context/page-help-view.js), so this file is the one place the slugs are
// written down — every call site imports from here, and
// mcp-help-extraction.test.js asserts each value is really a heading in the
// topic.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top. That is also why `pairing` carries no "?" of its own — the
// Working Environments form exposes no MCP picker, so there is no surface on
// this page (or that one) where a "?" about the pairing would sit honestly; it
// is one scroll away from wherever a deep link lands, since the panel renders
// the WHOLE topic.
//
// It lives flat beside the page's other pure module (mcp-server-submit-state.js)
// rather than in a pages/mcp/ directory of its own — the call #1990 (Skills),
// #1993 (Credentials) and #1994 (Token Usage) all made; a one-file directory
// would be the odd one out here. The ticket's Scope-in names `pages/mcp/`, and
// AC3 only requires the module to export one slug per chapter.

export const MCP_HELP_SECTIONS = {
  // 1 — servers + credentials + a Working Environment that pairs them
  model: 'the-three-part-model',
  // 2 — the server create form: transports and the two mutually-exclusive shapes
  servers: 'the-server-registry-and-its-transports',
  // 3 — the credential create form, and where the *required* status comes from
  credentials: 'the-credential-store-and-credential-substitution',
  // 4 — the pairing, the seed-time merge, and when a change reaches an agent
  pairing: 'environment-pairing-and-the-seed-time-merge',
  // 5 — refused while an environment still references the entry
  deleting: 'deleting-a-server-or-a-credential',
};

export default MCP_HELP_SECTIONS;
