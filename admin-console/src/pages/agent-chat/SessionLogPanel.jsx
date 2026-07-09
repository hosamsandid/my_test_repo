import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Loader2, PanelRightClose } from 'lucide-react';
import { useSSE } from '../../hooks/useSSE';
import LogEvent from './LogEvent';
import PinnedTodoPanel from './PinnedTodoPanel';
import { sumContextTokens } from './context-window';

/**
 * Right-rail panel showing the structured timeline of internal agent
 * activity (Claude tool calls, assistant text, errors, timings).
 *
 * Lifecycle for a given (agentId, roomId):
 *   1. GET /api/agents/:agentId/session/:roomId?limit=500 for backfill;
 *      seed events + cursor.
 *   2. SSE /api/agents/:agentId/session/:roomId/stream?since=<cursor>:
 *      append parsed events; track `_cursor` (advance offset) and
 *      `_truncated` (clear + re-backfill).
 *   3. Auto-scroll: stick to bottom unless user has scrolled up >100 px.
 *
 * Tool-pair merging: adjacent `tool_use` and `tool_result` events with the
 * same `toolId` are folded into a single render row { kind: 'tool',
 * toolUse, toolResult } — they get a unified collapsible block in
 * LogEvent → ToolBlock. Orphan results (result without a prior use) and
 * pending uses (use without a result yet) render as single-sided blocks.
 *
 * Filter chips: All | Tool Calls | Errors | Posted.
 *
 * Cross-panel hover correlation: `hoveredCorrelationId` (from parent) dims
 * non-matching rows; mouseEnter/Leave on a row calls
 * `onHoverCorrelation(eventCorrelationId | null)`.
 *
 * Props:
 *   agentId, roomId
 *   hoveredCorrelationId       — what the chat panel is currently hovering
 *   onHoverCorrelation(id|null)
 *   onClose()                  — parent toggles `logOpen` to false
 *   onContextUpdate({tokensIn, model}|null) — last completed request's input
 *     tokens (input + cache-creation + cache-read, #490) + the model reported
 *     by its preceding `system_init` event, fed up so the chat toolbar can
 *     render the context-window fill indicator (#471)
 *   todoCloseSignal            — bumped by the parent (AgentChat.jsx) whenever
 *     a session boundary occurs elsewhere in the UI (new message sent, Reset
 *     Session clicked, or a trigger-started run's first message arrives, see
 *     ChatPanel's `onTodoBoundary`) so the pinned To-Do panel from the
 *     *previous* session is dismissed even though no new TodoWrite has
 *     arrived yet (#273). Default 0 = "never fired" so mount doesn't dismiss.
 */
