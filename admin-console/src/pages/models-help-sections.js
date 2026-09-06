// ─── Model Providers help chapters (#1988, epic #1981) ───────────────────────
//
// The "?" next to a Model Providers surface opens the /models help topic AT the
// chapter that explains that surface. A chapter is addressed by the slug of its
// heading (see sectionSlug in context/page-help-view.js), so this file is the
// one place the slugs are written down — every call site imports from here, and
// models-help-extraction.test.js asserts each value is really a heading in
// help-topics/models.md.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top. That is also the deliberate behaviour for a surface that is not
// on screen — the OAuth box only exists while `oauth-token` is selected, and the
// chapter documents the constraint generally, so the "?" is never empty.
//
// It lives beside ModelRegistry.jsx rather than in a pages/models/ directory of
// its own (which the ticket sketched): the page's other pure modules
// (model-provider-submit-state.js, llm-probe-state.js, provider-health-view.js
// and their tests) sit flat here too, and a one-file directory would split the
// page across two locations for no gain. Same call as skills-help-sections.js
// (#1990), mcp-help-sections.js (#1989) and token-usage-help-sections.js (#1994).

export const MODELS_HELP_SECTIONS = {
  // 1 — what a provider is, what the table shows, the model-precedence chain
  page: 'what-a-model-provider-is',
  // 2 — Bearer against a Base URL
  apiKeyAuth: 'api-key-proxy-authentication',
  // 3 — the subscription seat, and the Consumer-Terms rule inside it
  oauthAuth: 'anthropic-subscription-authentication',
  oauthSingleUser: 'single-user-only-the-compliance-constraint',
  // 4 — what each probe does, and why it names the credential it used
  probes: 'test-connection-and-discover-models',
  // 5 — the background poller and the Health column
  health: 'health-the-poller-and-the-health-column',
  // 6 — rotating a credential, the restart-agents dialog, the delete refusal.
  // Carries NO "?" on purpose: the restart dialog and the delete refusal state
  // their own rules at the point of decision, and the panel renders the whole
  // topic anyway. Exported regardless so the chapter stays addressable and the
  // page-side guard covers its heading — the same call mcp-help-sections.js
  // (#1989) and credentials-help-sections.js (#1993) make for their own
  // affordance-less chapters.
  changingAndDeleting: 'changing-credentials-and-deleting',
};

export default MODELS_HELP_SECTIONS;
