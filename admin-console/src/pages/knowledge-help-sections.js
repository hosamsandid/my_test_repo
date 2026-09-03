// ─── Knowledge help chapters (#1985, epic #1981) ─────────────────────────────
//
// The "?" next to a Knowledge surface opens the /knowledge help topic AT the
// chapter that explains that surface. A chapter is addressed by the slug of its
// heading (see sectionSlug in context/page-help-view.js), so this file is the
// one place the slugs are written down — every call site imports from here, and
// knowledge-help-extraction.test.js asserts each value is really a heading in
// help-topics/knowledge.md.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top. That is also the deliberate behaviour for a surface a given
// operator does not currently see (the Skills column's power-tool panels are
// collapsed until opened; the configuration panel only exists while it is
// slid out), so the "?" is never empty.
//
// It lives beside KnowledgeFlow.jsx rather than in a pages/knowledge/ directory
// of its own: the page's other pure modules (knowledge-scope.js,
// knowledge-activation-view.js, knowledge-retrieval-view.js, skill-inbox-view.js
// …) sit flat here too, and a one-file directory would split the page across two
// places. Same call as #1990 made for skills-help-sections.js.

export const KNOWLEDGE_HELP_SECTIONS = {
  // 1 — the three stores, and the two views of the flow between them
  page: 'memory-vs-knowledge-vs-skills',
  // 2 — fact / entity / convention, converged, promotion to a skill
  learning: 'how-learning-works-in-three-steps',
  // 3 — what is guaranteed in context vs what stays searchable (the digest badge)
  digest: 'the-per-agent-digest-and-what-stays-searchable',
  // 4 — the ladder, review mode and the three promotion gates
  autonomy: 'autonomy-review-and-the-promotion-gates',
  // 5 — domains, consolidate, distill
  powerTools: 'power-tools-domains-consolidate-and-distill',
  // 6 — forgetting, assist model, storage
  configuration: 'configuration-forgetting-assist-model-and-storage',
};

export default KNOWLEDGE_HELP_SECTIONS;
