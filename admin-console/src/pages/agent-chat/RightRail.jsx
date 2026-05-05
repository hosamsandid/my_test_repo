import React, { useEffect, useState } from 'react';
import { PanelRightClose, ScrollText, FolderTree } from 'lucide-react';
import SessionLogPanel from './SessionLogPanel';
import WorkspaceBrowser from './WorkspaceBrowser';

const TAB_KEY = 'agentChat.rightRailTab';

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
  agentId, roomId, hoveredCorrelationId, onHoverCorrelation, onClose,
}) {
  const [tab, setTab] = useState(() => {
    try {
      const v = localStorage.getItem(TAB_KEY);
      if (v === 'workspace' || v === 'log') return v;
    } catch { /* ignore */ }
    return 'log';
  });
  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* ignore */ }
  }, [tab]);

  return (
    <div style={{
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
          active={tab === 'log'}
          onClick={() => setTab('log')}
        />
        <TabButton
          icon={<FolderTree size={13} />}
          label="Workspace"
          active={tab === 'workspace'}
          onClick={() => setTab('workspace')}
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
            embedded
          />
        </div>
        <div style={{ display: tab === 'workspace' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <WorkspaceBrowser agentId={agentId} active={tab === 'workspace'} />
        </div>
      </div>
    </div>
  );
}

function TabButton({ icon, label, active, onClick }) {
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
        cursor: 'pointer',
        transition: 'color var(--eb-transition-fast), border-color var(--eb-transition-fast)',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
    >
      {icon}
      {label}
    </button>
  );
}
