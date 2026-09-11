import React, { useState, useMemo } from 'react';
import { Loader2, Check, X, ChevronRight, Circle, CircleDot } from 'lucide-react';
import { isTaskTool, formatTodoSummary } from './task-todo.js';
import { computeLineDiff } from './edit-diff.js';
import { renderableRows } from './tool-value-view.js';
import { SafeMarkdown } from './Message';

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
 *   taskSnapshot: array | undefined         — for the task-tracking tools
 *                                              (TaskCreate/TaskUpdate/TaskList/
 *                                              TaskGet, #1662), the folded task
 *                                              list as of this event, so the
 *                                              summary/checklist reflect the
 *                                              whole list, not one increment.
 */
export default function ToolBlock({ toolUse, toolResult, taskSnapshot }) {
  const [open, setOpen] = useState(false);

  const tool = toolUse?.tool || 'tool';
  const input = toolUse?.input;
  const pending = !toolResult;
  const ok = toolResult?.ok !== false;

  // Task-tracking tools render as a live checklist. Prefer the folded snapshot
  // assembled from the incremental Task* events; fall back to a legacy
  // TodoWrite call's own `input.todos` when no snapshot was threaded through.
  const isTasky = isTaskTool(tool);
  const todosForDisplay = Array.isArray(taskSnapshot)
    ? taskSnapshot
    : (tool === 'TodoWrite' && Array.isArray(input?.todos) ? input.todos : null);
  const summary = todosForDisplay
    ? formatTodoSummary(todosForDisplay)
    : formatToolSummary(tool, input);

  // Edit/Write tool calls render a red/green line diff instead of the raw
  // input JSON (#2189) — same red/green language as the Workspace tab's
  // DiffView, computed from old_string/new_string (Edit) or the whole new
  // file against nothing (Write, a new-file creation).
  const diffStrings = editDiffStrings(tool, input);

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

  const resultContent = toolResult?.content;
  const hasResultContent = resultContent !== null && resultContent !== undefined && resultContent !== '';

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
          {todosForDisplay ? (
            <TodoList todos={todosForDisplay} />
          ) : diffStrings ? (
            <EditDiff oldString={diffStrings.oldString} newString={diffStrings.newString} />
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
              <ValueRows value={input} isInput />
            </>
          )}

          {isTasky ? null : toolResult ? (
            <>
              <div style={{
                fontSize: 10,
                fontWeight: 'var(--eb-font-semibold)',
                color: 'var(--eb-accent-primary)',
                marginBottom: 4,
                textTransform: 'uppercase',
                letterSpacing: 0.4,
              }}>Result{ok ? '' : ' (error)'}</div>
              {hasResultContent ? (
                <div style={{ color: ok ? 'var(--eb-text-primary)' : 'var(--eb-status-error)' }}>
                  <ValueRows value={resultContent} />
                </div>
              ) : (
                <div style={{ color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
                  (empty result)
                </div>
              )}
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

// `formatTodoSummary` now lives in the pure, unit-tested `task-todo.js` module
// (#1662, #651 convention) and is imported at the top of this file.

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Which two strings to diff for a given tool call, or `null` when the tool
 *  isn't a diffable file edit / creation. */
function editDiffStrings(tool, input) {
  if (!input || typeof input !== 'object') return null;
  if (tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return { oldString: input.old_string, newString: input.new_string };
  }
  if (tool === 'Write' && typeof input.content === 'string') {
    return { oldString: '', newString: input.content };
  }
  return null;
}

const DIFF_GUTTER_WIDTH = 34;

function diffRowStyle(type) {
  const base = {
    display: 'flex',
    whiteSpace: 'pre',
    lineHeight: 1.45,
  };
  if (type === 'add') {
    return { ...base, background: 'var(--eb-status-success-bg)', color: 'var(--eb-status-success)' };
  }
  if (type === 'del') {
    return { ...base, background: 'var(--eb-status-error-bg)', color: 'var(--eb-status-error)' };
  }
  return { ...base, color: 'var(--eb-text-primary)' };
}

const diffGutterStyle = {
  flexShrink: 0,
  width: DIFF_GUTTER_WIDTH,
  textAlign: 'right',
  paddingRight: 6,
  color: 'var(--eb-text-muted)',
  userSelect: 'none',
};

const diffMarkerStyle = {
  flexShrink: 0,
  width: 14,
  textAlign: 'center',
  userSelect: 'none',
};

/** Red/green line diff for an Edit/Write tool call, with an old/new
 *  line-number gutter — the same visual language as the Workspace tab's
 *  `DiffView` (#2189). Always renders the full diff; the surrounding
 *  ToolBlock collapse/expand is what keeps a long one out of view by default. */
function EditDiff({ oldString, newString }) {
  const { rows } = useMemo(() => computeLineDiff(oldString, newString), [oldString, newString]);
  return (
    <div style={{ overflowX: 'auto' }}>
      <pre style={{
        margin: 0,
        padding: 0,
        fontFamily: 'var(--eb-font-mono)',
        fontSize: 'var(--eb-text-xs)',
        tabSize: 2,
      }}>
        {rows.map((row, i) => (
          <div key={i} style={diffRowStyle(row.type)}>
            <span style={diffGutterStyle}>{row.oldLineNo ?? ''}</span>
            <span style={diffGutterStyle}>{row.newLineNo ?? ''}</span>
            <span style={diffMarkerStyle}>{row.type === 'add' ? '+' : row.type === 'del' ? '-' : ''}</span>
            <span>{row.text}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

const VALUE_ROW_INDENT = 14;

function formatScalar(v) {
  if (v === null) return 'null';
  if (v === undefined) return '';
  return String(v);
}

/** Generic pretty-printed key/value renderer for a tool's `input` or
 *  `toolResult.content` (#2197) — the fallback every tool hits unless it has
 *  its own bespoke render (task list, Edit/Write diff, task_updated/
 *  task_notification). No raw JSON punctuation: unquoted `key:` labels, one
 *  field per line, nested objects/arrays indented recursively, multi-line
 *  strings shown as real line breaks and markdown-like strings rendered via
 *  the same `SafeMarkdown` chat messages use. */
function ValueRows({ value, isInput }) {
  const rows = useMemo(() => renderableRows(value, { isInput }), [value, isInput]);
  return (
    <div>
      {rows.map((row) => (
        <ValueRow key={row.path || 'root'} row={row} />
      ))}
    </div>
  );
}

function ValueRow({ row }) {
  const indent = row.depth * VALUE_ROW_INDENT;
  const keyLabel = row.key == null ? null : row.key;
  const keyPrefix = keyLabel != null ? `${keyLabel}: ` : '';

  if (row.kind === 'object' || row.kind === 'array') {
    return (
      <div style={{ marginLeft: indent, color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-semibold)' }}>
        {keyLabel}:
      </div>
    );
  }
  if (row.kind === 'empty-object' || row.kind === 'empty-array') {
    return (
      <div style={{ marginLeft: indent }}>
        {keyPrefix}<span style={{ color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>(empty)</span>
      </div>
    );
  }
  if (row.kind === 'multiline') {
    return (
      <div style={{ marginLeft: indent }}>
        {keyLabel != null && <div style={{ color: 'var(--eb-text-muted)' }}>{keyLabel}:</div>}
        <pre style={{ margin: '0 0 4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {row.value}{row.truncated ? '\n… (truncated)' : ''}
        </pre>
      </div>
    );
  }
  if (row.kind === 'markdown') {
    return (
      <div style={{ marginLeft: indent }}>
        {keyLabel != null && <div style={{ color: 'var(--eb-text-muted)' }}>{keyLabel}:</div>}
        <SafeMarkdown body={row.truncated ? row.value + '\n\n… (truncated)' : row.value} />
      </div>
    );
  }
  // 'scalar'
  return (
    <div style={{ marginLeft: indent, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {keyPrefix}{formatScalar(row.value)}{row.truncated ? ' …' : ''}
    </div>
  );
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
