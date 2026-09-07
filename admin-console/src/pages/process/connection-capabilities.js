// connection-capabilities.js — the single source of truth for what each Flow
// view can do with connections (unified connection model, #409).
//
// Before this module, three scattered mechanisms gated connection editing: the
// `types` prop threaded into CreateEdgeDialog, selectively-missing renderer
// callbacks (onConnect / onConnectChannel / onSelectEdge), and the `editable`
// flag inside the renderer state. Every view declared its abilities ad hoc.
// Now a view resolves its *mode* once and reads everything from the matrix:
//
//   - editable      — structural editing at all (ports, edge clicks)
//   - connectPort   — render the ● connect handle on nodes
//   - edgeClick     — edges open the edit/delete dialog
//   - actorSources  — offer the actor nodes (@github/@external) as drag
//                     sources even before they have edges (#410/#411)
//   - readOnlyHint  — the sentence shown instead of editing affordances (#413)
//   - createTypes   — per drag-source kind, the connection types the create
//                     dialog offers (the source dimension, #411)
//
// Type tokens (per source, #411):
//   agent:    'github-pr' | 'github-issue' | 'label' | 'wake' | 'artifact'
//             | 'hierarchy'
//             ('artifact' with no name/path degrades to a plain dependency —
//             the only view that offered 'dependency' as an explicit tile was
//             the BriefingPack one, removed in #1965; 'wake' is the direct
//             agent-to-agent hand-off, #2031 — agent-source only, because
//             `wakeAgent` addresses a same-team ROLE and neither @github nor
//             @external is one)
//   github:   'event'  (one unified GitHub-trigger dialog: raw events AND
//             label-based triggers incl. human-set labels / approval gates —
//             the former @human source is folded into GitHub)
//   external: 'webhook'
//
// Schedules are no longer wired from an actor — they live inside the agent
// card and the inspector's Triggers tab. Human approvals are authored on the
// edges themselves: a `gate: 'human'` on a GitHub channel, or a listener on a
// label the registry flags `humanGate` (#928 — configuration, not a naming
// convention) via the label / GitHub-trigger forms.
//
// Modes:
//   live      — a materialised team; ops write through to running agents
//   draft     — a process-template bundle being authored
//   blueprint — the role-template catalog or an imported-bundle preview
//   viewer    — any read-only projection
//
// A fifth mode, `bp` (a BriefingPack workspace, whose ops wrote back into
// brief.md front matter), was removed in #1965 together with the flow editor's
// BriefingPack source.

const PROCESS_CREATE_TYPES = {
  agent: ['github-pr', 'github-issue', 'label', 'wake', 'artifact', 'hierarchy'],
  github: ['event'],
  external: ['webhook'],
};

// Actor pseudo-node id → source kind (#411). Everything else is an agent.
// The generic @human hub is gone (#987) — human roles are named nodes, wired via
// the human-aware CreateEdgeDialog (which branches on the node's `kind`).
const ACTOR_SOURCE_KINDS = {
  '@github': 'github',
  '@external': 'external',
};

/** The drag-source kind of a node id: an actor kind or 'agent'. */
export function sourceKindOf(nodeId) {
  return ACTOR_SOURCE_KINDS[nodeId] || 'agent';
}

const MODES = {
  live: {
    mode: 'live',
    editable: true,
    connectPort: true,
    edgeClick: true,
    actorSources: true,
    readOnlyHint: null,
    createTypes: PROCESS_CREATE_TYPES,
  },
  draft: {
    mode: 'draft',
    editable: true,
    connectPort: true,
    edgeClick: true,
    actorSources: true,
    readOnlyHint: null,
    createTypes: PROCESS_CREATE_TYPES,
  },
  blueprint: {
    mode: 'blueprint',
    editable: false,
    connectPort: false,
    edgeClick: false,
    actorSources: false,
    readOnlyHint: 'Blueprint is read-only — use “Edit as draft” (or materialize it) to change it.',
    createTypes: {},
  },
  viewer: {
    mode: 'viewer',
    editable: false,
    connectPort: false,
    edgeClick: false,
    actorSources: false,
    readOnlyHint: 'Read-only view.',
    createTypes: {},
  },
};

/** The capability descriptor for a mode. Unknown modes fail closed (viewer). */
export function capabilitiesFor(mode) {
  return MODES[mode] || MODES.viewer;
}

/**
 * Resolve the Process Canvas scope to a mode. A draft is always editable; an
 * imported bundle preview and the template catalog are read-only blueprints;
 * everything else is a live team.
 */
export function processMode({ isDraft, imported, level }) {
  if (isDraft) return 'draft';
  if (imported || level === 'template') return 'blueprint';
  return 'live';
}

/** The create-type tokens a given drag-source kind offers in this mode. */
export function createTypesFor(caps, sourceKind = 'agent') {
  return (caps && caps.createTypes && caps.createTypes[sourceKind]) || [];
}
