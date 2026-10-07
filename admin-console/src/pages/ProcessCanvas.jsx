import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { AlertTriangle, Download, Boxes, X, Plus, Layers, Sparkles, Pencil, Loader2, Tag, User, Activity, TrendingUp, Gauge, Users } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import { initFlowGraph } from './process/flow-graph-render';
import NodeInspector from './process/NodeInspector';
import StageManager from './process/StageManager';
import LabelRegistryPanel from './process/LabelRegistryPanel';
import HumanRegistryPanel from './process/HumanRegistryPanel';
import FlowAnomaliesPanel from './process/FlowAnomaliesPanel';
import ImprovementsPanel from './process/ImprovementsPanel';
import ParallelismPanel from './process/ParallelismPanel';
import { hasPooledMember } from './process/parallelism-view.js';
import FlowCopilotPanel from './process/FlowCopilotPanel';
import { useFlowCopilot } from '../context/FlowCopilotContext.jsx';
import { proposalNodeDiff } from './process/flow-copilot-view';
import { anomalyCountByNode } from './process/flow-anomalies-view';
import { poolInstanceHintsByNode, poolInstanceRoleMap, isPoolInstanceRow } from './process/pool-instance-hint.js';
import { lintView, lintAction } from './process/lint-view';
import HumanNodeInspector from './process/HumanNodeInspector';
import { EditHandoffDialog, CreateEdgeDialog, CreateHandoffDialog, CreateChannelDialog, AgentToPersonDialog } from './process/EdgeDialogs';
import { outcomeDropDialog, edgeOpensProducerOutcome, nodeLabelTarget, labelTargetKind } from './process/outcome-routing';
import MaterializeDialog from './process/MaterializeDialog';
import SidePanel from '../components/SidePanel';
import { LabelSuffixContext } from '../components/SuffixedLabelInput';
import { labelSuffixContextFor } from './process/label-suffix-view.js';
import { roleIcon } from '../components/role-icons';
import { liveOps, makeDraftOps } from './process/edit-adapters';
import { capabilitiesFor, processMode, createTypesFor, sourceKindOf } from './process/connection-capabilities';
import { toolbarTitle, STATUS_TITLES, draftStatusText, PROPOSAL_PENDING_REASON } from './process-toolbar-hints';
import { CREATE_TEAM_LABEL, createdTeamNotice, importedBlueprintCounts } from './process/create-team-copy.js';
import {
  ADD_ROLE_MATERIALIZE_DEFAULT, ADD_ROLE_MATERIALIZE_HINT, ADD_ROLE_MATERIALIZE_LABEL,
  addRoleMaterializeBody, addRoleNotice, addRoleSubmitLabel,
} from './process/add-role-materialize.js';
import { FLOW_INTENTS } from './process/flows-rail-menu.js';
import { downloadBundle } from './process/bundle-download.js';
import { draftWriteError, isReadOnlyDraft, duplicateDraftBody, READ_ONLY_DRAFT_HINT } from './process/draft-share-view.js';
import PageHelpButton from '../components/PageHelpButton';
import { FLOWS_HELP_SECTIONS } from './process/flows-help-sections';
import Tooltip from '../components/Tooltip';
import { shouldWrapTooltip } from '../components/tooltip-wrap';

// Display names for the actor pseudo-nodes (#411) — the graph carries them as
// nodes when they have edges, but a drag can also start from a placeholder.
// (@human/@timer are gone: human actions are GitHub label events, schedules
// render inside the agent card.)
const ACTOR_NAMES = { '@github': 'GitHub', '@external': 'External system', '@timer': 'Schedule' };

// Inline-editable process name for the draft toolbar — the single rename
// control for a draft (#581). Click to edit; Enter or blur commits, Escape
// reverts. The backend re-derives the draft's storage id from the new name, and
// the panel follows the re-keyed id (see persistDraft).
function EditableDraftTitle({ name, onRename }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name || '');
  const inputRef = useRef(null);
  useEffect(() => { setValue(name || ''); }, [name]);
  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    else setValue(name || '');
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); setValue(name || ''); setEditing(false); }
        }}
        maxLength={80}
        style={{
          fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)',
          color: 'var(--eb-text-primary)', background: 'var(--eb-bg-surface)',
          border: '1px solid var(--eb-accent-primary)', borderRadius: 'var(--eb-radius-sm)',
          padding: '2px 6px', fontFamily: 'inherit', maxWidth: 320, width: '100%',
        }}
      />
    );
  }

  // The visible text is the flow's NAME, so dropping the native title="Rename
  // draft" (#1999) would leave a screen reader announcing only the name — the
  // verb would be gone. `aria-label` carries both; the tooltip stays the short
  // presentational hint.
  return (
    <Tooltip label={STATUS_TITLES.renameDraft}>
      <button
        onClick={() => setEditing(true)}
        aria-label={`Rename flow: ${name || 'Untitled flow'}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 360,
          background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer',
          fontFamily: 'inherit', color: 'var(--eb-text-primary)',
          fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name || 'Untitled flow'}
        </span>
        <Pencil size={13} style={{ flexShrink: 0, color: 'var(--eb-text-muted)' }} />
      </button>
    </Tooltip>
  );
}

// Mode pill (#1125): live-team and draft canvases were visually near-identical,
// yet a live edit re-derives triggers on running agents at once. This badge
// makes the current mode unmistakable in the toolbar. `live` = amber (edits hit
// production), `draft` = blue (safe sandbox).
// `children` is the pill's short visible text ('Live team' / 'Draft'); `title`
// is the sentence explaining what that mode means. #1999 moved the sentence
// from a native title= to the shared dark tooltip, so it is composed into
// aria-label as well — a screen reader would otherwise hear only 'Draft' and
// lose the consequence, which is the whole point of the badge.
function ModePill({ tone, icon: Icon, title, children }) {
  const live = tone === 'live';
  return (
    <Tooltip label={title} wrap={shouldWrapTooltip(title)}>
      <span
        aria-label={`${children}: ${title}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, cursor: 'help',
          padding: '2px 8px', borderRadius: 'var(--eb-radius-full)',
          fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)',
          background: live ? 'var(--eb-status-warning-bg)' : 'var(--eb-status-info-bg)',
          color: live ? 'var(--eb-status-warning)' : 'var(--eb-status-info)',
          border: `1px solid ${live ? 'var(--eb-status-warning)' : 'var(--eb-status-info)'}`,
        }}
      >
        {Icon && <Icon size={12} style={{ flexShrink: 0 }} />}
        {children}
      </span>
    </Tooltip>
  );
}

