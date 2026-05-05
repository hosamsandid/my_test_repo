import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Wifi, WifiOff, Loader2, RefreshCw, RotateCcw, GraduationCap } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import { useSSE } from '../../hooks/useSSE';
import Message from './Message';
import MessageInput from './MessageInput';

// Default prompt sent when the user clicks "Reset & lernen". The agent
// continues in its current Claude session (so it has full conversational
// context), is asked to consolidate that context into the memory files,
// and replies with a short summary. After the reply lands, the UI clears
// the session pointer so the next message starts fresh.
const LEARN_PROMPT =
  'Bevor wir das Gespraech hier beenden: Bitte fasse die wichtigsten Erkenntnisse, ' +
  'Entscheidungen und offenen Punkte aus unserer bisherigen Konversation zusammen ' +
  'und aktualisiere deine memory/-Dateien (insbesondere memory/log.md und memory/context.md, ' +
  'falls vorhanden) entsprechend. Antworte danach kurz mit dem, was du dir gemerkt hast.';

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
 *      send. When SSE delivers a real event with the same body+sender within
 *      30 s we replace the optimistic stub.
 *
 * @param {object} agent              From /api/matrix/agents
 * @param {string|null} roomId        DM room id (or null until created)
 * @param {(roomId:string)=>void} onRoomCreated  Notify parent when we POST to /dm
 * @param {string|null} hoveredCorrelationId      Cross-panel hover state from parent
 * @param {(id:string|null)=>void} onHoverCorrelation
 */
