import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Wifi, WifiOff, Loader2, RefreshCw, RotateCcw, GraduationCap, Server, DollarSign, Cpu, Trash2, GitBranch, ArrowRight } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import { useSSE } from '../../hooks/useSSE';
import ConfirmDialog from '../../components/ConfirmDialog';
import HandoffDialog from './HandoffDialog';
import Message from './Message';
import MessageInput from './MessageInput';
import LearningBadge from '../../components/LearningBadge';

// Default prompt sent when the user clicks "Reset & learn". The agent
// continues in its current Claude session (so it has full conversational
// context), is asked to consolidate that context into the memory files,
// and replies with a short summary. After the reply lands, the UI clears
// the session pointer so the next message starts fresh.
const LEARN_PROMPT =
  'Before we end this conversation: please summarize the key insights, ' +
  'decisions and open points from our discussion so far ' +
  'and update your memory/ files accordingly, routing each piece to the right file:\n' +
  '- memory/context.md — current session state (keep slim)\n' +
  '- memory/log.md — one summary entry for this conversation\n' +
  '- memory/facts.md — atomic, deduplicated facts (one per line, with date)\n' +
  '- memory/entities.md — rich knowledge about projects, systems, frameworks\n' +
  '- memory/users.md — per-user interaction profiles\n' +
  'Then briefly reply with what you have saved.';

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
 */
