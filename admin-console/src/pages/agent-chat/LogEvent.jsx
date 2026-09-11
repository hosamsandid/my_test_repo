import React, { useState, memo } from 'react';
import {
  MessageCircle, Sparkles, Wrench, CheckCircle2, AlertTriangle, Brain,
  Send, ArrowDown, Cpu, Clock, Settings2, ChevronRight, Repeat, Gauge,
} from 'lucide-react';
import ToolBlock, { ValueRows } from './ToolBlock';
import {
  systemEventSummary, systemEventHasDetail,
  isTaskEvent, taskEventSummary, taskUpdatedPatchRows,
  taskNotificationSummary, formatOutputFileRef,
} from './system-event.js';
import { rateLimitEventSummary, rateLimitEventDetailRows } from './rate-limit-event.js';
import { buildSystemInitView } from './system-init.js';
import { isLoopFired, loopFiredLabel } from './loop-run-view.js';
import { SafeMarkdown } from './Message';

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
 *
 * Cross-panel hover dim (#1676) is driven by CSS off the `data-cid` set on the
 * wrapper in SessionLogPanel, so this component no longer takes a `dimmed`
 * prop or the hover handlers — which lets it be memoized (a hover on the chat
 * side never re-renders these rows).
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
    case 'system_event':     return Settings2;
    case 'rate_limit_event': return Gauge;
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
    case 'system_event':     return 'var(--eb-text-muted)';
    case 'rate_limit_event': return 'var(--eb-text-muted)';
    default:                 return 'var(--eb-text-secondary)';
  }
}

