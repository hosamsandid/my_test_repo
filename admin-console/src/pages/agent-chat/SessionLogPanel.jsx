import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Loader2, PanelRightClose, Info } from 'lucide-react';
import { useSSE } from '../../hooks/useSSE';
import { useAuth } from '../../auth/AuthContext';
import { useApi } from '../../hooks/useApi';
import LogEvent from './LogEvent';
import { buildAuthorDirectory } from './message-author.js';
import PinnedTodoPanel from './PinnedTodoPanel';
import VirtualList from '../../components/VirtualList.jsx';
import { EventErrorBoundary } from '../../components/ErrorBoundary.js';
import { sumContextTokens, resolveContextTokensForResult } from './context-window';
import { mergeThinkingTokens } from './system-event.js';
import { hoverBaseCss, hoverDimCss } from './hover-highlight.js';
import { annotateTaskRows } from './task-todo.js';
import { mergeToolPairs } from './tool-progress.js';
import { buildRepoDirectory, parseCiWaitCommand } from './ci-wait-view.js';
import { firstRowKeyForCorrelation, revealStatus, jumpHighlightCss, JUMP_HIGHLIGHT_MS } from './session-jump.js';
import {
  HOVER_CORRELATION_COACHMARK,
  hasSeenCoachmark,
  markCoachmarkSeen,
} from './coachmark.js';

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
 * When `scopeCorrelationId` is set the panel renders only that session's rows
 * — used by the merged Sessions tab (#543). It may be a single correlationId
 * (one running sub-tab) or, for a finished session that groups several runs
 * (#555), an array of every correlationId in that Claude session; the combined
 * log then reads oldest-first across runs. In scoped mode the per-correlation
 * left border is dropped (the rows are one logical session), and the backfill
 * is filtered server-side by correlationId so the full session is returned even
 * when its rows sit outside the last-`limit` tail of a busy room.
 *
 * When `staticOnly` is set (historical/finished session viewing, #544) the
 * panel does a one-shot backfill and skips the live SSE tail — a finished
 * session receives no new rows, so there is nothing to stream.
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
 *   onContextUpdate({tokensIn, model}|null) — a plausible estimate of the
 *     tokens actually held in context as of the last completed turn (input +
 *     cache-creation + cache-read of the turn's *last individual* API call,
 *     `result.contextTokens` from the entrypoint, #509 — NOT `result.tokens`,
 *     which sums/duplicates across every internal tool-call round-trip in the
 *     turn and can wildly overcount) + the model reported by its preceding
 *     `system_init` event, fed up so the chat toolbar can render the
 *     context-window fill indicator (#471)
 *   todoCloseSignal            — bumped by the parent (AgentChat.jsx) whenever
 *     a session boundary occurs elsewhere in the UI (new message sent, Reset
 *     Session clicked, or a trigger-started run's first message arrives, see
 *     ChatPanel's `onTodoBoundary`) so the pinned To-Do panel from the
 *     *previous* session is dismissed even though no new task-list change has
 *     arrived yet (#273). Default 0 = "never fired" so mount doesn't dismiss.
 *   revealRequest              — `{ correlationId, ts }` from "Show in session
 *     log" (#2603): once loaded, scroll to that run's first row, flash all of
 *     its rows and move focus there. Pauses stick-to-bottom so a live run's
 *     new rows don't yank the view away.
 *   onRevealMissing()          — the load finished without a row of the
 *     requested run; the parent shows its "not found" notice.
 */
export default function SessionLogPanel({
  agentId, roomId, hoveredCorrelationId, onHoverCorrelation, onClose, onCostUpdate, onContextUpdate,
  todoCloseSignal = 0, embedded = false, scopeCorrelationId = null, staticOnly = false,
  revealRequest = null, onRevealMissing,
}) {
  const [events, setEvents]       = useState([]);
  const [cursor, setCursor]       = useState(0);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);

  const scrollerRef = useRef(null);
  const [atBottom, setAtBottom]   = useState(true);

  // One-time hover-correlation coachmark (#1808): the cross-panel hover tip used
  // to be a permanent caption; it now shows once per user and is dismissed with
  // "Got it", remembered across sessions in localStorage. Start "seen" so a
  // returning user never gets a flash; the effect flips it on for a newcomer.
  const { user } = useAuth();
  const username = user?.username;

  // Names the author of `message.received` rows from the same directory the
  // transcript uses (#2715). A failed/forbidden read falls back to the login
  // subject stamped on the row; memoized so LogEvent's memo keeps holding.
  const { data: directoryUsers } = useApi('/api/admin/users');
  const authorDirectory = useMemo(() => buildAuthorDirectory(directoryUsers), [directoryUsers]);
  const [coachmarkSeen, setCoachmarkSeen]           = useState(true);
  const [coachmarkDismissed, setCoachmarkDismissed] = useState(false);
  useEffect(() => {
    setCoachmarkSeen(hasSeenCoachmark(HOVER_CORRELATION_COACHMARK, username));
  }, [username]);
  const dismissCoachmark = useCallback(() => {
    markCoachmarkSeen(HOVER_CORRELATION_COACHMARK, username);
    setCoachmarkDismissed(true);
  }, [username]);

  // `scopeCorrelationId` may be a single id (a running sub-tab) or an array of
  // every run in a finished Claude session (#555). Normalise to an array (or
  // null when unscoped) so the backfill query, event filter and accent colour
  // all treat the two shapes the same.
  const scopeCids = useMemo(() => {
    if (scopeCorrelationId == null) return null;
    const arr = Array.isArray(scopeCorrelationId) ? scopeCorrelationId : [scopeCorrelationId];
    const clean = arr.filter(c => typeof c === 'string' && c);
    return clean.length ? clean : null;
  }, [scopeCorrelationId]);

  // Backfill bumps a generation counter so a slow response from the previous
  // (agent, room) can't clobber the current state.
  const reqIdRef = useRef(0);
  // Which (agent, room, scope) the last *finished* backfill was for. A reveal
  // (#2603) only judges found/missing against a settled load — right after a
  // mount `loading` is still false before the backfill effect has run.
  const loadKey = `${agentId}|${roomId}|${scopeCids ? scopeCids.join(',') : ''}`;
  const [loadedKey, setLoadedKey] = useState(null);

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

    const scopeQuery = scopeCids
      ? scopeCids.map(c => `&correlationId=${encodeURIComponent(c)}`).join('')
      : '';
    fetch(`/api/agents/${encodeURIComponent(agentId)}/session/${encodeURIComponent(roomId)}?limit=500${scopeQuery}`)
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
        if (reqId === reqIdRef.current) {
          setLoading(false);
          setLoadedKey(`${agentId}|${roomId}|${scopeCids ? scopeCids.join(',') : ''}`);
        }
      });
  }, [agentId, roomId, scopeCids]);

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

  // A finished session receives no new rows, so skip the live tail entirely
  // (#544) — one-shot backfill is enough and avoids a dangling SSE connection.
  const sseUrl = (!staticOnly && agentId && roomId && sseSince !== null)
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

  /* ─── 4. Scope to a single session + tool-pair merging ─────────────────
   * When `scopeCids` is set (merged Sessions tab, #543/#555) only the runs of
   * the viewed session are shown; internal `_truncated` markers carry no
   * correlationId, so they're kept so the truncation banner still renders.
   * `scopedEvents` also feeds the cost/context/todo aggregations below so the
   * chat toolbar reflects the viewed session rather than the whole room. */
  const scopedEvents = useMemo(() => {
    if (!scopeCids) return events;
    const set = new Set(scopeCids);
    return events.filter(ev => set.has(ev?.correlationId) || ev?.type === '_truncated');
  }, [events, scopeCids]);

  // Collapse each run's stream of thinking_tokens ticks into one live row
  // (#870) before pairing tool_use/tool_result. Runs on every recompute, so it
  // applies to live SSE appends and backfilled/legacy logs alike. Then fold the
  // incremental task-tracking events (TaskCreate/TaskUpdate/…, #1662) into a
  // running list: `annotated.rows` carry a per-row `taskSnapshot` for the
  // inline checklist/summary, and `annotated.{todos,lastToolId,…}` drive the
  // pinned TODO panel below. Tool pairing also folds each call's tool_progress
  // heartbeats and task_started row into its block (#2841); a historical view
  // has no live run left, so nothing in it keeps spinning.
  const annotated = useMemo(
    () => annotateTaskRows(mergeToolPairs(mergeThinkingTokens(scopedEvents), { ended: staticOnly })),
    [scopedEvents, staticOnly],
  );
  const renderable = annotated.rows;

  // CI-wait cards (#2841) link the PR on GitHub; a `--repo <clone-dir>` or a
  // bare PR number is resolved through the agent's repositories, read only
  // once the log actually contains an aee-wait-ci call.
  const hasCiWait = useMemo(
    () => renderable.some(r => r.kind === 'tool' && r.toolUse?.tool === 'Bash'
      && parseCiWaitCommand(r.toolUse.input?.command) !== null),
    [renderable],
  );
  const { data: repoData } = useApi(hasCiWait && agentId
    ? `/api/agents/${encodeURIComponent(agentId)}/repositories` : null);
  const repoDirectory = useMemo(() => buildRepoDirectory(repoData?.repositories), [repoData]);

  /* ─── 4b. "Show in session log" reveal (#2603) ─────────────────────────
   * A request is settled once: scroll to the run's first row (VirtualList
   * #2310 seek), then flash every row of the run via CSS and focus the target
   * row. A load without a row of the run reports back instead (AC6). */
  const [revealKey, setRevealKey]       = useState(null);
  const [highlightCid, setHighlightCid] = useState(null);
  const revealRef = useRef(null); // the request being settled, null when done
  useEffect(() => {
    revealRef.current = revealRequest && revealRequest.correlationId ? revealRequest : null;
    setRevealKey(null);
    setHighlightCid(null);
    if (revealRef.current) setAtBottom(false);
  }, [revealRequest]);
  useEffect(() => {
    const req = revealRef.current;
    if (!req) return;
    const status = revealStatus({ loading: loading || loadedKey !== loadKey, rows: renderable, correlationId: req.correlationId, keyOf: logKeyOf });
    if (status === 'pending') return;
    revealRef.current = null;
    if (status === 'found') {
      setRevealKey(firstRowKeyForCorrelation(renderable, req.correlationId, logKeyOf));
    } else if (onRevealMissing) {
      onRevealMissing();
    }
  }, [loading, loadedKey, loadKey, renderable, onRevealMissing]);
  const handleScrolledToReveal = useCallback(() => {
    const req = revealRequest;
    setRevealKey(null);
    if (!req) return;
    setHighlightCid(req.correlationId);
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const row = Array.from(scroller.querySelectorAll('[data-cid]'))
      .find(el => el.getAttribute('data-cid') === req.correlationId);
    const target = row || scroller;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }, [revealRequest]);
  useEffect(() => {
    if (!highlightCid) return undefined;
    const t = setTimeout(() => setHighlightCid(null), JUMP_HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlightCid]);

  /* ─── 5. Session cost aggregation ──────────────────────────────────── */
  const costTotals = useMemo(() => {
    let usd = 0, tokIn = 0, tokOut = 0;
    // #1718: the header info popover shows a per-class token breakdown, so keep
    // the four raw classes separate here in addition to the #494 "tokens in"
    // sum. cacheCreationInput = cache-write, cacheReadInput = cache-read.
    let input = 0, output = 0, cacheWrite = 0, cacheRead = 0;
    for (const ev of scopedEvents) {
      if (ev.type === 'result' && typeof ev.costUsd === 'number') {
        usd += ev.costUsd;
        // #494: same undercount as #490 (context-window fill) — "tokens in"
        // must include cache-creation/-read tokens, not just input_tokens.
        tokIn  += sumContextTokens(ev.tokens) ?? 0;
        tokOut += ev.tokens?.output ?? 0;
        input      += ev.tokens?.input ?? 0;
        output     += ev.tokens?.output ?? 0;
        cacheWrite += ev.tokens?.cacheCreationInput ?? 0;
        cacheRead  += ev.tokens?.cacheReadInput ?? 0;
      }
    }
    return { usd, tokIn, tokOut, breakdown: { input, output, cacheWrite, cacheRead } };
  }, [scopedEvents]);

  useEffect(() => {
    if (onCostUpdate) onCostUpdate(costTotals.usd, costTotals.tokIn, costTotals.tokOut, costTotals.breakdown);
  }, [costTotals, onCostUpdate]);

  /* ─── 5b. Last-request context-window snapshot (#471, #509) ────────────
   * Walks events in order, remembering the model from the most recent
   * `system_init` and the context tokens from the most recent `result` — the
   * `system_init` for a turn always precedes that turn's `result`, so this
   * single pass naturally pairs the two without needing correlationId
   * matching. Unlike costTotals this is NOT cumulative: it reflects only the
   * last completed request, per the issue's scope.
   *
   * #509: reads `result.contextTokens` (the entrypoint's per-call usage
   * snapshot from the turn's last internal assistant message), NOT
   * `result.tokens` (the turn-wide aggregate, still correct for costTotals
   * above) — the latter sums/duplicates across every internal tool-call
   * round-trip in the turn and can overcount by a large multiple. Falls back
   * to `result.tokens` only for log entries written before this fix (no
   * `contextTokens` field yet), so old sessions don't just go blank.
   */
  const lastContext = useMemo(() => {
    let model = null;
    let tokensIn = null;
    for (const ev of scopedEvents) {
      if (ev.type === 'system_init' && ev.model) model = ev.model;
      if (ev.type === 'result') {
        const summed = resolveContextTokensForResult(ev);
        if (summed != null) tokensIn = summed;
      }
    }
    return tokensIn == null ? null : { tokensIn, model };
  }, [scopedEvents]);

  useEffect(() => {
    if (onContextUpdate) onContextUpdate(lastContext);
  }, [lastContext, onContextUpdate]);

  /* ─── 6. Current task list for the pinned panel (#255, #1662) ───────────
   * The agent no longer emits a single `TodoWrite` snapshot; it tracks tasks
   * incrementally with `TaskCreate` / `TaskUpdate` (legacy `TodoWrite` is still
   * folded as a full-list replace). `annotateTaskRows` (above) assembles the
   * current list over the run — `annotated.todos` is the live list and
   * `annotated.lastToolId` identifies the last list-CHANGING event, which
   * drives the dismiss-until-next-change contract below. "Latest state wins":
   * the fold recomputes from `scopedEvents` on every change, so a burst of
   * updates in one batch never leaves the panel on a stale intermediate. */
  const taskTodos = annotated.todos;
  const taskLastToolId = annotated.lastToolId;

  /* User-controlled dismissal. The panel is hidden only after the user
   * clicks ×; it re-appears automatically when the next task-list change
   * arrives (i.e. once the last changing event's toolId differs from the
   * dismissed one). Switching agents/rooms drops the events array and resets
   * the marker via the agent/room-change effect below. */
  const [dismissedTodoId, setDismissedTodoId] = useState(null);
  useEffect(() => {
    setDismissedTodoId(null);
  }, [agentId, roomId]);

  // Session-boundary dismissal (#273): a new message, a session reset, or a
  // trigger-started run's first message all mean the previous session has
  // ended, so the pinned panel must close even though no new task change has
  // arrived yet. Skip the initial 0 so mounting doesn't dismiss anything.
  const firstTodoSignalRef = useRef(true);
  useEffect(() => {
    if (firstTodoSignalRef.current) {
      firstTodoSignalRef.current = false;
      return;
    }
    setDismissedTodoId(taskLastToolId || '__session_boundary__');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todoCloseSignal]);

  const todoVisible = taskTodos.length > 0 && taskLastToolId !== dismissedTodoId;

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

      {/* Discoverability coachmark for the cross-panel hover correlation:
          hovering a chat message dims the log rows it did NOT produce (and
          vice-versa). Without this hint the dimming reads like a random
          flicker. Shown ONCE per user (dismissed with "Got it", remembered
          across sessions — #1808), and only once there is activity to
          correlate. `role="status"` announces it to screen readers on appear;
          the "Got it" button is natively keyboard-focusable. */}
      {!loading && agentId && roomId && renderable.length > 0
        && !coachmarkSeen && !coachmarkDismissed && (
        <div
          role="status"
          aria-label="Tip"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--eb-space-2)',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            borderBottom: '1px solid var(--eb-border-default)',
            background: 'var(--eb-bg-surface)',
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            flexShrink: 0,
            lineHeight: 1.4,
          }}
        >
          <Info size={12} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
          <span style={{ flex: 1 }}>
            Hover a chat message to highlight the events that produced it — and hover a log entry to highlight its message.
          </span>
          <button
            type="button"
            onClick={dismissCoachmark}
            style={{
              flexShrink: 0,
              background: 'none',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-sm)',
              color: 'var(--eb-text-secondary)',
              cursor: 'pointer',
              fontSize: 'var(--eb-text-xs)',
              padding: '2px 8px',
              lineHeight: 1.4,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
          >
            Got it
          </button>
        </div>
      )}

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
        data-hover-scope="log"
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
            No agent activity yet.
          </div>
        )}

        {/* Virtualized timeline (#1685): only the visible window of tool-event
            rows is mounted, keeping the DOM bounded for a long-running session.
            The scroller above owns auto-scroll; VirtualList reads its geometry.
            Each row carries a stable data-cid for the CSS-driven cross-panel
            hover dim (#1676). */}
        <VirtualList
          items={renderable}
          scrollerRef={scrollerRef}
          keyOf={logKeyOf}
          scrollToKey={revealKey}
          onScrolledToKey={handleScrolledToReveal}
          estimateHeight={44}
          overscan={10}
          renderItem={(ev) => {
            const cid = ev.correlationId || null;
            // In single-session (scoped) mode every row is the same session, so
            // the per-correlation colour adds no information — drop the border.
            const accentColor = (!scopeCids && cid) ? colorForCorrelation(cid) : 'transparent';
            // Per-event containment (#1974): an unexpected tool-result shape
            // degrades this one row to a placeholder instead of unmounting the
            // whole console. The boundary is outermost so the hover/accent
            // wrapper cannot itself throw past it.
            return (
              <EventErrorBoundary agentId={agentId} sessionId={roomId} eventId={ev._key}>
              <div
                data-cid={cid || ''}
                onMouseEnter={() => onHoverCorrelation && onHoverCorrelation(cid)}
                onMouseLeave={() => onHoverCorrelation && onHoverCorrelation(null)}
                style={{
                  borderLeft: `2px solid ${accentColor}`,
                  marginLeft: 'var(--eb-space-1)',
                }}
              >
                <LogEvent event={ev} authorDirectory={authorDirectory} repoDirectory={repoDirectory} />
              </div>
              </EventErrorBoundary>
            );
          }}
        />
      </div>

      {todoVisible && (
        <PinnedTodoPanel
          todos={taskTodos}
          correlationId={annotated.lastCorrelationId || null}
          onClose={() => setDismissedTodoId(taskLastToolId || '__dismissed__')}
          onHoverCorrelation={onHoverCorrelation}
        />
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        ${hoverBaseCss('log')}
        ${hoverDimCss('log', hoveredCorrelationId)}
        ${jumpHighlightCss('log', highlightCid)}
      `}</style>
    </div>
  );
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

/** Stable row key for the VirtualList and the #2603 reveal seek. */
function logKeyOf(ev, i) {
  return ev._key ?? `e${i}`;
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
