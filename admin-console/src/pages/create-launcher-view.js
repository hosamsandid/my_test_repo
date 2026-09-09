// Pure decision logic for the unified "Create" launcher (#1665, Phase B/C of
// epic #1661), re-sorted into three tiers by #2027.
//
// The launcher fronts every "how do I start?" entry point that used to be
// scattered across the Single Agent page, the Team Wizard's first step and the
// Flows canvas. It began as five EQUALLY-RANKED tiles per #1661 decision D1 (no
// forced default) and #1956's direct-form appendix.
//
// **#2027 supersedes D1 deliberately.** Five flat tiles turned out to be the
// paradox of choice: nothing signalled where to begin, the two single-agent
// paths read as near-duplicates with the *expert* one sounding simplest, the
// three flow paths were never named as "a team of agents working together", and
// no tile said whether you would land in a chat, an editor or an empty canvas.
// The entries are now ordered simplest → most advanced and split across three
// tiers, so `hasForcedDefault()` — the helper that asserted D1 — is gone rather
// than left asserting a rule the product no longer follows:
//
//   hero      one entry, full width, the primary action (`chat`)
//   flow      three cards under one heading that names the concept
//   advanced  collapsed disclosure, the specialist path (`single-agent`)
//
// **#1665's AC7 jargon-free-title rule is superseded too**, and for the same
// reason. It said a first-time user must be able to choose without knowing the
// words agent / team / flow / template, which is why the old titles talked
// around them ("Start from a ready-made setup", "Build it yourself"). #2027's
// AC3 requires the opposite of exactly one of those words: the flow group's
// heading must NAME the concept ("…that work together (a flow)") and define it,
// because talking around it is what left three of the five paths unidentifiable
// as the same thing. So the guard that enforced the rule is gone as well; what
// survives is the intent behind it — nobody has to ARRIVE knowing the
// vocabulary, because the one heading that uses it explains it in the next
// sentence. `template` and `orchestrator` still appear nowhere a newcomer
// looks.
//
// **#2034 narrows the "what you get" preview to the flow tier.** #2027 gave
// every entry one; in practice it only earned its place where the destination is
// genuinely non-obvious. On the hero a large chat-window schematic dominated the
// page to say that a chat is a chat, and on the advanced entry it told a
// specialist what a form looks like. So `preview` is now an OPTIONAL field —
// present on the three flow entries, absent on the other two — and `hasPreview`
// is what the renderer branches on, so the reveal path (schematic, eye
// affordance, hover/focus handlers) is absent from those two cards rather than
// hidden.
//
// This module is dependency-free and unit-tested (admin-console-src CI job);
// Create.jsx is a thin renderer over it, and the technical routing (which
// existing backend/flow each entry hands off to) lives here as data so it can
// be asserted (per the #651 convention). Icons and preview schematics are
// referenced by NAME only, so the module stays free of React / lucide imports.
//
// Every user-visible string below is #2027's binding copy inventory, verbatim,
// with exactly two deviations — both mandated by the ticket's own edge case, see
// the `build` entry.

// The direct single-agent form (#1956) is a *state of* `/create`, not a route of
// its own: the Agent Chat header's primary action leads to plain `/create`
// (AC3), and the form has to be reachable from there without a second page. A
// query param says so in the URL — deep-linkable, back-button-correct, and no
// new route/breadcrumb entry for what is one panel.
export const SINGLE_AGENT_PARAM = 'form';
export const SINGLE_AGENT_VALUE = 'agent';
export const SINGLE_AGENT_ROUTE = `/create?${SINGLE_AGENT_PARAM}=${SINGLE_AGENT_VALUE}`;

// The three tiers, outermost-first. Display order within a tier is the order of
// CREATE_ENTRIES below; the tier decides where the group is rendered.
export const CREATE_TIERS = ['hero', 'flow', 'advanced'];

