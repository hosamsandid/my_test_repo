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
//
// Each description is ONE line: the tile is a chooser, so it states the intent
// and nothing else. What the path actually produces (draft vs wizard vs fast
// lane, what gets created, what "a team of one" implies) is the `create` help
// topic — E14 of epic #1870 (#1888).
// The direct single-agent form (#1956) is a *state of* `/create`, not a route
// of its own: the Agent Chat header's primary action leads to plain `/create`
// (AC3), and the form has to be reachable from there without a second page. A
// query param says so in the URL — deep-linkable, back-button-correct, and no
// new route/breadcrumb entry for what is one panel.
export const SINGLE_AGENT_PARAM = 'form';
export const SINGLE_AGENT_VALUE = 'agent';
export const SINGLE_AGENT_ROUTE = `/create?${SINGLE_AGENT_PARAM}=${SINGLE_AGENT_VALUE}`;

const CREATE_ENTRIES = [
  {
    key: 'describe',
    icon: 'MessageSquare',
    title: 'Describe what you need',
    description: 'Tell us in plain language what you want to get done.',
    // The conversational creator: a new draft opened with the Flow Copilot
    // (POST /api/process/copilot) — live graph preview + confirm-to-create (AC3).
    to: '/flows?new=describe',
  },
  {
    key: 'template',
    icon: 'LayoutTemplate',
    title: 'Start from a ready-made setup',
    description: 'Pick a proven starting point and adjust it.',
    // The curated registry + saved drafts, picked and materialised through the
    // Team Wizard's first step (AC4).
    to: '/team-setup',
  },
  {
    key: 'build',
    icon: 'PenTool',
    title: 'Build it yourself',
    description: 'Lay it out visually on a canvas and connect the pieces yourself.',
    // A fresh draft opened in the Flows canvas (POST /api/process/drafts → /flows, AC5).
    to: '/flows?new=blank',
  },
  {
    key: 'chat',
    icon: 'Rocket',
    title: 'Just give me one assistant to chat with',
    // Keeps the "team of one" framing (#1667 AC3, asserted in the test): it is
    // what stops this tile reading as a separate mode. The rationale moved.
    description: 'Start talking right away — simply a team of one you can grow later.',
    // The merged single-agent form from Phase A (#1664) — the "Fast lane" (AC6).
    // Kept as an explicit shortcut so users who just want one assistant are not
    // forced through the right-sizing flow (#1667 Phase D, AC4).
    to: '/quickstart',
  },
  {
    key: 'single-agent',
    icon: 'UserPlus',
    title: 'Create a single agent',
    // The one entry that names the artifact on purpose: it is the "I know what
    // I want" path, and someone who reaches for it already knows the word. The
    // description says what it costs (you fill the fields in) so it does not
    // read as a second, better version of the `chat` fast lane above.
    description: 'Set the id, role, Working Environment and system prompt yourself.',
    // Stays ON the launcher (#1956): the direct create form is hosted here in a
    // side panel rather than on a route of its own, so `New Agent` in Agent
    // Chat's header can hand over to plain `/create` and the four guided tiles
    // stay visible behind it. Deep-linkable, and still a plain <Link> like
    // every other tile, so the keyboard/screen-reader path is unchanged.
    to: SINGLE_AGENT_ROUTE,
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

// Is the direct single-agent form open? Accepts whatever the caller has: a
// `URLSearchParams`, a raw `?a=b` / `a=b` string, or nothing. Kept pure so the
// renderer's one branch is asserted without mounting a router.
export function isSingleAgentFormOpen(search) {
  if (!search) return false;
  const params = typeof search === 'string'
    ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    : search;
  if (typeof params.get !== 'function') return false;
  return params.get(SINGLE_AGENT_PARAM) === SINGLE_AGENT_VALUE;
}

// Where a freshly created agent should land the user. A `team` agent hosts no
// chat of its own (it is a prompt template plus a group header in the rail), so
// deep-linking to `/chats/<teamId>` would drop the user on an empty chat — the
// rail is the honest destination for it. Everything else is a real DM room.
// Guessing wrong here is exactly the dead end the create form must not create,
// so the decision is data, not an inline ternary.
export function createdAgentDestination(agent) {
  const id = agent && typeof agent.id === 'string' ? agent.id.trim() : '';
  if (!id) return '/chats';
  if (agent.role === 'team') return '/chats';
  return `/chats/${encodeURIComponent(id)}`;
}