// Process graph panel (#330) — data-driven view of the agent orchestration:
// which agent reacts to which label, in what order. Embedded into the Flows
// view; the scope (a team id or 'draft:<id>') is supplied by the
// parent, which also owns the scope picker (the left Flows list). The node
// inspector (#331) and edge modeling (#332) build on the same renderer.
//
// Props:
//   scope             — '<teamId>' | 'draft:<id>' | 'import'
//   onNavigate(s)     — switch scope (e.g. after creating/opening a draft)
//   onDraftsChanged   — notify the parent that the drafts list changed (counts)
//   pendingImport     — { bundle, graph } from the Flows sidebar's Import button
//                        (#512) — seeds the read-only preview when scope is 'import'
//   onImportConsumed  — tell the parent the pendingImport has been loaded, so it
//                        can clear it and avoid re-processing on re-render
//   onImportClosed    — tell the parent the import preview was closed without
//                        continuing/materializing (scope 'import' has no
//                        underlying graph to fall back to)
//   pendingFocus      — { nodeId, tab } deep link (#963): select that node and
//                        open the given inspector tab once the graph has loaded.
//                        Fed by the `?node=&tab=` query params, so the right
//                        rail's read-only Outcomes tab can hand editing over.
//   onFocusConsumed   — tell the parent the pendingFocus was applied, so it can
//                        strip the params and not re-apply a stale selection
//   pendingIntent     — a one-shot action the Flows rail context menu asked for
//                       (#2053 B3), fed by `?intent=`. The rail cannot create a
//                       team or derive a draft from a team itself — both need
//                       the bundle this panel already loads — so it selects the
//                       row and hands the intent over rather than growing a
//                       second copy of either call. Consumed on mount, like
//                       pendingFocus; `onIntentConsumed` strips the param so a
//                       reload does not re-fire it.
//   draftReloadToken  — bump to refetch the open draft's bundle when it changed
//                       server-side without changing its id (#2053) — a rail
//                       rename whose slug is unchanged.
//   onTeamsChanged    — tell the parent the team list changed (#2737): a
//                       successful Create team adds a team the Flows rail
//                       must list without a page reload.
//   autoOpenCopilot   — open the Flow Copilot panel on mount (#1069) — fed by
//                        the `?copilot=1` query param ("Describe flow…" entry,
//                        Edit-as-draft bridge). onNavigate accepts an optional
//                        second arg `{ copilot: true }` so scope changes that
//                        should keep the panel open (draft re-key on rename,
//                        team → draft bridge) can carry the flag.
export function ProcessGraphPanel({ scope, onNavigate, onDraftsChanged, pendingImport, onImportConsumed, onImportClosed, pendingFocus = null, onFocusConsumed, autoOpenCopilot = false, pendingIntent = null, onIntentConsumed, draftReloadToken = 0, onTeamsChanged }) {
  const navigate = useCallback((s, opts) => { if (onNavigate) onNavigate(s, opts); }, [onNavigate]);

  const { data: agents, refetch: refetchAgents } = useApi('/api/agents');
  const teams = useMemo(
    () => (Array.isArray(agents) ? agents.filter(a => a.role === 'team') : []),
    [agents],
  );

  // Drafts (#345): a process being authored from scratch. Scope `draft:<id>`.
  const draftId = scope && scope.startsWith('draft:') ? scope.slice(6) : null;
  const isDraft = !!draftId;
  // A sidebar-triggered import (#512) has no underlying team/draft to fetch —
  // its graph comes from `pendingImport` instead, same as a draft's does from
  // its bundle.
  const isImportPreview = scope === 'import';
  const isTeamScope = useMemo(
    () => Array.isArray(teams) && teams.some(t => t.id === scope),
    [teams, scope],
  );
  // The team agent's own `wipLimit`/`autoDispatch` (#2272 Parallelism panel) —
  // already present on every `/api/agents` entry (GET /api/agents/:id spreads
  // the full config), so no separate fetch. `hasPooledMember` answers the
  // panel's auto-dispatch prerequisite from the SAME list.
  const parallelismTeamCfg = useMemo(
    () => (isTeamScope && Array.isArray(agents) ? agents.find(a => a.id === scope) : null),
    [agents, scope, isTeamScope],
  );
  const hasPooledRole = useMemo(() => hasPooledMember(agents, scope), [agents, scope]);

  // Scope is always one of: a team id (live graph), 'draft:<id>' (derived
  // client-side from the bundle, so no fetch), or 'import' (derived
  // client-side from pendingImport, so no fetch either). A null url skips the
  // fetch for the client-derived scopes.
  // All scopes feed the unified rich renderer (#362 UI rework C3).
  const graphUrl = (isDraft || isImportPreview)
    ? null
    : `/api/flows/graph?team=${encodeURIComponent(scope)}`;
  const { data: graph, loading, error, refetch } = useApi(graphUrl);

  // Live pool instances (#2814): not graph nodes (the server leaves them out),
  // shown as an "n running" hint on their role's node instead. Read from the
  // team's pool-control — the same instance read and status rule as the
  // pool-instance lanes — and re-read whenever the graph is.
  const poolControlUrl = !isDraft && !isImportPreview && isTeamScope && hasPooledRole
    ? `/api/teams/${encodeURIComponent(scope)}/pool-control` : null;
  const { data: poolControl, refetch: refetchPoolControl } = useApi(poolControlUrl);
  const seenGraphRef = useRef(null);
  useEffect(() => {
    // Skip the first graph load — useApi already fetched for the new URL.
    if (graph && seenGraphRef.current && poolControlUrl) refetchPoolControl();
    seenGraphRef.current = graph;
  }, [graph]); // eslint-disable-line react-hooks/exhaustive-deps
  const poolHints = useMemo(() => poolInstanceHintsByNode(poolControl), [poolControl]);

  // An imported bundle (#334) overrides the fetched graph until closed — shown
  // as a read-only blueprint that can be materialised into a real team.
  const [imported, setImported] = useState(null); // { bundle, graph }
  const [importError, setImportError] = useState(null);
  const [materializeOpen, setMaterializeOpen] = useState(false);
  // The team a successful creation produced, so the dialog can confirm it
  // instead of closing and navigating away with nothing said (#2053 D5/AC12).
  const [createdTeam, setCreatedTeam] = useState(null);
  // The proposal a rail `Create team…` was refused against. Scoped to that
  // exact proposal object rather than a boolean: `proposal` CYCLES (every
  // Copilot turn sets a new one, Apply and Discard clear it), so a write-once
  // flag would latch and re-attach the refusal to the next proposal the user
  // asked for — telling them to discard the very thing they are being asked to
  // review. Comparing identity self-clears on both replacement and resolution,
  // with no clearing effect to keep in sync.
  const [refusedFor, setRefusedFor] = useState(null);
  const [addRoleOpen, setAddRoleOpen] = useState(false);
  // Success notice after a live-team "Add agent" (#2558 AC6) — stub vs
  // provisioned, as reported by the server. Tagged with the scope it was
  // raised in so it never lingers onto another team's canvas.
  const [addRoleResult, setAddRoleResult] = useState(null); // { scope, text }
  const [stagesOpen, setStagesOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [humansOpen, setHumansOpen] = useState(false);
  const [anomaliesOpen, setAnomaliesOpen] = useState(false);
  // Per-node anomaly counts (#959) — overlaid as a badge on the canvas cards.
  const [anomalyList, setAnomalyList] = useState([]);
  // Stable callback so FlowAnomaliesPanel's useCallback([teamId, onData]) dep never
  // changes between renders — an inline arrow here would recreate load() on every
  // render, causing an infinite fetch → setState → re-render → fetch loop.
  const onAnomalyData = useCallback(
    (data) => setAnomalyList(Array.isArray(data && data.anomalies) ? data.anomalies : []),
    [],
  );
  // A pool instance is not a node (#2814): its anomalies count on its role.
  const anomalyCounts = useMemo(
    () => anomalyCountByNode(anomalyList, poolInstanceRoleMap(agents)),
    [anomalyList, agents],
  );
  // Improvements panel (#1223, hill-climbing loop Phase 1) — run-metric tiles.
  const [improvementsOpen, setImprovementsOpen] = useState(false);
  // Parallelism panel (#2272, Amendment 2 A2.2) — team-axis pool config.
  const [parallelismOpen, setParallelismOpen] = useState(false);

  // Flow Copilot (#1069): a docked chat rail; each turn yields a PROPOSAL
  // { bundle, graph, ok } rendered exactly like the import preview — read-only
  // graph + banner — until the user applies (normal draft PUT) or discards it.
  const [copilotOpen, setCopilotOpen] = useState(!!autoOpenCopilot);
  const [proposal, setProposal] = useState(null); // { bundle, graph, ok }
  const copilotOpenRef = useRef(copilotOpen);
  copilotOpenRef.current = copilotOpen;
  // The panel registers { apply, discard, ok, busy } here so the canvas banner
  // and the chat card share the same handlers.
  const copilotActionsRef = useRef(null);
  // The app-level turn owner (#2087). Read here only to follow a draft rename
  // (below) — the panel is what drives it.
  const flowCopilot = useFlowCopilot();

  // Draft bundle + its derived graph. The bundle is the source of truth; the
  // graph is recomputed server-side from it on every change.
  const [draftBundle, setDraftBundle] = useState(null);
  const [draftGraph, setDraftGraph] = useState(null);
  const draftBundleRef = useRef(null);
  // #2870 AC10 — a draft reached only through "Visible to everyone" opens
  // read-only: the canvas behaves like a blueprint preview, the edit toolbar
  // and Copilot are hidden, and the banner offers "Duplicate to my drafts".
  // The server refuses the writes regardless (AC11); this keeps the UI honest.
  const draftReadOnly = !!draftId && isReadOnlyDraft(draftBundle);

  // `draftReloadToken` (#2053) re-runs this when the draft changed underneath us
  // without its id changing — a case- or punctuation-only rename from the Flows
  // rail keeps the slug, so `draftId` alone would leave us holding a bundle with
  // the OLD name, which the next canvas edit would PUT back and silently undo
  // the rename. A refetch rather than a remount, deliberately: remounting would
  // also discard an unapplied Copilot proposal and close the Copilot rail.
  useEffect(() => {
    if (!draftId) { draftBundleRef.current = null; setDraftBundle(null); setDraftGraph(null); return; }
    let alive = true;
    apiCall('GET', `/api/process/drafts/${draftId}`)
      .then(b => { if (alive) { draftBundleRef.current = b; setDraftBundle(b); } })
      // #2068 AC17 — a draft deleted, or unshared, under an open canvas comes
      // back as a bare 404. Say what happened instead of relaying "Draft not
      // found", which reads like a bug in the URL.
      .catch(e => { if (alive) setImportError(draftWriteError(e, e.message)); });
    return () => { alive = false; };
  }, [draftId, draftReloadToken]);

  useEffect(() => {
    if (!draftBundle) return;
    let alive = true;
    // Derive the unified graph from the bundle — the rich renderer consumes it
    // directly (label + dependency + artifact edges + the content/prompt).
    apiCall('POST', '/api/flows/graph', { processTemplate: draftBundle })
      .then(g => { if (alive) setDraftGraph(g); }).catch(() => {});
    return () => { alive = false; };
  }, [draftBundle]);

  const persistDraft = useCallback(async (next) => {
    if (isReadOnlyDraft(draftBundleRef.current)) throw new Error(READ_ONLY_DRAFT_HINT);
    let saved;
    try {
      saved = await apiCall('PUT', `/api/process/drafts/${draftId}`, next);
    } catch (e) {
      // #2068 AC17 — the draft can disappear from under an open editor: deleted
      // by another holder, or your access removed. Surface it as a sentence on
      // the page's own error line and re-throw, so the dialog that triggered the
      // save still sees the failure and does not report success.
      setImportError(draftWriteError(e, e.message));
      throw e;
    }
    draftBundleRef.current = saved;
    setDraftBundle(saved);
    if (onDraftsChanged) onDraftsChanged();
    // A rename re-keys the draft (#581): follow the new id so the open selection,
    // the URL scope param and every subsequent save target the live id (AC6).
    // Carry the copilot flag so an apply that renames the draft (the first
    // Copilot generation proposes a name) reopens the panel after the remount.
    if (saved.id && saved.id !== draftId) {
      // #2087 edge case: a turn (or an unapplied proposal) is bound to the OLD
      // scope key, which nothing can select any more. Re-key it onto the new id
      // before navigating — the binding follows the rename rather than silently
      // mismatching. Done first, because the navigate remounts this subtree.
      if (flowCopilot) flowCopilot.rekeyScope(`draft:${draftId}`, `draft:${saved.id}`);
      navigate(`draft:${saved.id}`, { copilot: copilotOpenRef.current });
    }
  }, [draftId, onDraftsChanged, navigate, flowCopilot]);

  const draftOps = useMemo(
    () => makeDraftOps(() => draftBundleRef.current, persistDraft),
    [persistDraft],
  );
  const ops = isDraft ? draftOps : liveOps;

  // Live stage-management ops (#674): bind the team id (= scope) so StageManager
  // keeps its name-only contract (addStage(name)/renameStage(old,new)/…) — the
  // same shape draftOps exposes. Live scope only; unused for drafts/imports.
  const liveStageOps = useMemo(() => ({
    addStage: (name) => liveOps.addStage(scope, name),
    renameStage: (oldName, newName) => liveOps.renameStage(scope, oldName, newName),
    removeStage: (name) => liveOps.removeStage(scope, name),
    reorderStages: (names) => liveOps.reorderStages(scope, names),
  }), [scope]);

  // Live label-registry ops (#981): same teamId binding as the stage ops, so
  // LabelRegistryPanel keeps its name-first contract in both modes.
  const liveLabelOps = useMemo(() => ({
    setLabelFlags: (name, flags) => liveOps.setLabelFlags(scope, name, flags),
    removeLabels: (names) => liveOps.removeLabels(scope, names),
  }), [scope]);

  // Live human-role ops (#987): same teamId binding, so HumanRegistryPanel keeps
  // its name-first contract in both modes (draft mutates the bundle's humans[]).
  const liveHumanOps = useMemo(() => ({
    upsertHuman: (human) => liveOps.upsertHuman(scope, human),
    removeHuman: (id) => liveOps.removeHuman(scope, id),
    getHuman: (id) => liveOps.getHuman(scope, id),
    wireHumanConsume: (id, entry) => liveOps.wireHumanConsume(scope, id, entry),
    unwireHumanConsume: (id, entry) => liveOps.unwireHumanConsume(scope, id, entry),
    addHumanEmit: (id, label) => liveOps.addHumanEmit(scope, id, label),
    removeHumanEmit: (id, label) => liveOps.removeHumanEmit(scope, id, label),
  }), [scope]);

  // #2858: a live team's label editors show the base + the suffix as a chip.
  // Drafts, imports and Copilot proposals are templates — no suffix there.
  const labelSuffixCtx = useMemo(
    () => (parallelismTeamCfg && !imported && !proposal ? labelSuffixContextFor(parallelismTeamCfg) : null),
    [parallelismTeamCfg, imported, proposal],
  );
  // A Copilot proposal wins the display like an imported bundle does — the
  // canvas is the read-only preview of what the chat produced (#1069).
  const displayGraph = proposal ? proposal.graph : imported ? imported.graph : isDraft ? draftGraph : graph;

  const [selectedId, setSelectedId] = useState(null);
  const [connectPair, setConnectPair] = useState(null); // { from, to } — from may be an actor id (#411)
  const [outcomeConnect, setOutcomeConnect] = useState(null); // { from, to, outcome } — outcome-port drag (#828)
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [routingFocus, setRoutingFocus] = useState(null); // { tab:'routing', outcome } — outcome-edge click (#828)
  const viewportRef = useRef(null);
  const graphRef = useRef(null);
  const editableRef = useRef(true);
  // Current inline-prompt save handler (draft only) — kept in a ref so the
  // renderer, created once, always calls the live one.

  useEffect(() => {
    if (!viewportRef.current) return;
    const g = initFlowGraph(viewportRef.current, {
      onSelectNode: (id) => { setSelectedId(id); setRoutingFocus(null); },
      onConnect: (from, to) => { if (editableRef.current) setConnectPair({ from, to }); },
      // Outcome-port drag (#828): pre-fill a label hand-off from the outcome onto
      // the drop target — only the listener is created (the source already emits
      // via its outcome).
      onConnectOutcome: (from, to, outcome) => { if (editableRef.current) setOutcomeConnect({ from, to, outcome }); },
      // Clicking an outcome-keyed edge focuses the Routing tab on that outcome
      // (#828) — but NOT a label hand-off edge (#1192): that opens the hand-off
      // edit dialog (Delivery, label, wake prompt, delete), so editing an edge
      // is symmetric with creating it; the dialog links back to the outcome.
      // Every other edge keeps its own edit dialog.
      onSelectEdge: (edge) => {
        if (!editableRef.current) return;
        if (edgeOpensProducerOutcome(edge)) {
          setSelectedId(edge.from);
          graphRef.current?.setSelected(edge.from);
          setRoutingFocus({ tab: 'routing', outcome: edge.outcome });
          setSelectedEdge(null);
        } else {
          setSelectedEdge(edge);
        }
      },
      actorSources: true, // offer @github/@external as drag sources (#411)
      expandChildrenByDefault: false, // start collapsed; user expands on demand to avoid rendering crashes on large flows
    });
    graphRef.current = g;
    return () => { g.cleanup(); graphRef.current = null; };
  }, []);

  // What this view may do with connections — resolved once per scope from the
  // capability matrix (#409). A draft's derived graph reports level 'template',
  // so the mode is driven off the scope, not the level. A pending Copilot
  // proposal turns the view read-only exactly like an imported blueprint.
  const caps = useMemo(
    () => capabilitiesFor(processMode({
      isDraft: isDraft && !proposal && !draftReadOnly,
      imported: imported || proposal || draftReadOnly,
      level: displayGraph?.level,
    })),
    [isDraft, imported, proposal, draftReadOnly, displayGraph],
  );

  useEffect(() => {
    if (!graphRef.current || !displayGraph) return;
    editableRef.current = caps.editable;
    graphRef.current.setEditable(caps.editable);
    // Prompt/stage editing happens in the right inspector (DraftNodeInspector),
    // consistent with BP flows — there is no inline editing.
    graphRef.current.setData(displayGraph);
  }, [displayGraph, imported, isDraft, caps]);

  // Overlay a per-node anomaly badge on the canvas cards (#959). Runs AFTER
  // setData so it decorates freshly-rendered `.bp-node` elements; re-runs
  // whenever the counts or graph change, and removes stale badges each pass.
  useEffect(() => {
    const root = viewportRef.current;
    if (!root) return;
    const stale = root.querySelectorAll('.bp-anomaly-badge');
    stale.forEach((el) => el.remove());
    for (const [id, count] of Object.entries(anomalyCounts || {})) {
      if (!count) continue;
      const node = root.querySelector(`.bp-node[data-id="${(window.CSS && window.CSS.escape) ? window.CSS.escape(id) : id}"]`);
      if (!node) continue;
      if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
      const badge = document.createElement('div');
      badge.className = 'bp-anomaly-badge';
      badge.title = `${count} flow anomal${count === 1 ? 'y' : 'ies'} — open the Anomalies panel`;
      badge.textContent = String(count);
      badge.style.cssText =
        'position:absolute;top:-8px;right:-8px;min-width:18px;height:18px;padding:0 5px;' +
        'border-radius:999px;background:var(--eb-status-warning,#d97706);color:var(--eb-text-on-warning);font-size:11px;' +
        'font-weight:700;display:flex;align-items:center;justify-content:center;z-index:5;' +
        'box-shadow:0 1px 3px rgba(0,0,0,0.3);pointer-events:none;';
      node.appendChild(badge);
    }
    return () => {
      if (viewportRef.current) viewportRef.current.querySelectorAll('.bp-anomaly-badge').forEach((el) => el.remove());
    };
  }, [anomalyCounts, displayGraph]);

  // "n running" hint on a pooled role's card (#2814 AC4) — same overlay
  // technique as the anomaly badge, bottom-right so the two never overlap.
  // Live team graph only: a draft, import or Copilot proposal has no instances.
  const showPoolHints = !isDraft && !imported && !proposal;
  useEffect(() => {
    const root = viewportRef.current;
    if (!root) return;
    root.querySelectorAll('.bp-pool-hint-badge').forEach((el) => el.remove());
    if (!showPoolHints) return;
    for (const [id, hint] of Object.entries(poolHints || {})) {
      const node = root.querySelector(`.bp-node[data-id="${(window.CSS && window.CSS.escape) ? window.CSS.escape(id) : id}"]`);
      if (!node) continue;
      if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
      const badge = document.createElement('div');
      badge.className = 'bp-pool-hint-badge';
      badge.title = `${hint.title} — open the node for details`;
      badge.textContent = hint.text;
      badge.style.cssText =
        'position:absolute;bottom:-9px;right:8px;height:18px;padding:0 6px;' +
        'border-radius:999px;background:var(--eb-bg-elevated);color:var(--eb-text-secondary);' +
        'border:1px solid var(--eb-border-default);font-size:11px;font-weight:600;white-space:nowrap;' +
        'display:flex;align-items:center;z-index:5;pointer-events:none;';
      node.appendChild(badge);
    }
    return () => {
      if (viewportRef.current) viewportRef.current.querySelectorAll('.bp-pool-hint-badge').forEach((el) => el.remove());
    };
  }, [poolHints, displayGraph, showPoolHints]);

  // Clear selection/dialogs when the scope (and thus the graph) changes. A
  // scope change from the parent also drops any imported blueprint preview or
  // Copilot proposal preview.
  useEffect(() => { setSelectedId(null); setConnectPair(null); setOutcomeConnect(null); setSelectedEdge(null); setRoutingFocus(null); }, [scope, imported, proposal]);
  useEffect(() => { setAnomaliesOpen(false); setAnomalyList([]); setImprovementsOpen(false); }, [scope]);
  useEffect(() => { setImported(null); setImportError(null); setProposal(null); }, [scope]);

  // Sidebar-triggered import (#512): seed the read-only preview from the
  // parent-supplied bundle instead of the (now-removed) in-editor file picker.
  // Runs after the scope-reset effect above so it isn't immediately cleared.
  useEffect(() => {
    if (isImportPreview && pendingImport) {
      setImported(pendingImport);
      setImportError(null);
      setSelectedId(null);
      if (onImportConsumed) onImportConsumed();
    }
  }, [isImportPreview, pendingImport, onImportConsumed]);

  // Deep-link focus (#963): `?node=<id>&tab=routing` selects a node and opens
  // that inspector tab. Like the import effect above, this is declared AFTER the
  // scope-reset effect so its selection isn't immediately cleared. It waits for
  // the graph — the node has to exist in it, and `setSelected` before `setData`
  // would be overwritten by the render. A one-shot ref keeps a re-render from
  // fighting the user's next click, and the parent strips the params once
  // applied.
  const focusConsumedRef = useRef(null);
  useEffect(() => {
    const nodeId = pendingFocus?.nodeId;
    if (!nodeId || !displayGraph) return;
    if (focusConsumedRef.current === nodeId) return;
    if (!(displayGraph.nodes || []).some(n => n.id === nodeId)) return;
    focusConsumedRef.current = nodeId;
    setSelectedEdge(null);
    setSelectedId(nodeId);
    graphRef.current?.setSelected(nodeId);
    if (pendingFocus.tab) setRoutingFocus({ tab: pendingFocus.tab });
    if (onFocusConsumed) onFocusConsumed();
  }, [pendingFocus, displayGraph, onFocusConsumed]);

  const nodeName = (id) =>
    (displayGraph?.nodes || []).find(n => n.id === id)?.displayName || ACTOR_NAMES[id] || id;
  // Which dialog an outcome-port drag opens (#1035): a human drop target routes
  // to the agent-to-person delivery form (like the generic ● port), never the
  // channel/hand-off forms which resolve agent consumers only and would throw
  // `role … not found` on a human.
  const outcomeToNode = outcomeConnect
    ? (displayGraph?.nodes || []).find(n => n.id === outcomeConnect.to) || null
    : null;
  // #2629: an outcome-port drag pre-selects where the label lands (PR vs issue)
  // from the producer's outcome, so the listener is typed on the right event.
  const outcomeFromNode = outcomeConnect
    ? (displayGraph?.nodes || []).find(n => n.id === outcomeConnect.from) || null
    : null;
  const outcomeDialog = outcomeConnect
    ? outcomeDropDialog(outcomeConnect.outcome, outcomeToNode)
    : null;
  const selectedNode = useMemo(
    () => (displayGraph?.nodes || []).find(n => n.id === selectedId) || null,
    [displayGraph, selectedId],
  );
  const selectedRole = isDraft && draftBundle && !draftReadOnly
    ? (draftBundle.roles || []).find(r => r.id === selectedId) || null
    : null;
  // A selected first-class human role (#987). Draft humans live on the bundle's
  // `humans[]`; live humans arrive as `kind:'human'` graph nodes — normalize both
  // to the { id, name, description, stage, emits, consumes } editor shape.
  const selectedHuman = useMemo(() => {
    if (!selectedId) return null;
    // A read-only draft opens its nodes in the template inspector instead.
    if (draftReadOnly) return null;
    if (isDraft && !proposal) return (draftBundle?.humans || []).find(h => h.id === selectedId) || null;
    const n = (displayGraph?.nodes || []).find(x => x.id === selectedId && x.kind === 'human');
    if (!n) return null;
    return {
      id: n.id, name: n.displayName || n.id, description: n.description || '',
      stage: n.stage || '', emits: n.emits || [], consumes: n.consumes || [],
    };
  }, [selectedId, isDraft, proposal, draftReadOnly, draftBundle, displayGraph]);

  function afterEdit() { if (!isDraft) refetch(); /* draft re-derives via persist */ }

  // "Open in Routing" jump (#865): an edge edit dialog hands control to the
  // owning node's inspector, focused on the row/section that carries the edge —
  // the same setRoutingFocus mechanism the canvas uses for outcome-edge clicks.
  // A 'structure' section targets the Details tab (Parent lives there now).
  function openRouting(nodeId, section, outcome) {
    if (!nodeId) return;
    setSelectedEdge(null);
    setSelectedId(nodeId);
    graphRef.current?.setSelected(nodeId);
    // An outcome jump (#1192) focuses the producer's Outcomes on that option —
    // the same shape the canvas uses for a direct outcome-edge click; otherwise
    // focus a section ('structure' → the Details tab).
    setRoutingFocus(outcome
      ? { tab: 'routing', outcome }
      : { tab: section === 'structure' ? 'details' : 'routing', section });
  }

  // Round-trip (#348): open a live team as an editable draft copy. The Copilot
  // panel's team-scope bridge (#1069) passes `openCopilot: true` so the chat
  // continues in the new draft (a bare `true` check — the toolbar's onClick
  // hands the click event in).
  async function editAsDraft(openCopilot) {
    try {
      const res = await fetch(`/api/process/template?team=${encodeURIComponent(scope)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tpl = await res.json();
      const d = await apiCall('POST', '/api/process/drafts', {
        name: `${tpl.name || scope} (draft)`,
        processTemplate: { ...tpl, sourceTeamId: scope },
      });
      if (onDraftsChanged) onDraftsChanged();
      navigate(`draft:${d.id}`, { copilot: openCopilot === true });
    } catch (e) { setImportError(e.message); }
  }

  // Act on a rail context-menu intent (#2053 B3), then ask the page to strip the
  // param. `edit-draft` runs through the SAME `editAsDraft` the toolbar calls,
  // which is the point of routing the rail through an intent instead of
  // re-implementing the call there.
  //
  // Firing this from an effect rather than from `materializeOpen`'s initial
  // state is what makes the already-selected row work: this panel is keyed on
  // `scope`, so an intent for the row that is ALREADY open changes the prop
  // without remounting, and a `useState` initializer would never be re-read.
  // The single-fire guard is the param itself — `onIntentConsumed` clears it, so
  // this re-runs once and returns early — deliberately NOT a ref, which would
  // latch after the first use and silently ignore the same request a second
  // time. The dialog's own render guard still waits for the bundle, so an
  // intent that arrives before the draft has loaded opens the dialog once it
  // has instead of flashing an empty panel.
  useEffect(() => {
    if (!pendingIntent) return;
    if (pendingIntent === FLOW_INTENTS.createTeam) {
      // The menu gates on `roleCount`, which it can see off the drafts list —
      // but NOT on a pending Copilot proposal, which is panel state. Without
      // this check, choosing `Create team…` for the row that is already open
      // while a proposal is previewing would create a real team from
      // `draftBundle`, i.e. the design UNDERNEATH the one on screen. Refuse and
      // say why, rather than acting on a bundle the user is not looking at.
      //
      // The refusal is a flag, not a message in `importError`: that channel is
      // cleared only on a scope change, so the sentence would outlive the
      // proposal it describes and still be on screen after a Discard. Keyed on
      // the proposal object, it disappears exactly when that one goes away.
      if (proposal) setRefusedFor(proposal);
      else setMaterializeOpen(true);
    }
    if (pendingIntent === FLOW_INTENTS.editAsDraft) editAsDraft(false);
    if (onIntentConsumed) onIntentConsumed();
    // `editAsDraft`/`onIntentConsumed` are stable; the deps hold only the
    // trigger so a re-render never re-fires an action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingIntent]);

  // Apply a Copilot proposal: the normal draft write — from then on it IS the
  // draft, editable with every existing dialog. The chat history (#1071) rides
  // along in the same PUT (`copilot` is storage metadata the server
  // normalizes). Clearing the preview drops the canvas back to the (now
  // updated) draft graph.
  const applyCopilotBundle = useCallback(async (b, persistedMessages) => {
    await persistDraft({ ...b, copilot: { messages: persistedMessages || [] } });
    setProposal(null);
  }, [persistDraft]);

  // History-only write (#1071) — after each turn/decision. Best-effort: a
  // failed history save must never surface as a chat error.
  const persistCopilotHistory = useCallback(async (persistedMessages) => {
    const cur = draftBundleRef.current;
    if (!cur) return;
    try { await persistDraft({ ...cur, copilot: { messages: persistedMessages || [] } }); }
    catch { /* best-effort */ }
  }, [persistDraft]);

  // Flow Copilot on the LIVE team (#2556). Loaded when the panel opens: the
  // team's portable bundle (what the chat edits and what Apply re-checks
  // against), and the shared chat history — whose GET doubles as the edit-
  // rights probe, since it uses the same canManageAgent gate as every write.
  // A 403 means read-only (AC8); the history stays hidden (AC16).
  const [liveCopilot, setLiveCopilot] = useState(null); // { bundle, canEdit, history }
  const liveTeamCopilot = copilotOpen && isTeamScope && !imported;
  const fetchLiveBundle = useCallback(async () => {
    const res = await fetch(`/api/process/template?team=${encodeURIComponent(scope)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, [scope]);
  const loadLiveCopilot = useCallback(async () => {
    let canEdit = true;
    let history = { messages: [] };
    try { history = await apiCall('GET', `/api/teams/${encodeURIComponent(scope)}/copilot-history`); }
    catch (e) { if (e && (e.status === 403 || e.status === 404)) canEdit = false; }
    let bundle = null;
    try { bundle = await fetchLiveBundle(); } catch { /* the panel stays unable to send */ }
    setLiveCopilot({ bundle, canEdit, history: canEdit ? history : { messages: [] } });
  }, [scope, fetchLiveBundle]);
  // Reloaded on every open, so a reopened panel hydrates the history as the
  // last close (or another editor) left it, not as it was on first open (AC11).
  useEffect(() => {
    if (!liveTeamCopilot) { setLiveCopilot(null); return; }
    if (!liveCopilot) loadLiveCopilot();
  }, [liveTeamCopilot, liveCopilot, loadLiveCopilot]);
  const persistLiveCopilotHistory = useCallback(async (persistedMessages) => {
    try { await apiCall('PUT', `/api/teams/${encodeURIComponent(scope)}/copilot-history`, { messages: persistedMessages || [] }); }
    catch { /* best-effort, like the draft history */ }
  }, [scope]);
  // The live apply transport: every step is an EXISTING route (AC8) — the
  // generic ones via apiCall, trigger creation via liveOps so a github-event
  // trigger gets the agent's repo filled in exactly as on the canvas.
  const liveCopilotTransport = useMemo(() => ({
    teamId: scope,
    // Roles only — an auto-scaled pool instance is not a member to edit (#2814).
    memberIds: Array.isArray(agents) ? agents.filter(a => a.parentTeamId === scope && !isPoolInstanceRow(a)).map(a => a.id) : [],
    fetchCurrent: fetchLiveBundle,
    fetchTickets: async () => {
      try {
        const r = await apiCall('GET', `/api/teams/${encodeURIComponent(scope)}/tickets`);
        return Array.isArray(r && r.tickets) ? r.tickets : null;
      } catch { return null; }
    },
    call: (step) => (step.op === 'createTrigger'
      ? liveOps.createTrigger(step.memberId, step.body)
      : apiCall(step.method, step.url, step.body)),
    onApplied: async () => {
      setProposal(null);
      refetch();
      refetchAgents();
      try {
        const bundle = await fetchLiveBundle();
        setLiveCopilot(c => (c ? { ...c, bundle } : c));
      } catch { /* the next open reloads it */ }
    },
  }), [scope, agents, fetchLiveBundle, refetch, refetchAgents]);

  // Canvas diff-highlighting (#1071 item 2): the proposal's node-level delta
  // vs. the current draft — added green, modified amber, removed in the banner.
  // On a live team the base is the team's exported bundle (#2556).
  const proposalDiff = useMemo(() => {
    if (!proposal) return null;
    if (isDraft) return proposalNodeDiff(draftBundle, proposal.bundle);
    if (isTeamScope && liveCopilot && liveCopilot.bundle) return proposalNodeDiff(liveCopilot.bundle, proposal.bundle);
    return null;
  }, [proposal, isDraft, draftBundle, isTeamScope, liveCopilot]);

  // Overlay the diff outlines on the freshly-rendered `.bp-node` cards — the
  // same decorate-after-setData pattern as the anomaly badges above.
  useEffect(() => {
    const root = viewportRef.current;
    if (!root) return;
    const clear = () => root.querySelectorAll('.bp-node[data-copilot-diff]').forEach((el) => {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.removeAttribute('data-copilot-diff');
    });
    clear();
    if (!proposalDiff) return undefined;
    const paint = (ids, color) => {
      for (const id of ids) {
        const node = root.querySelector(`.bp-node[data-id="${(window.CSS && window.CSS.escape) ? window.CSS.escape(id) : id}"]`);
        if (!node) continue;
        node.style.outline = `2px solid ${color}`;
        node.style.outlineOffset = '2px';
        node.setAttribute('data-copilot-diff', '1');
      }
    };
    paint(proposalDiff.added, 'var(--eb-status-success, #16a34a)');
    paint(proposalDiff.modified, 'var(--eb-status-warning, #d97706)');
    return clear;
  }, [proposalDiff, displayGraph]);

  // Live team: materialize a new role as a team-member immediately (#585) via the
  // existing member-create path — no draft round-trip. The member id mirrors the
  // wizard's `<teamId>-<roleId>` scheme so a name that resolves to an existing
  // member surfaces as a clear 409 (E1) instead of silently overwriting. Skills
  // and MCP are left to inherit from the team/env — no overrides (AC4).
  //
  // #2558: `materializeNow` (the dialog's checkbox, default off) is always sent
  // explicitly — off creates a stub (config + triggers only, no Matrix user,
  // clone or container) that Agent Chat lists under "Not materialized yet".
  async function addLiveRole({ displayName, systemPrompt, templateId, materializeNow }) {
    const slug = String(displayName || 'role').toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'role';
    const body = {
      id: `${scope}-${slug}`, displayName: displayName.trim(),
      ...addRoleMaterializeBody({ materializeNow }),
    };
    if (templateId) {
      // Template-based add (#586, AC-5): the backend loads the template, resolves
      // the team's `{{vars}}` from its env, and materializes a member with the
      // template's session policy + triggers substituted per-member.
      body.templateId = templateId;
    } else {
      const prompt = (systemPrompt || '').trim();
      if (prompt) body.systemPromptOverride = prompt;
    }
    const created = await apiCall('POST', `/api/agents/${encodeURIComponent(scope)}/members`, body);
    refetch(); // the graph now shows the new member as a live node (AC5)
    const id = (created && created.id) || body.id;
    setAddRoleResult({ scope, text: addRoleNotice({ ...(created || {}), id }) });
    return id;
  }

  // Continue an imported blueprint as an editable draft instead of materializing
  // straight away — turns the read-only preview into a real draft you can keep
  // building on before creating a team.
  async function continueImportAsDraft() {
    if (!imported?.bundle) return;
    try {
      const tpl = imported.bundle;
      const d = await apiCall('POST', '/api/process/drafts', {
        name: tpl.name || 'Imported flow',
        processTemplate: tpl,
      });
      if (onDraftsChanged) onDraftsChanged();
      setImported(null);
      setSelectedId(null);
      navigate(`draft:${d.id}`);
    } catch (e) { setImportError(e.message); }
  }

  // Source bundle for the Materialize dialog: an imported file or the open
  // draft. The `copilot` chat history is draft-storage metadata (#1071) —
  // stripped here so it never reaches materialisation.
  const materializeBundle = useMemo(() => {
    const src = imported ? imported.bundle : isDraft ? draftBundle : null;
    if (!src || src.copilot === undefined) return src;
    const { copilot, ...rest } = src;
    return rest;
  }, [imported, isDraft, draftBundle]);

  // #2870 AC10 — a read-only reader's way to an editable copy: an ordinary
  // private draft created through the same route as "Continue as draft".
  async function duplicateToMyDrafts() {
    try {
      const d = await apiCall('POST', '/api/process/drafts', duplicateDraftBody(draftBundleRef.current));
      if (onDraftsChanged) onDraftsChanged();
      if (navigate) navigate(`draft:${d.id}`);
    } catch (e) {
      setImportError(`Duplicate failed: ${draftWriteError(e, e.message)}`);
    }
  }

  async function exportBundle() {
    let bundle;
    if (isDraft) {
      // Strip the chat history from the portable export (#1071).
      bundle = materializeBundle;
    } else {
      const url = `/api/process/template?team=${encodeURIComponent(scope)}`;
      const res = await fetch(url);
      if (!res.ok) { setImportError(`Export failed: HTTP ${res.status}`); return; }
      bundle = await res.json();
    }
    // Shared with the Flows rail's own Export… entry (#2053) so the two export
    // buttons on this page cannot disagree about the filename.
    downloadBundle(bundle);
  }

  return (
    // Outer row: the canvas column + the docked Copilot rail (#1069). The rail
    // is a flex CHILD, not an overlay — the canvas stays visible and
    // interactive while chatting (it is the live preview of the chat's output).
    <LabelSuffixContext.Provider value={labelSuffixCtx}>
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar — the scope picker lives in the Flows left list, not here. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-3) var(--eb-space-4)', borderBottom: '1px solid var(--eb-border-default)', flexShrink: 0, flexWrap: 'wrap', minWidth: 0 }}>
        {/* Mode pill (#1125): live-team and draft canvases looked almost
            identical, yet a live edit re-derives triggers on running agents
            immediately. Badge the mode explicitly. Imported/Copilot previews
            carry their own banners below, so suppress the pill for them. */}
        {!imported && !proposal && isTeamScope && (
          <ModePill tone="live" icon={Activity} title={STATUS_TITLES.modeLive}>Live team</ModePill>
        )}
        {!imported && !proposal && isDraft && (
          <ModePill tone="draft" icon={Pencil} title={STATUS_TITLES.modeDraft}>Draft</ModePill>
        )}
        {isDraft && draftBundle && !draftReadOnly && (
          <EditableDraftTitle name={draftBundle.name} onRename={(n) => draftOps.renameDraft(n)} />
        )}
        {isDraft && draftBundle && draftReadOnly && (
          <span title={READ_ONLY_DRAFT_HINT} style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
            {draftBundle.name}
          </span>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flex: '1 1 auto', flexWrap: 'wrap' }}>
        {isDraft && draftReadOnly && (
          <CreateTeamButton
            onClick={() => setMaterializeOpen(true)}
            roleCount={draftBundle?.roles?.length || 0}
          />
        )}
        {isDraft && !draftReadOnly && (
          <>
            {/* Structural editing pauses while a Copilot proposal is on screen —
                the draft underneath is not what the canvas shows. */}
            <ToolbarButton onClick={() => setAddRoleOpen(true)} icon={Plus} disabled={!!proposal}
              title={toolbarTitle('addAgent', { hasProposal: !!proposal })}>Add agent</ToolbarButton>
            <ToolbarButton onClick={() => setHumansOpen(true)} icon={User} disabled={!!proposal}
              title={toolbarTitle('addHuman', { hasProposal: !!proposal })}>Add human</ToolbarButton>
            <ToolbarButton onClick={() => setStagesOpen(true)} icon={Layers} disabled={!!proposal}
              title={toolbarTitle('stages', { hasProposal: !!proposal })}>Stages</ToolbarButton>
            <ToolbarButton onClick={() => setLabelsOpen(true)} icon={Tag} disabled={!!proposal}
              title={toolbarTitle('labels', { hasProposal: !!proposal })}>Labels</ToolbarButton>
            <ToolbarButton onClick={() => setCopilotOpen(o => !o)} icon={Sparkles}
              title={toolbarTitle('copilot')}>Copilot</ToolbarButton>
            {/* Last in the draft group, fenced off (#2053 D3): reading order
                becomes the instruction — build first, then the set-apart exit.
                Export follows outside this fragment, shared with live scope. */}
            <ToolbarSeparator />
            <CreateTeamButton
              onClick={() => setMaterializeOpen(true)}
              roleCount={draftBundle?.roles?.length || 0}
              hasProposal={!!proposal}
            />
          </>
        )}
        {isTeamScope && !imported && (
          <>
            <ToolbarButton onClick={() => setAddRoleOpen(true)} icon={Plus}
              title={toolbarTitle('addAgent')}>Add agent</ToolbarButton>
            <ToolbarButton onClick={() => setHumansOpen(true)} icon={User}
              title={toolbarTitle('addHuman')}>Add human</ToolbarButton>
            <ToolbarButton onClick={() => setStagesOpen(true)} icon={Layers}
              title={toolbarTitle('stages')}>Stages</ToolbarButton>
            <ToolbarButton onClick={() => setLabelsOpen(true)} icon={Tag}
              title={toolbarTitle('labels')}>Labels</ToolbarButton>
            <ToolbarButton onClick={() => setAnomaliesOpen(true)} icon={Activity}
              title={toolbarTitle('anomalies')}
              badge={Object.keys(anomalyCounts).length ? Object.values(anomalyCounts).reduce((a, b) => a + b, 0) : null}>
              Anomalies
            </ToolbarButton>
            <ToolbarButton onClick={() => setImprovementsOpen(true)} icon={TrendingUp}
              title={toolbarTitle('improvements')}>
              Improvements
            </ToolbarButton>
            <ToolbarButton onClick={() => setParallelismOpen(true)} icon={Gauge}
              title={toolbarTitle('parallelism')}>
              Parallelism
            </ToolbarButton>
            <ToolbarButton onClick={() => setCopilotOpen(o => !o)} icon={Sparkles}
              title={toolbarTitle('copilot')}>Copilot</ToolbarButton>
            <ToolbarButton onClick={editAsDraft} icon={Boxes}
              title={toolbarTitle('editAsDraft')}>Edit as draft</ToolbarButton>
          </>
        )}
        <ToolbarButton onClick={exportBundle} icon={Download} disabled={!!imported || !!proposal}
          title={toolbarTitle('export', { hasProposal: !!proposal, imported: !!imported })}>Export</ToolbarButton>
        </div>
        {/* #1984: the canvas is the busiest surface on the page and was the one
            with no help affordance at all. It sits OUTSIDE the flex-1 group
            above so it pins to the far right and the buttons never shift as the
            toolbar reflows, and it is deliberately unconditional — the toolbar
            differs per mode, but "what am I looking at" is the same question on
            a draft and on a live team. */}
        <PageHelpButton
          label="What the canvas shows"
          size={15}
          section={FLOWS_HELP_SECTIONS.canvas}
          style={{ padding: 2, flexShrink: 0 }}
        />
      </div>

      {/* Imported-bundle banner */}
      {imported && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', marginBottom: 'var(--eb-space-3)',
          padding: 'var(--eb-space-2) var(--eb-space-3)', flexShrink: 0,
          background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-accent-primary)', borderRadius: 'var(--eb-radius-md)',
        }}>
          <Boxes size={16} style={{ color: 'var(--eb-accent-primary)' }} />
          <span style={{ flex: 1, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
            Imported blueprint <strong>{imported.bundle?.name}</strong> ({importedBlueprintCounts(imported.bundle)}) — read-only preview.
          </span>
          <button onClick={continueImportAsDraft} style={{
            background: 'none', color: 'var(--eb-accent-primary)', border: '1px solid var(--eb-accent-primary)',
            borderRadius: 'var(--eb-radius-md)', padding: '4px 12px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
          }}>Continue as draft</button>
          <CreateTeamButton
            onClick={() => setMaterializeOpen(true)}
            roleCount={materializeBundle?.roles?.length || 0}
          />
          <button onClick={() => {
            setImported(null); setSelectedId(null);
            // A sidebar-triggered import (#512) has no underlying team/draft to
            // fall back to — send the parent back to the empty selection state.
            if (isImportPreview && onImportClosed) onImportClosed();
          }} title="Close blueprint" style={{
            background: 'none', border: 'none', color: 'var(--eb-text-secondary)', cursor: 'pointer', display: 'flex',
          }}><X size={16} /></button>
        </div>
      )}
      {imported && Array.isArray(imported.graph?.coercions) && imported.graph.coercions.length > 0 && (
        <div style={{
          marginBottom: 'var(--eb-space-3)', padding: 'var(--eb-space-2) var(--eb-space-3)', flexShrink: 0,
          background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-1)' }}>
            <AlertTriangle size={14} style={{ color: 'var(--eb-status-warning)' }} />
            <strong>Auto-repaired on import ({imported.graph.coercions.length})</strong>
          </div>
          <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-4)' }}>
            {imported.graph.coercions.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {imported && Array.isArray(imported.graph?.promptWarnings) && imported.graph.promptWarnings.length > 0 && (
        <div style={{
          marginBottom: 'var(--eb-space-3)', padding: 'var(--eb-space-2) var(--eb-space-3)', flexShrink: 0,
          background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-1)' }}>
            <AlertTriangle size={14} style={{ color: 'var(--eb-status-warning)' }} />
            <strong>Prompt settings ({imported.graph.promptWarnings.length})</strong>
          </div>
          <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-4)' }}>
            {imported.graph.promptWarnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {importError && (
        <div style={{ marginBottom: 'var(--eb-space-3)', color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{importError}</div>
      )}
      {addRoleResult && addRoleResult.scope === scope && (
        <div role="status" style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-3)',
          padding: 'var(--eb-space-2) var(--eb-space-3)', flexShrink: 0,
          background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
        }}>
          <span style={{ flex: 1, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>{addRoleResult.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setAddRoleResult(null)} style={{
            background: 'none', border: 'none', cursor: 'pointer', color: 'var(--eb-text-secondary)', padding: 0, display: 'inline-flex',
          }}><X size={16} /></button>
        </div>
      )}

      {/* Live-mode warning (#1125): the toolbar controls for a live team look
          like a normal editor, but port and structural edits re-derive triggers
          on the running agents at once (reconcileTeamDataFlow /
          reconcileTeamGithubChannels). Spell that out so nobody edits
          production unaware. Suppressed while an imported or Copilot preview is
          on screen (those are read-only and carry their own banner). */}
      {isTeamScope && !imported && !proposal && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-3)',
          padding: 'var(--eb-space-2) var(--eb-space-3)', flexShrink: 0,
          background: 'var(--eb-status-warning-bg)', border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)',
        }}>
          <AlertTriangle size={16} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-warning)' }}>
            <strong>Live team.</strong> Edits apply to running agents immediately — port and structural changes re-derive triggers on save. To try changes safely, use <strong>Edit as draft</strong>.
          </span>
        </div>
      )}

      {/* Draft status line (#2053 B2/AC6). The live mode has had a warning strip
          since #1125 while the draft — the mode that actually needs guidance —
          carried its one explanatory sentence in a tooltip, and the reason the
          create action is greyed out on a fresh draft was reachable ONLY on
          hover. Both read inline now. Same guard shape as the live strip: an
          imported or Copilot preview is not the draft, and carries its own
          banner. */}
      {/* A rail `Create team…` refused because a Copilot proposal is previewing
          (#2053). Keyed on the proposal it was refused against, so resolving OR
          replacing that proposal removes it without any clearing logic — the
          state it describes IS its guard. */}
      {isDraft && proposal && refusedFor === proposal && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-3)',
          padding: 'var(--eb-space-2) var(--eb-space-3)', flexShrink: 0,
          background: 'var(--eb-status-warning-bg)', border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)',
        }}>
          <AlertTriangle size={16} style={{ color: 'var(--eb-status-warning)', flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-warning)' }}>
            {PROPOSAL_PENDING_REASON}
          </span>
        </div>
      )}

      {isDraft && draftBundle && draftReadOnly && !imported && !proposal && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', marginBottom: 'var(--eb-space-3)',
          padding: 'var(--eb-space-2) var(--eb-space-3)', flexShrink: 0,
          background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-accent-primary)', borderRadius: 'var(--eb-radius-md)',
        }}>
          <Users size={16} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
            {READ_ONLY_DRAFT_HINT}
          </span>
          <button onClick={duplicateToMyDrafts} style={{
            background: 'none', color: 'var(--eb-accent-primary)', border: '1px solid var(--eb-accent-primary)',
            borderRadius: 'var(--eb-radius-md)', padding: '4px 12px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
          }}>Duplicate to my drafts</button>
        </div>
      )}
      {isDraft && draftBundle && !draftReadOnly && !imported && !proposal && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-3)',
          padding: 'var(--eb-space-2) var(--eb-space-3)', flexShrink: 0,
          background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
        }}>
          <Pencil size={16} style={{ color: 'var(--eb-text-muted)', flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
            {draftStatusText(draftBundle?.roles?.length || 0)}
          </span>
        </div>
      )}

      {/* Copilot-proposal banner (#1069) — the pendingImport-style preview
          contract: read-only graph + an explicit Apply/Discard. The buttons
          share the panel's handlers (via copilotActionsRef) so card and banner
          can never disagree; Apply stays disabled on error-level findings. */}
      {proposal && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', marginBottom: 'var(--eb-space-3)',
          padding: 'var(--eb-space-2) var(--eb-space-3)', flexShrink: 0,
          background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-accent-primary)', borderRadius: 'var(--eb-radius-md)',
        }}>
          <Sparkles size={16} style={{ color: 'var(--eb-accent-primary)' }} />
          <span style={{ flex: 1, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
            Proposal from Copilot ({proposal.graph?.nodes?.length || 0} nodes
            {proposalDiff && (proposalDiff.added.length || proposalDiff.modified.length)
              ? ` · ${proposalDiff.added.length} added · ${proposalDiff.modified.length} modified`
              : ''}) — {isTeamScope
              ? 'review it; Apply asks you to confirm before anything reaches the running agents.'
              : 'review it, then Apply or Discard.'}
            {proposalDiff && proposalDiff.removed.length > 0 && (
              <> <span style={{ color: 'var(--eb-status-error)' }}>
                Removes: {proposalDiff.removed.map(r => r.name).join(', ')}.
              </span></>
            )}
          </span>
          <button
            onClick={() => copilotActionsRef.current?.apply()}
            disabled={!proposal.ok}
            title={!proposal.ok ? 'Cannot apply — the proposal still has error-level findings.' : undefined}
            style={{
              background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
              borderRadius: 'var(--eb-radius-md)', padding: '4px 12px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
              fontWeight: 'var(--eb-font-medium)', cursor: proposal.ok ? 'pointer' : 'not-allowed', opacity: proposal.ok ? 1 : 0.5,
            }}>Apply</button>
          <button
            onClick={() => copilotActionsRef.current?.discard()}
            style={{
              background: 'none', color: 'var(--eb-accent-primary)', border: '1px solid var(--eb-accent-primary)',
              borderRadius: 'var(--eb-radius-md)', padding: '4px 12px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
              fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
            }}>Discard</button>
        </div>
      )}

      {/* Graph viewport */}
      <div style={{ position: 'relative', flex: 1, border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-lg)', background: 'var(--eb-bg-app)', overflow: 'hidden' }}>
        <div ref={viewportRef} style={{ width: '100%', height: '100%' }} />
        {!displayGraph && !error && (
          <Overlay>Loading graph…</Overlay>
        )}
        {!isDraft && !imported && error && (
          <Overlay tone="error">Could not load graph: {error}</Overlay>
        )}
        {/* Empty-state (#1124): a brand-new draft opens to a blank canvas whose
            only cue is a grey toolbar hint newcomers miss. When the draft has
            zero agent roles, surface a centered prompt with a primary CTA that
            shares the toolbar's Add-agent handler; it disappears once the first
            node exists. Suppressed while a Copilot proposal previews the graph. */}
        {isDraft && !proposal && !draftReadOnly && displayGraph && !(draftBundle?.roles?.length) && (
          <EmptyCanvasState onAddAgent={() => setAddRoleOpen(true)} />
        )}

        <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 20, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, maxWidth: 360 }}>
          <LintsPanel
            lints={displayGraph?.lints || []}
            onFocus={(nodeId) => { if (nodeId) { setSelectedId(nodeId); graphRef.current?.setSelected(nodeId); } }}
            // #2878: "Create label" for a wake label missing on GitHub — live team only.
            onAction={isTeamScope && !isDraft ? async (a) => {
              await apiCall('POST', `/api/teams/${encodeURIComponent(scope)}/repo-labels`, { repo: a.repo, label: a.label });
              refetch();
            } : null}
          />
          <HumanTouchpointsPanel
            touchpoints={displayGraph?.humanTouchpoints || []}
            nodes={displayGraph?.nodes || []}
            onFocus={(nodeId) => { if (nodeId) { setSelectedId(nodeId); graphRef.current?.setSelected(nodeId); } }}
          />
        </div>
      </div>

      {/* Human-role inspector (#987): a person node has no prompt/triggers, so a
          focused variant handles it in both modes; the agent inspector below is
          suppressed for it. */}
      {selectedHuman && (
        <HumanNodeInspector
          key={`human:${selectedHuman.id}`}
          human={selectedHuman}
          stages={isDraft && !proposal ? (draftBundle?.stages || []) : (displayGraph?.stages || [])}
          ops={isDraft && !proposal ? draftOps : liveHumanOps}
          triggerOps={ops}
          peers={displayGraph?.nodes || []}
          onClose={() => { setSelectedId(null); graphRef.current?.setSelected(null); }}
          onDeleted={() => { setSelectedId(null); graphRef.current?.setSelected(null); if (!isDraft) refetch(); }}
          onChanged={() => { if (!isDraft) refetch(); }}
        />
      )}

      {/* Inspector — ONE shared component drives both draft and live modes (#692).
          While a Copilot proposal is previewed, the draft inspector is suppressed
          (the draft underneath is not what the canvas shows) and nodes open in
          the read-only template view instead — import-preview parity. */}
      {isDraft && !proposal && !selectedHuman && selectedRole && (
        <NodeInspector
          key={`${selectedRole.id}:${routingFocus?.outcome || ''}`}
          mode="draft"
          node={selectedRole}
          roles={draftBundle?.roles || []}
          stages={draftBundle?.stages || []}
          lints={displayGraph?.lints || []}
          labels={displayGraph?.labels || []}
          humans={isDraft ? (draftBundle?.humans || []) : (displayGraph?.humans || [])}
          humanOps={isDraft ? draftOps : liveHumanOps}
          focus={routingFocus}
          ops={draftOps}
          onClose={() => { setSelectedId(null); setRoutingFocus(null); graphRef.current?.setSelected(null); }}
          onDeleted={() => { setSelectedId(null); graphRef.current?.setSelected(null); }}
          onRenamedId={(nid) => { setSelectedId(nid); graphRef.current?.setSelected(nid); }}
          onChanged={() => {}}
        />
      )}
      {(!isDraft || proposal || draftReadOnly) && !selectedHuman && selectedNode && (
        <NodeInspector
          key={`${selectedNode.id}:${routingFocus?.outcome || ''}`}
          mode="live"
          node={selectedNode}
          nodes={displayGraph?.nodes || []}
          agents={agents || []}
          stages={displayGraph?.stages || []}
          lints={displayGraph?.lints || []}
          labels={displayGraph?.labels || []}
          humans={displayGraph?.humans || []}
          humanOps={liveHumanOps}
          focus={routingFocus}
          ops={liveOps}
          teamId={isTeamScope && !imported ? scope : undefined}
          level={imported || proposal || draftReadOnly ? 'template' : displayGraph?.level}
          onClose={() => { setSelectedId(null); setRoutingFocus(null); graphRef.current?.setSelected(null); }}
          onChanged={() => refetch()}
        />
      )}

      {/* The ONE connect dialog (#411) for both draft and live teams: the drag
          source (agent or actor) picks the type set via the capability matrix —
          only the ops adapter differs underneath. */}
      {connectPair && (
        <CreateEdgeDialog
          from={connectPair.from}
          to={connectPair.to}
          fromName={nodeName(connectPair.from)}
          toName={nodeName(connectPair.to)}
          labels={displayGraph?.labels || []}
          ops={ops}
          humanOps={isDraft ? draftOps : liveHumanOps}
          types={createTypesFor(caps, sourceKindOf(connectPair.from))}
          fromNode={(displayGraph?.nodes || []).find(n => n.id === connectPair.from) || null}
          toNode={(displayGraph?.nodes || []).find(n => n.id === connectPair.to) || null}
          peers={displayGraph?.nodes || []}
          humans={displayGraph?.humans || []}
          onClose={() => setConnectPair(null)}
          onDone={() => { setConnectPair(null); afterEdit(); }}
        />
      )}

      {/* Pre-typed outcome/badge drag (#1005, §4.3): the outcome's action picks
          the form — a channel dialog for openPr/openIssue (and the produce
          badges), the label hand-off for setLabel. Never the generic picker.
          A HUMAN drop target routes to the agent-to-person delivery dialog
          instead (#1035) — the same branch CreateEdgeDialog takes for the ●
          port; the channel/hand-off forms resolve agent consumers only. */}
      {outcomeConnect && (outcomeDialog === 'person' ? (
        <AgentToPersonDialog
          from={outcomeConnect.from}
          to={outcomeConnect.to}
          fromName={nodeName(outcomeConnect.from)}
          toName={nodeName(outcomeConnect.to)}
          ops={ops}
          humanOps={isDraft ? draftOps : liveHumanOps}
          fromNode={(displayGraph?.nodes || []).find(n => n.id === outcomeConnect.from) || null}
          peers={displayGraph?.nodes || []}
          initialArtifact={outcomeConnect.outcome?.artifact || null}
          initialLabel={outcomeConnect.outcome?.label || ''}
          labels={displayGraph?.labels || []}
          onClose={() => setOutcomeConnect(null)}
          onDone={() => { setOutcomeConnect(null); afterEdit(); }}
        />
      ) : outcomeDialog === 'channel' ? (
        <CreateChannelDialog
          from={outcomeConnect.from}
          to={outcomeConnect.to}
          fromName={nodeName(outcomeConnect.from)}
          toName={nodeName(outcomeConnect.to)}
          artifact={outcomeConnect.outcome.artifact}
          lockArtifact
          existingChannels={(displayGraph?.nodes || []).find(n => n.id === outcomeConnect.to)?.channels}
          ops={ops}
          humans={displayGraph?.humans || []}
          humanOps={isDraft ? draftOps : liveHumanOps}
          onClose={() => setOutcomeConnect(null)}
          onDone={() => { setOutcomeConnect(null); afterEdit(); }}
        />
      ) : (
        <CreateHandoffDialog
          from={outcomeConnect.from}
          to={outcomeConnect.to}
          fromName={nodeName(outcomeConnect.from)}
          toName={nodeName(outcomeConnect.to)}
          labels={displayGraph?.labels || []}
          ops={ops}
          initialLabel={outcomeConnect.outcome?.label || ''}
          initialTarget={labelTargetKind(nodeLabelTarget(outcomeFromNode, outcomeConnect.outcome?.label))}
          emitSource={false}
          onClose={() => setOutcomeConnect(null)}
          onDone={() => { setOutcomeConnect(null); afterEdit(); }}
        />
      ))}

      {selectedEdge && (
        <EditHandoffDialog
          edge={selectedEdge}
          fromName={nodeName(selectedEdge.from)}
          toName={nodeName(selectedEdge.to)}
          ops={ops}
          graph={displayGraph}
          humanOps={isDraft ? draftOps : liveHumanOps}
          onOpenRouting={openRouting}
          onClose={() => setSelectedEdge(null)}
          onDone={() => { setSelectedEdge(null); afterEdit(); }}
        />
      )}

      {addRoleOpen && (isDraft || (isTeamScope && !imported)) && (
        <AddRoleDialog
          live={!isDraft}
          onClose={() => setAddRoleOpen(false)}
          onCreate={async ({ displayName, systemPrompt, templateId, template, materializeNow }) => {
            // Draft: append the role to the bundle — from scratch (free-form
            // prompt) or from a template (fields copied, {{vars}} raw, E2/AC-4).
            // Live team: materialize as a team-member immediately (#585), passing
            // the templateId so the backend substitutes per-member (AC-5). Errors
            // propagate so the dialog can surface them and stay open (AC7 / E1).
            const id = isDraft
              ? await draftOps.addRole({ displayName, systemPrompt, template })
              : await addLiveRole({ displayName, systemPrompt, templateId, materializeNow });
            setAddRoleOpen(false);
            setSelectedId(id);
          }}
        />
      )}

      {labelsOpen && (isDraft || (isTeamScope && !imported)) && (
        <LabelRegistryPanel
          key={JSON.stringify([displayGraph?.labels || [], displayGraph?.unusedLabels || []])}
          labels={displayGraph?.labels || []}
          unusedLabels={displayGraph?.unusedLabels || []}
          ops={isDraft ? draftOps : liveLabelOps}
          onClose={() => setLabelsOpen(false)}
          onChanged={() => { if (!isDraft) refetch(); }}
        />
      )}

      {humansOpen && (isDraft || (isTeamScope && !imported)) && (
        <HumanRegistryPanel
          key={JSON.stringify(displayGraph?.humans || [])}
          humans={isDraft ? (draftBundle?.humans || []) : (displayGraph?.humans || [])}
          stages={isDraft ? (draftBundle?.stages || []) : (displayGraph?.stages || [])}
          ops={isDraft ? draftOps : liveHumanOps}
          onClose={() => setHumansOpen(false)}
          onChanged={() => { if (!isDraft) refetch(); }}
        />
      )}

      {anomaliesOpen && isTeamScope && !imported && (
        <FlowAnomaliesPanel
          teamId={scope}
          onClose={() => setAnomaliesOpen(false)}
          onData={onAnomalyData}
        />
      )}

      {improvementsOpen && isTeamScope && !imported && (
        <ImprovementsPanel
          teamId={scope}
          onClose={() => setImprovementsOpen(false)}
        />
      )}

      {parallelismOpen && isTeamScope && !imported && (
        <ParallelismPanel
          teamId={scope}
          wipLimit={Number.isInteger(parallelismTeamCfg?.wipLimit) ? parallelismTeamCfg.wipLimit : null}
          autoDispatch={parallelismTeamCfg?.autoDispatch || null}
          hasPooledRole={hasPooledRole}
          onClose={() => setParallelismOpen(false)}
          onChanged={() => { refetchAgents(); refetch(); }}
        />
      )}

      {stagesOpen && (isDraft || (isTeamScope && !imported)) && (
        <StageManager
          stages={isDraft ? (draftBundle?.stages || []) : (displayGraph?.stages || [])}
          counts={isDraft
            ? (draftBundle?.roles || []).reduce((m, r) => {
                if (r.stage) m[r.stage] = (m[r.stage] || 0) + 1;
                return m;
              }, {})
            : (displayGraph?.nodes || []).reduce((m, n) => {
                if (n.stage) m[n.stage] = (m[n.stage] || 0) + 1;
                return m;
              }, {})}
          ops={isDraft ? draftOps : liveStageOps}
          onClose={() => setStagesOpen(false)}
          onChanged={() => { if (!isDraft) refetch(); }}
        />
      )}

      {materializeOpen && materializeBundle && (
        <MaterializeDialog
          bundle={materializeBundle}
          // The dialog now stays open on success to confirm what happened
          // (#2053 AC12) and calls `onDone` when the user leaves it, so the
          // imported preview is cleared at the same moment as before.
          createdNotice={createdTeam ? createdTeamNotice(createdTeam, { fromImport: !!imported }) : ''}
          // #2737: refresh the rail's team list (the parent's /api/agents) and
          // this panel's own, so the new team is listed straight away rather
          // than after a page reload.
          onCreated={(result) => { setCreatedTeam(result?.teamName || null); refetchAgents(); onTeamsChanged?.(); }}
          // Both close paths behave the same ONCE a team exists: the preview is
          // read-only and its `Create team…` would re-submit the identical
          // bundle straight into the collision card. Before #2053 this state
          // was unreachable — the dialog closed itself on completion — so an
          // Escape/X after success is a path only the new confirmation opens.
          onClose={() => {
            setMaterializeOpen(false);
            // Dropping the preview is not enough: in `import` scope `imported`
            // is the ONLY source of a graph, so clearing it alone leaves the
            // pane on a permanent "Loading graph…" with no toolbar and no
            // banner. Hand the parent back to the empty selection state, the
            // way the banner's own X does.
            if (createdTeam && imported) {
              setImported(null); setSelectedId(null);
              if (isImportPreview && onImportClosed) onImportClosed();
            }
            setCreatedTeam(null);
          }}
          onDone={() => { setMaterializeOpen(false); setCreatedTeam(null); if (imported) setImported(null); }}
        />
      )}
    </div>

    {/* Flow Copilot rail (#1069). Draft scope chats against the open draft;
        team scope (#2556) chats against the live team's exported bundle and
        applies through a confirmation, replaying the diff as the canvas's own
        live writes. Closing drops the canvas PREVIEW only — since
        #2087 the turn and its unapplied proposal live in the app-level
        FlowCopilotProvider, so reopening the panel finds them again. */}
    {copilotOpen && ((isDraft && !draftReadOnly) || (isTeamScope && !imported)) && (
      <FlowCopilotPanel
        mode={isDraft ? 'draft' : 'team'}
        scope={scope}
        bundle={isDraft ? draftBundle : liveCopilot?.bundle}
        autoFocus={autoOpenCopilot}
        onPreview={setProposal}
        onApplyBundle={applyCopilotBundle}
        onPersistHistory={isDraft ? persistCopilotHistory : persistLiveCopilotHistory}
        onEditAsDraft={() => editAsDraft(true)}
        canEdit={liveCopilot ? liveCopilot.canEdit : null}
        history={liveCopilot ? liveCopilot.history : undefined}
        live={isDraft ? undefined : liveCopilotTransport}
        onClose={() => { setCopilotOpen(false); setProposal(null); }}
        actionsRef={copilotActionsRef}
      />
    )}
    </div>
    </LabelSuffixContext.Provider>
  );
}

