// ─── Skills help chapters (#1990, epic #1981) ────────────────────────────────
//
// The "?" next to a Skills surface opens the /skills help topic AT the chapter
// that explains that surface. A chapter is addressed by the slug of its heading
// (see sectionSlug in context/page-help-view.js), so this file is the one place
// the slugs are written down — every call site imports from here, and
// skills-help-extraction.test.js asserts each value is really a heading in
// help-topics/skills.md.
//
// A slug that no longer matches is not a crash: the panel just opens the topic
// from the top. That is also the deliberate behaviour for a surface a given
// operator does not see (the Team-Admin-gated transfer actions, the Adopt panel
// on a team-tier skill) — the chapter documents the function generally and the
// "?" is never empty.
//
// It lives beside SkillsRegistry.jsx rather than in a pages/skills/ directory of
// its own: the page's other pure modules (skill-inbox-view.js,
// skill-rollout-view.js) sit flat here too, and a one-file directory would be
// the odd one out.

export const SKILLS_HELP_SECTIONS = {
  // 1 — what a skill is, and what the viewer's four tabs show
  page: 'what-a-skill-is',
  // 2 — Global / Team / Agent and the own-team-pool-first resolution order
  tiers: 'the-three-tiers-and-which-one-an-agent-gets',
  // 3 — the three mechanics behind the verbs
  grants: 'grant-activation-and-install-into-agent',
  // 4 — the action table: promote / move / adopt / distill / merge / import / export
  actions: 'the-actions-promote-move-adopt-distill-merge-import-and-export',
  // 5 — what an overwrite replaces, and what merging does to provenance + grants
  overwrite: 'overwrite-and-merge-what-each-one-replaces',
  // 6 — the three-way distinction the Knowledge page cross-links to
  vsKnowledge: 'skills-vs-knowledge-vs-memory',
};

export default SKILLS_HELP_SECTIONS;
