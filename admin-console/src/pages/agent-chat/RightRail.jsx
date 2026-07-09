import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PanelRightClose, ScrollText, FolderTree, CalendarClock, Activity, FileText, MoreHorizontal } from 'lucide-react';
import SessionLogPanel from './SessionLogPanel';
import WorkspaceBrowser from './WorkspaceBrowser';
import TriggersPanel from './TriggersPanel';
import RunningSessionsPanel from './RunningSessionsPanel';
import PromptPreviewPanel from './PromptPreviewPanel';
import { apiCall } from '../../hooks/useApi';

const TAB_KEY = 'agentChat.rightRailTab';
const SESSION_POLL_MS = 3_000;
// Width reserved (px) for the overflow "⋯" toggle when it is shown. Used only
// as a layout budget in the fit computation; the button sizes itself.
const OVERFLOW_BTN_WIDTH = 40;

const TAB_KEYS = ['log', 'workspace', 'triggers', 'sessions', 'prompt'];

/**
 * Tabbed right rail for the agent chat page.
 *
 * Tabs:
 *   - "Log"       — structured session timeline (existing SessionLogPanel)
 *   - "Workspace" — read-only file tree of /workspace/agents/<id>/
 *   - "Triggers"  — the agent's triggers.json
 *   - "Sessions"  — running Claude sessions (with a live count badge)
 *   - "Prompt"    — read-only preview of the composed system prompt
 *
 * The active tab is persisted in localStorage so it survives reloads. The
 * close button lifts state up to the page-level `logOpen` toggle.
 *
 * The rail is independently resizable, so the tab strip measures itself: tabs
 * always render icon + label, and whichever ones no longer fit spill into an
 * overflow "⋯" menu. This adapts to any rail width and any number of tabs
 * (rather than a single hard-coded icons-only breakpoint).
 *
 * SessionLogPanel keeps its own header/filter chrome — we intentionally
 * mount it without an `onClose` prop so its close button doesn't appear
 * twice; the close action moves up to the tab strip.
 */
