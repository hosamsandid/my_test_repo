import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, ChevronLeft, FolderTree, CalendarClock, Activity, FileText, MoreHorizontal, Brain } from 'lucide-react';
import SessionsPanel from './SessionsPanel';
import WorkspaceBrowser from './WorkspaceBrowser';
import TriggersPanel from './TriggersPanel';
import PromptPreviewPanel from './PromptPreviewPanel';
import AgentKnowledgePanel from './AgentKnowledgePanel';
import { apiCall } from '../../hooks/useApi';

const TAB_KEY = 'agentChat.rightRailTab';
const SESSION_POLL_MS = 3_000;
// Width reserved (px) for the overflow "⋯" toggle when it is shown. Used only
// as a layout budget in the fit computation; the button sizes itself.
const OVERFLOW_BTN_WIDTH = 40;

const TAB_KEYS = ['sessions', 'workspace', 'triggers', 'prompt', 'knowledge'];

/**
 * Tabbed right rail for the agent chat page.
 *
 * Tabs:
 *   - "Sessions"  — one sub-tab per active Claude session; the selected one
 *     shows that session's log + an in-tab Stop (merged Log+Sessions, #543)
 *   - "Workspace" — read-only file tree of /workspace/agents/<id>/
 *   - "Triggers"  — the agent's triggers.json
 *   - "Prompt"    — read-only preview of the composed system prompt
 *   - "Knowledge" — the agent's knowledge base
 *
 * The active tab is persisted in localStorage so it survives reloads; an old
 * stored 'log' value silently falls back to the default 'sessions' tab (it is
 * no longer a member of TAB_KEYS), which is where Log used to live.
 *
 * The rail is independently resizable, so the tab strip measures itself: tabs
 * always render icon + label, and whichever ones no longer fit spill into an
 * overflow "⋯" menu. This adapts to any rail width and any number of tabs
 * (rather than a single hard-coded icons-only breakpoint).
 *
 * Collapsing follows the left navigation sidebar's pattern (#905): the owner
 * animates the rail's width down to `--eb-sidebar-collapsed` and passes
 * `collapsed`, at which point the rail renders a slim icon-only strip — an
 * inline expand chevron plus the tab icons, each of which re-expands straight
 * to its tab. The component stays mounted across a collapse, so the active tab
 * survives the cycle; the tab bodies do not render while collapsed, so a
 * hidden rail costs no polling.
 */
