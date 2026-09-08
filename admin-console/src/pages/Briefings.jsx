import React, { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Users, FileText, Plus, Upload, Sparkles, Package, MoreVertical } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import { useAuth } from '../auth/AuthContext';
import ConfirmDialog from '../components/ConfirmDialog';
import PageHelpButton from '../components/PageHelpButton';
import { usePageActions } from '../context/PageActionsContext';
import Tooltip from '../components/Tooltip';
import { shouldWrapTooltip } from '../components/tooltip-wrap';
import { PAGE_ACTION_TITLES } from './process-toolbar-hints';
import { FLOWS_HELP_SECTIONS } from './process/flows-help-sections';
import RowContextMenu from '../components/RowContextMenu.jsx';
import { buildFlowsRailMenu, intentForMenuKey, parseFlowIntent } from './process/flows-rail-menu.js';
import { downloadBundle } from './process/bundle-download.js';
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

// Generic selectable row (teams, drafts).
//
// #2053: the row's per-row affordance is a **context menu**, not an icon row —
// the house decision epic #1925 D3 took and #1938 applied to the Agent-Chat
// rail's last hover icon. Before this, a draft row carried a hover-revealed
// trash icon (its only action, and the most destructive one), a team row carried
// nothing at all, and renaming a draft was possible only from the flow header
// (ProcessCanvas, #581). All of that is now in the menu, which the kebab, a
// right-click and the `Menu`/`Shift+F10` keys all open — so a beginner meets one
// interaction model on this list and on the chat list rather than two.
//
// The row stays presentational: it reports *that* a menu was asked for and at
// which point, and the page decides what it contains (the AgentList contract).
function ListRow({ icon: Icon, label, sub, selected, onSelect, onRequestMenu }) {
  const [hover, setHover] = useState(false);

  // The trailing gutter the kebab sits in. Reserved whether or not the kebab is
  // currently visible, so the label never reflows on hover.
  const actionCount = onRequestMenu ? 1 : 0;

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        onClick={onSelect}
        onContextMenu={onRequestMenu ? (e) => {
          e.preventDefault();
          onRequestMenu({ x: e.clientX, y: e.clientY });
        } : undefined}
        onKeyDown={onRequestMenu ? (e) => {
          // Shift+F10 / the Menu key are the platform keyboard paths to a
          // context menu — without them the kebab would be the only keyboard
          // route (AC8).
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            onRequestMenu({ x: r.right - 8, y: r.bottom });
          }
        } : undefined}
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
      {onRequestMenu && (
        <div style={{
          position: 'absolute', top: '50%', right: 'var(--eb-space-2)', transform: 'translateY(-50%)',
          display: 'flex', alignItems: 'center', gap: 2,
        }}>
          <KebabButton
            label={`Actions for ${label}`}
            active={hover || selected}
            onOpen={onRequestMenu}
          />
        </div>
      )}
    </div>
  );
}

