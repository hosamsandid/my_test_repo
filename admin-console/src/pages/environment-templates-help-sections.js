// ─── Environment Template help chapters (#2170, epic #2166 A4) ───────────────
//
// The System-Admin Environment Template catalog that replaced the general-
// purpose "Working Environments" page (help-topics/environment-templates.md).
// A chapter is addressed by the slug of its heading (see sectionSlug in
// context/page-help-view.js) — every call site imports from here, and
// environment-templates-help-extraction.test.js asserts each value is really a
// heading in the topic. A slug that no longer matches is not a crash: the
// panel just opens the topic from the top, which still *looks* like the "?"
// worked, so the guard is the only thing that notices.
//
// Flat beside the page's other pure modules (working-env-submit-state.js,
// toolchain-select-view.js).

export const ENVIRONMENT_TEMPLATES_HELP_SECTIONS = {
  // 1 — what a template is, "start from a template", and why it is never a
  // live-shared binding
  whatIs: 'what-an-environment-template-is',
  // 2 — repositories on a template: URL/branch are copied, the SSH key never is
  repositories: 'repositories',
  // 3 — why a credential set here is never copied — the same rule the
  // repositories/MCP chapters restate for their own fields
  credentials: 'credentials',
  // 4 — the MCP server/credential picker; the credential is never copied
  mcp: 'mcp-server-references',
  // 5 — the System-Admin Toolchains panel (cross-cutting; applies to every
  // environment, not only templates)
  toolchains: 'toolchains',
};

export default ENVIRONMENT_TEMPLATES_HELP_SECTIONS;