export default function RightRail({
  agentId, roomId, hoveredCorrelationId, onHoverCorrelation, onClose, onOpen, onCostUpdate, onContextUpdate,
  todoCloseSignal = 0, workspaceRefreshKey = 0, knowledgeRefreshKey = 0, openTabRequest = null,
  onResumeSession, sessionSelectRequest = null, collapsed = false,
}) {
  const [tab, setTab] = useState(() => {
    try {
      const v = localStorage.getItem(TAB_KEY);
      if (TAB_KEYS.includes(v)) return v;
    } catch { /* ignore */ }
    return 'sessions';
  });
  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* ignore */ }
  }, [tab]);

  // External tab request (e.g. clicking the "N learned" badge in the chat
  // header switches to the Knowledge tab). `ts` disambiguates repeat clicks.
  useEffect(() => {
    if (openTabRequest && TAB_KEYS.includes(openTabRequest.tab)) setTab(openTabRequest.tab);
  }, [openTabRequest]);

  // Lightweight poll of just the session COUNT — so the "Sessions" tab
  // can show a badge regardless of which tab is currently visible. The
  // SessionsPanel itself owns the full list when it's active.
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

  // `Icon` is the component (not a rendered element) because the tab strip and
  // the collapsed icon rail render it at different sizes — 13 inline next to a
  // label, 20 standalone to match the left nav's icon-only items.
  const tabs = useMemo(() => [
    { key: 'sessions', Icon: Activity, label: 'Sessions', badge: sessionCount > 0 ? sessionCount : null },
    { key: 'workspace', Icon: FolderTree, label: 'Workspace' },
    { key: 'triggers', Icon: CalendarClock, label: 'Triggers' },
    { key: 'prompt', Icon: FileText, label: 'Prompt' },
    { key: 'knowledge', Icon: Brain, label: 'Knowledge' },
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
  // An overflow dropdown must not outlive a collapse.
  useEffect(() => { if (collapsed) setMenuOpen(false); }, [collapsed]);

  if (collapsed) {
    return (
      <CollapsedRail
        tabs={tabs}
        activeTab={tab}
        onExpandTo={(key) => { setTab(key); if (onOpen) onOpen(); }}
        onExpand={onOpen}
      />
    );
  }

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
            Icon={t.Icon}
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
                    Icon={t.Icon}
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
          title="Collapse panel (Cmd+Shift+L)"
          aria-label="Collapse panel"
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
          {/* Mirror of the left nav's collapse chevron: the rail sits on the
              right, so "toward the edge" points right. */}
          <ChevronRight size={16} />
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
            <TabButton key={t.key} Icon={t.Icon} label={t.label} badge={t.badge ?? null} active={false} onClick={() => {}} />
          ))}
        </div>
      </div>

      {/* Body — keep both subtrees mounted via display:none so the user
          doesn't lose log scroll position / expanded folders when toggling. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: tab === 'sessions' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <SessionsPanel
            agentId={agentId}
            roomId={roomId}
            active={tab === 'sessions'}
            hoveredCorrelationId={hoveredCorrelationId}
            onHoverCorrelation={onHoverCorrelation}
            onCostUpdate={onCostUpdate}
            onContextUpdate={onContextUpdate}
            todoCloseSignal={todoCloseSignal}
            onResumeSession={onResumeSession}
            selectRequest={sessionSelectRequest}
          />
        </div>
        <div style={{ display: tab === 'workspace' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <WorkspaceBrowser agentId={agentId} active={tab === 'workspace'} refreshKey={workspaceRefreshKey} />
        </div>
        <div style={{ display: tab === 'triggers' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <TriggersPanel agentId={agentId} active={tab === 'triggers'} />
        </div>
        <div style={{ display: tab === 'prompt' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <PromptPreviewPanel agentId={agentId} embedded />
        </div>
        <div style={{ display: tab === 'knowledge' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <AgentKnowledgePanel agentId={agentId} active={tab === 'knowledge'} refreshKey={knowledgeRefreshKey} />
        </div>
      </div>
    </div>
  );
}

/**
 * The collapsed rail — the right-hand mirror of the left navigation sidebar's
 * icon-only rail (`Shell.jsx`): an inline expand chevron at the top, then the
 * tab icons stacked vertically, each with a native tooltip and centred in the
 * strip. The active tab is marked with the accent bar on the *content* side
 * (borderRight here vs. borderLeft in the left nav), and clicking any icon
 * expands the rail straight to that tab.
 */
function CollapsedRail({ tabs, activeTab, onExpandTo, onExpand }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minWidth: 0,
      overflow: 'hidden',
      background: 'var(--eb-bg-surface)',
      borderLeft: '1px solid var(--eb-border-default)',
    }}>
      {/* Expand chevron — same slot the tab strip's collapse button occupies. */}
      <div style={{
        height: 'var(--eb-header-height)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderBottom: '1px solid var(--eb-border-default)',
      }}>
        <button
          type="button"
          onClick={onExpand}
          title="Expand panel (Cmd+Shift+L)"
          aria-label="Expand panel"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--eb-text-secondary)',
            cursor: 'pointer',
            padding: 'var(--eb-space-1)',
            display: 'flex',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
        >
          {/* Mirror of the left nav's expand chevron: points toward the content. */}
          <ChevronLeft size={16} />
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', padding: 'var(--eb-space-2) 0' }}>
        {tabs.map(({ key, Icon, label, badge }) => {
          const active = activeTab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onExpandTo(key)}
              title={label}
              aria-label={label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                padding: 'var(--eb-space-2) 0',
                background: active ? 'var(--eb-bg-selected)' : 'transparent',
                border: 'none',
                borderRight: active ? '3px solid var(--eb-accent-primary)' : '3px solid transparent',
                color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'background var(--eb-transition-fast)',
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
            >
              {/* Counts don't fit the icon rail, so a badge becomes a dot — the
                  same treatment the left nav gives its collapsed chat badge. */}
              <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
                <Icon size={20} />
                {badge !== null && badge !== undefined && (
                  <span style={{
                    position: 'absolute',
                    top: -2,
                    right: -2,
                    width: 7,
                    height: 7,
                    borderRadius: 'var(--eb-radius-full)',
                    background: 'var(--eb-accent-primary)',
                    border: '1.5px solid var(--eb-bg-surface)',
                  }} />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TabButton({ Icon, label, active, onClick, badge = null }) {
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
      <Icon size={13} />
      {label}
      {badge !== null && badge !== undefined && <Badge value={badge} />}
    </button>
  );
}

function MenuItem({ Icon, label, active, onClick, badge = null }) {
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
      <Icon size={13} />
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