// The page chrome and the flow group's framing. Kept here rather than inline in
// the JSX so the binding copy is asserted in one place (AC4).
export const CREATE_COPY = {
  pageTitle: 'What do you want to create?',
  pageSubhead: 'Pick a starting point — you can always grow or change it later.',
  // The header "?" tooltip. It doubles as the button's accessible name, so it
  // has to read as a sentence rather than as a control label.
  headerHelp: 'Not sure? Start by chatting with one assistant — you can turn it into a team anytime.',
  flowHeading: 'Or build a team of agents that work together (a flow)',
  // **Amendment to #2027's binding copy inventory (#2053 D6/AC14).** This said
  // "All three options below end in the same flow — they differ only in how you
  // start", which is where the wrong expectation was born: only *Start from a
  // ready-made team* runs a launch step and ends in a team; the other two end in
  // a DRAFT, which is a document — no agent exists, nothing runs. A newcomer
  // then reached a finished design on the canvas still looking for the team they
  // had been promised. Polishing the far end of that path while leaving this
  // sentence in place would have treated the symptom, so the sentence is
  // corrected here and the guard below asserts the correction rather than the
  // claim. The per-card `outcome` lines were always honest and are untouched.
  flowIntro: 'A flow is several agents that hand work off to each other. All three build the same kind of flow — the first ends with a live team, the other two with a design you turn into a team when it is ready.',
  advancedToggle: 'Advanced options',
};

// The Advanced disclosure starts closed for everyone, on every load, and the
// state is deliberately NOT persisted (open question 3, answered): the ticket's
// edge case says "collapsed on first load for every user", and a remembered
// expansion is indistinguishable from that only until the second visit. A
// specialist re-opening one disclosure is cheaper than a newcomer meeting five
// options again on a page whose whole point is that it ranks them.
export const ADVANCED_DEFAULT_OPEN = false;

// Ordered simplest → most advanced (#2027): chat · ready-made team · describe ·
// canvas · configure manually. The array order IS the display order — there is
// no separate rank field to fall out of sync with it.
const CREATE_ENTRIES = [
  {
    key: 'chat',
    tier: 'hero',
    icon: 'Rocket',
    title: 'Chat with one assistant',
    description: "The fastest way in. Get a single assistant you can talk to right away — and grow it into a team whenever you're ready.",
    // The hero is the only entry with an explicit button label: it is a
    // full-width primary action rather than one of a row of peers.
    action: 'Start chatting',
    badge: 'Fastest start',
    outcome: '→ Opens a chat with your assistant',
    // No `preview` (#2034): a chat window is self-evident, and at hero width the
    // schematic was the largest thing on the page. The outcome line above still
    // says where you land.
    // The merged single-agent form from Phase A (#1664) — the "Fast lane" (AC6).
    // Promoted from a peer tile to the hero by #2027: it was the easy path that
    // read as the hard one, sitting under the wordiest title on the page.
    to: '/quickstart',
  },
  {
    key: 'template',
    tier: 'flow',
    icon: 'LayoutTemplate',
    title: 'Start from a ready-made team',
    badge: 'Recommended',
    description: 'Pick a proven setup and adjust it to fit.',
    outcome: '→ Review the team, then launch it',
    preview: {
      schematic: 'template',
      caption: "You'll see a ready-made flow of agents to review, then launch.",
    },
    // The curated registry + saved drafts, picked and materialised through the
    // Team Wizard's first step (AC4).
    to: '/team-setup',
  },
  {
    key: 'describe',
    tier: 'flow',
    icon: 'MessageSquare',
    title: 'Describe what you need',
    description: 'Tell us in plain language what you want done; we draft the team for you.',
    outcome: '→ Opens an editable draft on the canvas',
    preview: {
      schematic: 'describe',
      caption: 'You type a sentence; we turn it into an editable draft flow.',
    },
    // The conversational creator: a new draft opened with the Flow Copilot
    // (POST /api/process/copilot) — live graph preview + confirm-to-create (AC3).
    to: '/flows?new=describe',
  },
  {
    key: 'build',
    tier: 'flow',
    icon: 'PenTool',
    title: 'Design it on the canvas',
    badge: 'Advanced',
    description: 'Lay the agents out visually and connect them yourself.',
    // DEVIATION 1 from the copy inventory, required by the ticket's own edge
    // case. The inventory reads "→ Opens the canvas with a guided first step",
    // but the guided empty-canvas state is explicitly out of scope here and the
    // edge case forbids shipping that promise ahead of it. Verified against the
    // code rather than assumed: an empty draft renders #1124's centered
    // "This flow is empty" block with a primary "Add agent" CTA
    // (ProcessCanvas.jsx EmptyCanvasState) — real, but a prompt, not a guided
    // step, and nothing is placed on the graph at all (flow-graph-render.js
    // returns early for zero visible nodes, so even the @github / @external
    // drag-sources are absent). So open question 1 is answered (b): ship the
    // softer interim copy the ticket itself proposes.
    outcome: '→ Opens the canvas',
    preview: {
      schematic: 'canvas',
      // DEVIATION 2, same cause. The inventory's caption promises "a guided
      // first step"; what exists is a prompt to add the first agent. The
      // "never a blank page" half is kept because it is literally true.
      caption: "You'll start on the canvas with a prompt to add your first agent — never a blank page.",
    },
    // A fresh draft opened in the Flows canvas (POST /api/process/drafts → /flows, AC5).
    to: '/flows?new=blank',
  },
  {
    key: 'single-agent',
    tier: 'advanced',
    icon: 'UserPlus',
    title: 'Configure an agent manually',
    badge: 'Advanced',
    // The one entry that names the artifact on purpose: it is the "I know what
    // I want" path, and someone who reaches for it already knows the word. It
    // was the tile that *sounded* simplest while being the specialist form, so
    // #2027 moved it behind the disclosure and renamed it after what it costs.
    description: 'Set the id, role, Working Environment and system prompt yourself. For specialists who want full control.',
    outcome: '→ Opens the agent editor',
    // No `preview` (#2034): this is the deliberate specialist path, and someone
    // who opens the disclosure to reach it does not need to be shown a form.
    // Stays ON the launcher (#1956): the direct create form is hosted here in a
    // side panel rather than on a route of its own, so `New Agent` in Agent
    // Chat's header can hand over to plain `/create` and the ranked entries
    // stay visible behind it. Deep-linkable, and still a plain <Link> like
    // every other entry, so the keyboard/screen-reader path is unchanged.
    to: SINGLE_AGENT_ROUTE,
  },
];

