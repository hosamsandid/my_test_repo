import React, { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Users, FileText, Plus, Trash2, Upload, Sparkles, Package } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import { useAuth } from '../auth/AuthContext';
import ConfirmDialog from '../components/ConfirmDialog';
import PageHelpButton from '../components/PageHelpButton';
import { usePageActions } from '../context/PageActionsContext';
import Tooltip from '../components/Tooltip';
import { shouldWrapTooltip } from '../components/tooltip-wrap';
import { PAGE_ACTION_TITLES } from './process-toolbar-hints';
import { FLOWS_HELP_SECTIONS } from './process/flows-help-sections';
import {
  IMPORT_BRIEFINGS_COPY, importCandidates, importSubmitState, importRequestBody, importErrorText,
} from './process/import-briefings-view';

// The process graph/editor is a heavy module (custom SVG renderer + dialogs) —
// load it only when a process scope is actually selected.
const ProcessGraphPanel = lazy(() =>
  import('./ProcessCanvas').then(m => ({ default: m.ProcessGraphPanel })));

const LAST_SELECTED_KEY_PREFIX = 'flows.lastSelected';
const SIDEBAR_WIDTH_KEY = 'flowsPaneWidth';
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 600;
const DETAILS_MIN = 300;
const DIVIDER_W = 12;

// Header page-actions styling (#1912) — the convention the other #1847-migrated
// pages use: accent for the page's main create action, bordered/elevated for
// the secondary ones (mirrors Teams.jsx `primaryBtn` and Agents.jsx's Import).
const HEADER_PRIMARY_BTN = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 12px',
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
  border: 'none', borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
};

const HEADER_SECONDARY_BTN = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 12px',
  background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-secondary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
  cursor: 'pointer', whiteSpace: 'nowrap',
};

// Field styling for the BriefingPack-import dialog's two controls (#1965).
const FIELD_LABEL = {
  display: 'block', marginBottom: 4,
  fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-secondary)',
};

const FIELD_CONTROL = {
  width: '100%', boxSizing: 'border-box',
  padding: '6px 8px',
  background: 'var(--eb-bg-input, var(--eb-bg-surface))', color: 'var(--eb-text-primary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
  fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
};

function loadSidebarWidth() {
  try {
    const v = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
    return Number.isFinite(v) ? v : 260;
  } catch { return 260; }
}

function ResizeDivider({ onMouseDown, disabled = false }) {
  const [hovered, setHovered] = React.useState(false);
  const showGrab = hovered && !disabled;
  return (
    <div
      onMouseDown={disabled ? undefined : onMouseDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: DIVIDER_W,
        flexShrink: 0,
        cursor: disabled ? 'default' : 'col-resize',
        position: 'relative',
        zIndex: 5,
        userSelect: 'none',
      }}
    >
      <div style={{
        position: 'absolute',
        left: '50%',
        top: 0,
        bottom: 0,
        width: showGrab ? 3 : 1,
        transform: 'translateX(-50%)',
        background: showGrab ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)',
        transition: 'background 0.15s, width 0.15s',
        pointerEvents: 'none',
      }} />
    </div>
  );
}

// Section header inside the left list (Flows / Teams / Drafts …).
function SectionHeader({ children, action }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: 'var(--eb-space-3) var(--eb-space-4) var(--eb-space-1)',
      fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
      color: 'var(--eb-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>
      <span>{children}</span>
      {action}
    </div>
  );
}

