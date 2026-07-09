import React, { useEffect, useRef, useState } from 'react';
import { PanelRightClose, ScrollText, FolderTree, CalendarClock, Activity, FileText } from 'lucide-react';
import SessionLogPanel from './SessionLogPanel';
import WorkspaceBrowser from './WorkspaceBrowser';
import TriggersPanel from './TriggersPanel';
import RunningSessionsPanel from './RunningSessionsPanel';
import PromptPreviewPanel from './PromptPreviewPanel';
import { apiCall } from '../../hooks/useApi';

const TAB_KEY = 'agentChat.rightRailTab';
const SESSION_POLL_MS = 3_000;
// Below this rail width, tab labels collapse and only icons remain — the
// close button always stays visible. Tuned so the current tabs plus
// the close button still fit comfortably above the threshold.
const COMPACT_WIDTH_PX = 360;

/**
 * Tabbed right rail for the agent chat page.
 *
 * Tabs:
 *   - "Log"       — structured session timeline (existing SessionLogPanel)
 *   - "Workspace" — read-only file tree of /workspace/agents/<id>/
 *
 * The active tab is persisted in localStorage so it survives reloads. The
 * close button lifts state up to the page-level `logOpen` toggle.
 *
 * SessionLogPanel keeps its own header/filter chrome — we intentionally
 * mount it without an `onClose` prop so its close button doesn't appear
 * twice; the close action moves up to the tab strip.
 */
export default function RightRail({
  agentId, roomId, hoveredCorrelationId, onHoverCorrelation, onClose, onCostUpdate, onContextUpdate,
  workspaceRefreshKey = 0,
}) {
  const [tab, setTab] = useState(() => {
    try {
      const v = localStorage.getItem(TAB_KEY);
      if (v === 'workspace' || v === 'log' || v === 'triggers' || v === 'sessions' || v === 'prompt') return v;
    } catch { /* ignore */ }
    return 'log';
  });
  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* ignore */ }
  }, [tab]);

  // Container-width awareness so tab labels collapse to icons-only when the
  // rail is dragged narrow. Viewport media queries don't help here — the
  // rail is independently resizable from AgentChat.
  const containerRef = useRef(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCompact(entry.contentRect.width < COMPACT_WIDTH_PX);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  return (
    <div ref={containerRef} style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minWidth: 0,
      background: 'var(--eb-bg-app)',
    }}>
      {/* Tab strip */}
      <div style={{
        height: 'var(--eb-header-height)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
      }}>
        <TabButton
          icon={<ScrollText size={13} />}
          label="Log"
          compact={compact}
          active={tab === 'log'}
          onClick={() => setTab('log')}
        />
        <TabButton
          icon={<FolderTree size={13} />}
          label="Workspace"
          compact={compact}
          active={tab === 'workspace'}
          onClick={() => setTab('workspace')}
        />
        <TabButton
          icon={<CalendarClock size={13} />}
          label="Triggers"
          compact={compact}
          active={tab === 'triggers'}
          onClick={() => setTab('triggers')}
        />
        <TabButton
          icon={<Activity size={13} />}
          label="Sessions"
          compact={compact}
          badge={sessionCount > 0 ? sessionCount : null}
          active={tab === 'sessions'}
          onClick={() => setTab('sessions')}
        />
        <TabButton
          icon={<FileText size={13} />}
          label="Prompt"
          compact={compact}
          active={tab === 'prompt'}
          onClick={() => setTab('prompt')}
        />
        <div style={{ flex: 1 }} />
        <button
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

function TabButton({ icon, label, active, onClick, badge = null, compact = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={compact ? label : undefined}
      aria-label={compact ? label : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: compact ? 4 : 6,
        padding: compact ? '0 var(--eb-space-2)' : '0 var(--eb-space-3)',
        background: 'none',
        border: 'none',
        borderBottom: `2px solid ${active ? 'var(--eb-accent-primary)' : 'transparent'}`,
        color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
        fontSize: 'var(--eb-text-sm)',
        fontWeight: active ? 'var(--eb-font-semibold)' : 'var(--eb-font-medium)',
        fontFamily: 'inherit',
        cursor: 'pointer',
        transition: 'color var(--eb-transition-fast), border-color var(--eb-transition-fast)',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
    >
      {icon}
      {!compact && label}
      {badge !== null && badge !== undefined && (
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
          {badge}
        </span>
      )}
    </button>
  );
}