// One entry, copied out. A shallow copy so callers can't mutate the module-level
// list; the nested `preview` object is copied too — a renderer that memoised on
// it would otherwise share one object with the module. An entry that carries no
// preview (#2034) is handed out WITHOUT the key rather than with an empty
// object: `{}` is truthy, so a renderer branching on the field would draw an
// affordance for a preview that does not exist.
function copyEntry(entry) {
  return entry.preview
    ? { ...entry, preview: { ...entry.preview } }
    : { ...entry };
}

export function createEntries() {
  return CREATE_ENTRIES.map(copyEntry);
}

export const CREATE_ENTRY_KEYS = CREATE_ENTRIES.map((e) => e.key);

export function entryByKey(key) {
  const found = CREATE_ENTRIES.find((e) => e.key === key);
  return found ? copyEntry(found) : null;
}

// Does this entry reveal a "what you get" schematic? Since #2034 only the three
// flow entries do, so this is the renderer's one branch — and it demands a named
// schematic rather than merely a `preview` object, because an entry whose
// preview named nothing would otherwise get an eye control that reveals an empty
// panel (the reveal resolves the schematic BY NAME, and an unknown name renders
// nothing at all).
export function hasPreview(entry) {
  const schematic = entry && entry.preview && entry.preview.schematic;
  return typeof schematic === 'string' && schematic.trim().length > 0;
}

// The entries of one tier, in display order. An unknown tier yields `[]` rather
// than throwing — a renderer asking for a tier that no entry claims should draw
// nothing, not break the page.
export function entriesByTier(tier) {
  return createEntries().filter((e) => e.tier === tier);
}

// The single hero entry. Returned as one object rather than a one-element list
// because the renderer treats it as *the* primary action: full width, its own
// button label, above the flow group.
export function heroEntry() {
  return entriesByTier('hero')[0] || null;
}

// Accessible name (and tooltip) for an entry's "what you get" preview control.
// It has to name the entry, because on touch the control is the only way in and
// a screen reader meets five of them in a row (edge case: "independently
// focusable/labelled"). The state is in the label so a toggle never announces
// the opposite of what pressing it will do.
export function previewToggleLabel(entry, shown = false) {
  const title = entry && typeof entry.title === 'string' && entry.title.trim()
    ? entry.title
    : 'this option';
  return `${shown ? 'Hide' : 'Show'} what you get: ${title}`;
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
