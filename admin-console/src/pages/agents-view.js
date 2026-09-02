// Pure copy + framing decisions for the Agents page (#1669, Phase F of epic
// #1661). Phase F reframes the Agents page from a de-facto *creation* surface
// (a peer of the unified "Create" launcher) into a **manage-first** page: the
// place where you look after the agents and teams you already have. The manual
// creation actions ("+ New Agent", "Add Member", "Add role", "Import Agent")
// stay available for power users (decision D2 — nothing removed, only
// re-layered) but as clearly secondary/advanced affordances, and the primary
// "create" intent (empty-state and informational CTAs) now points at the
// launcher (Phase B/C #1665) instead of the individual /quickstart and
// /team-setup pages.
//
// Per the #651 convention the user-facing strings + framing guards live here as
// a dependency-free, unit-tested module (admin-console-src CI job); Agents.jsx
// is a thin renderer over these constants so "the page reads as manage, and its
// primary create CTAs route through the launcher" becomes assertable rather
// than eyeballed (mirrors quickstart-view.js's QUICKSTART_COPY guard, #1667).

// The unified "Create" launcher route (#1665) — the single front door the
// Agents page points its primary "create" intent at (AC3).
export const CREATE_LAUNCHER_PATH = '/create';

// The individual creation pages the launcher fronts. A primary "create" CTA on
// the Agents page must NOT link here directly anymore (AC3).
export const LEGACY_CREATE_PATHS = Object.freeze(['/quickstart', '/team-setup']);

export const AGENTS_PAGE_COPY = Object.freeze({
  heading: 'Agents',
  // AC1 — the page presents *managing* existing agents/teams as its purpose.
  subtitle:
    'Manage the agents and teams you already have. To start something new, '
    + 'use the Create launcher.',
  // The former `introLead`/`introBody` ("What is an agent?" + the role table)
  // moved into the page help topic in #1875 — the page now carries only its
  // title, this one-line subtitle and the "?" affordance.
  // Empty-state copy (AC1) — leads to the launcher as the primary path while
  // still pointing at the advanced/manual create above (edge case: fresh
  // install / zero agents).
  emptyLead: 'No agents to manage yet.',
  emptyCtaLabel: 'Open the Create launcher',
  emptyAdvancedHint: 'Prefer full control? + New Agent above is the advanced path.',
});

// The empty-state primary CTA, expressed as data so AC3 (points at the launcher,
// not /quickstart or /team-setup) is testable.
export const EMPTY_STATE_PRIMARY_CTA = Object.freeze({
  label: AGENTS_PAGE_COPY.emptyCtaLabel,
  to: CREATE_LAUNCHER_PATH,
});

// AC3 predicate — reusable check that a given create-CTA target is the launcher
// and not one of the individual pages it fronts.
export function ctaAvoidsLegacyCreatePages(to) {
  return !LEGACY_CREATE_PATHS.includes(to);
}

// AC3 guard — the empty-state / informational primary create CTAs route through
// the launcher.
export function ctaUsesLauncher(cta = EMPTY_STATE_PRIMARY_CTA) {
  return cta.to === CREATE_LAUNCHER_PATH && ctaAvoidsLegacyCreatePages(cta.to);
}

// AC1 guard — the page copy frames the page as "manage", not "create": the
// subtitle leads with "Manage", and manage wording is present across the
// subtitle/empty-state copy that remains on the page after #1875 moved the
// intro box into the help topic.
export function isManageFramed(copy = AGENTS_PAGE_COPY) {
  const subtitleLeadsWithManage = /^\s*manage\b/i.test(copy.subtitle || '');
  const hay = `${copy.subtitle} ${copy.emptyLead}`.toLowerCase();
  return subtitleLeadsWithManage && hay.includes('manage');
}