// The hover-revealed menu trigger. A `span[role="button"]` rather than a
// `<button>` because the row itself is already a `<button>` and a button inside
// a button is invalid HTML; rest-vs-hover is opacity only, so the trailing
// cluster never shifts. Mirrors the Agent-Chat rail's own `KebabButton`, which
// lives in `agent-chat/AgentList.jsx` and is coupled to that list's row layout —
// the two are small enough that a shared component would be more indirection
// than it saves.
function KebabButton({ label, active, onOpen }) {
  function open(e) {
    e.stopPropagation();
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    onOpen({ x: r.right, y: r.bottom + 2 });
  }
  return (
    <span
      role="button"
      tabIndex={0}
      aria-haspopup="menu"
      aria-label={label}
      title="Actions"
      onClick={open}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') open(e); }}
      style={{
        display: 'flex', alignItems: 'center', padding: 4, cursor: 'pointer',
        color: 'var(--eb-text-muted)', opacity: active ? 1 : 0.35,
      }}
    >
      <MoreVertical size={15} />
    </span>
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
  // canvas (the "Design it on the canvas" entry), `?new=describe` a fresh draft with
  // the Flow Copilot open (the conversational "Describe it" entry). Consumed
  // once on mount, then replaced by the resulting `?proc=draft:<id>` selection.
  const newParam = searchParams.get('new');
  // Rail context-menu intent (#2053 B3): the menu's `Create team…` and
  // `Edit as draft` need the bundle the canvas already loads, so the rail hands
  // the action over through the URL rather than growing a second copy of either
  // call. Consumed once by the graph panel, which then asks us to strip it.
  const intentParam = parseFlowIntent(searchParams.get('intent'));
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

  const navigate = useNavigate();
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
    if (opts && opts.copilot) { setSearchParams({ proc: scope, copilot: '1' }); return; }
    // `opts.intent` (#2053) hands the canvas a one-shot rail-menu action.
    if (opts && opts.intent) { setSearchParams({ proc: scope, intent: opts.intent }); return; }
    setSearchParams({ proc: scope });
  }

  const clearPendingIntent = useCallback(() => {
    if (!intentParam) return;
    setSearchParams(proc ? { proc } : {}, { replace: true });
  }, [proc, intentParam, setSearchParams]);

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

  // ── Rail context menu (#2053 B3) ────────────────────────────────────────────
  // The rows report *that* a menu was asked for and for which target; which
  // entries it holds is the pure `buildFlowsRailMenu`, and everything behind
  // them lives here — the RailLifecycleHost split, applied to this page.
  const [menuRequest, setMenuRequest] = useState(null); // { target, anchor } | null
  const handleRequestMenu = useCallback((target, anchor) => setMenuRequest({ target, anchor }), []);
  const closeMenu = useCallback(() => setMenuRequest(null), []);
  const railMenu = useMemo(() => buildFlowsRailMenu(menuRequest?.target), [menuRequest]);

  // A draft's name, pending rename. Renaming used to be possible only from the
  // flow header, which meant selecting the draft first (#581) — the menu is its
  // natural second home, so this is the dialog behind that entry.
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState(null);
  const renameInputRef = useRef(null);
  // Bumped when a rename must reach an already-open canvas that will NOT re-key.
  // Passed to the graph panel as a REFETCH token, deliberately not folded into
  // its `key`: a remount would also discard an unapplied Copilot proposal and
  // close the Copilot rail, which is a much worse trade than the stale name.
  const [draftReload, setDraftReload] = useState(0);

  // `ConfirmDialog` focuses its own confirm button in a passive effect on
  // `[open]`, which beats the input's `autoFocus` (React applies that in the
  // layout phase, before any passive effect runs). Without this the caret is not
  // in the field and the Enter reflex activates **Rename** with the value
  // unchanged, which closes the dialog having renamed nothing.
  //
  // A plain effect here is enough — React flushes passive effects child-first
  // and `ConfirmDialog` is our child, so this runs after its focus call. Both
  // calls are needed: `select()` only sets the selection range and does not
  // move focus (the same order `EditableDraftTitle` uses in ProcessCanvas).
  useEffect(() => {
    if (!renameTarget) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renameTarget]);

  async function confirmRenameDraft() {
    const d = renameTarget;
    const name = renameValue.trim();
    // The Enter handler on the input is not `disabled={busy}` the way the
    // dialog's confirm button is, so key-repeat would otherwise fork the rename:
    // two GET+PUT pairs interleave, the second re-derives an id that is now
    // taken and gets bumped to `<name>-2`, leaving two drafts with one name.
    if (!d || !name || renameBusy) return;
    if (name === d.name) { setRenameTarget(null); return; }
    setRenameBusy(true); setRenameError(null);
    try {
      // The PUT carries the whole bundle (that is the route's contract) and the
      // server re-derives the storage id from the new name, so a rename MAY
      // re-key the draft — follow the id it returns rather than assuming it.
      const bundle = await apiCall('GET', `/api/process/drafts/${d.id}`);
      const saved = await apiCall('PUT', `/api/process/drafts/${d.id}`, { ...bundle, name });
      refetchDrafts();
      if (proc === `draft:${d.id}`) {
        if (saved?.id && saved.id !== d.id) {
          // The re-key remounts the panel (it is keyed on `proc`), so carry the
          // Copilot panel across the way the canvas's own rename does.
          selectProc(`draft:${saved.id}`, { copilot: copilotParam });
        } else {
          // Same slug (a case-only or punctuation-only rename), so `proc` does
          // not change and the canvas keeps the bundle it fetched — showing the
          // OLD name in its header, and, worse, PUTting that stale bundle back
          // on the next canvas edit, which silently undoes the rename. Ask it
          // to refetch; the re-keying branch above gets that for free.
          setDraftReload(n => n + 1);
        }
      }
      setRenameTarget(null);
    } catch (e) {
      setRenameError(e.message || 'Rename failed.');
    } finally {
      setRenameBusy(false);
    }
  }

  // Export from the rail. The canvas toolbar's Export reads the bundle it
  // already has; here we fetch it first, then hand it to the SAME download
  // helper so the two buttons cannot disagree about the filename.
  async function exportFromRail(target) {
    try {
      const bundle = target.kind === 'draft'
        ? await apiCall('GET', `/api/process/drafts/${target.id}`)
        : await apiCall('GET', `/api/process/template?team=${encodeURIComponent(target.id)}`);
      downloadBundle(bundle);
    } catch (e) {
      setImportError(`Export failed: ${e.message}`);
    }
  }

  function chooseMenuItem(key) {
    const target = menuRequest?.target;
    if (!target) return;
    const intent = intentForMenuKey(key);
    if (intent) {
      // Select the row and let the canvas run the action it already owns.
      selectProc(target.kind === 'draft' ? `draft:${target.id}` : target.id, { intent });
      return;
    }
    if (key === 'rename') {
      setRenameValue(target.name || '');
      setRenameError(null);
      setRenameTarget({ id: target.id, name: target.name });
      return;
    }
    if (key === 'export') { exportFromRail(target); return; }
    if (key === 'delete') { setDeleteTarget({ id: target.id, name: target.name }); return; }
    if (key === 'open-chat') { navigate(`/chats/${encodeURIComponent(target.id)}`); }
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
                    onRequestMenu={(anchor) => handleRequestMenu(
                      { kind: 'team', id: t.id, name: t.displayName || t.id }, anchor,
                    )}
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
                    onRequestMenu={(anchor) => handleRequestMenu(
                      { kind: 'draft', id: d.id, name: d.name, roleCount: d.roleCount }, anchor,
                    )}
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
                pendingIntent={intentParam}
                onIntentConsumed={clearPendingIntent}
                draftReloadToken={draftReload}
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

      {/* The rail's row context menu (#2053 B3). Portaled + point-anchored, so
          the same component serves the kebab, the right-click and the keyboard
          path; an empty item set renders nothing rather than an empty box. */}
      {menuRequest && railMenu.items.length > 0 && (
        <RowContextMenu
          items={railMenu.items}
          label={railMenu.label}
          anchor={menuRequest.anchor}
          onChoose={chooseMenuItem}
          onClose={closeMenu}
        />
      )}

      <ConfirmDialog
        open={!!renameTarget}
        title="Rename flow"
        variant="info"
        confirmLabel={renameBusy ? 'Renaming…' : 'Rename'}
        busy={renameBusy}
        onConfirm={confirmRenameDraft}
        onCancel={() => setRenameTarget(null)}
        message={
          <>
            <label style={{ display: 'block', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginBottom: 6 }}>
              Name
            </label>
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && renameValue.trim()) confirmRenameDraft(); }}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '6px 10px', fontFamily: 'inherit',
                fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)',
                background: 'var(--eb-bg-app)', border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-md)',
              }}
            />
            {renameError && (
              <p style={{ margin: 'var(--eb-space-2) 0 0', color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
                {renameError}
              </p>
            )}
          </>
        }
      />

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
