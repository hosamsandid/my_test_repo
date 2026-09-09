import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Loader2, RefreshCw, RotateCcw, Gauge, Trash2 } from 'lucide-react';
import { apiCall, useApi } from '../../hooks/useApi';
import { useSSE } from '../../hooks/useSSE';
import { useAuth } from '../../auth/AuthContext';
import { useMaintenanceMode } from '../../context/MaintenanceModeContext';
import { useTranscriptionSession } from '../../context/TranscriptionSessionContext.jsx';
import ConfirmDialog from '../../components/ConfirmDialog';
import SidePanel from '../../components/SidePanel';
import Message from './Message';
import MessageInput from './MessageInput';
import ChatModelSelector from './ChatModelSelector.jsx';
import HeaderOverflowMenu from './HeaderOverflowMenu.jsx';
import { chatResetAction } from './chat-model-selector.js';
import { TriggerForm } from './TriggersPanel';
import { isLaunchedLoop } from './trigger-summary.js';
import { isAtBottom, isNearTop } from './chat-scroll.js';
import { latestLoopProgress } from './loop-run-view.js';
import { useSessionsActive } from './SessionsActiveContext';
import { hasActiveTriggerSessionForRoom } from './sessions-active';
import {
  ASK_QUESTION_FIELD, ASK_ANSWER_FIELD,
  buildAnswerContent, buildMultiAnswerContent, multiAnswerText,
  indexAskAnswers, questionState,
} from './ask-question-view.js';
import LearningBadge from '../../components/LearningBadge';
import PageHelpButton from '../../components/PageHelpButton';
import { AGENT_CHAT_HELP_SECTIONS } from './agent-chat-help-sections.js';
import VirtualList from '../../components/VirtualList.jsx';
import { EventErrorBoundary } from '../../components/ErrorBoundary.js';
import { resolveContextWindowTokens, computeContextFillLevel } from './context-window';
import { headerContextIndicator } from './session-info.js';
import SessionInfoPopover from './SessionInfoPopover.jsx';
import { maintenanceBannerText } from './maintenance-banner';
import { providerWarningText } from '../provider-health-view.js';
import { RESUME_MESSAGE } from './resume-session';
import { hoverBaseCss, hoverDimCss } from './hover-highlight.js';
import { AUTHOR_FIELD, authorStampFor, buildAuthorDirectory } from './message-author.js';
import {
  resolveInitialFontSize, loadStoredFontSize, FONT_SIZE_CHANGED_EVENT,
} from './chat-font-size.js';

// #1922: the manual "Save & Learn" button and its canned LEARN_PROMPT were
// removed. The instruction they sent is one the runtime already gives the agent
// on *every* invocation — the memory hint (`_build_memory_hint()` in
// agent-image/scripts/agent-entrypoint.py, byte-identical to `buildMemoryHint()`
// in orchestrator/prompt-assembly.js), plus `build_harvest_hint()` and the #602
// structured harvest block on the legacy memory model. That automatic hint is
// now the single source of the memory/knowledge consolidation instruction, so a
// user never has to ask for it. Reset Session took over the primary slot.

/**
 * The middle column: header + scrollable message list + input.
 *
 * Lifecycle for a given (agent, roomId):
 *   1. If `agent.dmRoomId` is null, POST `/api/matrix/agents/:id/dm` to create
 *      the room and inform the parent via `onRoomCreated`.
 *   2. With a known `roomId`, fetch the last 50 messages (`dir=b`, reverse so
 *      oldest is first) and seed `messages` state.
 *   3. Subscribe to `/api/matrix/rooms/:roomId/stream` (SSE) and append new
 *      events, deduplicating by `event_id` (backfill + first sync overlap).
 *   4. Optimistic insert: a synthetic `pending-<uuid>` message goes in on
 *      send. When `POST /messages` returns the assigned Matrix `event_id`,
 *      we stamp it onto the stub as `pendingEventId`; the SSE handler then
 *      reconciles by exact event_id. A body-only fallback covers the race
 *      where SSE delivers the canonical event before the POST response.
 *      Timestamps are intentionally not compared — browser clock and server
 *      clock can drift arbitrarily (see issue #252).
 *
 * @param {object} agent              From /api/matrix/agents
 * @param {string|null} roomId        DM room id (or null until created)
 * @param {(roomId:string)=>void} onRoomCreated  Notify parent when we POST to /dm
 * @param {string|null} hoveredCorrelationId      Cross-panel hover state from parent
 * @param {(id:string|null)=>void} onHoverCorrelation
 * @param {()=>void} [onWorkspaceChanged]  Notify parent after a chat upload lands
 *        in the workspace, so the Workspace tab can refresh its tree.
 * @param {()=>void} [onTodoBoundary]  Notify parent (AgentChat.jsx) that a
 *        session boundary just occurred — sending a message, resetting the
 *        session, or a trigger-started run's first message arriving — so the
 *        pinned To-Do panel from a previous session gets dismissed (#273).
 * @param {()=>void} [onOpenKnowledge] Open the right rail on its Knowledge tab
 *        (wired to the "N learned" badge in the header).
 * @param {?{ref:string, ts:number}} [insertRefRequest] Cross-panel request to
 *        splice a `@<ref>` file reference into the composer draft, forwarded
 *        straight to MessageInput (#1699 — the workspace browser's "Reference in
 *        chat" button).
 */
