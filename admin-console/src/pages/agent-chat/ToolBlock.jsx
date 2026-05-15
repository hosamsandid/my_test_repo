import React, { useState } from 'react';
import { Loader2, Check, X, ChevronRight, Circle, CircleDot } from 'lucide-react';

/**
 * Collapsible tool-use / tool-result block, ported from
 * `bp-explorer/app.js:6055-6087` + `styles.css:4074-4172` and restyled to
 * match the admin-console palette (CSS variables `--eb-*`).
 *
 * Shows a one-line summary (status icon + tool name + truncated input
 * preview). Click to expand and see the full input JSON and, if present,
 * the result content.
 *
 * Props:
 *   toolUse:    { tool, toolId, input }     — required
 *   toolResult: { ok, content }   | null    — optional; presence flips the
 *                                              block from "pending" to "done"
 */
export default function ToolBlock({ toolUse, toolResult }) {
  const [open, setOpen] = useState(false);

  const tool = toolUse?.tool || 'tool';
  const input = toolUse?.input;
  const pending = !toolResult;
  const ok = toolResult?.ok !== false;
  const summary = formatToolSummary(tool, input);

  let StatusIcon = Loader2;
  let statusColor = 'var(--eb-accent-primary)';
  let statusAnimate = true;
  if (!pending) {
    statusAnimate = false;
    if (ok) {
      StatusIcon = Check;
      statusColor = 'var(--eb-status-success)';
    } else {
      StatusIcon = X;
      statusColor = 'var(--eb-status-error)';
    }
  }

  const borderColor = pending
    ? 'var(--eb-accent-muted)'
    : (ok ? 'var(--eb-border-default)' : 'var(--eb-status-error)');

  const resultText = toolResult?.content == null
    ? ''
    : (typeof toolResult.content === 'string'
        ? toolResult.content
        : JSON.stringify(toolResult.content, null, 2));
  const RESULT_MAX = 2000;
  const resultTruncated = resultText.length > RESULT_MAX;
  const resultDisplay = resultTruncated ? resultText.slice(0, RESULT_MAX) : resultText;

  return (
    <div style={{
      margin: '4px 0',
      border: `1px solid ${borderColor}`,
      borderRadius: 'var(--eb-radius-md)',
      overflow: 'hidden',
      background: 'var(--eb-bg-surface)',
      transition: 'border-color 0.2s',
      fontSize: 'var(--eb-text-xs)',
    }}>
      {/* Summary row */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '6px 8px',
          background: 'transparent',
          border: 'none',
          color: 'var(--eb-text-primary)',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
          fontSize: 'var(--eb-text-xs)',
          userSelect: 'none',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      >
        <ChevronRight
          size={11}
          style={{
            flexShrink: 0,
            color: 'var(--eb-text-muted)',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
          }}
        />
        <StatusIcon
          size={12}
          style={{
            flexShrink: 0,
            color: statusColor,
            animation: statusAnimate ? 'spin 1s linear infinite' : undefined,
          }}
        />
        <span style={{
          fontFamily: 'var(--eb-font-mono)',
          fontWeight: 'var(--eb-font-semibold)',
          color: 'var(--eb-text-primary)',
          flexShrink: 0,
        }}>
          {tool}
        </span>
        <span style={{
          fontFamily: 'var(--eb-font-mono)',
          color: 'var(--eb-text-muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
        }}>
          {summary}
        </span>
      </button>

      {open && (
        <div style={{
          padding: '6px 10px 8px',
          borderTop: '1px solid var(--eb-border-default)',
          fontFamily: 'var(--eb-font-mono)',
          fontSize: 'var(--eb-text-xs)',
          lineHeight: 1.45,
          color: 'var(--eb-text-secondary)',
          maxHeight: 280,
          overflowY: 'auto',
          background: 'var(--eb-bg-app)',
        }}>
          {tool === 'TodoWrite' && Array.isArray(input?.todos) ? (
            <TodoList todos={input.todos} />
          ) : input !== undefined && (
            <>
              <div style={{
                fontSize: 10,
                fontWeight: 'var(--eb-font-semibold)',
                color: 'var(--eb-accent-primary)',
                marginBottom: 4,
                textTransform: 'uppercase',
                letterSpacing: 0.4,
              }}>Input</div>
              <pre style={{
                margin: '0 0 8px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: 'var(--eb-text-primary)',
              }}>
                {typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
              </pre>
            </>
          )}

          {tool === 'TodoWrite' ? null : toolResult ? (
            <>
              <div style={{
                fontSize: 10,
                fontWeight: 'var(--eb-font-semibold)',
                color: 'var(--eb-accent-primary)',
                marginBottom: 4,
                textTransform: 'uppercase',
                letterSpacing: 0.4,
              }}>Result{ok ? '' : ' (error)'}</div>
              <pre style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: ok ? 'var(--eb-text-primary)' : 'var(--eb-status-error)',
              }}>
                {resultDisplay}
                {resultTruncated && '\n… (truncated)'}
              </pre>
            </>
          ) : (
            <div style={{
              color: 'var(--eb-text-muted)',
              fontStyle: 'italic',
            }}>
              Waiting for tool response…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Pick the most relevant input field for a one-line summary, mirroring
 * Claude Code's own block summary behaviour.
 */
function formatToolSummary(tool, input) {
  if (!input || typeof input !== 'object') {
    if (typeof input === 'string') return truncate(input, 80);
    return '';
  }
  switch (tool) {
    case 'Read':  return input.file_path || '';
    case 'Write': return input.file_path || '';
    case 'Edit':  return input.file_path || '';
    case 'Bash':  return input.command  || '';
    case 'Grep':  return input.pattern  || '';
    case 'Glob':  return input.pattern  || '';
    case 'TodoWrite': return formatTodoSummary(input.todos);
    default:      return truncate(JSON.stringify(input), 80);
  }
}

export function formatTodoSummary(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return '(no todos)';
  const total = todos.length;
  const done  = todos.filter(t => t?.status === 'completed').length;
  const active = todos.find(t => t?.status === 'in_progress');
  const label = active
    ? (active.activeForm || active.content || '')
    : (done === total ? 'all done' : (todos.find(t => t?.status === 'pending')?.content || ''));
  return `${done}/${total} · ${truncate(label, 60)}`;
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function TodoList({ todos }) {
  if (!Array.isArray(todos) || todos.length === 0) {
    return (
      <div style={{ color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
        (empty todo list)
      </div>
    );
  }
  return (
    <ul style={{
      listStyle: 'none',
      margin: 0,
      padding: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      fontFamily: 'var(--eb-font-sans, inherit)',
    }}>
      {todos.map((todo, i) => {
        const status = todo?.status || 'pending';
        const isDone     = status === 'completed';
        const isActive   = status === 'in_progress';
        const text = isActive
          ? (todo?.activeForm || todo?.content || '')
          : (todo?.content || todo?.activeForm || '');

        let Icon = Circle;
        let color = 'var(--eb-text-muted)';
        if (isDone)        { Icon = Check;     color = 'var(--eb-status-success)'; }
        else if (isActive) { Icon = CircleDot; color = 'var(--eb-accent-primary)'; }

        return (
          <li
            key={i}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '2px 0',
            }}
          >
            <Icon
              size={13}
              style={{
                color,
                flexShrink: 0,
                marginTop: 2,
              }}
            />
            <span style={{
              flex: 1,
              minWidth: 0,
              color: isDone ? 'var(--eb-text-muted)' : 'var(--eb-text-primary)',
              textDecoration: isDone ? 'line-through' : 'none',
              fontWeight: isActive ? 'var(--eb-font-semibold)' : 'var(--eb-font-regular, 400)',
              wordBreak: 'break-word',
              lineHeight: 1.4,
            }}>
              {text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