// Generic selectable row (teams, drafts). An optional `onDelete` renders a trash button that fades in on hover.
// Renaming a draft lives solely in the flow header (ProcessCanvas, #581) — this
// row has no rename affordance.
function ListRow({ icon: Icon, label, sub, selected, onSelect, onDelete, deleteTitle }) {
  const [hover, setHover] = useState(false);

  const actionCount = onDelete ? 1 : 0;

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        onClick={onSelect}
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', width: '100%',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          paddingRight: actionCount ? `calc(var(--eb-space-3) + ${actionCount * 24}px)` : 'var(--eb-space-3)',
          background: selected ? 'var(--eb-bg-selected)' : 'transparent',
          borderLeft: selected ? '3px solid var(--eb-accent-primary)' : '3px solid transparent',
          borderTop: 'none', borderRight: 'none', borderBottom: '1px solid transparent',
          color: selected ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
          transition: 'background var(--eb-transition-fast)',
        }}
        onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
        onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
      >
        <Icon size={18} style={{ flexShrink: 0, color: selected ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{label}</div>
          {sub && (
            <div style={{
              marginTop: 2, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{sub}</div>
          )}
        </div>
      </button>
      {(hover || selected) && onDelete && (
        <div style={{
          position: 'absolute', top: '50%', right: 'var(--eb-space-2)', transform: 'translateY(-50%)',
          display: 'flex', alignItems: 'center', gap: 2,
        }}>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title={deleteTitle || 'Delete'}
            aria-label={deleteTitle || 'Delete'}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 4,
              color: 'var(--eb-text-muted)', display: 'flex', alignItems: 'center',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-status-error)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

export default function Briefings() {
  const { user } = useAuth();
  const lastSelectedKey = user ? `${LAST_SELECTED_KEY_PREFIX}.${user.username}` : null;
  const [searchParams, setSearchParams] = useSearchParams();
  const [navCollapsed, setNavCollapsed] = useState(false);

  // Resizable left sidebar — width persisted in localStorage.
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const [containerW, setContainerW] = useState(null);

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)); } catch {}
  }, [sidebarWidth]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width;
      if (w) setContainerW(w);
    });
    ro.observe(el);
    setContainerW(el.getBoundingClientRect().width || null);
    return () => ro.disconnect();
  }, []);

  const effSidebarWidth = navCollapsed
    ? 40
    : Math.max(SIDEBAR_MIN, Math.min(
        SIDEBAR_MAX,
        containerW ? Math.min(sidebarWidth, containerW - DIVIDER_W - DETAILS_MIN) : sidebarWidth
      ));

  const startDrag = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = effSidebarWidth;
    const containerNow = containerRef.current?.getBoundingClientRect().width || window.innerWidth;
    const upperCap = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, containerNow - DIVIDER_W - DETAILS_MIN));
    dragRef.current = { startX, startWidth, lowerCap: SIDEBAR_MIN, upperCap };

    setResizing(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (ev) => {
      if (!dragRef.current) return;
      const { startX: sx, startWidth: sw, lowerCap: lo, upperCap: hi } = dragRef.current;
      setSidebarWidth(Math.max(lo, Math.min(hi, sw + (ev.clientX - sx))));
    };
    const onUp = () => {
      dragRef.current = null;
      setResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [effSidebarWidth]);
  // Selection: `proc` is a team id, 'draft:<id>', or 'import'. It used to share
  // the page with a second selection param, `?flow=<orchestratorId>`, for the
  // BriefingPack source — removed in #1965 along with that list (see the
  // obsolete-scope effect below, which drops both stale params).
  const proc = searchParams.get('proc');
  // Deep link into a node's inspector tab (#963): `?proc=<team>&node=<agentId>
  // &tab=routing`, as used by the Agent-Chat right rail's read-only Outcomes tab
  // to hand editing over to the Flow Editor. Bookmarkable query params rather
  // than router state, so the link survives a cold navigation (the pattern
  // established for `?session=` in #642). Consumed once by the graph panel,
  // which then asks us to strip them so a later scope change or reload doesn't
  // re-apply a stale selection.
  const focusNode = searchParams.get('node');
  const focusTab = searchParams.get('tab');
  // Flow Copilot (#1069): `?copilot=1` opens the docked chat panel on mount —
  // set by the "Describe flow…" entry below and by scope changes that should
  // keep the panel open (draft re-key on rename, team → draft bridge).
  const copilotParam = searchParams.get('copilot') === '1';
  // Create-launcher deep link (#1665): `?new=blank` starts a fresh draft in the
  // canvas (the "Build it yourself" entry), `?new=describe` a fresh draft with
  // the Flow Copilot open (the conversational "Describe it" entry). Consumed
  // once on mount, then replaced by the resulting `?proc=draft:<id>` selection.
  const newParam = searchParams.get('new');
  const pendingFocus = useMemo(
    () => (proc && focusNode ? { nodeId: focusNode, tab: focusTab || 'routing' } : null),
    [proc, focusNode, focusTab],
  );
  const clearPendingFocus = useCallback(() => {
    if (!focusNode && !focusTab) return;
    setSearchParams(copilotParam ? { proc, copilot: '1' } : { proc }, { replace: true });
  }, [proc, focusNode, focusTab, copilotParam, setSearchParams]);

  // Obsolete selections from earlier versions of this page. Both would render
  // an empty right pane with no explanation, so drop them and fall back to the
  // default selection state: the read-only "Role templates" blueprint scope
  // (?proc=templates) and the BriefingPack source (?flow=<orchestratorId>,
  // removed in #1965).
  const staleFlowParam = searchParams.get('flow');
  useEffect(() => {
    if (proc === 'templates') { setSearchParams({}, { replace: true }); return; }
    // A `?flow=` that arrives alongside a live `?proc=` is only ever stale
    // decoration (the two were mutually exclusive in the URL writer), so strip
    // the dead param rather than discarding a selection that still resolves.
    if (staleFlowParam) setSearchParams(proc ? { proc } : {}, { replace: true });
  }, [proc, staleFlowParam, setSearchParams]);

  const { data: agents } = useApi('/api/agents');
  const { data: environments } = useApi('/api/environments');
  const { data: draftsList, refetch: refetchDrafts } = useApi('/api/process/drafts');

  const teams = (agents || []).filter(a => a.role === 'team');
  const drafts = Array.isArray(draftsList) ? draftsList : [];
  const envNameById = new Map((environments || []).map(e => [e.id, e.name]));

  function persistLastSelected(kind, value) {
    if (!lastSelectedKey) return;
    try { localStorage.setItem(lastSelectedKey, JSON.stringify({ kind, value })); } catch { /* ignore */ }
  }

  function selectProc(scope, opts) {
    // 'import' is a transient state (reading a file); don't persist it.
    if (scope !== 'import') persistLastSelected('proc', scope);
    // `opts.copilot` (#1069) keeps the Copilot panel open across a scope change
    // (draft rename re-key, team → draft bridge) — the panel is component state
    // inside the (scope-keyed) graph panel, so it only survives via the param.
    setSearchParams(opts && opts.copilot ? { proc: scope, copilot: '1' } : { proc: scope });
  }

  // Restore the last-viewed flow on mount when the URL carries no selection.
  // Mirrors the Agent Chat last-agent restore pattern. Waits for both agents
  // and drafts to load so the stored id can be validated against live data.
  useEffect(() => {
    if (proc) return;
    // A launcher deep link (`?new=…`) owns the initial selection — don't let the
    // last-selected restore race it and navigate away before it's consumed.
    if (newParam) return;
    if (!lastSelectedKey) return;
    if (agents === null || draftsList === null) return;

    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(lastSelectedKey)); } catch { /* ignore */ }
    if (!stored) return;

    // `kind: 'proc'` is the only kind this page writes. A stored `kind: 'flow'`
    // is a BriefingPack selection left in a returning user's localStorage from
    // before #1965 — it falls through and restores nothing, which is what we
    // want: the list it named no longer exists.
    if (stored.kind === 'proc') {
      const value = stored.value;
      if (value === 'import') return; // ephemeral; don't restore
      const validTeam = teams.find(t => t.id === value);
      const validDraft = value.startsWith('draft:') && drafts.find(d => `draft:${d.id}` === value);
      if (validTeam || validDraft) setSearchParams({ proc: value }, { replace: true });
    }
  }, [agents, draftsList, proc, lastSelectedKey, teams, drafts, setSearchParams]);

  // Consume a Create-launcher `?new=…` deep link exactly once. Waits for the
  // lists so the new draft appears immediately; newProcess/describeFlow replace
  // the URL with the draft selection, which clears `new` and prevents re-firing.
  const launcherNewConsumed = useRef(false);
  useEffect(() => {
    if (!newParam || launcherNewConsumed.current) return;
    if (agents === null || draftsList === null) return;
    launcherNewConsumed.current = true;
    if (newParam === 'describe') describeFlow();
    else if (newParam === 'blank') newProcess();
    else setSearchParams({}, { replace: true }); // unknown value → drop the param
    // newProcess/describeFlow are stable hoisted declarations; deps intentionally
    // omit them so this fires only on the param/data becoming ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newParam, agents, draftsList]);

  async function newProcess() {
    try {
      const d = await apiCall('POST', '/api/process/drafts', { name: 'Untitled flow' });
      refetchDrafts();
      setSearchParams({ proc: `draft:${d.id}` });
    } catch { /* surfaced elsewhere; keep the list usable */ }
  }

  // "Describe flow…" (#1069): same empty draft as New flow, but lands with the
  // Flow Copilot panel open and its composer focused — the natural-language
  // path to a first flow. The first generation also proposes the draft's name.
  async function describeFlow() {
    try {
      const d = await apiCall('POST', '/api/process/drafts', { name: 'Untitled flow' });
      refetchDrafts();
      persistLastSelected('proc', `draft:${d.id}`);
      setSearchParams({ proc: `draft:${d.id}`, copilot: '1' });
    } catch { /* surfaced elsewhere; keep the list usable */ }
  }

  // Import a previously-exported process-template JSON (#512) — the entry
  // point lives here, next to "New process", rather than inside an
  // already-open flow (importing always creates a brand-new flow, so the
  // previously-open one was irrelevant context). Validation/preview logic is
  // unchanged from the former in-editor flow, just moved up a level: on
  // success, `ProcessGraphPanel` is mounted with scope 'import' to render the
  // read-only preview from `pendingImport`.
  const importInputRef = useRef(null);
  const [pendingImport, setPendingImport] = useState(null); // { bundle, graph }
  const [importError, setImportError] = useState(null);
  const [importBusy, setImportBusy] = useState(false);

  const clearPendingImport = useCallback(() => setPendingImport(null), []);
  const closeImportPreview = useCallback(() => setSearchParams({}), [setSearchParams]);

  async function onImportFile(e) {
    setImportError(null);
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    let bundle;
    try { bundle = JSON.parse(await file.text()); }
    catch { setImportError('Not valid JSON.'); return; }
    setImportBusy(true);
    try {
      const res = await fetch('/api/flows/graph', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processTemplate: bundle }),
      });
      const g = await res.json();
      if (!res.ok) { setImportError(g.error || `HTTP ${res.status}`); return; }
      setPendingImport({ bundle, graph: g });
      setSearchParams({ proc: 'import' });
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportBusy(false);
    }
  }

  // Delete confirmation goes through the shared styled ConfirmDialog (like every
  // other delete action in the console) rather than a native browser prompt,
  // so the flow looks and behaves consistently across pages.
  const [deleteTarget, setDeleteTarget] = useState(null); // the draft pending deletion
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function confirmDeleteDraft() {
    const d = deleteTarget;
    if (!d) return;
    setDeleteBusy(true);
    try {
      await apiCall('DELETE', `/api/process/drafts/${d.id}`);
      // If the deleted draft was open, drop the selection.
      if (proc === `draft:${d.id}`) setSearchParams({});
      refetchDrafts();
    } catch { /* leave the list as-is; the draft may already be gone */ }
    finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  }

  // Import a BriefingPack hierarchy as an editable flow draft (#377). Since
  // #1965 this is an explicit action rather than a button floating over the
  // removed BriefingPack listing: the packs are read straight off the chosen
  // agent's workspace, so the dialog asks which agent and which directory.
  // Opens the new draft on success.
  const [bpImportOpen, setBpImportOpen] = useState(false);
  const [bpImportAgentId, setBpImportAgentId] = useState('');
  const [bpImportPath, setBpImportPath] = useState('');
  const [bpImporting, setBpImporting] = useState(false);
  const [bpImportError, setBpImportError] = useState(null);

  const bpCandidates = useMemo(() => importCandidates(agents), [agents]);
  const bpSelected = bpCandidates.find(c => c.id === bpImportAgentId) || null;
  const bpSubmit = importSubmitState({ agentId: bpImportAgentId, busy: bpImporting });

  function openBriefingsImport() {
    // Pre-select the most likely source so the common case is one click. The
    // path field follows the picker (below) rather than being seeded here, so
    // the two can never disagree about which agent's guess is showing.
    setBpImportAgentId(bpCandidates.length ? bpCandidates[0].id : '');
    setBpImportPath(bpCandidates.length ? bpCandidates[0].path : '');
    setBpImportError(null);
    setBpImportOpen(true);
  }

  function pickBriefingsAgent(id) {
    setBpImportAgentId(id);
    setBpImportPath((bpCandidates.find(c => c.id === id) || {}).path || '');
    setBpImportError(null);
  }

  async function submitBriefingsImport() {
    if (bpSubmit.disabled) return;
    const body = importRequestBody({
      agentId: bpImportAgentId, path: bpImportPath, label: bpSelected && bpSelected.label,
    });
    if (!body) return;
    setBpImporting(true);
    setBpImportError(null);
    try {
      const d = await apiCall('POST', '/api/process/drafts/import-briefings', body);
      refetchDrafts();
      setBpImportOpen(false);
      setSearchParams({ proc: `draft:${d.id}` });
    } catch (e) {
      // Inline, not a window.alert: the server's message names the actual
      // problem (missing directory, no pack ids, refused path) and the user
      // needs it next to the field they must correct.
      setBpImportError(importErrorText(e));
    } finally {
      setBpImporting(false);
    }
  }

  // The create actions live in the unified top-bar header (#1912),
  // through the same `usePageActions()` slot every other migrated page uses
  // (#1847) — so they keep their placement/styling convention and stay
  // reachable while the left flows list is collapsed.
  const headerAction = usePageActions(
    <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
      <input
        ref={importInputRef} type="file" accept="application/json,.json"
        onChange={onImportFile} style={{ display: 'none' }}
      />
      {/* #1999: the create actions never said what they do. Each wears the
          shared dark Tooltip (hover + keyboard focus); the visible button text
          stays the accessible name. Import swaps its hint while busy, since the
          "import a file" sentence contradicts a button that is mid-read. */}
      {/* #1965 (AC4): the BriefingPack import is an explicit action here, next
          to the ordinary flow import it must not be confused with. It sits
          first and unaccented — a migration aid is not a create action, and a
          reader who never used BriefingPacks should skip past it. */}
      <Tooltip
        label={agents === null ? IMPORT_BRIEFINGS_COPY.loading : IMPORT_BRIEFINGS_COPY.tooltip}
        wrap={shouldWrapTooltip(IMPORT_BRIEFINGS_COPY.tooltip)}
      >
        {/* Held until the agent list resolves: the dialog's picker is built
            from it, and opening early would show the honest-looking but wrong
            "no agent workspace is available" instead of a loading state. */}
        <button
          onClick={openBriefingsImport}
          disabled={agents === null}
          style={{
            ...HEADER_SECONDARY_BTN,
            cursor: agents === null ? 'not-allowed' : 'pointer',
            opacity: agents === null ? 0.6 : 1,
          }}
        >
          <Package size={14} /> {IMPORT_BRIEFINGS_COPY.action}
        </button>
      </Tooltip>
      <Tooltip label={importBusy ? PAGE_ACTION_TITLES.importBusy : PAGE_ACTION_TITLES.import}>
        <button
          onClick={() => importInputRef.current?.click()}
          disabled={importBusy}
          style={{ ...HEADER_SECONDARY_BTN, cursor: importBusy ? 'not-allowed' : 'pointer', opacity: importBusy ? 0.6 : 1 }}
        >
          <Upload size={14} /> {importBusy ? 'Importing…' : 'Import'}
        </button>
      </Tooltip>
      <Tooltip
        label={PAGE_ACTION_TITLES.describe}
        wrap={shouldWrapTooltip(PAGE_ACTION_TITLES.describe)}
      >
        <button onClick={describeFlow} style={HEADER_SECONDARY_BTN}>
          <Sparkles size={14} /> Describe flow…
        </button>
      </Tooltip>
      <Tooltip label={PAGE_ACTION_TITLES.newFlow}>
        <button onClick={newProcess} style={HEADER_PRIMARY_BTN}>
          <Plus size={15} /> New flow
        </button>
      </Tooltip>
    </div>
  );

  return (
    <>
    {headerAction}
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: 'calc(100vh - var(--eb-header-height))',
      margin: 'calc(-1 * var(--eb-space-6))',
      background: 'var(--eb-bg-app)',
      overflow: 'hidden',
    }}>
      {/* Import status belongs at the top of the page content area, directly
          below the header the Import button now lives in — not in the left
          panel, which no longer owns the action (#1912). */}
      {(importBusy || importError) && (
        <div
          role="status"
          style={{
            flexShrink: 0,
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            borderBottom: '1px solid var(--eb-border-default)',
            background: 'var(--eb-bg-surface)',
            fontSize: 'var(--eb-text-xs)',
            color: importError ? 'var(--eb-status-error)' : 'var(--eb-text-secondary)',
          }}
        >
          {importError || 'Importing…'}
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
      {/* Left column: Flow list */}
      <div style={{
        width: effSidebarWidth,
        minWidth: effSidebarWidth,
        height: '100%',
        background: 'var(--eb-bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: resizing ? 'none' : 'width var(--eb-transition-normal), min-width var(--eb-transition-normal)',
        flexShrink: 0,
      }}>
        {navCollapsed ? (
          /* Collapsed: expand button only */
          <button
            onClick={() => setNavCollapsed(false)}
            title="Show Flows"
            aria-label="Show Flows"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              padding: 'var(--eb-space-3) 0',
              background: 'none',
              border: 'none',
              borderBottom: '1px solid var(--eb-border-default)',
              color: 'var(--eb-text-secondary)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
          >
            <ChevronRight size={16} />
          </button>
        ) : (
          <>
            {/* Header: help icon + collapse button. The panel's own "Flows"
                heading is gone (#1912) — the page title lives exactly once, in
                the unified top bar (#1847), and the create actions moved there
                too, so collapsing this panel no longer hides flow creation. */}
            <div style={{
              padding: 'var(--eb-space-3) var(--eb-space-3) var(--eb-space-3) var(--eb-space-4)',
              borderBottom: '1px solid var(--eb-border-default)',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', minWidth: 0 }}>
                {/* The Welcome banner and this page's own help drawer moved into
                    the `flows` help topic (#1876) — the "?" opens the Help panel
                    on its "This page" face.

                    #1984: it now names its chapter. It opens at "What Flows is"
                    rather than at "The flows left list" it literally sits in —
                    that chapter is the very next heading, so landing on the
                    first one gives the reader the definition AND the list,
                    while landing on the second hides the definition above the
                    fold, and scrolling UP is the direction nobody tries. */}
                <PageHelpButton
                  label="Help for Flows"
                  size={15}
                  section={FLOWS_HELP_SECTIONS.overview}
                  style={{ padding: 2, flexShrink: 0 }}
                />
              </div>
              <button
                onClick={() => setNavCollapsed(true)}
                title="Hide Flows"
                aria-label="Hide Flows"
                style={{
                  background: 'none', border: 'none',
                  color: 'var(--eb-text-secondary)', cursor: 'pointer',
                  padding: 'var(--eb-space-1)', display: 'flex', alignItems: 'center', flexShrink: 0,
                }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
              >
                <ChevronLeft size={16} />
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {/* The three create actions (New flow / Describe flow… / Import)
                  used to sit here, above the list. They moved into the unified
                  top-bar header (#1912) — see `headerAction` below. */}

              {/* Teams — each team is a process (live orchestration graph) */}
              <SectionHeader>Teams</SectionHeader>
              {teams.length === 0 ? (
                <div style={{ padding: '0 var(--eb-space-4) var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                  No teams yet.
                </div>
              ) : (
                teams.map(t => (
                  <ListRow
                    key={t.id}
                    icon={Users}
                    label={t.displayName || t.id}
                    sub={envNameById.get(t.environmentId) || t.environmentId || null}
                    selected={proc === t.id}
                    onSelect={() => selectProc(t.id)}
                  />
                ))
              )}

              {/* Drafts — processes being authored, not yet materialised */}
              <SectionHeader>Drafts</SectionHeader>
              {drafts.length === 0 ? (
                <div style={{ padding: '0 var(--eb-space-4) var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                  No drafts. Use “New flow”.
                </div>
              ) : (
                drafts.map(d => (
                  <ListRow
                    key={d.id}
                    icon={FileText}
                    label={d.name}
                    sub={`${d.roleCount} agent${d.roleCount === 1 ? '' : 's'}`}
                    selected={proc === `draft:${d.id}`}
                    onSelect={() => selectProc(`draft:${d.id}`)}
                    onDelete={() => setDeleteTarget(d)}
                    deleteTitle="Delete draft"
                  />
                ))
              )}

            </div>
          </>
        )}
      </div>

      <ResizeDivider onMouseDown={startDrag} disabled={navCollapsed} />

      {/* Right pane: the graph */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {proc ? (
            <Suspense fallback={
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
                Loading…
              </div>
            }>
              <ProcessGraphPanel
                key={proc}
                scope={proc}
                onNavigate={selectProc}
                onDraftsChanged={refetchDrafts}
                pendingImport={pendingImport}
                onImportConsumed={clearPendingImport}
                onImportClosed={closeImportPreview}
                pendingFocus={pendingFocus}
                onFocusConsumed={clearPendingFocus}
                autoOpenCopilot={copilotParam}
              />
            </Suspense>
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '100%', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)',
            }}>
              Select a team or draft on the left
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete draft"
        message={
          <>
            <p style={{ margin: 0 }}>
              Really delete "<strong>{deleteTarget?.name || deleteTarget?.id}</strong>"?
            </p>
            <p style={{ margin: 'var(--eb-space-3) 0 0', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
              This cannot be undone.
            </p>
          </>
        }
        variant="danger"
        confirmLabel="Delete"
        busy={deleteBusy}
        onConfirm={confirmDeleteDraft}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* #1965 (AC4) — the BriefingPack import, as an explicit action. Two
          fields fit the shared ConfirmDialog's ReactNode `message`, so this
          needs no bespoke dialog (the technique #1958 used for Add member).
          With no importable agent it degrades to an alert that says why,
          rather than a live-looking button that would do nothing. */}
      <ConfirmDialog
        open={bpImportOpen}
        title={IMPORT_BRIEFINGS_COPY.title}
        variant="info"
        maxWidth={560}
        alertOnly={bpCandidates.length === 0}
        confirmLabel={bpImporting ? IMPORT_BRIEFINGS_COPY.busy : IMPORT_BRIEFINGS_COPY.confirm}
        busy={bpImporting}
        onConfirm={bpCandidates.length === 0 ? () => setBpImportOpen(false) : submitBriefingsImport}
        onCancel={() => setBpImportOpen(false)}
        message={
          <>
            <p style={{ margin: 0, color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)', lineHeight: 1.6 }}>
              {IMPORT_BRIEFINGS_COPY.lead}
            </p>
            {bpCandidates.length === 0 ? (
              <p style={{ margin: 'var(--eb-space-4) 0 0', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
                No agent workspace is available to read packs from.
              </p>
            ) : (
              <>
                <label style={{ display: 'block', margin: 'var(--eb-space-4) 0 0' }}>
                  <span style={FIELD_LABEL}>{IMPORT_BRIEFINGS_COPY.agentLabel}</span>
                  <select
                    value={bpImportAgentId}
                    onChange={e => pickBriefingsAgent(e.target.value)}
                    disabled={bpImporting}
                    style={FIELD_CONTROL}
                  >
                    {bpCandidates.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.label}{c.likely ? ` · ${c.path}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: 'block', margin: 'var(--eb-space-3) 0 0' }}>
                  <span style={FIELD_LABEL}>{IMPORT_BRIEFINGS_COPY.pathLabel}</span>
                  <input
                    type="text"
                    value={bpImportPath}
                    onChange={e => { setBpImportPath(e.target.value); setBpImportError(null); }}
                    disabled={bpImporting}
                    placeholder="(agent workspace root)"
                    style={FIELD_CONTROL}
                  />
                  <span style={{ display: 'block', marginTop: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>
                    {IMPORT_BRIEFINGS_COPY.pathHint}
                  </span>
                </label>
                {bpImportError && (
                  <p role="alert" style={{ margin: 'var(--eb-space-3) 0 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>
                    {bpImportError}
                  </p>
                )}
              </>
            )}
          </>
        }
      />
      </div>
    </div>
    </>
  );
}
