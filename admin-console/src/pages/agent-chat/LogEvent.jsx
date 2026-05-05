import React, { useState } from 'react';
import {
  MessageCircle, Sparkles, Wrench, CheckCircle2, AlertTriangle, Brain,
  Send, ArrowDown, Cpu, Clock,
} from 'lucide-react';
import ToolBlock from './ToolBlock';

/**
 * One row in the SessionLogPanel.
 *
 * Renders one of the JSONL event types defined in
 * `docs/agent-chat-plan.md` §4.1. Click toggles "expanded" mode for any row
 * with extra payload (full body, full text, raw JSON).
 *
 * Tool-pair rendering (`tool_use` + matching `tool_result`) is delegated to
 * ToolBlock; SessionLogPanel pre-pairs them and passes the merged shape
 * through `event.kind === 'tool'`. Standalone tool_use / tool_result events
 * (orphan results, missing pair) fall back to ToolBlock with one side null.
 *
 * Props:
 *   event:           the (possibly pre-merged) event object
 *   dimmed:          true → reduce opacity for cross-panel hover hint
 *   onMouseEnter,
 *   onMouseLeave:    cross-panel hover correlation handlers
 */
const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function formatTs(ts) {
  if (!ts) return '';
  try { return TIME_FMT.format(new Date(ts)); } catch { return ''; }
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function iconForType(type) {
  switch (type) {
    case 'message.received': return MessageCircle;
    case 'message.posted':   return Send;
    case 'claude.invoke':    return ArrowDown;
    case 'assistant_text':   return Sparkles;
    case 'tool_use':
    case 'tool_result':
    case 'tool':             return Wrench;
    case 'thinking':         return Brain;
    case 'result':           return CheckCircle2;
    case 'error':
    case 'parse_error':      return AlertTriangle;
    case 'system_init':      return Cpu;
    case 'trigger.fired':    return Clock;
    case '_truncated':       return AlertTriangle;
    default:                 return MessageCircle;
  }
}

function colorForType(type) {
  switch (type) {
    case 'error':
    case 'parse_error':      return 'var(--eb-status-error)';
    case 'result':           return 'var(--eb-status-success)';
    case 'thinking':         return 'var(--eb-text-muted)';
    case 'assistant_text':   return 'var(--eb-accent-primary)';
    case '_truncated':       return 'var(--eb-status-warning)';
    default:                 return 'var(--eb-text-secondary)';
  }
}

export default function LogEvent({ event, dimmed = false, onMouseEnter, onMouseLeave }) {
  const [expanded, setExpanded] = useState(false);
  const type = event?.type || 'unknown';
  const Icon = iconForType(type);
  const iconColor = colorForType(type);

  // Tool-pair short-circuit: SessionLogPanel pre-merges adjacent
  // tool_use+tool_result into a single { kind: 'tool', toolUse, toolResult }
  // event. Render ToolBlock and skip the rest of the row scaffolding.
  if (event?.kind === 'tool') {
    return (
      <div
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        style={{
          opacity: dimmed ? 0.35 : 1,
          padding: '2px var(--eb-space-3)',
          transition: 'opacity 0.15s',
        }}
      >
        <RowMeta ts={event.ts} type="tool_use" />
        <ToolBlock toolUse={event.toolUse} toolResult={event.toolResult} />
      </div>
    );
  }

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={() => hasExpansion(event) && setExpanded(e => !e)}
      style={{
        display: 'flex',
        gap: 8,
        padding: '4px var(--eb-space-3)',
        opacity: dimmed ? 0.35 : 1,
        transition: 'opacity 0.15s, background 0.15s',
        cursor: hasExpansion(event) ? 'pointer' : 'default',
        borderRadius: 'var(--eb-radius-sm)',
      }}
      onMouseOver={e => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
      onMouseOut ={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      <Icon
        size={12}
        style={{
          color: iconColor,
          flexShrink: 0,
          marginTop: 3,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-muted)',
          fontFamily: 'var(--eb-font-mono)',
        }}>
          <span style={{ flexShrink: 0 }}>{formatTs(event.ts)}</span>
          <span style={{
            color: 'var(--eb-text-muted)',
            opacity: 0.7,
            fontSize: 10,
            textTransform: 'lowercase',
          }}>
            {type}
          </span>
        </div>
        <Body event={event} expanded={expanded} />
      </div>
    </div>
  );
}

function RowMeta({ ts, type }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      gap: 6,
      fontSize: 'var(--eb-text-xs)',
      color: 'var(--eb-text-muted)',
      fontFamily: 'var(--eb-font-mono)',
      marginBottom: 2,
    }}>
      <span>{formatTs(ts)}</span>
      <span style={{ opacity: 0.7, fontSize: 10, textTransform: 'lowercase' }}>{type}</span>
    </div>
  );
}

function hasExpansion(ev) {
  if (!ev) return false;
  switch (ev.type) {
    case 'message.received':
    case 'assistant_text':
    case 'thinking':
    case 'error':
    case 'unknown':
    case 'parse_error':
      return true;
    default:
      return false;
  }
}