export default function ChatPanel({
  agent, roomId, onRoomCreated, hoveredCorrelationId, onHoverCorrelation, sessionCost,
  onWorkspaceChanged,
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
  // invocation and read back here so the UI can show a "Session active"
  // badge and offer reset controls.
  const [sessionId, setSessionId]     = useState(null);
  const [sessionUpdatedAt, setSessionUpdatedAt] = useState(null);
  const [resetting, setResetting]     = useState(false);
  const [learnPending, setLearnPending] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);

  // Per-agent model selection. `modelOptions` is the resolved snapshot from
  // /api/agents/:id/model-options: which endpoint the agent is bound to,
  // what catalog it offers, the env-level default, and the per-agent
  // override. `modelSwitching` blocks rapid double-clicks during the PATCH.
  const [modelOptions, setModelOptions] = useState(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  // Wall-clock at the moment the user clicked "Full Learn". The
  // post-message effect uses it to decide which agent reply to treat as
  // "the response to the learn prompt" — namely, the next agent message
  // whose timestamp is at or after this value.
  const learnTriggeredAtRef = useRef(0);

  // Git repos info for the agent workspace (branch + dirty status).
  const [gitInfo, setGitInfo] = useState(null);

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
      msgtype:  ev.content?.msgtype || 'm.text',
      'io.aee.trigger':  ev.content?.['io.aee.trigger'] || null,
    };

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
            msgtype:  ev.content?.msgtype || 'm.text',
            'io.aee.trigger':  ev.content?.['io.aee.trigger'] || null,
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

  async function handleModelChange(newId) {
    if (!agent?.id || modelSwitching) return;
    setModelSwitching(true);
    setError(null);
    try {
      // Empty string from the <select> means "back to env default" — send
      // null so the API clears the override.
      const payload = { modelId: newId ? newId : null };
      const resp = await apiCall('PATCH', `/api/agents/${encodeURIComponent(agent.id)}/model`, payload);
      setModelOptions(prev => prev ? { ...prev, override: resp.override } : prev);
    } catch (err) {
      setError(`Model switch failed: ${err.message}`);
    } finally {
      setModelSwitching(false);
    }
  }

  async function handleFullLearn() {
    if (!sessionApiBase || learnPending) return;
    setError(null);
    setLearnPending(true);
    learnTriggeredAtRef.current = Date.now();
    try {
      await handleSend(LEARN_PROMPT);
    } catch (err) {
      setLearnPending(false);
      setError(`Full learn failed: ${err.message}`);
    }
  }

  // Clear learnPending once the agent has replied to the learn prompt.
  useEffect(() => {
    if (!learnPending) return;
    if (!messages.length || !agent?.userId) return;
    const last = messages[messages.length - 1];
    if (last?.sender !== agent.userId) return;
    if (last?.isOptimistic) return;
    if ((last?.ts || 0) < learnTriggeredAtRef.current) return;
    setLearnPending(false);
  }, [messages, learnPending, agent?.userId]);

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
      const resp = await apiCall('POST', `/api/matrix/rooms/${encodeURIComponent(roomId)}/messages`, { body });
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

  /* ─── Thinking indicator: latest message is from user, no agent reply yet */
  const lastMsg = messages[messages.length - 1];
  const showThinking =
    !!lastMsg &&
    lastMsg.type !== 'context-reset' &&
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
            {agent.environmentName && (
              <div
                title={agent.environmentName}
                style={{
                  flex: '0 1 auto',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 'var(--eb-text-xs)',
                  color: 'var(--eb-text-muted)',
                  minWidth: 0,
                  overflow: 'hidden',
                }}
              >
                <Server size={11} style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {agent.environmentName}
                </span>
              </div>
            )}
            <LearningBadge scope={`agent:${agent.id}`} refreshKey={sessionUpdatedAt} />
          </div>
          {gitInfo && gitInfo.length > 0 && (
            <div
              title={gitInfo.map(r =>
                `${gitInfo.length > 1 ? r.repoPath + ': ' : ''}${r.branch ?? 'detached'}${r.isDirty ? ` (${r.changesCount} uncommitted)` : ''}`
              ).join(' · ')}
              style={{ display: 'flex', flexWrap: 'nowrap', gap: 6, marginTop: 1, overflow: 'hidden' }}
            >
              {gitInfo.map(repo => (
                <div key={repo.repoPath} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
                  minWidth: 0, flexShrink: 1, overflow: 'hidden',
                }}>
                  <GitBranch size={11} style={{ flexShrink: 0 }} />
                  {gitInfo.length > 1 && (
                    <span style={{ fontFamily: 'monospace', flexShrink: 0 }}>
                      {repo.repoPath}:
                    </span>
                  )}
                  <span style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {repo.branch ?? 'detached'}
                  </span>
                  {repo.isDirty && (
                    <span
                      style={{
                        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                        background: 'var(--eb-color-warning, #f59e0b)',
                        display: 'inline-block',
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <ConnectionDot status={sseStatus} />
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
        <SessionBadge active={!!sessionId} updatedAt={sessionUpdatedAt} />
        <button
          type="button"
          onClick={handleFullLearn}
          disabled={!sessionId || learnPending || disabled}
          title="Agent summarizes this conversation and saves key insights to its memory files — the session stays open afterwards"
          style={sessionBtnStyle(!sessionId || learnPending || disabled)}
        >
          {learnPending
            ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
            : <GraduationCap size={11} />}
          Full Learn
        </button>
        <button
          type="button"
          onClick={handleResetSession}
          disabled={!sessionId || resetting || learnPending || disabled}
          title="Clear the session — the next message starts a new conversation with no memory of this one"
          style={sessionBtnStyle(!sessionId || resetting || learnPending || disabled)}
        >
          {resetting
            ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
            : <RotateCcw size={11} />}
          Reset Session
        </button>
        <button
          type="button"
          onClick={() => setShowClearConfirm(true)}
          disabled={!roomId || clearingHistory || disabled}
          title="Permanently delete all messages in this chat"
          style={sessionBtnStyle(!roomId || clearingHistory || disabled)}
        >
          {clearingHistory
            ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
            : <Trash2 size={11} />}
          Clear History
        </button>
        {agent?.role === 'bp-instance' && (
          <button
            type="button"
            onClick={() => setShowHandoff(true)}
            disabled={disabled}
            title="Hand work off to downstream bp-instance agents — they receive your note as a chat message and start working"
            style={{
              ...sessionBtnStyle(disabled),
              color: disabled ? undefined : 'var(--eb-accent-primary)',
              borderColor: disabled ? undefined : 'var(--eb-accent-primary)',
            }}
          >
            <ArrowRight size={11} />
            Hand-off
          </button>
        )}
        <ModelPicker
          options={modelOptions}
          switching={modelSwitching}
          disabled={disabled}
          onChange={handleModelChange}
        />
        <div style={{ flex: 1 }} />
        {sessionCost !== null && sessionCost.usd > 0 && (
          <span
            title={`Session total: $${sessionCost.usd.toFixed(4)} · ${sessionCost.tokIn.toLocaleString()} tokens in / ${sessionCost.tokOut.toLocaleString()} tokens out`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontFamily: 'var(--eb-font-mono)',
              fontSize: 'var(--eb-text-xs)',
              color: 'var(--eb-text-muted)',
              whiteSpace: 'nowrap',
            }}
          >
            <DollarSign size={10} />
            {sessionCost.usd.toFixed(4)}
          </span>
        )}
        {sessionId && (
          <span
            title={`Session ID: ${sessionId}${sessionUpdatedAt ? ` (updated ${sessionUpdatedAt})` : ''}`}
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
          overflowX: 'hidden',
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
          if (msg.type === 'context-reset') {
            return <ContextResetSeparator key={msg.event_id} ts={msg.ts} />;
          }
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
        onUpload={handleUpload}
        uploading={uploading}
      />

      {/* Local keyframes for the spinner; scoped to this page render. */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes dotPulse { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
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

      <HandoffDialog
        open={showHandoff}
        agent={agent}
        onClose={() => setShowHandoff(false)}
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

function SessionBadge({ active }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 'var(--eb-space-1)',
      fontSize: 'var(--eb-text-xs)',
      color: active ? 'var(--eb-status-info)' : 'var(--eb-text-muted)',
      fontWeight: 'var(--eb-font-medium)',
    }}>
      <span style={{
        width: 7,
        height: 7,
        borderRadius: 'var(--eb-radius-full)',
        background: active ? 'var(--eb-status-info)' : 'var(--eb-text-muted)',
        display: 'inline-block',
      }} />
      {active ? 'Session active' : 'New session'}
    </span>
  );
}

function ModelPicker({ options, switching, disabled, onChange }) {
  // Render a stable empty placeholder while the options are loading so the
  // toolbar layout doesn't jump.
  if (!options) return null;

  const hasEndpoint = !!options.endpointId;
  const hasModels   = (options.models || []).length > 0;
  const effective   = options.override || options.defaultModelId || '';
  const overridden  = !!options.override;
  const interactionDisabled = disabled || switching || !hasEndpoint || !hasModels;

  // Build a tooltip that explains the binding in one line — useful when the
  // dropdown shows "(no endpoint)" or "(no models)" so the user knows where
  // to fix it.
  const tooltip = !hasEndpoint
    ? 'No model provider bound to this environment — set one in Working Environments.'
    : !hasModels
      ? `Provider "${options.endpointName}" has no models in its catalog.`
      : overridden
        ? `Override active. Environment default: ${options.defaultModelId || '(none)'}.`
        : `Environment default. Provider: ${options.endpointName}.`;

  return (
    <div
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 'var(--eb-text-xs)',
        color: overridden ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
      }}
    >
      <Cpu size={11} />
      <select
        value={effective}
        disabled={interactionDisabled}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: '2px 6px',
          fontSize: 'var(--eb-text-xs)',
          fontFamily: 'inherit',
          color: 'inherit',
          background: 'transparent',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-sm)',
          cursor: interactionDisabled ? 'not-allowed' : 'pointer',
          opacity: interactionDisabled ? 0.6 : 1,
          maxWidth: 220,
        }}
      >
        {!hasEndpoint && <option value="">(no endpoint)</option>}
        {hasEndpoint && !hasModels && <option value="">(no models)</option>}
        {hasModels && (
          <option value="">
            {options.defaultModelId
              ? `Default: ${options.defaultModelId}`
              : '— pick a model —'}
          </option>
        )}
        {options.models?.map(m => (
          <option key={m.id} value={m.id}>
            {(m.displayName || m.id) + (m.kind ? ` · ${m.kind}` : '')}
          </option>
        ))}
      </select>
      {overridden && (
        <button
          type="button"
          onClick={() => onChange('')}
          disabled={switching || disabled}
          title="Clear override and fall back to the environment default"
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            color: 'var(--eb-accent-primary)',
            cursor: switching || disabled ? 'not-allowed' : 'pointer',
            fontSize: 'var(--eb-text-xs)',
            textDecoration: 'underline',
          }}
        >
          reset
        </button>
      )}
      {switching && <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />}
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
