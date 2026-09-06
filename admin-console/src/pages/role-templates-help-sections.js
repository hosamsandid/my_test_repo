// ─── Agent Templates help chapters (#1996, epic #1981) ───────────────────────
//
// The "?" next to an Agent Templates surface opens the /role-templates help
// topic AT the chapter that explains that surface. A chapter is addressed by the
// slug of its heading (see sectionSlug in context/page-help-view.js), so this
// file is the one place the slugs are written down — RoleTemplates.jsx imports
// from here, and role-templates-help-extraction.test.js asserts each value is
// really a heading in help-topics/role-templates.md.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top.
//
// The ticket asks for an "invocation-mode field ?" *if warranted*. It is: the
// field's two options describe one stored behaviour, and picking one silently
// decides whether the agent is framed as autonomous — neither of which the
// option labels can say in the space they have. The Advanced box gets the second
// one for the same reason (it is the page's only free-form JSON field, and the
// form's values are layered over whatever you put in it). Both sit inside the
// editor SidePanel, which is why that panel publishes an overlay subject.
//
// It lives flat beside RoleTemplates.jsx rather than in a one-file
// pages/role-templates/ directory, matching skills-help-sections.js (#1990) and
// token-usage-help-sections.js (#1994).

export const ROLE_TEMPLATES_HELP_SECTIONS = {
  // 1 — blueprint-not-agent, who builds from templates, the shipped catalog
  page: 'what-an-agent-template-is',
  // 5 — the two-state switch, and the one-way implication to "autonomous"
  invocation: 'invocation-mode',
  // 6 — promptTemplate vs prompt, the raw-JSON remainder, fixed id, last-write-wins
  advanced: 'prompt-and-advanced',
};

export default ROLE_TEMPLATES_HELP_SECTIONS;