export default function ChatPanel({
  agent, roomId, onRoomCreated, hoveredCorrelationId, onHoverCorrelation,
}) {
  const [messages, setMessages]      = useState([]);
  const [loading, setLoading]        = useState(false);
  const [error, setError]            = useState(null);
  const [creating, setCreating]      = useState(false);
  const [sending, setSending]        = useState(false);

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
  // invocation and read back here so the UI can show a "Session aktiv"
  // badge and offer reset controls.
  const [sessionId, setSessionId]     = useState(null);
  const [sessionUpdatedAt, setSessionUpdatedAt] = useState(null);
  const [resetting, setResetting]     = useState(false);
  const [learnPending, setLearnPending] = useState(false);
  // Wall-clock at the moment the user clicked "Reset & lernen". The
  // post-message effect uses it to decide which agent reply to treat as
  // "the response to the learn prompt" — namely, the next agent message
  // whose timestamp is at or after this value.
  const learnTriggeredAtRef = useRef(0);

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

  /* ─── 2. Backfill on roomId change ──────────────────────────────── */
  useEffect(() => {
    setMessages([]);
    setUnread(0);
    setEndToken(null);
    setOlderExhausted(false);
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
        const seed = chunk
          .filter(ev => ev.type === 'm.room.message')
          .reverse()
          .map(ev => ({
            event_id: ev.event_id,
            sender:   ev.sender,
            ts:       ev.origin_server_ts,
            body:     ev.content?.body || '',
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
        .filter(ev => ev.type === 'm.room.message')
        .reverse()
        .map(ev => ({
          event_id: ev.event_id,
          sender:   ev.sender,
          ts:       ev.origin_server_ts,
          body:     ev.content?.body || '',
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
    const incoming = {
      event_id: ev.event_id,
      sender:   ev.sender,
      ts:       ev.origin_server_ts,
      body:     ev.content?.body || '',
    };

    setMessages(prev => {
      // Already have the canonical event — skip.
      if (prev.some(m => m.event_id === incoming.event_id)) return prev;

      // Try to reconcile with an optimistic stub: same body within a 30 s
      // window. Sender intentionally not compared — the optimistic stub uses
      // a sentinel sender id, while the canonical event carries the real
      // admin user id. The isOptimistic flag already restricts the match
      // set to messages we sent ourselves.
      const idx = prev.findIndex(m =>
        m.isOptimistic
        && m.body === incoming.body
        && Math.abs((incoming.ts || 0) - (m.ts || 0)) < 30_000
      );
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = incoming;
        return next;
      }
      return [...prev, incoming];
    });
  }, []);

  const sseUrl = roomId ? `/api/matrix/rooms/${encodeURIComponent(roomId)}/stream` : null;
  const { status: sseStatus } = useSSE(sseUrl, {
    onEvent: handleEvent,
    enabled: !!roomId,
  });

  /* ─── 4. Auto-scroll behaviour ───────────────────────────────────── */
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
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
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isAtBottom = distance < 100;
    setAtBottom(isAtBottom);
    if (isAtBottom) setUnread(0);

    // Top-edge backfill: when the user scrolls within 100 px of the top and
    // we still have an `endToken`, fetch the next-older 50 messages.
    if (el.scrollTop < 100 && endToken && !loadingOlder && !olderExhausted) {
      loadOlder();
    }
  }

  function scrollToBottom() {
    const el = scrollerRef.current;
    if (!el) return;
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
    setResetting(true);
    setError(null);
    try {
      await apiCall('DELETE', sessionApiBase);
      setSessionId(null);
      setSessionUpdatedAt(null);
    } catch (err) {
      setError(`Reset failed: ${err.message}`);
    } finally {
      setResetting(false);
    }
  }

  async function handleLearnAndReset() {
    if (!sessionApiBase || learnPending) return;
    setError(null);
    setLearnPending(true);
    learnTriggeredAtRef.current = Date.now();
    try {
      // Send the learn prompt as a normal user message — the user sees it
      // in the chat, the agent replies in its current Claude session, and
      // the post-reply effect below clears the pointer.
      await handleSend(LEARN_PROMPT);
    } catch (err) {
      setLearnPending(false);
      setError(`Learn-and-reset failed: ${err.message}`);
    }
  }

  // Auto-clear the session pointer once the agent has replied to the
  // learn prompt. We treat "the next non-optimistic agent message whose
  // ts >= triggered-at" as that reply. Edge case: a stray agent message
  // arriving in that window would short-circuit the wait — acceptable
  // for a rare manual workflow.
  useEffect(() => {
    if (!learnPending || !sessionApiBase) return;
    if (!messages.length || !agent?.userId) return;
    const last = messages[messages.length - 1];
    if (last?.sender !== agent.userId) return;
    if (last?.isOptimistic) return;
    if ((last?.ts || 0) < learnTriggeredAtRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        await apiCall('DELETE', sessionApiBase);
        if (cancelled) return;
        setSessionId(null);
        setSessionUpdatedAt(null);
      } catch (err) {
        if (cancelled) return;
        setError(`Auto-reset after lernen failed: ${err.message}`);
      } finally {
        if (!cancelled) setLearnPending(false);
      }
    })();
    return () => { cancelled = true; };
  }, [messages, learnPending, agent?.userId, sessionApiBase]);

  /* ─── 5. Send ────────────────────────────────────────────────────── */
  async function handleSend(text) {
    if (!roomId) return;
    const body = text.trim();
    if (!body) return;
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
    };
    setMessages(prev => [...prev, optimistic]);
    setSending(true);
    setError(null);
    try {
      await apiCall('POST', `/api/matrix/rooms/${encodeURIComponent(roomId)}/messages`, { body });
      // Real event arrives via SSE; the onEvent handler reconciles it.
    } catch (err) {
      setError(`Send failed: ${err.message}`);
      // Roll back the optimistic message so the user can retry.
      setMessages(prev => prev.filter(m => m.event_id !== optimisticId));
    } finally {
      setSending(false);
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

  /* ─── Thinking indicator: latest message is from user, no agent reply yet */
  const lastMsg = messages[messages.length - 1];
  const showThinking =
    !!lastMsg &&
    lastMsg.sender !== agent.userId &&
    !lastMsg.isOptimistic && // already covered by sending state below
    !sending;
  const showSendingDots = sending;

  /* ─── Render ─────────────────────────────────────────────────────── */
  const disabled = agent.enabled === false;

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
          <div style={{
            fontSize: 'var(--eb-text-md)',
            fontWeight: 'var(--eb-font-semibold)',
            color: 'var(--eb-text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {agent.displayName || agent.id}
          </div>
          <div style={{
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            fontFamily: 'var(--eb-font-mono)',
          }}>
            {agent.userId}
          </div>
        </div>
        <ConnectionDot status={sseStatus} />
      </div>

      {/* Session-control toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-2)',
        padding: '6px var(--eb-space-4)',
        borderBottom: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        flexShrink: 0,
        fontSize: 'var(--eb-text-xs)',
        color: 'var(--eb-text-muted)',
      }}>
        <SessionBadge active={!!sessionId} updatedAt={sessionUpdatedAt} />
        <button
          type="button"
          onClick={handleResetSession}
          disabled={!sessionId || resetting || learnPending || disabled}
          title="Aktuelle Session verwerfen — naechste Nachricht startet frisch"
          style={sessionBtnStyle(!sessionId || resetting || learnPending || disabled)}
        >
          {resetting
            ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
            : <RotateCcw size={11} />}
          Reset
        </button>
        <button
          type="button"
          onClick={handleLearnAndReset}
          disabled={!sessionId || resetting || learnPending || disabled}
          title="Agent fasst die Konversation zusammen, aktualisiert seine memory/-Dateien und startet danach mit frischer Session"
          style={sessionBtnStyle(!sessionId || resetting || learnPending || disabled)}
        >
          {learnPending
            ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
            : <GraduationCap size={11} />}
          Reset &amp; lernen
        </button>
        <div style={{ flex: 1 }} />
        {sessionId && (
          <span
            title={`Session-ID: ${sessionId}${sessionUpdatedAt ? ` (aktualisiert ${sessionUpdatedAt})` : ''}`}
            style={{
              fontFamily: 'var(--eb-font-mono)',
              fontSize: 'var(--eb-text-xs)',
              color: 'var(--eb-text-muted)',
              maxWidth: 120,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {sessionId.slice(0, 8)}…
          </span>
        )}
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
          This agent is disabled. Enable it in Agent Manager to chat.
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
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 'var(--eb-space-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--eb-space-3)',
          minHeight: 0,
          position: 'relative',
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
            <div>{creating ? 'Opening DM with agent…' : 'Loading conversation…'}</div>
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

        {messages.map(msg => {
          const cid = correlationByEvent.get(msg.event_id) || null;
          const dimmed = !!hoveredCorrelationId && cid !== hoveredCorrelationId;
          return (
            <div
              key={msg.event_id}
              onMouseEnter={() => onHoverCorrelation && onHoverCorrelation(cid)}
              onMouseLeave={() => onHoverCorrelation && onHoverCorrelation(null)}
              style={{
                opacity: dimmed ? 0.35 : 1,
                transition: 'opacity 0.15s',
              }}
            >
              <Message message={msg} agentUserId={agent.userId} />
            </div>
          );
        })}

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
        disabled={disabled || !roomId || sending}
        agentDisplayName={agent.displayName || agent.id}
      />

      {/* Local keyframes for the spinner; scoped to this page render. */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes dotPulse { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
      `}</style>
    </div>
  );
}

function SessionBadge({ active }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 'var(--eb-space-1)',
      fontSize: 'var(--eb-text-xs)',
      color: active ? 'var(--eb-status-success)' : 'var(--eb-text-muted)',
      fontWeight: 'var(--eb-font-medium)',
    }}>
      <span style={{
        width: 7,
        height: 7,
        borderRadius: 'var(--eb-radius-full)',
        background: active ? 'var(--eb-status-success)' : 'var(--eb-text-muted)',
        display: 'inline-block',
      }} />
      {active ? 'Session aktiv' : 'Neue Session'}
    </span>
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

function ConnectionDot({ status }) {
  let color = 'var(--eb-text-muted)';
  let label = 'Idle';
  let Icon  = WifiOff;
  if (status === 'open')         { color = 'var(--eb-status-success)'; label = 'Live';         Icon = Wifi; }
  else if (status === 'connecting')   { color = 'var(--eb-status-warning)'; label = 'Connecting…'; Icon = Loader2; }
  else if (status === 'reconnecting') { color = 'var(--eb-status-warning)'; label = 'Reconnecting…'; Icon = Loader2; }

  const animate = status === 'connecting' || status === 'reconnecting';
  return (
    <div title={label} style={{
      display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)',
      color, fontSize: 'var(--eb-text-xs)',
    }}>
      <Icon size={12} style={animate ? { animation: 'spin 1s linear infinite' } : undefined} />
      <span>{label}</span>
    </div>
  );
}
