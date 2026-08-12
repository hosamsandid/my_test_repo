import React, { useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { TodoList } from './ToolBlock';

/**
 * Pinned status panel docked to the bottom of the Log tab, always showing
 * the agent's current task list for the active (agent, room).
 *
 * The host (SessionLogPanel) folds the incremental task events
 * (TaskCreate/TaskUpdate/…, #1662) into the list and owns the
 * dismissal-vs-next-change logic: if this component renders, it is meant to be
 * visible. Internal state is limited to the collapse toggle.
 *
 * Props:
 *   todos:               array of { content, activeForm?, status } — the
 *                        current folded task list.
 *   correlationId:       correlationId of the last list-changing event, used
 *                        for cross-panel hover dimming.
 *   onClose():           user clicked the × button; the host should hide the
 *                        panel until the next task-list change arrives.
 *   onHoverCorrelation:  same hover-correlation callback as the log rows.
 */
export default function PinnedTodoPanel({ todos, correlationId, onClose, onHoverCorrelation }) {
  const [collapsed, setCollapsed] = useState(false);

  if (!Array.isArray(todos) || todos.length === 0) return null;

  const total = todos.length;
  const done = todos.filter(t => t?.status === 'completed').length;
  const active = todos.find(t => t?.status === 'in_progress');
  const headerLabel = active
    ? (active.activeForm || active.content || '')
    : (done === total ? 'all done' : (todos.find(t => t?.status === 'pending')?.content || ''));

  const Caret = collapsed ? ChevronRight : ChevronDown;

  return (
    <div
      onMouseEnter={() => onHoverCorrelation && onHoverCorrelation(correlationId || null)}
      onMouseLeave={() => onHoverCorrelation && onHoverCorrelation(null)}
      style={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderTop: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
      }}
    >
      {/* Header — click anywhere on header (outside the × button) toggles collapse. */}
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand TODO list' : 'Collapse TODO list'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px var(--eb-space-3)',
          background: 'transparent',
          border: 'none',
          color: 'var(--eb-text-primary)',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
          width: '100%',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      >
        <Caret
          size={12}
          style={{
            flexShrink: 0,
            color: 'var(--eb-text-muted)',
            transition: 'transform 0.15s',
          }}
        />
        <span style={{
          fontSize: 'var(--eb-text-xs)',
          fontWeight: 'var(--eb-font-semibold)',
          color: 'var(--eb-text-secondary)',
          flexShrink: 0,
        }}>
          TODO {done}/{total}
        </span>
        <span style={{
          flex: 1,
          minWidth: 0,
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-muted)',
          fontFamily: 'var(--eb-font-mono)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {headerLabel ? `· ${headerLabel}` : ''}
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={e => { e.stopPropagation(); onClose && onClose(); }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              e.preventDefault();
              onClose && onClose();
            }
          }}
          title="Hide TODO panel"
          aria-label="Hide TODO panel"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            borderRadius: 'var(--eb-radius-sm)',
            color: 'var(--eb-text-muted)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          onMouseEnter={e => {
            e.stopPropagation();
            e.currentTarget.style.background = 'var(--eb-bg-app)';
            e.currentTarget.style.color = 'var(--eb-text-primary)';
          }}
          onMouseLeave={e => {
            e.stopPropagation();
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--eb-text-muted)';
          }}
        >
          <X size={13} />
        </span>
      </button>

      {!collapsed && (
        <div style={{
          padding: '4px var(--eb-space-3) 8px',
          maxHeight: 160,
          overflowY: 'auto',
          background: 'var(--eb-bg-app)',
          fontSize: 'var(--eb-text-xs)',
        }}>
          <TodoList todos={todos} />
        </div>
      )}
    </div>
  );
}