export default function ChatPanel({
  agent, roomId, onRoomCreated, hoveredCorrelationId, onHoverCorrelation, sessionCost, contextFill,
  onWorkspaceChanged, onTodoBoundary, onOpenKnowledge, resumeRequest,
  insertRefRequest,
}) {
  const [messages, setMessages]      = useState([]);
  const [loading, setLoading]        = useState(false);
  const [error, setError]            = useState(null);
  const [creating, setCreating]      = useState(false);
  const [sending, setSending]        = useState(false);
  const [uploading, setUploading]    = useState(false);

  // Backfill (scroll-up) state. `endToken` is the Matrix `end` field from
  // `dir=b` /messages, which marks the older boundary — pass it back as
  // `from=` to fetch the next-older chunk. `null` → no further history.
  const [endToken, setEndToken] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderExhausted, setOlderExhausted] = useState(false);

  // Stick-to-bottom: only auto-scroll when the user is within 100 px of the
  // bottom; otherwise show a "↓ N new messages" pill.
  const scrollerRef     = useRef(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread]     = useState(0);

  // Active Claude `--resume <sessionId>` pointer for this (agent, room).
  // The pointer file is written by the runner after every successful
  // invocation and read back here so the UI can gate the reset
  // control on whether a resumable session exists.
  const [sessionId, setSessionId]     = useState(null);
  const [sessionUpdatedAt, setSessionUpdatedAt] = useState(null);
  const [resetting, setResetting]     = useState(false);
  const [resuming, setResuming]       = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Chat-launched loops (#1020): a loop is started from the composer, runs as
  // a launched run visible here, and can be stopped. `activeLoop` is the
  // running launched-loop trigger (or null); we poll the agent's triggers to
  // reflect its lifecycle (it self-removes on any terminal outcome).
  const [loopDialogOpen, setLoopDialogOpen] = useState(false);
  const [activeLoop, setActiveLoop] = useState(null);
  // Re-launch pre-fill (#1231): when a finished-loop record's "Start again"
  // button is pressed, seed the launcher with that loop's settings. null = a
  // blank launcher (the composer "+" path). A fresh loop is created on submit
  // (the record's trigger id is never carried), so the original record stays
  // unchanged.
  const [relaunchValues, setRelaunchValues] = useState(null);
  // Live progress of the running loop (#1155): `{ iteration, maxIterations }`
  // or null (neutral running state), derived from the numbered `trigger.fired`
  // session-log rows at the same cadence as the trigger poll.
  const [loopProgress, setLoopProgress] = useState(null);
  const [loopBusy, setLoopBusy] = useState(false);
  const [showStopLoopConfirm, setShowStopLoopConfirm] = useState(false);
  // A chat-turn stop request is in flight (#1427). Distinct from `loopBusy`
  // (loop lifecycle) so the unified Stop button reflects either abort path.
  const [stopping, setStopping] = useState(false);

  // Per-agent model selection. `modelOptions` is the resolved snapshot from
  // /api/agents/:id/model-options: which endpoint the agent is bound to,
  // what catalog it offers, the env-level default, and the per-agent
  // override. `modelSwitching` blocks rapid double-clicks during the PATCH.
  const [modelOptions, setModelOptions] = useState(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  // Provider (LLM endpoint) switching lives in the same `modelOptions` snapshot
  // (`endpoints` = curated set, `endpointOverride`, `canSwitch`). Switching the
  // provider requires an agent respawn, so it blocks briefly.
  const [providerSwitching, setProviderSwitching] = useState(false);
  // Context-window fill for the last completed request (#471, cache-tokens
  // fix #490, overcounting fix #509). `contextFill` (from the parent, fed by
  // SessionLogPanel) carries a plausible estimate of the tokens actually held
  // in context — input + cache-creation + cache-read of the turn's *last
  // individual* API call (`result.contextTokens`, #509), since a `--resume`d
  // session runs on prompt caching and most of its held context lives in the
  // cache fields, not `input`, and a turn's own `result.tokens` aggregate
  // sums/duplicates across every internal tool-call round-trip rather than
  // reflecting a single context snapshot — plus the model actually used.
  // Resolve that model's window size against the agent's catalog (falling
  // back to the known-Claude-family table) and derive the warning level from
  // the (corrected) ratio; the toolbar renders it as a rounded
  // "<used>K / <limit>K" token count rather than a percentage. Hidden
  // entirely when the window size can't be determined (AC 7) rather than
  // showing a misleading value.
  const contextWindowTokens = useMemo(() => {
    if (!contextFill?.model) return null;
    const modelEntry = (modelOptions?.models || []).find(m => m.id === contextFill.model);
    return resolveContextWindowTokens(modelEntry || { id: contextFill.model });
  }, [contextFill, modelOptions]);
  const contextFillLevel = useMemo(() => {
    if (!contextFill || contextWindowTokens == null) return null;
    return computeContextFillLevel(contextFill.tokensIn, contextWindowTokens);
  }, [contextFill, contextWindowTokens]);
  // #1718: the compact header context-usage indicator model — "used / window · %"
  // when the window is known, else the used count alone (consistent with #1717).
  const contextIndicator = useMemo(
    () => (contextFill ? headerContextIndicator(contextFill.tokensIn, contextWindowTokens, contextFillLevel) : null),
    [contextFill, contextWindowTokens, contextFillLevel],
  );
  // #1718: the currently *selected* (effective) model — its context window and,
  // when discovery captured it, its max-output tokens — drives the info popover's
  // Model section. Distinct from contextFill.model (the last completed run's).
  const selectedModelInfo = useMemo(() => {
    const modelId = (modelOptions?.override) || (modelOptions?.defaultModelId) || null;
    const entry = modelId ? (modelOptions?.models || []).find(m => m.id === modelId) : null;
    const windowTokens = entry ? resolveContextWindowTokens(entry) : (modelId ? resolveContextWindowTokens({ id: modelId }) : null);
    const maxOutput = typeof entry?.maxOutputTokens === 'number' && entry.maxOutputTokens > 0 ? entry.maxOutputTokens : null;
    return { windowTokens, maxOutput };
  }, [modelOptions]);
  // Git repos info for the agent workspace (branch + dirty status).
  const [gitInfo, setGitInfo] = useState(null);

  // Active-sessions context (#1678, extended in #1852): the one shared poll of
  // /api/agents/:id/sessions/active (polled at 3 s by SessionsActiveContext in
  // AgentChat.jsx) is now also available to ChatPanel so it can derive whether
  // a trigger-initiated run is currently active for this room. Returns a safe
  // inert default (empty sessions, no-op refresh) when not inside the provider.
  const { sessions: activeSessions } = useSessionsActive();

  // Per-user transcript font size (#1437, control moved to Settings → Display in #1806).
  // Seeded from the user's server-stored preference with a per-username localStorage
  // fallback for the env single-admin. Live changes arrive via the FONT_SIZE_CHANGED_EVENT
  // dispatched by SettingsModal's Display section.
  const { user } = useAuth();
  const username = user?.username;
  const hasServerRecord = user != null && user.userId != null;

  /* ─── Human-message attribution (#2065) ──────────────────────────────
   * `viewer` decides which side a bubble sits on ("is this mine?"), the
   * directory resolves the author's *current* display name for the badge
   * ("who wrote this?"). Both are memoized to stable values so a bubble's
   * props do not change on an unrelated re-render and `React.memo` on
   * `Message` keeps holding (AC20) — and the directory is fetched once per
   * transcript, never per row.
   */
  const viewer = useMemo(
    () => ({ userId: user?.userId ?? null, username: username ?? null }),
    [user?.userId, username],
  );
  // A failed/forbidden directory read is not an error worth showing: the badge
  // then falls back to the login subject stamped on the message itself.
  const { data: directoryUsers } = useApi('/api/admin/users');
  const authorDirectory = useMemo(() => buildAuthorDirectory(directoryUsers), [directoryUsers]);
  const [fontSize, setFontSize] = useState(() => resolveInitialFontSize({
    sessionValue: user?.chatFontSize,
    storedValue: loadStoredFontSize(username),
    hasServerRecord,
  }));
  // Re-seed only when the logged-in identity changes (login / logout / initial
  // session load) — keyed on the stable username.
  useEffect(() => {
    setFontSize(resolveInitialFontSize({
      sessionValue: user?.chatFontSize,
      storedValue: loadStoredFontSize(username),
      hasServerRecord,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);
  // Pick up live font-size changes dispatched by SettingsModal → Display section.
  useEffect(() => {
    const handler = (e) => setFontSize(e.detail.size);
    window.addEventListener(FONT_SIZE_CHANGED_EVENT, handler);
    return () => window.removeEventListener(FONT_SIZE_CHANGED_EVENT, handler);
  }, []);

  /* ─── 1. Lazy DM-room creation ───────────────────────────────────── */
  useEffect(() => {
    if (!agent || roomId) return;
    if (agent.enabled === false) return;
    let cancelled = false;
    setCreating(true);
    setError(null);
    apiCall('POST', `/api/matrix/agents/${agent.id}/dm`)
      .then(resp => {
        if (cancelled) return;
        if (resp?.roomId) onRoomCreated(resp.roomId);
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setCreating(false); });
    return () => { cancelled = true; };
  }, [agent, roomId, onRoomCreated]);

  /* ─── 1b. Git info polling ──────────────────────────────────────── */
  useEffect(() => {
    if (!agent?.id) return;
    let cancelled = false;
    const loadGitInfo = () => {
      apiCall('GET', `/api/agents/${agent.id}/git-info`)
        .then(data => { if (!cancelled) setGitInfo(data?.repos ?? []); })
        .catch(() => { if (!cancelled) setGitInfo([]); });
    };
    loadGitInfo();
    const timer = setInterval(loadGitInfo, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [agent?.id]);

  /* ─── 2. Backfill on roomId change ──────────────────────────────── */
  useEffect(() => {
    setMessages([]);
    setUnread(0);
    setEndToken(null);
    setOlderExhausted(false);
    // Switching into a chat must land at the newest message regardless of where
    // the previously-open chat was scrolled (#1710, AC2) — re-arm stick-to-
    // bottom so the freshly loaded history pins to the bottom.
    setAtBottom(true);
    if (!roomId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/matrix/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (cancelled) return;
        const chunk = Array.isArray(data?.chunk) ? data.chunk : [];
        // dir=b returns newest-first — reverse for chronological display.
        // Exclude redacted events (unsigned.redacted_because present) to avoid
        // empty bubbles after a Clear History operation.
        const seed = chunk
          .filter(ev => ev.type === 'm.room.message' && !ev.unsigned?.redacted_because)
          .reverse()
          .map(ev => ({
            event_id: ev.event_id,
            sender:   ev.sender,
            ts:       ev.origin_server_ts,
            body:     ev.content?.body || '',
            msgtype:  ev.content?.msgtype || 'm.text',
            'io.aee.trigger':  ev.content?.['io.aee.trigger'] || null,
            'io.aee.loop-record':  ev.content?.['io.aee.loop-record'] || null,
            [ASK_QUESTION_FIELD]:  ev.content?.[ASK_QUESTION_FIELD] || null,
            [ASK_ANSWER_FIELD]:    ev.content?.[ASK_ANSWER_FIELD] || null,
            [AUTHOR_FIELD]:        ev.content?.[AUTHOR_FIELD] || null,
          }));
        setMessages(seed);
        // `end` (in dir=b) is the older boundary — use it as `from=` for the
        // next chunk on scroll-up. If absent or chunk was empty, mark
        // "nothing more to load".
        const nextFrom = typeof data?.end === 'string' ? data.end : null;
        if (!nextFrom || chunk.length === 0) {
          setOlderExhausted(true);
          setEndToken(null);
        } else {
          setEndToken(nextFrom);
        }
      })
      .catch(e => { if (!cancelled) setError(`History load failed: ${e.message}`); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [roomId]);

  /* ─── 2b. Scroll-up backfill ─────────────────────────────────────── */
  const loadOlder = useCallback(async () => {
    if (!roomId || !endToken || loadingOlder || olderExhausted) return;
    const el = scrollerRef.current;
    if (!el) return;
    setLoadingOlder(true);
    // Snapshot scroll geometry so we can restore the visual position after
    // the prepend (otherwise the viewport jumps to the top).
    const prevScrollHeight = el.scrollHeight;
    const prevScrollTop    = el.scrollTop;
    try {
      const url = `/api/matrix/rooms/${encodeURIComponent(roomId)}/messages`
                + `?dir=b&limit=50&from=${encodeURIComponent(endToken)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const chunk = Array.isArray(data?.chunk) ? data.chunk : [];
      const older = chunk
        .filter(ev => ev.type === 'm.room.message' && !ev.unsigned?.redacted_because)
        .reverse()
        .map(ev => ({
          event_id: ev.event_id,
          sender:   ev.sender,
          ts:       ev.origin_server_ts,
          body:     ev.content?.body || '',
          msgtype:  ev.content?.msgtype || 'm.text',
          'io.aee.trigger':  ev.content?.['io.aee.trigger'] || null,
          'io.aee.loop-record':  ev.content?.['io.aee.loop-record'] || null,
          [ASK_QUESTION_FIELD]:  ev.content?.[ASK_QUESTION_FIELD] || null,
          [ASK_ANSWER_FIELD]:    ev.content?.[ASK_ANSWER_FIELD] || null,
          [AUTHOR_FIELD]:        ev.content?.[AUTHOR_FIELD] || null,
        }));

      const nextFrom = typeof data?.end === 'string' ? data.end : null;
      if (!nextFrom || chunk.length === 0 || older.length === 0) {
        setOlderExhausted(true);
        setEndToken(null);
      } else {
        setEndToken(nextFrom);
      }

      if (older.length === 0) return;

      setMessages(prev => {
        const seen = new Set(prev.map(m => m.event_id));
        const fresh = older.filter(m => !seen.has(m.event_id));
        if (fresh.length === 0) return prev;
        return [...fresh, ...prev];
      });

      // Restore scroll position on the next paint, after the layout has
      // accounted for the prepended messages.
      requestAnimationFrame(() => {
        const node = scrollerRef.current;
        if (!node) return;
        const newScrollHeight = node.scrollHeight;
        node.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;
      });
    } catch (e) {
      setError(`Loading older messages failed: ${e.message}`);
    } finally {
      setLoadingOlder(false);
    }
  }, [roomId, endToken, loadingOlder, olderExhausted]);

  /* ─── 3. Live stream ─────────────────────────────────────────────── */
  const handleEvent = useCallback((ev) => {
    if (!ev?.event_id) return;
    const triggerMeta = ev.content?.['io.aee.trigger'] || null;
    const incoming = {
      event_id: ev.event_id,
      sender:   ev.sender,
      ts:       ev.origin_server_ts,
      body:     ev.content?.body || '',
      msgtype:  ev.content?.msgtype || 'm.text',
      'io.aee.trigger':  triggerMeta,
      'io.aee.loop-record':  ev.content?.['io.aee.loop-record'] || null,
      [ASK_QUESTION_FIELD]:  ev.content?.[ASK_QUESTION_FIELD] || null,
      [ASK_ANSWER_FIELD]:    ev.content?.[ASK_ANSWER_FIELD] || null,
      [AUTHOR_FIELD]:        ev.content?.[AUTHOR_FIELD] || null,
    };

    // A trigger-started run always posts this notice before invoking Claude
    // (agent-entrypoint.py's `_post_trigger_notice`), so its arrival is the
    // earliest observable signal that a new, unrelated session has begun in
    // this room — close any stale To-Do window from the previous run (#273).
    if (triggerMeta) onTodoBoundary?.();

    setMessages(prev => {
      // Already have the canonical event — skip.
      if (prev.some(m => m.event_id === incoming.event_id)) return prev;

      // Reconcile with an optimistic stub. Primary key: `pendingEventId`,
      // stamped onto the stub by handleSend once `POST /messages` returns
      // the assigned Matrix event_id. Fallback: body-only match against a
      // stub that hasn't received its event_id yet — covers the race where
      // SSE delivers the canonical event before the POST response. We do
      // NOT compare timestamps: the optimistic ts is browser `Date.now()`,
      // the canonical ts is `origin_server_ts`, and the two clocks can drift
      // arbitrarily (issue #252).
      let idx = prev.findIndex(m => m.isOptimistic && m.pendingEventId === incoming.event_id);
      if (idx < 0) {
        idx = prev.findIndex(m =>
          m.isOptimistic && !m.pendingEventId && m.body === incoming.body
        );
      }
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = incoming;
        return next;
      }
      return [...prev, incoming];
    });
  }, [onTodoBoundary]);

  const sseUrl = roomId ? `/api/matrix/rooms/${encodeURIComponent(roomId)}/stream` : null;
  useSSE(sseUrl, {
    onEvent: handleEvent,
    enabled: !!roomId,
  });

  /* ─── 4. Auto-scroll behaviour ───────────────────────────────────── */
  // The actual "pin to the bottom" is owned by VirtualList via `stickToBottom`
  // (below): with the transcript windowed, off-screen rows are estimated, so a
  // one-shot `scrollTop = scrollHeight` here would land short of the real bottom
  // (#1710). This effect only maintains the unread counter on a new message —
  // reset it while pinned, bump it while the user is reading older history.
  useEffect(() => {
    if (atBottom) {
      setUnread(0);
    } else {
      // Count of messages the user hasn't scrolled to yet.
      setUnread(u => u + 1);
    }
    // We only care about the messages-length change here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  function handleScroll(e) {
    const el = e.currentTarget;
    const atBottomNow = isAtBottom(el);
    setAtBottom(atBottomNow);
    if (atBottomNow) setUnread(0);

    // Top-edge backfill: when the user scrolls within 100 px of the top and
    // we still have an `endToken`, fetch the next-older 50 messages.
    if (isNearTop(el) && endToken && !loadingOlder && !olderExhausted) {
      loadOlder();
    }
  }

  function scrollToBottom() {
    const el = scrollerRef.current;
    if (!el) return;
    // Immediate nudge to the estimated bottom; re-arming stick-to-bottom lets
    // VirtualList converge on the true bottom as the off-screen rows settle.
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    setUnread(0);
  }

  /**
   * Retry handler for the error banner: clears the error and triggers a
   * full reload of the current room's history. We do this by toggling a
   * counter that the backfill effect doesn't depend on directly — instead
   * we call the same pattern (set state to null then to roomId again is
   * impossible since `roomId` is a prop), so we just re-fetch inline.
   */
  const retryAll = useCallback(() => {
    setError(null);
    if (!roomId) return;
    setMessages([]);
    setEndToken(null);
    setOlderExhausted(false);
    setLoading(true);
    fetch(`/api/matrix/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        const chunk = Array.isArray(data?.chunk) ? data.chunk : [];
        const seed = chunk
          .filter(ev => ev.type === 'm.room.message')
          .reverse()
          .map(ev => ({
            event_id: ev.event_id,
            sender:   ev.sender,
            ts:       ev.origin_server_ts,
            body:     ev.content?.body || '',
            msgtype:  ev.content?.msgtype || 'm.text',
            'io.aee.trigger':  ev.content?.['io.aee.trigger'] || null,
            'io.aee.loop-record':  ev.content?.['io.aee.loop-record'] || null,
            [ASK_QUESTION_FIELD]:  ev.content?.[ASK_QUESTION_FIELD] || null,
            [ASK_ANSWER_FIELD]:    ev.content?.[ASK_ANSWER_FIELD] || null,
            [AUTHOR_FIELD]:        ev.content?.[AUTHOR_FIELD] || null,
          }));
        setMessages(seed);
        const nextFrom = typeof data?.end === 'string' ? data.end : null;
        if (!nextFrom || chunk.length === 0) {
          setOlderExhausted(true);
          setEndToken(null);
        } else {
          setEndToken(nextFrom);
        }
      })
      .catch(e => setError(`History load failed: ${e.message}`))
      .finally(() => setLoading(false));
  }, [roomId]);

  /* ─── 4b. Session pointer (Claude --resume id) ───────────────────── */
  const sessionApiBase = roomId && agent?.id
    ? `/api/agents/${encodeURIComponent(agent.id)}/session/${encodeURIComponent(roomId)}/current`
    : null;

  const fetchSession = useCallback(async () => {
    if (!sessionApiBase) {
      setSessionId(null);
      setSessionUpdatedAt(null);
      return;
    }
    try {
      const r = await fetch(sessionApiBase);
      if (!r.ok) return; // best-effort; leave stale state alone
      const j = await r.json();
      setSessionId(j?.sessionId || null);
      setSessionUpdatedAt(j?.updatedAt || null);
      // If the backend still has a pending reset flag, inject the separator so
      // it stays visible even after navigating away and coming back.
      if (j?.resetAt) {
        setMessages(prev => {
          if (prev.some(m => m.type === 'context-reset')) return prev;
          return [...prev, {
            event_id: `reset-${j.resetAt}`,
            type: 'context-reset',
            ts: new Date(j.resetAt).getTime(),
          }];
        });
      }
    } catch {
      // Network blip — the next refetch will fix it.
    }
  }, [sessionApiBase]);

  // Refetch on roomId change.
  useEffect(() => { fetchSession(); }, [fetchSession]);

  // Refetch shortly after each new agent message — the runner writes the
  // pointer at the end of the Claude run, which lands just before/around
  // the Matrix reply. A small delay gives the FS write time to land.
  useEffect(() => {
    if (!messages.length || !agent?.userId) return;
    const last = messages[messages.length - 1];
    if (last?.sender !== agent.userId) return;
    if (last?.isOptimistic) return;
    const t = setTimeout(fetchSession, 600);
    return () => clearTimeout(t);
  }, [messages, agent?.userId, fetchSession]);

  async function handleResetSession() {
    if (!sessionApiBase || resetting) return;
    onTodoBoundary?.();
    setResetting(true);
    setError(null);
    try {
      await apiCall('DELETE', sessionApiBase);
      setSessionId(null);
      setSessionUpdatedAt(null);
      setMessages(prev => [...prev, {
        event_id: `reset-${crypto.randomUUID()}`,
        type: 'context-reset',
        ts: Date.now(),
      }]);
    } catch (err) {
      setError(`Reset failed: ${err.message}`);
    } finally {
      setResetting(false);
    }
  }

  // Resume a finished session (#574): re-point the room at the chosen Claude
  // session-ID (PUT the pointer with `resumeRequested`), then send the fixed
  // predefined message down the normal DM path so the agent runs with --resume
  // and the message is visible in history (AC2/AC3/AC5). The message-send is
  // what makes the resumed session show as active (AC4). The `resuming` guard
  // + ts dedup below stop rapid double-activation from spawning duplicate runs.
  const handleResumeSession = useCallback(async (resumeSessionId) => {
    if (!sessionApiBase || !resumeSessionId || resuming) return;
    onTodoBoundary?.();
    setResuming(true);
    setError(null);
    try {
      await apiCall('POST', sessionApiBase, { sessionId: resumeSessionId });
      // Optimistically reflect the re-pointed session so the badge updates
      // without waiting for the post-run refetch.
      setSessionId(resumeSessionId);
      setSessionUpdatedAt(new Date().toISOString());
      await handleSend(RESUME_MESSAGE);
    } catch (err) {
      setError(`Resume failed: ${err.message}`);
    } finally {
      setResuming(false);
    }
  }, [sessionApiBase, resuming, onTodoBoundary]);

  // Fire when the parent (AgentChat) signals a resume from the Sessions tab.
  // `ts` disambiguates repeat activations; the ref guards against re-firing on
  // unrelated re-renders.
  const lastResumeTsRef = useRef(0);
  useEffect(() => {
    if (!resumeRequest || !resumeRequest.ts) return;
    if (resumeRequest.ts === lastResumeTsRef.current) return;
    lastResumeTsRef.current = resumeRequest.ts;
    handleResumeSession(resumeRequest.sessionId);
  }, [resumeRequest, handleResumeSession]);

  async function handleClearHistory() {
    if (!roomId || clearingHistory) return;
    setClearingHistory(true);
    setError(null);
    try {
      await apiCall('DELETE', `/api/matrix/rooms/${encodeURIComponent(roomId)}/messages`);
      setMessages([]);
      setEndToken(null);
      setOlderExhausted(true);
    } catch (err) {
      setError(`Clear history failed: ${err.message}`);
    } finally {
      setClearingHistory(false);
    }
  }

  /* ─── Model picker ───────────────────────────────────────────────── */
  // Fetch the resolved model options whenever the agent changes. Re-runs
  // also after the user picks a different model (handler below) so the UI
  // stays in sync with the persisted config.
  useEffect(() => {
    if (!agent?.id) { setModelOptions(null); return; }
    let cancelled = false;
    apiCall('GET', `/api/agents/${encodeURIComponent(agent.id)}/model-options`)
      .then(data => { if (!cancelled) setModelOptions(data); })
      .catch(() => { if (!cancelled) setModelOptions(null); });
    return () => { cancelled = true; };
  }, [agent?.id]);

  // On-demand refresh of the resolved model options (#1305). The provider
  // catalog / team assignment can change elsewhere in the app while this chat
  // stays open; the switcher calls this when its popover opens so a newly
  // added / (un)assigned provider appears without a full page reload. Unlike
  // the agent-change effect above, a transient failure keeps the last good
  // snapshot rather than blanking the chip.
  const refreshModelOptions = useCallback(async () => {
    if (!agent?.id) return;
    try {
      const data = await apiCall('GET', `/api/agents/${encodeURIComponent(agent.id)}/model-options`);
      setModelOptions(data);
    } catch {
      /* keep the current snapshot on a transient error */
    }
  }, [agent?.id]);

  // Switch the agent's model within the current provider (live, no respawn).
  // A null id clears the per-agent override → back to the environment default.
  async function handleModelChange(newId) {
    if (!agent?.id || modelSwitching) return;
    setModelSwitching(true);
    setError(null);
    try {
      const payload = { modelId: newId ? newId : null };
      const resp = await apiCall('PATCH', `/api/agents/${encodeURIComponent(agent.id)}/model`, payload);
      setModelOptions(prev => prev ? { ...prev, override: resp.override } : prev);
    } catch (err) {
      setError(`Model switch failed: ${err.message}`);
    } finally {
      setModelSwitching(false);
    }
  }

  // Switch the agent's provider (respawns the container). A null endpointId means
  // "back to the environment default". Because the shared popover lets the user
  // pick a specific model under the new provider group, an optional non-default
  // modelId is applied with a follow-up model PATCH once the provider is set
  // (PATCH /provider itself only sets the endpoint and prunes an incompatible
  // model pin). Either way we refetch the full snapshot — the provider change
  // clears the old override and swaps the whole catalogue.
  async function handleProviderSwitch(newEndpointId, modelId) {
    if (!agent?.id || providerSwitching) return;
    setProviderSwitching(true);
    setError(null);
    try {
      await apiCall('PATCH', `/api/agents/${encodeURIComponent(agent.id)}/provider`, { endpointId: newEndpointId ? newEndpointId : null });
      if (modelId) {
        await apiCall('PATCH', `/api/agents/${encodeURIComponent(agent.id)}/model`, { modelId });
      }
      const fresh = await apiCall('GET', `/api/agents/${encodeURIComponent(agent.id)}/model-options`);
      setModelOptions(fresh);
    } catch (err) {
      setError(`Provider switch failed: ${err.message}`);
    } finally {
      setProviderSwitching(false);
    }
  }

  // Reset to the environment default: clear a provider override through the
  // provider endpoint (respawns, also prunes the model pin) or a lone model
  // override through the model endpoint (live). Decided by chatResetAction.
  async function handleModelReset() {
    if (!agent?.id) return;
    const act = chatResetAction(modelOptions);
    if (act.kind === 'provider') await handleProviderSwitch(null, null);
    else if (act.kind === 'model') await handleModelChange(null);
  }

  /* ─── 5. Send ────────────────────────────────────────────────────── */
  /* ─── Loop launch (#1020) ────────────────────────────────────────────
   * A loop is launched from the composer, runs as a launched run visible
   * here, and self-removes on any terminal outcome. Poll the agent's triggers
   * so the composer reflects whether a launched loop is currently running —
   * at most one per agent (the control then offers Stop instead of Start).
   */
  const refreshActiveLoop = useCallback(async () => {
    if (!agent?.id) { setActiveLoop(null); setLoopProgress(null); return; }
    try {
      const list = await apiCall('GET', `/api/agents/${encodeURIComponent(agent.id)}/triggers`);
      const running = Array.isArray(list) ? list.find(isLaunchedLoop) : null;
      setActiveLoop(running || null);
      // Live progress (#1155 AC5/AC6): read the tail of THIS room's session log
      // and take the newest numbered loop firing for the running trigger. The
      // log is persisted per room, so this is correct after a reload and for
      // whichever agent's loop is running. No numbered firing yet ⇒ null
      // (neutral running state, never a fabricated count).
      if (running && roomId) {
        try {
          const res = await apiCall('GET',
            `/api/agents/${encodeURIComponent(agent.id)}/session/${encodeURIComponent(roomId)}?limit=120`);
          const evts = Array.isArray(res?.events) ? res.events : [];
          setLoopProgress(latestLoopProgress(evts, running.id));
        } catch {
          /* keep the last known progress on a transient read error */
        }
      } else {
        setLoopProgress(null);
      }
    } catch {
      /* best-effort — a transient error just keeps the last known state */
    }
  }, [agent?.id, roomId]);

  useEffect(() => {
    if (!agent?.id) return undefined;
    refreshActiveLoop();
    const timer = setInterval(refreshActiveLoop, 15000);
    return () => clearInterval(timer);
  }, [agent?.id, refreshActiveLoop]);

  function handleLoopClick() {
    if (activeLoop) setShowStopLoopConfirm(true);
    else { setRelaunchValues(null); setLoopDialogOpen(true); }
  }

  // "Start again" on a finished-loop record (#1231): open the loop launcher
  // pre-filled with that loop's config. Does NOT start the loop — the user
  // confirms/edits in the dialog, exactly like a fresh launch. If a loop is
  // already running the launcher can't open (the composer control is in Stop
  // mode), so surface that rather than silently doing nothing.
  // Stable identity (#1676) so the memoized transcript rows don't re-render
  // when this component re-renders for an unrelated reason (e.g. a hover).
  const handleRelaunchLoop = useCallback((values) => {
    if (activeLoop) {
      setError('A loop is already running for this agent — stop it before starting another.');
      return;
    }
    setRelaunchValues(values || null);
    setLoopDialogOpen(true);
  }, [activeLoop]);

  function closeLoopDialog() {
    setLoopDialogOpen(false);
    setRelaunchValues(null);
  }

  async function handleLaunchLoop(body) {
    if (!agent?.id) return;
    setLoopBusy(true);
    setError(null);
    try {
      // A chat-launched loop is a loop trigger tagged `launched: true`; the
      // runtime runs it once and removes it on completion. Post the room id so
      // the terminal outcome DM lands in this chat.
      await apiCall('POST', `/api/agents/${encodeURIComponent(agent.id)}/triggers`, {
        ...body,
        launched: true,
        enabled: true,
        ...(roomId ? { roomId } : {}),
      });
      closeLoopDialog();
      await refreshActiveLoop();
    } catch (err) {
      setError(`Could not start loop: ${err.message}`);
    } finally {
      setLoopBusy(false);
    }
  }

  async function handleStopLoop() {
    setShowStopLoopConfirm(false);
    if (!agent?.id || !activeLoop) return;
    setLoopBusy(true);
    setError(null);
    try {
      // Deleting the trigger cancels the loop's re-arm cycle (the runtime
      // cancels the runner on the next sync); stopping the session kills the
      // in-flight iteration immediately. Both best-effort.
      await apiCall('DELETE', `/api/agents/${encodeURIComponent(agent.id)}/triggers/${encodeURIComponent(activeLoop.id)}`);
      if (roomId) {
        try {
          await apiCall('POST', `/api/agents/${encodeURIComponent(agent.id)}/session/${encodeURIComponent(roomId)}/stop`);
        } catch { /* the loop is already stopping — ignore */ }
      }
    } catch (err) {
      setError(`Stop loop failed: ${err.message}`);
    } finally {
      setLoopBusy(false);
      await refreshActiveLoop();
    }
  }

  // Unified composer Stop (#1427): abort whatever is running for this agent.
  // A running loop is the more consequential state (repeated autonomous runs),
  // so it keeps its confirmation dialog; a single chat turn stops immediately,
  // matching the instant Stop of VS Code / Cursor / the Claude Code CLI.
  function handleStop() {
    if (activeLoop) { setShowStopLoopConfirm(true); return; }
    handleStopTurn();
  }

  // Stop the in-flight chat turn by reusing the existing session-stop path
  // (SIGUSR1 → terminate the Claude process — same endpoint the Sessions tab
  // uses). Optimistically end the local thinking state and drop a distinct
  // "Stopped by user" marker into the transcript (AC4); the runtime also posts
  // its own abort notice, which arrives over SSE.
  async function handleStopTurn() {
    if (!agent?.id || !roomId) return;
    setStopping(true);
    setError(null);
    try {
      await apiCall('POST', `/api/agents/${encodeURIComponent(agent.id)}/session/${encodeURIComponent(roomId)}/stop`);
      setSending(false);
      setMessages(prev => [...prev, {
        event_id: `user-stop-${crypto.randomUUID()}`,
        type: 'user-stop',
        ts: Date.now(),
      }]);
    } catch (err) {
      setError(`Stop failed: ${err.message}`);
    } finally {
      setStopping(false);
    }
  }

  async function handleSend(text, extraContent = null) {
    if (!roomId) return;
    const body = text.trim();
    if (!body) return;
    onTodoBoundary?.();
    const optimisticId = `pending-${crypto.randomUUID()}`;
    const ts = Date.now();
    // We don't know the admin user id yet, so use a sentinel that won't match
    // the agent's user id. Message bubble only checks `sender !== agent.userId`.
    const optimistic = {
      event_id:    optimisticId,
      sender:      '@me:local-optimistic',
      ts,
      body,
      isOptimistic: true,
      // Carry any structured payload (e.g. the quick-reply `io.aee.ask-answer`,
      // #1663) onto the optimistic stub so the answered-question state reflects
      // immediately, before the canonical event round-trips.
      ...(extraContent && typeof extraContent === 'object' ? extraContent : {}),
      // Mirror the author stamp the server will apply (#2065), so the bubble
      // keeps the same side and the same badge across the transition from stub
      // to confirmed event — no jump, no flicker, no label change (AC18). The
      // authoritative stamp is always the server's; this one never leaves the
      // browser (the send payload carries only `body`/`extraContent`).
      [AUTHOR_FIELD]: authorStampFor(viewer),
    };
    setMessages(prev => [...prev, optimistic]);
    setSending(true);
    setError(null);
    try {
      const payload = { body };
      if (extraContent && typeof extraContent === 'object') payload.extraContent = extraContent;
      const resp = await apiCall('POST', `/api/matrix/rooms/${encodeURIComponent(roomId)}/messages`, payload);
      // Stamp the assigned Matrix event_id onto the optimistic stub so the
      // SSE handler can reconcile by exact id rather than a fuzzy body
      // match. If SSE already delivered the canonical event (stream faster
      // than the HTTP response), the stub is already gone — nothing to do.
      const eventId = resp?.event_id;
      if (eventId) {
        setMessages(prev => {
          if (prev.some(m => m.event_id === eventId)) return prev;
          return prev.map(m =>
            m.event_id === optimisticId ? { ...m, pendingEventId: eventId } : m
          );
        });
      }
    } catch (err) {
      setError(`Send failed: ${err.message}`);
      // Roll back the optimistic message so the user can retry.
      setMessages(prev => prev.filter(m => m.event_id !== optimisticId));
    } finally {
      setSending(false);
    }
  }

  /* ─── 5a′. Quick-reply answer (#1663, #1799) ─────────────────────────
   * Single-question (D1): clicking an option sends its label as the user's
   * reply (unchanged, AC1).
   *
   * Multi-question (#1799 AC4): the card collects intermediate choices
   * client-side (no message sent) and calls back here only after the last
   * question with { isMulti: true, answers: [{questionId,optionId,label}…] }.
   * We then send one consolidated reply and resume the session.
   *
   * Selection is final in both cases (AC5/AC6): the optimistic reply lands
   * after the question, so `questionState` immediately marks the card inert.
   * The guard below also rejects a duplicate click once any answer references
   * this question.
   */
  function handleAnswerQuestion(questionEventId, optOrConsolidated) {
    if (!questionEventId) return;
    if (sending) return;
    const already = messages.some(m => m[ASK_ANSWER_FIELD]?.questionEventId === questionEventId);
    if (already) return;

    if (optOrConsolidated?.isMulti && Array.isArray(optOrConsolidated.answers)) {
      // Multi-question consolidated reply (#1799).
      const { answers } = optOrConsolidated;
      const extra = buildMultiAnswerContent(questionEventId, answers);
      handleSend(multiAnswerText(answers), extra);
    } else {
      // Single-question (unchanged).
      const option = optOrConsolidated;
      if (!option?.label) return;
      const extra = buildAnswerContent(questionEventId, option);
      handleSend(option.label, extra);
    }
  }

  /* ─── 5b. Attach files ───────────────────────────────────────────────
   * Upload dropped / picked files into the agent's `chat-uploads/` dir and
   * return the uploaded descriptors so the composer can insert a
   * `@chat-uploads/<name>` reference for each. Multipart, so plain fetch
   * rather than the JSON apiCall helper. Resolves to [] on failure (error is
   * surfaced via setError) so the composer can simply skip token insertion.
   */
  async function handleUpload(files) {
    const list = Array.from(files || []);
    if (list.length === 0 || !agent?.id) return [];
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of list) form.append('files', f);
      const r = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/chat-upload`, {
        method: 'POST',
        body: form,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      const uploaded = Array.isArray(j.uploaded) ? j.uploaded : [];
      // Let the workspace tree pick up the freshly uploaded file(s).
      if (uploaded.length) onWorkspaceChanged?.();
      return uploaded;
    } catch (err) {
      setError(`Upload failed: ${err.message}`);
      return [];
    } finally {
      setUploading(false);
    }
  }

  /* ─── Cross-panel hover correlation ─────────────────────────────────
   * Best-effort correlation: each agent bubble is "the response to the most
   * recent prior user message" — its correlationId is that user message's
   * eventId. Limitation: an agent message that was actually triggered by a
   * cron / out-of-band event will still be paired with the last preceding
   * user message in this view; PR #5 may revisit by reading the JSONL itself.
   */
  const correlationByEvent = useMemo(() => {
    const map = new Map();
    let lastUserEventId = null;
    for (const m of messages) {
      const isAgent = m.sender === agent.userId;
      if (!isAgent) {
        // User-sent message: correlationId is its own eventId.
        map.set(m.event_id, m.event_id);
        lastUserEventId = m.event_id;
      } else {
        // Agent message: correlate with the previous user message.
        map.set(m.event_id, lastUserEventId);
      }
    }
    return map;
  }, [messages, agent.userId]);

  // Quick-reply answers (#1663): map each answered question's event_id to the
  // answer record, so a rendered AskUserQuestion can show which option was
  // chosen and render its buttons inert (AC5 / AC6).
  const askAnswersByQuestion = useMemo(() => indexAskAnswers(messages), [messages]);

  /* ─── Thinking indicator: latest message is from user, no agent reply yet */
  // For trigger-initiated runs the last transcript entry is the trigger notice
  // (m.notice, sender = agent.userId), so the original "last-message-is-human"
  // heuristic never fires. `hasActiveTriggerRun` provides the supplementary
  // signal: when the shared active-sessions poll sees a trigger session for
  // this room we show the same animated indicator (#1852 AC1-3).
  const hasActiveTriggerRun = hasActiveTriggerSessionForRoom(activeSessions, roomId);
  const lastMsg = messages[messages.length - 1];
  const showThinking =
    !!lastMsg &&
    lastMsg.type !== 'context-reset' &&
    lastMsg.type !== 'user-stop' && // a user Stop ends the turn — no thinking
    (lastMsg.sender !== agent.userId || hasActiveTriggerRun) &&
    !lastMsg.isOptimistic && // already covered by sending state below
    !sending;
  const showSendingDots = sending;
  // The agent is busy on something the unified composer Stop (#1427) can abort:
  // a chat turn in flight (sending or waiting on the reply), a running loop,
  // or a trigger-initiated run (#1852).
  const agentBusy = showSendingDots || showThinking || !!activeLoop || hasActiveTriggerRun;

  /* ─── Render ─────────────────────────────────────────────────────── */
  const disabled = agent.enabled === false;
  const maintenance = useMaintenanceMode();
  const maintenanceBanner = maintenanceBannerText(maintenance);
  // AC5 (#1843): non-blocking warning when the agent's bound Model Provider is
  // currently red. The GET /model-options fetch (fired on agent selection) also
  // triggers a fresh probe server-side when the status is stale.
  const providerWarning = providerWarningText(modelOptions?.endpointHealth, modelOptions?.endpointName);

  // Meeting Note-Taker (#1296): the session engine is app-level, so ChatPanel
  // only needs to kick a session off for this agent and know whether one is
  // already running (to disable the entry point + quick dictation).
  const transcription = useTranscriptionSession();

  // One transcript row. Extracted out of the VirtualList prop (#1974) so the
  // per-event error boundary wraps it in exactly ONE place: with the branches
  // inline, a fourth message type added later would have silently returned an
  // unguarded row, and a single malformed event would blank the whole page.
  const renderTranscriptRow = (msg, i) => {
    if (msg.type === 'context-reset') {
      return <ContextResetSeparator ts={msg.ts} />;
    }
    if (msg.type === 'user-stop') {
      return <UserStopSeparator ts={msg.ts} />;
    }
    const cid = correlationByEvent.get(msg.event_id) || null;
    // Quick-reply state (#1663): a question is answerable only while it
    // is the newest message and no answer references it; a disabled
    // composer (offline / mid-send / maintenance) blocks a click either way.
    const isQuestion = !!msg[ASK_QUESTION_FIELD];
    const qState = isQuestion
      ? questionState({
          index: i,
          messageCount: messages.length,
          answer: askAnswersByQuestion.get(msg.event_id),
          disabled: disabled || !roomId || sending || maintenance.active,
        })
      : null;
    return (
      <div
        data-cid={cid || ''}
        onMouseEnter={() => onHoverCorrelation && onHoverCorrelation(cid)}
        onMouseLeave={() => onHoverCorrelation && onHoverCorrelation(null)}
      >
        <Message
          message={msg}
          agentUserId={agent.userId}
          onRelaunchLoop={handleRelaunchLoop}
          onAnswerQuestion={handleAnswerQuestion}
          questionAnswerable={qState?.answerable}
          questionAnswer={qState}
          viewer={viewer}
          authorDirectory={authorDirectory}
        />
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}>
      {/* Header */}
      <div style={{
        height: 'var(--eb-header-height)',
        borderBottom: '1px solid var(--eb-border-default)',
        padding: '0 var(--eb-space-4)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-3)',
        background: 'var(--eb-bg-surface)',
        flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', minWidth: 0 }}>
            <div
              title={agent.displayName || agent.id}
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                fontSize: 'var(--eb-text-md)',
                fontWeight: 'var(--eb-font-semibold)',
                color: 'var(--eb-text-primary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {agent.displayName || agent.id}
            </div>
            <LearningBadge
              scope={`agent:${agent.id}`}
              refreshKey={sessionUpdatedAt}
              onClick={onOpenKnowledge}
              title="Show what this agent has learned (Knowledge tab)"
            />
            {/* E15 (#1889, epic #1870): the page's "?" affordance. The chat header
                is bespoke (it carries the agent name, not a page title — the #1847
                exception), so the control joins this cluster rather than a shared
                page header. */}
            <PageHelpButton label="Help for Agent Chat" size={14} style={{ flexShrink: 0 }} />
          </div>
        </div>
      </div>

      {/* Session-control toolbar. flexWrap lets the controls flow onto a
          second row at narrow widths instead of dictating the chat panel's
          minimum width (long nowrap button row = min-content floor). */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '4px var(--eb-space-2)',
        padding: '6px var(--eb-space-4)',
        borderBottom: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        flexShrink: 0,
        fontSize: 'var(--eb-text-xs)',
        color: 'var(--eb-text-muted)',
        minWidth: 0,
      }}>
        {/* #1922: Reset Session is the primary, always-visible session action
            (it took over the slot the removed Save & Learn held). Its action,
            guards, busy spinner and tooltip are the ones it carried inside the
            `…` menu — only its location changed. Deliberately still no
            confirmation: it drops the session pointer, it does not delete
            anything (unlike Clear History, which keeps its confirm dialog). */}
        <button
          type="button"
          onClick={handleResetSession}
          disabled={!sessionId || resetting || disabled}
          title="This room keeps one running Claude session; your next message resumes it. Reset Session clears it — the next message starts a new conversation with no memory of this one."
          style={sessionBtnStyle(!sessionId || resetting || disabled)}
        >
          {resetting
            ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
            : <RotateCcw size={11} />}
          Reset Session
        </button>
        {/* #1810 (re-pointed in #1922): the `…` overflow menu still groups the
            rare, destructive session actions away from the primary button — it
            now holds Clear History (with its confirmation dialog) and stays in
            place as the home for further actions. */}
        <HeaderOverflowMenu
          buttonStyle={sessionBtnStyle}
          items={[
            {
              key: 'clear',
              label: 'Clear History',
              icon: <Trash2 size={13} />,
              onClick: () => setShowClearConfirm(true),
              disabled: !roomId || clearingHistory || disabled,
              busy: clearingHistory,
              title: 'Permanently delete all messages in this chat',
            },
          ]}
        />
        <ChatModelSelector
          options={modelOptions}
          disabled={disabled}
          busy={providerSwitching || modelSwitching}
          onModel={handleModelChange}
          onProvider={handleProviderSwitch}
          onReset={handleModelReset}
          onOpen={refreshModelOptions}
        />
        <div style={{ flex: 1 }} />
        {/* #1718: compact context-usage indicator (used / real window · %, or the
            used count alone when the window is unknown). The session id, price and
            per-class token breakdown moved into the info popover below. */}
        {contextIndicator && (
          <span
            title={contextWindowTokens != null
              ? `${contextFill.tokensIn.toLocaleString()} / ${contextWindowTokens.toLocaleString()} tokens · ${contextFill.model}`
              : `${contextFill.tokensIn.toLocaleString()} tokens · ${contextFill.model}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontFamily: 'var(--eb-font-mono)',
              fontSize: 'var(--eb-text-xs)',
              color: contextIndicator.level === 'critical' ? 'var(--eb-status-error)'
                : contextIndicator.level === 'warning' ? 'var(--eb-status-warning)'
                : 'var(--eb-text-muted)',
              whiteSpace: 'nowrap',
            }}
          >
            <Gauge size={10} />
            {contextIndicator.text}
          </span>
        )}
        <SessionInfoPopover
          sessionId={sessionId}
          sessionUpdatedAt={sessionUpdatedAt}
          sessionCost={sessionCost}
          contextWindowTokens={selectedModelInfo.windowTokens}
          maxOutputTokens={selectedModelInfo.maxOutput}
          environmentName={agent.environmentName}
          gitInfo={gitInfo}
        />
        {/* #1972: the header controls — model/provider selector, context-usage
            indicator, About this chat, the session tools — get their own "?"
            landing on the chapter that explains them. */}
        <PageHelpButton
          label="What the header controls do"
          size={13}
          section={AGENT_CHAT_HELP_SECTIONS.header}
          style={{ padding: 2, flexShrink: 0 }}
        />
      </div>

      {disabled && (
        <div style={{
          padding: 'var(--eb-space-3) var(--eb-space-4)',
          background: 'var(--eb-status-warning-bg)',
          borderBottom: '1px solid var(--eb-status-warning)',
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-primary)',
          flexShrink: 0,
        }}>
          This agent is disabled. Enable it from its row's menu in the agent list to chat — turn on <b>show disabled agents</b> there if you cannot see it.
        </div>
      )}

      {maintenanceBanner && (
        <div style={{
          padding: 'var(--eb-space-3) var(--eb-space-4)',
          background: 'var(--eb-status-warning-bg)',
          borderBottom: '1px solid var(--eb-status-warning)',
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-primary)',
          flexShrink: 0,
        }}>
          {maintenanceBanner}
        </div>
      )}

      {providerWarning && (
        <div role="status" style={{
          padding: 'var(--eb-space-3) var(--eb-space-4)',
          background: 'var(--eb-status-warning-bg)',
          borderBottom: '1px solid var(--eb-status-warning)',
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-primary)',
          flexShrink: 0,
        }}>
          {providerWarning}
        </div>
      )}

      {error && (
        <div role="alert" style={{
          padding: 'var(--eb-space-2) var(--eb-space-4)',
          background: 'var(--eb-status-error-bg)',
          borderBottom: '1px solid var(--eb-status-error)',
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-primary)',
          flexShrink: 0,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
        }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{error}</span>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexShrink: 0 }}>
            <button
              onClick={retryAll}
              title="Reload conversation"
              style={{
                background: 'none', border: '1px solid var(--eb-status-error)',
                color: 'var(--eb-status-error)', cursor: 'pointer',
                fontSize: 'var(--eb-text-xs)', padding: '2px 8px',
                borderRadius: 'var(--eb-radius-sm)', display: 'inline-flex',
                alignItems: 'center', gap: 4,
              }}
            >
              <RefreshCw size={11} /> Retry
            </button>
            <button
              onClick={() => setError(null)}
              style={{
                background: 'none', border: 'none', color: 'var(--eb-status-error)',
                cursor: 'pointer', fontSize: 'var(--eb-text-sm)',
              }}
            >Dismiss</button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        data-hover-scope="chat"
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: 'var(--eb-space-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--eb-space-3)',
          minHeight: 0,
          position: 'relative',
          // Per-user transcript font size (#1437). Scopes the override to the
          // message list only — the header/toolbar keep their own sizing. Each
          // message bubble reads var(--chat-font-size), falling back to the
          // 14px design token outside the chat view.
          '--chat-font-size': `${fontSize}px`,
        }}
      >
        {/* Top spinner while backfilling older history on scroll-up. */}
        {loadingOlder && (
          <div style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 'var(--eb-space-2)',
            padding: 'var(--eb-space-2)',
            color: 'var(--eb-text-muted)',
            fontSize: 'var(--eb-text-xs)',
          }}>
            <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
            Loading older messages…
          </div>
        )}

        {/* "Beginning of conversation" marker. */}
        {olderExhausted && messages.length > 0 && !loadingOlder && (
          <div style={{
            textAlign: 'center',
            padding: 'var(--eb-space-2)',
            color: 'var(--eb-text-muted)',
            fontSize: 'var(--eb-text-xs)',
            fontStyle: 'italic',
          }}>
            Beginning of conversation
          </div>
        )}

        {/* Initial-load skeleton. Shown only when there are no messages yet. */}
        {(creating || (loading && messages.length === 0)) && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1,
            color: 'var(--eb-text-muted)',
            fontSize: 'var(--eb-text-sm)',
            gap: 'var(--eb-space-2)',
          }}>
            <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
            <div>{creating ? 'Opening conversation with agent…' : 'Loading conversation…'}</div>
          </div>
        )}

        {!loading && !creating && messages.length === 0 && roomId && !error && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1,
            color: 'var(--eb-text-muted)',
            fontSize: 'var(--eb-text-sm)',
            textAlign: 'center',
            padding: 'var(--eb-space-6)',
          }}>
            <div style={{ fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-1)' }}>
              No messages yet
            </div>
            <div>Say hi to {agent.displayName || agent.id}.</div>
          </div>
        )}

        {/* Virtualized transcript (#1685): only the visible window of bubbles is
            mounted, so a very long session keeps a bounded DOM. The scroller is
            the div above; VirtualList reads its geometry via scrollerRef and the
            auto-scroll / load-older / unread logic keeps owning scroll. Each row
            carries a stable data-cid for the CSS-driven cross-panel hover dim
            (#1676) and rides the quick-reply question state (#1663). */}
        <VirtualList
          items={messages}
          scrollerRef={scrollerRef}
          keyOf={msg => msg.event_id}
          estimateHeight={90}
          overscan={8}
          gap={12}
          stickToBottom={atBottom}
          renderItem={(msg, i) => (
            <EventErrorBoundary agentId={agent.id} eventId={msg.event_id}>
              {renderTranscriptRow(msg, i)}
            </EventErrorBoundary>
          )}
        />

        {(showSendingDots || showThinking) && (
          <Message
            key="__thinking"
            message={{ event_id: '__thinking', sender: agent.userId, ts: Date.now(), body: '' }}
            agentUserId={agent.userId}
            thinking
          />
        )}
      </div>

      {/* "↓ N new messages" pill, anchored at the bottom of the scroll area */}
      {!atBottom && unread > 0 && (
        <button
          onClick={scrollToBottom}
          style={{
            position: 'absolute',
            right: 'var(--eb-space-6)',
            bottom: 84,
            padding: 'var(--eb-space-1) var(--eb-space-3)',
            background: 'var(--eb-accent-primary)',
            color: 'var(--eb-text-inverted)',
            border: 'none',
            borderRadius: 'var(--eb-radius-full)',
            fontSize: 'var(--eb-text-xs)',
            fontFamily: 'inherit',
            cursor: 'pointer',
            boxShadow: 'var(--eb-shadow-md)',
            zIndex: 10,
          }}
        >
          ↓ {unread} new message{unread === 1 ? '' : 's'}
        </button>
      )}

      {/* Input */}
      <MessageInput
        onSend={handleSend}
        disabled={disabled || !roomId || sending || maintenance.active}
        agentId={agent.id}
        agentDisplayName={agent.displayName || agent.id}
        onUpload={handleUpload}
        uploading={uploading}
        onLoopClick={handleLoopClick}
        loopRunning={!!activeLoop}
        loopBusy={loopBusy}
        loopTrigger={activeLoop}
        loopProgress={loopProgress}
        busy={agentBusy}
        onStop={handleStop}
        stopBusy={stopping || loopBusy}
        onStartMeeting={transcription ? () => transcription.startSession({ agentId: agent.id, agentName: agent.displayName || agent.id }) : undefined}
        meetingActive={!!transcription?.active}
        insertRefRequest={insertRefRequest}
      />

      {/* Local keyframes for the spinner; scoped to this page render. The
          cross-panel hover dim (#1676) is CSS-driven off `data-cid` so it
          never re-renders the transcript — only this <style> updates. */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes dotPulse { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
        ${hoverBaseCss('chat')}
        ${hoverDimCss('chat', hoveredCorrelationId)}
      `}</style>

      <ConfirmDialog
        open={showClearConfirm}
        title="Clear Chat History"
        message="This will permanently delete all messages in this chat. This action cannot be undone."
        variant="danger"
        confirmLabel="Delete All Messages"
        onConfirm={() => { setShowClearConfirm(false); handleClearHistory(); }}
        onCancel={() => setShowClearConfirm(false)}
      />

      {/* Loop launcher (#1020): reuse the shared loop configuration form,
          pinned to a loop and started in one step ("Start loop"). */}
      <SidePanel
        open={loopDialogOpen}
        onClose={closeLoopDialog}
        title={relaunchValues ? 'Start loop again' : 'Start a loop'}
      >
        {/* Loop-launcher explainer (#1120): a loop is one of the most
            consequential actions in the UI (repeated autonomous runs, token
            spend), so what it does and how it stops stays here at the point of
            decision. E15 (#1889) moved the wider concept material — why each try
            starts fresh, the four terminal states, what a verifier is for, and
            that everything else waits while a loop holds the workspace — into the
            Agent Chat help topic, reachable from the "?" beside it. */}
        <p style={{
          margin: '0 0 var(--eb-space-4)',
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-secondary)',
          lineHeight: 1.5,
        }}>
          A loop re-runs this agent on the instruction below — each run starts
          fresh — working on its own between runs. It stops when the{' '}
          <strong>max iterations</strong> cap is hit, when the{' '}
          <strong>stop condition</strong> passes, or when you press Stop.
          <PageHelpButton
            label="How loops work"
            size={13}
            section={AGENT_CHAT_HELP_SECTIONS.loops}
            style={{ padding: 0, marginLeft: 4, verticalAlign: 'middle' }}
          />
        </p>
        <TriggerForm
          // Remount on each open so the form re-seeds from the current
          // pre-fill (fresh launch vs "Start again"): TriggerForm reads
          // initialValues only in its useState initialiser.
          key={relaunchValues ? 'relaunch' : 'fresh'}
          agentId={agent.id}
          saving={loopBusy}
          lockType="loop"
          allowLoopType
          initialValues={relaunchValues || undefined}
          submitLabel="Start loop"
          onSave={handleLaunchLoop}
          onCancel={closeLoopDialog}
        />
      </SidePanel>

      <ConfirmDialog
        open={showStopLoopConfirm}
        title="Stop loop"
        message={`Stop the running loop for this agent${
          loopProgress?.iteration
            ? ` (currently on iteration ${loopProgress.iteration}${
                loopProgress.maxIterations ? ` of ${loopProgress.maxIterations}` : ''})`
            : ''
        }? The current iteration is interrupted and no further iterations run.`}
        variant="danger"
        confirmLabel="Stop loop"
        onConfirm={handleStopLoop}
        onCancel={() => setShowStopLoopConfirm(false)}
      />
    </div>
  );
}

function ContextResetSeparator({ ts }) {
  const label = ts
    ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--eb-space-3)',
      margin: 'var(--eb-space-2) 0',
      userSelect: 'none',
    }}>
      <div style={{ flex: 1, height: 1, background: 'var(--eb-status-warning)' }} />
      <span style={{
        fontSize: 'var(--eb-text-xs)',
        color: 'var(--eb-status-warning)',
        fontWeight: 'var(--eb-font-medium)',
        whiteSpace: 'nowrap',
        padding: '2px var(--eb-space-2)',
        border: '1px solid var(--eb-status-warning)',
        borderRadius: 'var(--eb-radius-sm)',
        background: 'var(--eb-status-warning-bg)',
      }}>
        ↺ New Context{label ? ` · ${label}` : ''}
      </span>
      <div style={{ flex: 1, height: 1, background: 'var(--eb-status-warning)' }} />
    </div>
  );
}

// A distinct "Stopped by user" transcript marker (#1427 AC4): rendered when the
// operator aborts a running turn from the composer's unified Stop control, so
// the stop is visibly different from a natural end-of-turn. Danger-toned to
// mirror the Stop button; injected optimistically on Stop (the runtime also
// posts its own abort notice over SSE).
function UserStopSeparator({ ts }) {
  const label = ts
    ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--eb-space-3)',
      margin: 'var(--eb-space-2) 0',
      userSelect: 'none',
    }}>
      <div style={{ flex: 1, height: 1, background: 'var(--eb-status-error-text, #dc2626)' }} />
      <span style={{
        fontSize: 'var(--eb-text-xs)',
        color: 'var(--eb-status-error-text, #dc2626)',
        fontWeight: 'var(--eb-font-medium)',
        whiteSpace: 'nowrap',
        padding: '2px var(--eb-space-2)',
        border: '1px solid var(--eb-status-error-text, #dc2626)',
        borderRadius: 'var(--eb-radius-sm)',
        background: 'var(--eb-status-error-bg, #fef2f2)',
      }}>
        ⏹ Stopped by user{label ? ` · ${label}` : ''}
      </span>
      <div style={{ flex: 1, height: 1, background: 'var(--eb-status-error-text, #dc2626)' }} />
    </div>
  );
}


function sessionBtnStyle(isDisabled) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    fontSize: 'var(--eb-text-xs)',
    fontFamily: 'inherit',
    color: isDisabled ? 'var(--eb-text-muted)' : 'var(--eb-text-secondary)',
    background: 'transparent',
    border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-sm)',
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    opacity: isDisabled ? 0.6 : 1,
    transition: 'background var(--eb-transition-fast), color var(--eb-transition-fast)',
  };
}


