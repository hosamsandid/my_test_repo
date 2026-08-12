// Pure decision logic for the unified "Create" launcher (#1665, Phase B/C of
// epic #1661). The launcher fronts every "how do I start?" entry point that
// used to be scattered across the Single Agent page, the Team Wizard's first
// step and the Flows canvas, presenting them as a small set of EQUALLY-RANKED,
// plainly-labelled choices. Per #1661 decisions D1 (equal tiles, no forced
// default) and D4 (reachable from both a persistent "+ Create" control and a
// dedicated route), both of which resolve to the same launcher.
//
// This module is dependency-free and unit-tested (admin-console-src CI job);
// Create.jsx is a thin renderer over it, and the technical routing (which
// existing backend/flow each entry hands off to) lives here as data so it can
// be asserted (per the #651 convention). Icons are referenced by name only so
// the module stays free of React / lucide imports.

// The four entries, in display order. Order is presentational only — no entry
// carries a `default`/`primary`/`recommended` flag, so none is a forced default
// (AC1). Labels deliberately avoid the words agent / team / flow / template /
// orchestrator so a first-time user can choose by intent, not artifact (AC7).
const CREATE_ENTRIES = [
  {
    key: 'describe',
    icon: 'MessageSquare',
    title: 'Describe what you need',
    description:
      'Tell us in plain language what you want to get done. We draft it for you and '
      + 'show a live preview before anything is created.',
    // The conversational creator: a new draft opened with the Flow Copilot
    // (POST /api/process/copilot) — live graph preview + confirm-to-create (AC3).
    to: '/flows?new=describe',
  },
  {
    key: 'template',
    icon: 'LayoutTemplate',
    title: 'Start from a ready-made setup',
    description:
      'Pick a proven starting point and adjust it. Fastest way to a working setup '
      + 'when one already fits.',
    // The curated registry + saved drafts, picked and materialised through the
    // Team Wizard's first step (AC4).
    to: '/team-setup',
  },
  {
    key: 'build',
    icon: 'PenTool',
    title: 'Build it yourself',
    description:
      'Lay it out visually on a canvas and connect the pieces yourself. Full control '
      + 'from a blank slate.',
    // A fresh draft opened in the Flows canvas (POST /api/process/drafts → /flows, AC5).
    to: '/flows?new=blank',
  },
  {
    key: 'chat',
    icon: 'Rocket',
    title: 'Just give me one assistant to chat with',
    description:
      'Spin up a single assistant you can start talking to right away. No wiring, '
      + 'no setup — the quickest path in. It is simply a team of one; grow it into a '
      + 'full team whenever you need more.',
    // The merged single-agent form from Phase A (#1664) — the "Fast lane" (AC6).
    // Kept as an explicit shortcut so users who just want one assistant are not
    // forced through the right-sizing flow (#1667 Phase D, AC4).
    to: '/quickstart',
  },
];

export function createEntries() {
  // Return a shallow copy so callers can't mutate the module-level list.
  return CREATE_ENTRIES.map((e) => ({ ...e }));
}

export const CREATE_ENTRY_KEYS = CREATE_ENTRIES.map((e) => e.key);

export function entryByKey(key) {
  const found = CREATE_ENTRIES.find((e) => e.key === key);
  return found ? { ...found } : null;
}

// AC1 guard, expressed as data: true iff any entry is styled/behaves as a
// forced default. Kept as a helper so the equal-ranking invariant is testable
// and the renderer can assert it rather than encode a "primary" tile by hand.
export function hasForcedDefault(entries = CREATE_ENTRIES) {
  return entries.some(
    (e) => e.default === true || e.primary === true || e.recommended === true,
  );
}