function AddRoleDialog({ live = false, onClose, onCreate }) {
  const [displayName, setDisplayName] = useState('');
  // #2558: live team only — provision now, or create a stub (default) that is
  // materialized later from Agent Chat. A draft role has nothing to provision.
  const [materializeNow, setMaterializeNow] = useState(ADD_ROLE_MATERIALIZE_DEFAULT);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  // Surfaced when onCreate rejects (e.g. a live-team id collision, E1) so the
  // dialog stays open with the error instead of failing silently (AC7).
  const [submitError, setSubmitError] = useState(null);
  // LLM-assisted prompt authoring (see POST /api/agent-prompt/generate).
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(null);
  // Template picker (#586). `mode` toggles between picking a predefined role
  // template and authoring one from scratch (AC-3 keeps the scratch path
  // unchanged). Templates are loaded once; a load failure / empty catalog is
  // non-blocking — the dialog falls back to scratch with a notice (E1).
  const [mode, setMode] = useState('scratch');
  const [templates, setTemplates] = useState([]);
  const [templatesError, setTemplatesError] = useState(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);
  const [fullTemplate, setFullTemplate] = useState(null);
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const resp = await apiCall('GET', '/api/agent-templates');
        if (!live) return;
        const list = Array.isArray(resp?.templates) ? resp.templates : [];
        setTemplates(list);
        // Lead with the picker when templates are available (AC-1); otherwise
        // stay on the scratch path so the dialog is never blocked (E1).
        if (list.length) setMode('template');
      } catch (e) {
        if (live) setTemplatesError(e.message || 'Could not load agent templates');
      }
    })();
    return () => { live = false; };
  }, []);
  // Select a template → fetch its full definition and pre-fill the editable
  // name + prompt (AC-2/AC-6). {{vars}} stay raw in the prompt preview — they
  // are resolved per-member at materialise time.
  const selectTemplate = async (id) => {
    setSelectedTemplateId(id);
    setSubmitError(null);
    setLoadingTemplate(true);
    setFullTemplate(null);
    try {
      const resp = await apiCall('GET', `/api/agent-templates/${encodeURIComponent(id)}`);
      const t = resp?.template;
      if (!t) throw new Error('Template not found');
      setFullTemplate(t);
      setDisplayName(t.displayName || '');
      setSystemPrompt(t.promptTemplate || '');
    } catch (e) {
      setSubmitError(e.message || 'Could not load template');
    } finally {
      setLoadingTemplate(false);
    }
  };
  // Switching template → from-scratch clears the template-derived fields (E3).
  const switchMode = (next) => {
    if (next === mode) return;
    setMode(next);
    setSubmitError(null);
    if (next === 'scratch') {
      setSelectedTemplateId(null);
      setFullTemplate(null);
      setDisplayName('');
      setSystemPrompt('');
    }
  };
  const submit = async () => {
    if (!displayName.trim()) return;
    if (mode === 'template' && (!selectedTemplateId || !fullTemplate)) {
      setSubmitError('Pick an agent template first, or switch to “From scratch”.');
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      const materialize = live ? { materializeNow } : {};
      await onCreate(mode === 'template'
        ? { displayName: displayName.trim(), templateId: selectedTemplateId, template: fullTemplate, ...materialize }
        : { displayName: displayName.trim(), systemPrompt, ...materialize });
    }
    catch (e) { setSubmitError(e.message || 'Failed to add agent'); }
    finally { setBusy(false); }
  };
  const generate = async () => {
    if (!displayName.trim() || generating) return;
    setGenerating(true);
    setGenError(null);
    try {
      const { prompt } = await apiCall('POST', '/api/agent-prompt/generate', {
        roleName: displayName.trim(), notes: notes.trim(),
      });
      if (prompt) setSystemPrompt(prompt);
    } catch (e) {
      setGenError(e.message || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };
  const field = {
    background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
    boxSizing: 'border-box', width: '100%', outline: 'none',
  };
  const hasTemplates = templates.length > 0;
  // Primary button is disabled both while a request is in flight (busy, prevents
  // double-submit — AC3) and when there is no agent name yet; both now read as
  // disabled visually (dim + not-allowed), matching the sibling Generate button.
  const addDisabled = busy || !displayName.trim();
  return (
    <SidePanel open onClose={onClose} title="Add agent" width="480px">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        {/* Source toggle (#586): pick a predefined role template or author one
            from scratch. Hidden when no templates are available — the dialog
            then behaves exactly as the pre-#586 from-scratch form (E1/AC-3). */}
        {hasTemplates && (
          <div style={{ display: 'flex', gap: 'var(--eb-space-1)', background: 'var(--eb-bg-app)',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 2 }}>
            {[['template', 'From a template'], ['scratch', 'From scratch']].map(([m, label]) => (
              <button key={m} type="button" onClick={() => switchMode(m)} style={{
                flex: 1, padding: '6px 10px', border: 'none', borderRadius: 'var(--eb-radius-sm)',
                fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
                background: mode === m ? 'var(--eb-accent-primary)' : 'transparent',
                color: mode === m ? 'var(--eb-text-inverted)' : 'var(--eb-text-secondary)',
                fontWeight: mode === m ? 'var(--eb-font-medium)' : 'normal',
              }}>{label}</button>
            ))}
          </div>
        )}
        {templatesError && (
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.4 }}>
            Agent templates could not be loaded ({templatesError}). You can still add an agent from scratch.
          </div>
        )}

        {/* Template picker (AC-1): icon, name, description, category. */}
        {mode === 'template' && hasTemplates && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Agent template</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
              {templates.map(t => {
                const sel = t.id === selectedTemplateId;
                const Icon = roleIcon(t.icon);
                return (
                  <button key={t.id} type="button" onClick={() => selectTemplate(t.id)} style={{
                    textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer',
                    background: sel ? 'var(--eb-bg-surface)' : 'var(--eb-bg-app)',
                    border: `1px solid ${sel ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
                    borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)',
                  }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Icon size={16} style={{ color: 'var(--eb-text-secondary)', flexShrink: 0 }} />
                      <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>{t.displayName}</span>
                      {t.category && (
                        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
                          border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)', padding: '0 6px' }}>{t.category}</span>
                      )}
                    </span>
                    {t.description && (
                      <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.4 }}>{t.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Agent name</span>
          <input autoFocus value={displayName} onChange={e => setDisplayName(e.target.value)}
            placeholder="e.g. Business Analyst" style={field}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
        </label>

        {/* Scratch path (AC-3, unchanged): Notes → LLM → editable agent prompt.
            The operator jots a few keywords and lets the model draft a full
            prompt; the role name alone is often enough context. */}
        {mode === 'scratch' && (<>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Notes for prompt generation (optional)</span>
          <textarea value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="A few keywords — e.g. reviews COBOL, flags risky changes, hands off to the migration lead"
            style={{ ...field, minHeight: 64, resize: 'vertical' }} />
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.4 }}>
            Generate uses the agent name and these notes to draft an agent prompt via the configured LLM.
            You can edit the result below.
          </span>
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <button type="button" onClick={generate} disabled={!displayName.trim() || generating} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--eb-bg-surface)', color: 'var(--eb-accent-primary)',
            border: '1px solid var(--eb-accent-primary)', borderRadius: 'var(--eb-radius-md)',
            padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: (!displayName.trim() || generating) ? 'not-allowed' : 'pointer',
            opacity: (!displayName.trim() || generating) ? 0.5 : 1,
          }}>
            <Sparkles size={14} />
            {generating ? 'Generating…' : 'Generate agent prompt'}
          </button>
          {genError && (
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error, #d33)' }}>{genError}</span>
          )}
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Agent prompt (optional now)</span>
          <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)}
            placeholder="What this agent does… — or use Generate above to draft it"
            style={{ ...field, minHeight: 160, resize: 'vertical', fontFamily: 'var(--eb-font-mono)' }} />
        </label>
        </>)}

        {/* Template path (AC-2): read-only preview of the template's prompt with
            `{{vars}}` kept raw — they resolve per-member at materialise time. */}
        {mode === 'template' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Agent prompt (from template)</span>
            <textarea readOnly value={loadingTemplate ? 'Loading…' : (systemPrompt || (selectedTemplateId ? '' : 'Select an agent template above.'))}
              style={{ ...field, minHeight: 160, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', opacity: 0.85 }} />
            {fullTemplate && Array.isArray(fullTemplate.triggers) && fullTemplate.triggers.length > 0 && (
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.4 }}>
                Includes {fullTemplate.triggers.length} trigger{fullTemplate.triggers.length === 1 ? '' : 's'}
                {fullTemplate.sessionPolicy === 'per-invocation' ? ' · per-invocation session' : ''}. You can edit the agent name above.
              </span>
            )}
          </label>
        )}

        {/* #2558: same checkbox + hint as the Agent Chat rail's "Add member"
            dialog, but defaulting off. Applies to both tabs. */}
        {live && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
            fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.4, cursor: 'pointer' }}>
            <input type="checkbox" checked={materializeNow} disabled={busy}
              onChange={e => setMaterializeNow(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              <strong style={{ color: 'var(--eb-text-primary)' }}>{ADD_ROLE_MATERIALIZE_LABEL}</strong> — {ADD_ROLE_MATERIALIZE_HINT}
            </span>
          </label>
        )}

        {submitError && (
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error, #d33)' }}>{submitError}</div>
        )}
        {/* #820: agent provisioning on a live team is genuinely slow (create the
            chat user → seed workspace → git clone), so surface the already-existing
            `busy` flag on the primary button — spinner + "Adding…" + dim/not-allowed —
            mirroring the sibling "Generate agent prompt" button and the ConfirmDialog
            pattern, so the click is visibly registered. Presentation-only; submit()
            and onCreate are untouched. */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)' }}>
          <button onClick={onClose} disabled={busy} style={{
            background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
            cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
          }}>Cancel</button>
          <button onClick={submit} disabled={addDisabled} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: addDisabled ? 'not-allowed' : 'pointer', opacity: addDisabled ? 0.6 : 1,
          }}>
            {busy && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
            {addRoleSubmitLabel({ busy, materializeNow, live })}
          </button>
        </div>
      </div>
      {busy && <style>{'@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>}
    </SidePanel>
  );
}

// The one action that turns a design into a live team (#2053 B1/AC4). Both entry
// points render THIS — the draft toolbar and the import-preview banner — so the
// label, the tooltip source and the disabled rule cannot diverge again: the
// banner used to be a raw <button> with its own hardcoded string, a native
// `title=` that skipped the #1999 tooltip migration, and no disabled state at
// all, so an imported bundle with zero roles was clickable there and greyed out
// two centimetres away.
function CreateTeamButton({ onClick, roleCount, hasProposal }) {
  return (
    <ToolbarButton
      variant="primary"
      onClick={onClick}
      icon={Boxes}
      title={toolbarTitle('materialize', { hasProposal: !!hasProposal, roleCount })}
      disabled={!!hasProposal || !roleCount}
    >{CREATE_TEAM_LABEL}</ToolbarButton>
  );
}

// A group boundary in the toolbar row. Position, separator and colour are three
// INDEPENDENT signals that the create action is the set-apart exit (#2053 D3) —
// colour alone fails for colour-blind readers and in low-contrast environments.
function ToolbarSeparator() {
  return (
    <span aria-hidden="true" style={{
      flexShrink: 0, alignSelf: 'stretch', width: 1, minHeight: 20,
      background: 'var(--eb-border-default)', margin: '0 var(--eb-space-1)',
    }} />
  );
}

// Every button in the flow header row renders through here, which is why the
// `title` → shared dark `Tooltip` migration (#1999) is a one-place change: the
// native `title=` attribute is gone, so no header button shows the slow grey
// browser tooltip any more. The button keeps its visible text as its accessible
// name — the tooltip is purely presentational and never the only label.
//
// `variant` (#2053 AC2) is the whole reason this component grew a second style
// block: the one irreversible, go-live action was pixel-identical to *Labels*,
// because there was no way to say "this one is the primary". Exactly ONE button
// per toolbar row may be `primary` — a row of accents ranks nothing — and every
// other button renders byte-identically to before (`secondary` is the default
// and takes the original style values verbatim).
function ToolbarButton({ onClick, icon: Icon, disabled, children, badge, title, variant = 'secondary' }) {
  const primary = variant === 'primary';
  return (
    <Tooltip label={title} wrap={shouldWrapTooltip(title)}>
      <button onClick={onClick} disabled={disabled} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, whiteSpace: 'nowrap',
        background: primary ? 'var(--eb-accent-primary)' : 'var(--eb-bg-surface)',
        color: primary ? 'var(--eb-text-inverted)' : 'var(--eb-text-secondary)',
        border: primary ? '1px solid var(--eb-accent-primary)' : '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-1) var(--eb-space-3)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
        fontWeight: primary ? 'var(--eb-font-medium)' : 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
      }}>
        <Icon size={14} /> {children}
        {badge != null && badge > 0 && (
          <span style={{
            marginLeft: 2, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999,
            background: 'var(--eb-status-warning, #d97706)', color: 'var(--eb-text-on-warning)', fontSize: 10,
            fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>{badge}</span>
        )}
      </button>
    </Tooltip>
  );
}

function LintsPanel({ lints, onFocus, onAction = null }) {
  const [open, setOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(null);
  const [actionError, setActionError] = useState('');
  const runAction = async (a, key) => {
    setActionBusy(key);
    setActionError('');
    try { await onAction(a); } catch (err) { setActionError(err.message || 'The action failed'); }
    setActionBusy(null);
  };
  if (!lints || lints.length === 0) return null;
  const errors = lints.filter(l => l.severity === 'error').length;
  const accent = errors > 0 ? 'var(--eb-status-error)' : 'var(--eb-status-warning)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'var(--eb-bg-elevated)', border: `1px solid ${accent}`,
          color: accent, borderRadius: 'var(--eb-radius-md)', padding: '4px 10px',
          fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', cursor: 'pointer',
          marginLeft: 'auto',
        }}
      >
        <AlertTriangle size={14} />
        {lints.length} issue{lints.length === 1 ? '' : 's'}{errors > 0 ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}
      </button>
      {open && (
        <div style={{
          marginTop: 6, background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)', boxShadow: 'var(--eb-shadow-lg)', maxHeight: '50vh', overflowY: 'auto',
        }}>
          {actionError && (
            <div style={{ padding: 'var(--eb-space-2) var(--eb-space-3)', color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-xs)' }}>{actionError}</div>
          )}
          {lints.map((l, i) => {
            const action = onAction ? lintAction(l) : null;
            return (
            <div key={i} style={{ borderTop: i ? '1px solid var(--eb-border-default)' : 'none' }}>
            <button
              onClick={() => onFocus(l.nodeId)}
              title={l.nodeId ? 'Focus node' : undefined}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: 'none', border: 'none',
                padding: 'var(--eb-space-2) var(--eb-space-3)', cursor: l.nodeId ? 'pointer' : 'default',
                fontFamily: 'inherit', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)',
              }}
            >
              {(() => {
                const v = lintView(l);
                return (
                  <>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                      <span
                        title={v.slug}
                        style={{
                          color: v.severityColor, fontSize: 'var(--eb-text-xs)',
                          fontWeight: 'var(--eb-font-semibold)', textTransform: 'uppercase',
                          cursor: 'help', flexShrink: 0,
                        }}
                      >{v.severityWord}</span>
                      <span style={{ color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-medium)' }}>
                        {v.title}
                      </span>
                    </div>
                    <div style={{ marginTop: 2, lineHeight: 1.4 }}>{stripTicks(v.message)}</div>
                    {v.fix && (
                      <div style={{ marginTop: 4, lineHeight: 1.4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                        <strong style={{ fontWeight: 'var(--eb-font-medium)' }}>To fix:</strong> {v.fix}
                      </div>
                    )}
                  </>
                );
              })()}
            </button>
            {action && (
              <div style={{ padding: '0 var(--eb-space-3) var(--eb-space-2)' }}>
                <button
                  onClick={() => runAction(action, i)}
                  disabled={actionBusy != null}
                  title={action.title}
                  style={{
                    background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
                    padding: '2px 8px', fontFamily: 'inherit', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)',
                    cursor: actionBusy != null ? 'wait' : 'pointer',
                  }}
                >{actionBusy === i ? 'Creating…' : action.text}</button>
              </div>
            )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Human touchpoints (#981) — the derived list of every place a PERSON acts in
// the flow, computed server-side (graph.humanTouchpoints): work injection
// (gate labels / gated channels), decisions (brake hand-offs), and artifact
// deliveries (PRs/issues whose audience is a human). Read-only; clicking an
// entry focuses the involved agent.
const TOUCHPOINT_TEXT = {
  injection: (t, name) => <>Human applies <code>{t.label || t.artifact}</code> → wakes <strong>{name}</strong></>,
  decision: (t, name) => <><strong>{name}</strong> pauses on <code>{t.label}</code> — human decides</>,
  delivery: (t, name) => t.label
    // #1197: a plain label the person is notified on (a touchpoint, not a gate).
    ? <><strong>{name}</strong> sets <code>{t.label}</code> — a person is notified</>
    : t.artifact === 'file'
      ? <><strong>{name}</strong> delivers <code>{t.name}</code> to a person</>
      : <><strong>{name}</strong> delivers a {t.artifact === 'issue' ? 'issue' : 'pull request'} for human review</>,
};
// Friendly, action-oriented headings for the raw touchpoint types (#1127) —
// "INJECTION/DECISION/DELIVERY" read as jargon; say what the person actually does.
const TOUCHPOINT_HEADING = {
  injection: 'Starts work',
  decision: 'Approval / brake',
  delivery: 'Receives output',
};
function HumanTouchpointsPanel({ touchpoints, nodes, onFocus }) {
  const [open, setOpen] = useState(false);
  if (!touchpoints || touchpoints.length === 0) return null;
  const nameOf = (id) => (nodes || []).find(n => n.id === id)?.displayName || id;
  const accent = 'var(--eb-accent-primary)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'var(--eb-bg-elevated)', border: `1px solid ${accent}`,
          color: accent, borderRadius: 'var(--eb-radius-md)', padding: '4px 10px',
          fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', cursor: 'pointer',
          marginLeft: 'auto',
        }}
      >
        <User size={14} />
        {touchpoints.length} human touchpoint{touchpoints.length === 1 ? '' : 's'}
      </button>
      {open && (
        <div style={{
          marginTop: 6, background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)', boxShadow: 'var(--eb-shadow-lg)', maxHeight: '50vh', overflowY: 'auto',
        }}>
          {touchpoints.map((t, i) => (
            <button
              key={i}
              onClick={() => onFocus(t.agentId)}
              title="Focus agent"
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: 'none', border: 'none', borderTop: i ? '1px solid var(--eb-border-default)' : 'none',
                padding: 'var(--eb-space-2) var(--eb-space-3)', cursor: 'pointer',
                fontFamily: 'inherit', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)',
              }}
            >
              <span
                title={t.type}
                style={{
                  color: accent, fontSize: 'var(--eb-text-xs)',
                  fontWeight: 'var(--eb-font-medium)',
                }}
              >{TOUCHPOINT_HEADING[t.type] || t.type}</span>
              <div style={{ marginTop: 2, lineHeight: 1.4 }}>
                {(TOUCHPOINT_TEXT[t.type] || TOUCHPOINT_TEXT.injection)(t, nameOf(t.agentId))}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function stripTicks(s) { return typeof s === 'string' ? s.replace(/`/g, '') : s; }

// Centered empty state for a draft flow with no agents yet (#1124). Unlike
// Overlay this captures pointer events on its CTA so a newcomer can start the
// flow straight from the blank canvas instead of hunting the toolbar hint.
function EmptyCanvasState({ onAddAgent }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 'var(--eb-space-3)',
      pointerEvents: 'none', textAlign: 'center', padding: 'var(--eb-space-4)',
    }}>
      <Boxes size={40} style={{ color: 'var(--eb-text-muted)' }} />
      <div style={{ fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
        This flow is empty
      </div>
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', maxWidth: 340 }}>
        Two steps: add the agents — plus any human touchpoints and stages — that
        make up the flow, then use <strong>{CREATE_TEAM_LABEL}</strong> in the
        toolbar to turn this design into a live team.
      </div>
      <button onClick={onAddAgent} style={{
        pointerEvents: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6,
        background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
        borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2) var(--eb-space-4)',
        fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
      }}>
        <Plus size={16} /> Add agent
      </button>
    </div>
  );
}

function Overlay({ children, tone }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none', color: tone === 'error' ? 'var(--eb-status-error)' : 'var(--eb-text-muted)',
      fontSize: 'var(--eb-text-sm)',
    }}>
      {children}
    </div>
  );
}