export default function SessionLogPanel({
  agentId, roomId, hoveredCorrelationId, onHoverCorrelation, onClose, onCostUpdate, onContextUpdate,
  todoCloseSignal = 0, embedded = false,
}) {
  const [events, setEvents]       = useState([]);
  const [cursor, setCursor]       = useState(0);
  const [filter, setFilter]       = useState('all'); // all | tools | errors | posted
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);

  const scrollerRef = useRef(null);
  const [atBottom, setAtBottom]   = useState(true);

  // Backfill bumps a generation counter so a slow response from the previous
  // (agent, room) can't clobber the current state.
  const reqIdRef = useRef(0);

  /* ─── 1. Backfill on agent/room change ──────────────────────────────── */
  const loadBackfill = useCallback(() => {
    if (!agentId || !roomId) {
      setEvents([]);
      setCursor(0);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    setEvents([]);
    setCursor(0);

    fetch(`/api/agents/${encodeURIComponent(agentId)}/session/${encodeURIComponent(roomId)}?limit=500`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (reqId !== reqIdRef.current) return; // outdated response
        const list = Array.isArray(data?.events) ? data.events : [];
        const initial = data?.truncated
          ? [{ ts: new Date().toISOString(), type: '_truncated' }, ...list]
          : list;
        setEvents(initial);
        setCursor(typeof data?.cursor === 'number' ? data.cursor : 0);
      })
      .catch(e => {
        if (reqId !== reqIdRef.current) return;
        setError(`Log load failed: ${e.message}`);
      })
      .finally(() => {
        if (reqId === reqIdRef.current) setLoading(false);
      });
  }, [agentId, roomId]);

  useEffect(() => { loadBackfill(); }, [loadBackfill]);

  /* ─── 2. Live tail via SSE ──────────────────────────────────────────── */
  // Re-key the SSE URL on cursor only when we backfill (otherwise every
  // _cursor event would force a reconnect). We snapshot the cursor at the
  // time of (agent, room) selection.
  const [sseSince, setSseSince] = useState(null);
  useEffect(() => {
    setSseSince(null); // invalidate while backfill runs
  }, [agentId, roomId]);
  useEffect(() => {
    if (loading) return;
    setSseSince(cursor);
    // We intentionally only resync `sseSince` when loading finishes or
    // a `_truncated` event causes loadBackfill to rerun — the cursor
    // increments arriving over SSE update local state without forcing a
    // reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, agentId, roomId]);

  const sseUrl = (agentId && roomId && sseSince !== null)
    ? `/api/agents/${encodeURIComponent(agentId)}/session/${encodeURIComponent(roomId)}/stream?since=${sseSince}`
    : null;

  const handleEvent = useCallback((ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === '_cursor') {
      if (typeof ev.cursor === 'number') setCursor(ev.cursor);
      return;
    }
    if (ev.type === '_truncated') {
      // Rotate / truncated: drop everything and re-fetch backfill.
      // The backfill itself will inject a banner at the head.
      loadBackfill();
      return;
    }
    setEvents(prev => [...prev, ev]);
  }, [loadBackfill]);

  const { status: sseStatus } = useSSE(sseUrl, {
    onEvent: handleEvent,
    enabled: !!sseUrl,
  });

  // Surface a "Reconnecting…" banner only when the SSE has been in
  // `reconnecting` for >3 s. Without this delay, every transient blip would
  // flash the banner; the threshold matches the user's perception of "this
  // hasn't recovered fast enough — let me tell them".
  const [showReconnectBanner, setShowReconnectBanner] = useState(false);
  useEffect(() => {
    if (sseStatus !== 'reconnecting') {
      setShowReconnectBanner(false);
      return undefined;
    }
    const t = setTimeout(() => setShowReconnectBanner(true), 3000);
    return () => clearTimeout(t);
  }, [sseStatus]);

  /* ─── 3. Auto-scroll ────────────────────────────────────────────────── */
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);

  function handleScroll(e) {
    const el = e.currentTarget;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < 100);
  }

  /* ─── 4. Tool-pair merging + filtering ─────────────────────────────── */
  const renderable = useMemo(() => {
    const merged = mergeToolPairs(events);
    if (filter === 'all') return merged;
    return merged.filter(ev => matchesFilter(ev, filter));
  }, [events, filter]);

  /* ─── 5. Session cost aggregation ──────────────────────────────────── */
  const costTotals = useMemo(() => {
    let usd = 0, tokIn = 0, tokOut = 0;
    for (const ev of events) {
      if (ev.type === 'result' && typeof ev.costUsd === 'number') {
        usd += ev.costUsd;
        tokIn  += ev.tokens?.input  ?? 0;
        tokOut += ev.tokens?.output ?? 0;
      }
    }
    return { usd, tokIn, tokOut };
  }, [events]);

  useEffect(() => {
    if (onCostUpdate) onCostUpdate(costTotals.usd, costTotals.tokIn, costTotals.tokOut);
  }, [costTotals, onCostUpdate]);

  /* ─── 5b. Last-request context-window snapshot (#471) ──────────────────
   * Walks events in order, remembering the model from the most recent
   * `system_init` and the input tokens from the most recent `result` — the
   * `system_init` for a turn always precedes that turn's `result`, so this
   * single pass naturally pairs the two without needing correlationId
   * matching. Unlike costTotals this is NOT cumulative: it reflects only the
   * last completed request, per the issue's scope.
   */
  const lastContext = useMemo(() => {
    let model = null;
    let tokensIn = null;
    for (const ev of events) {
      if (ev.type === 'system_init' && ev.model) model = ev.model;
      if (ev.type === 'result' && ev.tokens) {
        const summed = sumContextTokens(ev.tokens);
        if (summed != null) tokensIn = summed;
      }
    }
    return tokensIn == null ? null : { tokensIn, model };
  }, [events]);

  useEffect(() => {
    if (onContextUpdate) onContextUpdate(lastContext);
  }, [lastContext, onContextUpdate]);

  /* ─── 6. Latest TodoWrite for the pinned panel ─────────────────────────
   * Walk events tail-first to find the most recent `tool_use` whose tool
   * is `TodoWrite`. "Latest wins" — no merging across calls. The pinned
   * panel re-renders in place as new TodoWrites arrive.
   */
  const latestTodoWrite = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (
        ev?.type === 'tool_use' &&
        ev?.tool === 'TodoWrite' &&
        Array.isArray(ev?.input?.todos)
      ) {
        return ev;
      }
    }
    return null;
  }, [events]);

  /* User-controlled dismissal. The panel is hidden only after the user
   * clicks ×; it re-appears automatically when the next TodoWrite arrives
   * (i.e. once the latest entry's toolId differs from the dismissed one).
   * Switching agents/rooms drops the events array and resets the marker
   * via the agent/room-change effect below. */
  const [dismissedTodoId, setDismissedTodoId] = useState(null);
  useEffect(() => {
    setDismissedTodoId(null);
  }, [agentId, roomId]);

  // Session-boundary dismissal (#273): a new message, a session reset, or a
  // trigger-started run's first message all mean the previous session has
  // ended, so the pinned panel must close even though no new TodoWrite has
  // arrived yet. Skip the initial 0 so mounting doesn't dismiss anything.
  const firstTodoSignalRef = useRef(true);
  useEffect(() => {
    if (firstTodoSignalRef.current) {
      firstTodoSignalRef.current = false;
      return;
    }
    setDismissedTodoId(latestTodoWrite?.toolId || '__session_boundary__');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todoCloseSignal]);

  const todoVisible = !!latestTodoWrite && latestTodoWrite.toolId !== dismissedTodoId;

  /* ─── Render ────────────────────────────────────────────────────────── */
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minWidth: 0,
      background: 'var(--eb-bg-app)',
    }}>
      {/* Header strip — hidden when the panel is embedded inside a tabbed
          right rail (the parent renders its own tab strip + close button). */}
      {!embedded && (
        <div style={{
          height: 'var(--eb-header-height)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
          padding: '0 var(--eb-space-3)',
          borderBottom: '1px solid var(--eb-border-default)',
          background: 'var(--eb-bg-surface)',
        }}>
          <div style={{
            fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-semibold)',
            color: 'var(--eb-text-secondary)',
            flexShrink: 0,
          }}>
            Session Log
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            title="Hide log panel (Cmd+Shift+L)"
            aria-label="Hide log panel"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--eb-text-muted)',
              cursor: 'pointer',
              padding: 4,
              display: 'flex',
              alignItems: 'center',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
          >
            <PanelRightClose size={16} />
          </button>
        </div>
      )}

      {/* Filter chips */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: 'var(--eb-space-2) var(--eb-space-3)',
        borderBottom: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        flexShrink: 0,
      }}>
        <Chip label="All"        active={filter === 'all'}     onClick={() => setFilter('all')} />
        <Chip label="Tool Calls" active={filter === 'tools'}   onClick={() => setFilter('tools')} />
        <Chip label="Errors"     active={filter === 'errors'}  onClick={() => setFilter('errors')} />
        <Chip label="Posted"     active={filter === 'posted'}  onClick={() => setFilter('posted')} />
      </div>

      {error && (
        <div role="alert" style={{
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)',
          borderBottom: '1px solid var(--eb-status-error)',
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-primary)',
          flexShrink: 0,
        }}>
          {error}
        </div>
      )}

      {showReconnectBanner && (
        <div role="status" style={{
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)',
          borderBottom: '1px solid var(--eb-status-error)',
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-primary)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
        }}>
          <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
          Reconnecting…
        </div>
      )}

      {/* Scrollable list */}
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 'var(--eb-space-2) 0',
          minHeight: 0,
        }}
      >
        {loading && events.length === 0 && (
          <div style={{
            color: 'var(--eb-text-muted)',
            fontSize: 'var(--eb-text-xs)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--eb-space-2)',
            padding: 'var(--eb-space-4)',
          }}>
            <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
            Loading session log…
          </div>
        )}

        {!loading && (!agentId || !roomId) && (
          <div style={{
            color: 'var(--eb-text-muted)',
            fontSize: 'var(--eb-text-xs)',
            padding: 'var(--eb-space-3)',
            textAlign: 'center',
          }}>
            Select an agent to see its session log.
          </div>
        )}

        {!loading && agentId && roomId && renderable.length === 0 && (
          <div style={{
            color: 'var(--eb-text-muted)',
            fontSize: 'var(--eb-text-xs)',
            padding: 'var(--eb-space-4)',
            textAlign: 'center',
            lineHeight: 1.5,
          }}>
            {events.length === 0
              ? 'No agent activity yet. Send a message to see what’s happening.'
              : 'No entries match the current filter.'}
          </div>
        )}

        {renderable.map((ev, i) => {
          const cid = ev.correlationId || null;
          const dimmed = !!hoveredCorrelationId && cid !== hoveredCorrelationId;
          const accentColor = cid ? colorForCorrelation(cid) : 'transparent';
          return (
            <div
              key={ev._key ?? i}
              style={{
                borderLeft: `2px solid ${accentColor}`,
                marginLeft: 'var(--eb-space-1)',
              }}
            >
              <LogEvent
                event={ev}
                dimmed={dimmed}
                onMouseEnter={() => onHoverCorrelation && onHoverCorrelation(cid)}
                onMouseLeave={() => onHoverCorrelation && onHoverCorrelation(null)}
              />
            </div>
          );
        })}
      </div>

      {todoVisible && (
        <PinnedTodoPanel
          todos={latestTodoWrite.input.todos}
          correlationId={latestTodoWrite.correlationId || null}
          onClose={() => setDismissedTodoId(latestTodoWrite.toolId || '__dismissed__')}
          onHoverCorrelation={onHoverCorrelation}
        />
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function Chip({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '3px 10px',
        fontSize: 'var(--eb-text-xs)',
        fontWeight: 'var(--eb-font-medium)',
        background: active ? 'var(--eb-accent-muted)' : 'transparent',
        color: active ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
        border: `1px solid ${active ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
        borderRadius: 'var(--eb-radius-full)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'background var(--eb-transition-fast), color var(--eb-transition-fast)',
      }}
    >
      {label}
    </button>
  );
}

function matchesFilter(ev, filter) {
  if (filter === 'all') return true;
  if (filter === 'tools')  return ev.kind === 'tool' || ev.type === 'tool_use' || ev.type === 'tool_result';
  if (filter === 'errors') return ev.type === 'error' || ev.type === 'parse_error';
  if (filter === 'posted') return ev.type === 'message.posted';
  return true;
}

/**
 * Walk the event list once and pair each `tool_use` with its matching
 * `tool_result` (same `toolId`). Pairs are emitted as a single
 * { kind: 'tool', toolUse, toolResult, correlationId, ts, _key } element.
 * Unpaired uses keep `toolResult: null`. Orphan results (result with no
 * prior use) are emitted as standalone events — LogEvent renders them via
 * a single-sided ToolBlock.
 */
function mergeToolPairs(events) {
  const out = [];
  // Map: toolId → index in `out` of the merged tool entry awaiting its result
  const pendingByToolId = new Map();

  events.forEach((ev, idx) => {
    if (!ev || typeof ev !== 'object') {
      out.push({ ...ev, _key: `e${idx}` });
      return;
    }
    if (ev.type === 'tool_use' && ev.toolId) {
      const merged = {
        kind: 'tool',
        ts: ev.ts,
        correlationId: ev.correlationId,
        toolUse: { tool: ev.tool, toolId: ev.toolId, input: ev.input },
        toolResult: null,
        _key: `tool-${ev.toolId}-${idx}`,
      };
      pendingByToolId.set(ev.toolId, out.length);
      out.push(merged);
      return;
    }
    if (ev.type === 'tool_result' && ev.toolId && pendingByToolId.has(ev.toolId)) {
      const i = pendingByToolId.get(ev.toolId);
      pendingByToolId.delete(ev.toolId);
      const target = out[i];
      out[i] = {
        ...target,
        toolResult: { ok: ev.ok !== false, content: ev.content },
      };
      return;
    }
    out.push({ ...ev, _key: `e${idx}` });
  });
  return out;
}

/**
 * Stable color per correlationId from a small palette, hashed from the id.
 * A thin left-border keeps the per-conversation grouping legible without
 * shouting.
 */
const CORRELATION_PALETTE = [
  'oklch(0.72 0.15 195)', // accent-cyan-ish
  'oklch(0.72 0.18 155)', // success-green-ish
  'oklch(0.80 0.16 85)',  // warning-yellow-ish
  'oklch(0.75 0.17 30)',  // orange
  'oklch(0.70 0.15 320)', // pink
  'oklch(0.70 0.15 260)', // violet
];

function colorForCorrelation(id) {
  if (!id) return 'transparent';
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return CORRELATION_PALETTE[Math.abs(h) % CORRELATION_PALETTE.length];
}