function LogEvent({ event }) {
  const [expanded, setExpanded] = useState(false);
  const type = event?.type || 'unknown';
  // A loop iteration reads as a loop, not a generic trigger (#1155 AC7).
  const loopFired = isLoopFired(event);
  const Icon = loopFired ? Repeat : iconForType(type);
  const iconColor = loopFired ? 'var(--eb-status-warning)' : colorForType(type);

  // Tool-pair short-circuit: SessionLogPanel pre-merges adjacent
  // tool_use+tool_result into a single { kind: 'tool', toolUse, toolResult }
  // event. Render ToolBlock and skip the rest of the row scaffolding.
  if (event?.kind === 'tool') {
    return (
      <div style={{ padding: '2px var(--eb-space-3)' }}>
        <RowMeta ts={event.ts} type="tool_use" />
        <ToolBlock toolUse={event.toolUse} toolResult={event.toolResult} taskSnapshot={event.taskSnapshot} />
      </div>
    );
  }

  return (
    <div
      onClick={() => hasExpansion(event) && setExpanded(e => !e)}
      style={{
        display: 'flex',
        gap: 8,
        padding: '4px var(--eb-space-3)',
        transition: 'background 0.15s',
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

// Memoized (#1676): a cross-panel hover re-renders SessionLogPanel, but each
// row's `event` reference is stable (the list is memoized), so React.memo skips
// the row entirely.
export default memo(LogEvent);

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
    case 'rate_limit_event':
      return true;
    case 'system_event':
      // Expandable only when `raw` carries content beyond the subtype label.
      return systemEventHasDetail(ev);
    case 'system_init':
      // Expandable only when #980 provenance was captured (legacy rows have no
      // extra detail to reveal).
      return !!(ev.provenance);
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
        <ToolBlock
          toolUse={{ tool: event.tool, toolId: event.toolId, input: event.input }}
          taskSnapshot={event.taskSnapshot}
        />
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
      const hasText = text.trim().length > 0;
      const hasSignature = !!event.hasSignature;
      // Preview line: the first non-empty line, truncated. When the API
      // only returned a signature (no plain-text thinking) we say so up
      // front instead of leaving the row blank.
      const preview = hasText
        ? truncate(text.split('\n').find(l => l.trim()) || text, COMPACT)
        : (hasSignature ? '(summarized server-side — no readable text)' : '(no content)');
      return (
        <div style={{ ...baseStyle, color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
            <ChevronRight
              size={11}
              style={{
                flexShrink: 0,
                color: 'var(--eb-text-muted)',
                transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.15s',
                alignSelf: 'center',
              }}
            />
            <span>Thinking: {!expanded && <span>{preview}</span>}</span>
          </div>
          {expanded && (
            <div style={{
              marginTop: 4,
              paddingLeft: 15,
              whiteSpace: 'pre-wrap',
              fontStyle: 'normal',
            }}>
              {hasText
                ? text
                : (
                  <span style={{ color: 'var(--eb-text-muted)' }}>
                    {hasSignature
                      ? 'Claude summarized this thinking step internally — only an encrypted signature was returned, no readable text.'
                      : 'No thinking content was captured for this step.'}
                  </span>
                )}
            </div>
          )}
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
      // A loop iteration is visually a loop and carries its number (#1155 AC7),
      // instead of the bare "Trigger fired: <id>".
      if (isLoopFired(event)) {
        return (
          <div style={baseStyle}>
            <span style={{ color: 'var(--eb-status-warning)', fontWeight: 'var(--eb-font-semibold)' }}>
              {loopFiredLabel(event)}
            </span>
            {' · '}
            <code style={{
              fontFamily: 'var(--eb-font-mono)',
              fontSize: 'var(--eb-text-xs)',
              color: 'var(--eb-text-muted)',
            }}>{event.triggerId || event.id || ''}</code>
          </div>
        );
      }
      return (
        <div style={baseStyle}>
          Trigger fired: <code style={{
            fontFamily: 'var(--eb-font-mono)',
            color: 'var(--eb-text-primary)',
          }}>{event.triggerId || event.id || 'unknown'}</code>
        </div>
      );
    case 'system_init': {
      // #980: model + Model-Provider provenance in one compact opening row;
      // full detail (provider, auth, endpoint, requested vs effective model,
      // session id) on expand. Legacy rows (no provenance) render as before.
      const view = buildSystemInitView(event);
      return (
        <div style={baseStyle}>
          Session init: <code style={{
            fontFamily: 'var(--eb-font-mono)',
            color: 'var(--eb-text-primary)',
          }}>{view.model}</code>
          {view.requestedModel && (
            <span style={{ color: 'var(--eb-text-muted)' }}> (requested: {view.requestedModel})</span>
          )}
          {view.providerText && (
            <span style={{ color: 'var(--eb-text-secondary)' }}> · {view.providerText}</span>
          )}
          {view.sessionId && (
            <span style={{ color: 'var(--eb-text-muted)' }}> ({view.sessionId})</span>
          )}
          {expanded && view.detail && (
            <div style={{
              marginTop: 4,
              paddingLeft: 8,
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              columnGap: 8,
              rowGap: 1,
              fontSize: 'var(--eb-text-xs)',
              fontFamily: 'var(--eb-font-mono)',
            }}>
              {view.detail.map(([k, v]) => (
                <React.Fragment key={k}>
                  <span style={{ color: 'var(--eb-text-muted)' }}>{k}</span>
                  <span style={{ color: 'var(--eb-text-secondary)', overflowWrap: 'anywhere' }}>{v}</span>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
      );
    }
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
    case 'rate_limit_event': {
      // #2202: a purpose-built render instead of the generic `unknown` bucket
      // — a plain-language summary line up front, full field-by-field detail
      // (including both raw epoch timestamps converted to local time) on
      // expand, and the full raw payload below that for anyone who wants it —
      // through the same `ValueRows` pretty key/value renderer #2197 gave
      // every tool Input/Result fallback (#2204 review finding: this used to
      // be a `JSON.stringify` escaped dump, exactly what AC4 asks to avoid).
      const summary = rateLimitEventSummary(event);
      const detailRows = rateLimitEventDetailRows(event);
      const rawValue = event.raw ?? event;
      return (
        <div style={{ ...baseStyle, color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
          {summary || 'Rate limit event'}
          {expanded && detailRows.length > 0 && (
            <div style={{
              marginTop: 4,
              paddingLeft: 8,
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              columnGap: 8,
              rowGap: 1,
            }}>
              {detailRows.map(([k, v]) => (
                <React.Fragment key={k}>
                  <span style={{ color: 'var(--eb-text-muted)' }}>{k}</span>
                  <span style={{ color: 'var(--eb-text-secondary)', overflowWrap: 'anywhere' }}>{v}</span>
                </React.Fragment>
              ))}
            </div>
          )}
          {expanded && rawValue != null && (
            <div style={{ marginTop: 4, paddingLeft: 8 }}>
              <div style={{ color: 'var(--eb-text-muted)' }}>raw:</div>
              <ValueRows value={rawValue} />
            </div>
          )}
        </div>
      );
    }
    case 'parse_error':
      return (
        <div style={{ ...baseStyle, color: 'var(--eb-status-error)' }}>
          Parse error: {truncate(event.raw || '', 200)}
        </div>
      );
    case 'system_event': {
      // `task_updated`/`task_notification` (#2191) — background sub-agent
      // task tracking — get a purpose-built render instead of the generic
      // scalar-only handling below, which drops the nested `patch` and
      // JSON-escapes the markdown `summary`.
      if (isTaskEvent(event)) {
        const summary = taskEventSummary(event);
        const patchRows = taskUpdatedPatchRows(event);
        const notifSummary = taskNotificationSummary(event);
        const outputRef = formatOutputFileRef(event);
        return (
          <div style={{ ...baseStyle, color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
            system / <span style={{ color: 'var(--eb-text-secondary)' }}>{event.subtype}</span>
            {summary && <span style={{ color: 'var(--eb-text-secondary)' }}> — {summary}</span>}
            {expanded && patchRows.length > 0 && (
              <div style={{
                marginTop: 4,
                paddingLeft: 8,
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                columnGap: 8,
                rowGap: 1,
              }}>
                {patchRows.map(([k, v]) => (
                  <React.Fragment key={k}>
                    <span style={{ color: 'var(--eb-text-muted)' }}>{k}</span>
                    <span style={{ color: 'var(--eb-text-secondary)', overflowWrap: 'anywhere' }}>{String(v)}</span>
                  </React.Fragment>
                ))}
              </div>
            )}
            {expanded && notifSummary && (
              <div style={{ marginTop: 4, paddingLeft: 8, fontFamily: 'var(--eb-font-sans)', fontSize: 'var(--eb-text-sm)' }}>
                <SafeMarkdown body={notifSummary} />
              </div>
            )}
            {expanded && outputRef && (
              <div style={{ marginTop: 4, paddingLeft: 8, color: 'var(--eb-text-muted)' }}>
                output: <span style={{ color: 'var(--eb-text-secondary)' }}>{outputRef}</span>
              </div>
            )}
          </div>
        );
      }
      // Surface the informative content the CLI reported (captured in `raw`,
      // e.g. a thinking-token count) inline, and offer the full raw JSON on
      // expand — mirroring the default/unknown case below. Degrades to the
      // bare `system / <subtype>` label when `raw` carries nothing extra.
      const summary = systemEventSummary(event.raw);
      const detail = expanded ? JSON.stringify(event.raw, null, 2) : null;
      return (
        <div style={{ ...baseStyle, color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
          system / <span style={{ color: 'var(--eb-text-secondary)' }}>{event.subtype || 'unknown'}</span>
          {summary && <span style={{ color: 'var(--eb-text-secondary)' }}> — {summary}</span>}
          {detail && (
            <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', fontSize: 'inherit', color: 'var(--eb-text-muted)' }}>
              {detail}
            </pre>
          )}
        </div>
      );
    }
    default: {
      const rawObj = event.raw ?? event;
      const summary = [rawObj?.type, rawObj?.subtype].filter(Boolean).join(' / ') || event.type || 'unknown';
      const detail = expanded ? JSON.stringify(rawObj, null, 2) : null;
      return (
        <div style={{ ...baseStyle, color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
          {summary}
          {detail && (
            <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', fontSize: 'inherit', color: 'var(--eb-text-muted)' }}>
              {detail}
            </pre>
          )}
        </div>
      );
    }
  }
}