export default function RightRail({
  agentId, roomId, hoveredCorrelationId, onHoverCorrelation, onClose, onCostUpdate, onContextUpdate,
  todoCloseSignal = 0, workspaceRefreshKey = 0,
}) {
  const [tab, setTab] = useState(() => {
    try {
      const v = localStorage.getItem(TAB_KEY);
      if (TAB_KEYS.includes(v)) return v;
    } catch { /* ignore */ }
    return 'log';
  });
  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* ignore */ }
  }, [tab]);

  // Lightweight poll of just the session COUNT — so the "Sessions" tab
  // can show a badge regardless of which tab is currently visible. The
  // RunningSessionsPanel itself owns the full list when it's active.
  const [sessionCount, setSessionCount] = useState(0);
  useEffect(() => {
    if (!agentId) { setSessionCount(0); return undefined; }
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      if (cancelled) return;
      try {
        const data = await apiCall('GET', `/api/agents/${encodeURIComponent(agentId)}/sessions/active`);
        if (!cancelled) setSessionCount(Array.isArray(data?.sessions) ? data.sessions.length : 0);
      } catch { /* keep prior count */ }
      if (!cancelled) timer = setTimeout(tick, SESSION_POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agentId]);

  const tabs = useMemo(() => [
    { key: 'log', icon: <ScrollText size={13} />, label: 'Log' },
    { key: 'workspace', icon: <FolderTree size={13} />, label: 'Workspace' },
    { key: 'triggers', icon: <CalendarClock size={13} />, label: 'Triggers' },
    { key: 'sessions', icon: <Activity size={13} />, label: 'Sessions', badge: sessionCount > 0 ? sessionCount : null },
    { key: 'prompt', icon: <FileText size={13} />, label: 'Prompt' },
  ], [sessionCount]);

  // --- Overflow measurement ---------------------------------------------
  // We render a hidden, full-width copy of the tab row to learn each tab's
  // natural width, then greedily fit as many as the strip allows. Whatever
  // doesn't fit spills into the overflow menu. Re-measured on resize and
  // whenever a tab's width can change (e.g. the Sessions badge appears).
  const stripRef = useRef(null);
  const measureRef = useRef(null);
  const closeRef = useRef(null);
  const [visibleCount, setVisibleCount] = useState(tabs.length);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const measure = measureRef.current;
    if (!strip || !measure || typeof ResizeObserver === 'undefined') return undefined;

    const recompute = () => {
      const stripWidth = strip.clientWidth;
      const closeWidth = closeRef.current ? closeRef.current.offsetWidth : 0;
      const widths = Array.from(measure.children).map((el) => el.getBoundingClientRect().width);
      const total = widths.reduce((a, b) => a + b, 0);

      // Everything fits alongside the close button → no overflow menu.
      if (total <= stripWidth - closeWidth) {
        setVisibleCount(tabs.length);
        return;
      }
      // Otherwise reserve room for the "⋯" toggle and fit greedily.
      const budget = stripWidth - closeWidth - OVERFLOW_BTN_WIDTH;
      let used = 0;
      let count = 0;
      for (const w of widths) {
        if (used + w > budget) break;
        used += w;
        count += 1;
      }
      setVisibleCount(Math.max(1, count)); // always keep at least one real tab
    };

    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [tabs]);

  const visibleTabs = tabs.slice(0, visibleCount);
  const overflowTabs = tabs.slice(visibleCount);
  const activeInOverflow = overflowTabs.some((t) => t.key === tab);

  // --- Overflow dropdown open/close --------------------------------------
  // The dropdown is rendered through a portal (see IconButton for the same
  // pattern) because the tab strip needs `overflow: hidden` for its own
  // measurement row, which would otherwise clip an in-flow absolutely
  // positioned dropdown regardless of the open-state toggling correctly.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuCoords, setMenuCoords] = useState(null);
  const menuWrapRef = useRef(null);
  const menuToggleRef = useRef(null);
  const menuContentRef = useRef(null);

  const positionMenu = () => {
    const btn = menuToggleRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setMenuCoords({ top: rect.bottom + 2, right: window.innerWidth - rect.right });
  };

  useEffect(() => {
    if (!menuOpen) return undefined;
    positionMenu();
    const onDocClick = (e) => {
      const insideToggle = menuWrapRef.current && menuWrapRef.current.contains(e.target);
      const insideMenu = menuContentRef.current && menuContentRef.current.contains(e.target);
      if (!insideToggle && !insideMenu) setMenuOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', positionMenu);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', positionMenu);
    };
  }, [menuOpen]);
  // Close the menu if everything fits again after a resize.
  useEffect(() => { if (overflowTabs.length === 0) setMenuOpen(false); }, [overflowTabs.length]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minWidth: 0,
      background: 'var(--eb-bg-app)',
    }}>
      {/* Tab strip */}
      <div ref={stripRef} style={{
        position: 'relative',
        height: 'var(--eb-header-height)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        overflow: 'hidden',
      }}>
        {visibleTabs.map((t) => (
          <TabButton
            key={t.key}
            icon={t.icon}
            label={t.label}
            badge={t.badge ?? null}
            active={tab === t.key}
            onClick={() => setTab(t.key)}
          />
        ))}

        {overflowTabs.length > 0 && (
          <div ref={menuWrapRef} style={{ position: 'relative', display: 'flex', alignItems: 'stretch' }}>
            <button
              ref={menuToggleRef}
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              title="More tabs"
              aria-label="More tabs"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 var(--eb-space-3)',
                background: 'none',
                border: 'none',
                borderBottom: `2px solid ${activeInOverflow ? 'var(--eb-accent-primary)' : 'transparent'}`,
                color: (menuOpen || activeInOverflow) ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
                cursor: 'pointer',
                transition: 'color var(--eb-transition-fast), border-color var(--eb-transition-fast)',
              }}
              onMouseEnter={e => { if (!menuOpen && !activeInOverflow) e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
              onMouseLeave={e => { if (!menuOpen && !activeInOverflow) e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
            >
              <MoreHorizontal size={16} />
            </button>
            {menuOpen && menuCoords && createPortal(
              <div
                ref={menuContentRef}
                role="menu"
                style={{
                  position: 'fixed',
                  top: menuCoords.top,
                  right: menuCoords.right,
                  minWidth: 160,
                  background: 'var(--eb-bg-surface)',
                  border: '1px solid var(--eb-border-default)',
                  borderRadius: 'var(--eb-radius-md)',
                  boxShadow: 'var(--eb-shadow-md)',
                  padding: 'var(--eb-space-1)',
                  zIndex: 1000,
                }}
              >
                {overflowTabs.map((t) => (
                  <MenuItem
                    key={t.key}
                    icon={t.icon}
                    label={t.label}
                    badge={t.badge ?? null}
                    active={tab === t.key}
                    onClick={() => { setTab(t.key); setMenuOpen(false); }}
                  />
                ))}
              </div>,
              document.body,
            )}
          </div>
        )}

        <div style={{ flex: 1 }} />
        <button
          ref={closeRef}
          onClick={onClose}
          title="Hide panel (Cmd+Shift+L)"
          aria-label="Hide panel"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--eb-text-muted)',
            cursor: 'pointer',
            padding: '0 var(--eb-space-3)',
            display: 'flex',
            alignItems: 'center',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          <PanelRightClose size={16} />
        </button>

        {/* Hidden measurement row: full-width copy of all tabs so we can learn
            their natural widths without affecting layout. */}
        <div ref={measureRef} aria-hidden="true" style={{
          position: 'absolute',
          top: 0,
          left: 0,
          display: 'flex',
          visibility: 'hidden',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}>
          {tabs.map((t) => (
            <TabButton key={t.key} icon={t.icon} label={t.label} badge={t.badge ?? null} active={false} onClick={() => {}} />
          ))}
        </div>
      </div>

      {/* Body — keep both subtrees mounted via display:none so the user
          doesn't lose log scroll position / expanded folders when toggling. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: tab === 'log' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <SessionLogPanel
            agentId={agentId}
            roomId={roomId}
            hoveredCorrelationId={hoveredCorrelationId}
            onHoverCorrelation={onHoverCorrelation}
            onCostUpdate={onCostUpdate}
            onContextUpdate={onContextUpdate}
            todoCloseSignal={todoCloseSignal}
            embedded
          />
        </div>
        <div style={{ display: tab === 'workspace' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <WorkspaceBrowser agentId={agentId} active={tab === 'workspace'} refreshKey={workspaceRefreshKey} />
        </div>
        <div style={{ display: tab === 'triggers' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <TriggersPanel agentId={agentId} active={tab === 'triggers'} />
        </div>
        <div style={{ display: tab === 'sessions' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <RunningSessionsPanel agentId={agentId} active={tab === 'sessions'} />
        </div>
        <div style={{ display: tab === 'prompt' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <PromptPreviewPanel agentId={agentId} embedded />
        </div>
      </div>
    </div>
  );
}

function TabButton({ icon, label, active, onClick, badge = null }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 var(--eb-space-3)',
        background: 'none',
        border: 'none',
        borderBottom: `2px solid ${active ? 'var(--eb-accent-primary)' : 'transparent'}`,
        color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
        fontSize: 'var(--eb-text-sm)',
        fontWeight: active ? 'var(--eb-font-semibold)' : 'var(--eb-font-medium)',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        transition: 'color var(--eb-transition-fast), border-color var(--eb-transition-fast)',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
    >
      {icon}
      {label}
      {badge !== null && badge !== undefined && <Badge value={badge} />}
    </button>
  );
}

function MenuItem({ icon, label, active, onClick, badge = null }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-2)',
        width: '100%',
        padding: 'var(--eb-space-2) var(--eb-space-3)',
        background: active ? 'var(--eb-bg-hover)' : 'none',
        border: 'none',
        borderRadius: 'var(--eb-radius-sm)',
        color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
        fontSize: 'var(--eb-text-sm)',
        fontWeight: active ? 'var(--eb-font-semibold)' : 'var(--eb-font-medium)',
        fontFamily: 'inherit',
        textAlign: 'left',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = active ? 'var(--eb-bg-hover)' : 'none'; }}
    >
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {badge !== null && badge !== undefined && <Badge value={badge} />}
    </button>
  );
}

function Badge({ value }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 16,
      height: 16,
      padding: '0 5px',
      borderRadius: 'var(--eb-radius-full)',
      background: 'var(--eb-accent-primary)',
      color: 'var(--eb-bg-app)',
      fontSize: 10,
      fontWeight: 'var(--eb-font-semibold)',
      lineHeight: 1,
    }}>
      {value}
    </span>
  );
}