function Body({ event, expanded }) {
  const COMPACT = 200;
  const baseStyle = {
    fontSize: 'var(--eb-text-sm)',
    color: 'var(--eb-text-secondary)',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    lineHeight: 1.4,
  };

  switch (event.type) {
    case 'message.received': {
      const body = event.body || '';
      const display = expanded ? body : truncate(body, COMPACT);
      return (
        <div style={{ ...baseStyle, fontStyle: 'italic' }}>
          <span style={{ color: 'var(--eb-text-muted)' }}>← from </span>
          <span style={{ color: 'var(--eb-text-primary)' }}>{event.from || 'unknown'}</span>
          {body && <>: <span style={{ whiteSpace: expanded ? 'pre-wrap' : 'normal' }}>{display}</span></>}
        </div>
      );
    }
    case 'claude.invoke':
      return (
        <div style={baseStyle}>
          → Claude (<code style={{ fontFamily: 'var(--eb-font-mono)' }}>{event.promptChars || 0}</code> chars)
        </div>
      );
    case 'assistant_text': {
      const text = event.text || '';
      const display = expanded ? text : truncate(text, COMPACT);
      return (
        <div style={baseStyle}>
          <span style={{ color: 'var(--eb-accent-primary)', fontWeight: 'var(--eb-font-semibold)' }}>Claude: </span>
          <span style={{ whiteSpace: expanded ? 'pre-wrap' : 'normal' }}>{display}</span>
        </div>
      );
    }
    case 'tool_use':
      // Standalone tool_use: render via ToolBlock as pending.
      return (
        <ToolBlock toolUse={{ tool: event.tool, toolId: event.toolId, input: event.input }} />
      );
    case 'tool_result':
      // Standalone tool_result without a paired use — still show via
      // ToolBlock (no input side, just the result).
      return (
        <ToolBlock
          toolUse={{ tool: event.tool || 'tool', toolId: event.toolId, input: undefined }}
          toolResult={{ ok: event.ok !== false, content: event.content }}
        />
      );
    case 'thinking': {
      const text = event.text || '';
      const display = expanded ? text : truncate(text, COMPACT);
      return (
        <div style={{ ...baseStyle, color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
          Thinking: <span style={{ whiteSpace: expanded ? 'pre-wrap' : 'normal' }}>{display}</span>
        </div>
      );
    }
    case 'result': {
      const dur = event.durationMs;
      const tin = event.tokens?.input;
      const tout = event.tokens?.output;
      const cost = event.costUsd;
      return (
        <div style={baseStyle}>
          <span style={{ color: 'var(--eb-status-success)', fontWeight: 'var(--eb-font-semibold)' }}>Done</span>
          {dur !== undefined && <> in {dur}ms</>}
          {(tin !== undefined || tout !== undefined) && (
            <> · in:{tin ?? '?'} out:{tout ?? '?'}</>
          )}
          {cost !== undefined && <> · ${typeof cost === 'number' ? cost.toFixed(4) : cost}</>}
        </div>
      );
    }
    case 'message.posted':
      return (
        <div style={baseStyle}>
          → posted message <code style={{
            fontFamily: 'var(--eb-font-mono)',
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
          }}>{event.eventId || ''}</code>
        </div>
      );
    case 'trigger.fired':
      return (
        <div style={baseStyle}>
          Trigger fired: <code style={{
            fontFamily: 'var(--eb-font-mono)',
            color: 'var(--eb-text-primary)',
          }}>{event.triggerId || event.id || 'unknown'}</code>
        </div>
      );
    case 'system_init':
      return (
        <div style={baseStyle}>
          Session init: <code style={{
            fontFamily: 'var(--eb-font-mono)',
            color: 'var(--eb-text-primary)',
          }}>{event.model || 'unknown'}</code>
          {event.sessionId && (
            <span style={{ color: 'var(--eb-text-muted)' }}> ({event.sessionId})</span>
          )}
        </div>
      );
    case 'error': {
      const msg = event.message || '';
      const display = expanded ? msg : truncate(msg, COMPACT);
      return (
        <div style={{ ...baseStyle, color: 'var(--eb-status-error)' }}>
          Error{event.stage ? ` in ${event.stage}` : ''}: <span style={{ whiteSpace: expanded ? 'pre-wrap' : 'normal' }}>{display}</span>
        </div>
      );
    }
    case '_truncated':
      return (
        <div style={{ ...baseStyle, color: 'var(--eb-status-warning)', fontStyle: 'italic' }}>
          Log truncated — refreshed
        </div>
      );
    case 'parse_error':
      return (
        <div style={{ ...baseStyle, color: 'var(--eb-status-error)' }}>
          Parse error: {truncate(event.raw || '', 200)}
        </div>
      );
    default: {
      const raw = JSON.stringify(event).slice(0, 150);
      return (
        <div style={{
          ...baseStyle,
          color: 'var(--eb-text-muted)',
          fontFamily: 'var(--eb-font-mono)',
          fontSize: 'var(--eb-text-xs)',
        }}>
          [unknown] {raw}
        </div>
      );
    }
  }
}
