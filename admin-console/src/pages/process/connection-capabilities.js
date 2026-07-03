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
//   - actorSources  — offer the actor nodes (@human/@github/@external/@timer)
//                     as drag sources even before they have edges (#410/#411)
//   - readOnlyHint  — the sentence shown instead of editing affordances (#413)
//   - createTypes   — per drag-source kind, the connection types the create
//                     dialog offers (the source dimension, #411)
//
// Type tokens (per source, #411):
//   agent:    'github-pr' | 'github-issue' | 'label' | 'artifact' | 'hierarchy'
//             | 'dependency'  ('artifact' with no name/path degrades to a plain
//             dependency; the BP view keeps 'dependency' as an explicit tile)
//   human:    'human-label' | 'approval'
//   github:   'event'
//   external: 'webhook'
//   timer:    'schedule'
//
// Modes:
//   live      — a materialised team; ops write through to running agents
//   draft     — a process-template bundle being authored
//   bp        — a BriefingPack workspace (brief.md frontmatter editing)
//   blueprint — the role-template catalog or an imported-bundle preview
//   viewer    — any read-only projection (BP viewer without a workspace)

const PROCESS_CREATE_TYPES = {
  agent: ['github-pr', 'github-issue', 'label', 'artifact', 'hierarchy'],
  human: ['human-label', 'approval'],
  github: ['event'],
  external: ['webhook'],
  timer: ['schedule'],
};

// Actor pseudo-node id → source kind (#411). Everything else is an agent.
const ACTOR_SOURCE_KINDS = {
  '@human': 'human',
  '@github': 'github',
  '@external': 'external',
  '@timer': 'timer',
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
  bp: {
    mode: 'bp',
    editable: true,
    connectPort: true,
    edgeClick: true,
    actorSources: false, // BriefingPacks have no triggers — no external actors
    readOnlyHint: null,
    createTypes: { agent: ['dependency', 'artifact'] },
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

/** Resolve the FlowGraph (BP viewer) source to a mode. */
export function bpMode({ workspace }) {
  return workspace ? 'bp' : 'viewer';
}

/** The create-type tokens a given drag-source kind offers in this mode. */
export function createTypesFor(caps, sourceKind = 'agent') {
  return (caps && caps.createTypes && caps.createTypes[sourceKind]) || [];
}
