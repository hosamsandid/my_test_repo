import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  Activity, Loader2, Square, MessageCircle, Clock, Zap, Github, Terminal,
  History, ChevronDown, ChevronUp, ArrowLeft, RefreshCw, RotateCcw,
} from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import PageHelpButton from '../../components/PageHelpButton';
import { AGENT_CHAT_HELP_SECTIONS } from './agent-chat-help-sections.js';
import SessionLogPanel from './SessionLogPanel';
import { canResumeSession, resumeNeedsConfirm } from './resume-session';
import { resolveHistoricalId, historyFetchLimit } from './session-default';
import { findActiveSessionMatch, findFinishedSessionMatch } from '../github-event-session';
import { useSessionsActive } from './SessionsActiveContext';
import { removeSession } from './sessions-active';
import ConfirmDialog from '../../components/ConfirmDialog';

/**
 * Merged "Sessions" tab (#543, extended in #544). Replaces the old standalone
 * Log tab and the standalone running-Sessions tab with a single tab that shows
 * one sub-tab per active session; the selected sub-tab renders that session's
 * log (scoped to its correlationId via SessionLogPanel) plus an in-tab Stop
 * button.
 *
 * Historical sessions (#544, regrouped in #555): a footer control —
 * hidden/collapsed by default — expands into a dropdown of *finished* sessions
 * (those no longer running). Entries are grouped by Claude **session-ID**, so
 * the several manual messages of one ongoing conversation appear as a single
 * entry (its start/end timestamps + run count shown), while a reset or a fresh
 * externally-triggered run starts a new entry. Selecting one renders the
 * combined log of every run in that session, in the same per-session log view
 * used for active sub-tabs (read-only, no live tail). Because the logs are
 * already durable in the room's JSONL, this needs no new persistence — the
 * backend enumerates session-ID groups that aren't currently active
 * (`GET .../sessions/history`). A session stopped/ended while the tab is open
 * drops out of the active sub-tabs and, once the dropdown refreshes, becomes
 * reachable here (closing the loop left open in #543).
 *
 * Default view (#910): with no session running the panel does **not** fall back
 * to an empty state — it shows the most recently finished session's log, so the
 * run that just ended stays on screen (and keeps tracking the newest finished
 * session as further runs end). The empty state remains for an agent that has
 * never run. A newly started session still takes over the view automatically,
 * but only from that auto-default — a session the user *picked* from the
 * dropdown is left alone (the toolbar's Live button is the way back). The pure
 * rules live in `session-default.js`.
 *
 * Cost/context: the chat toolbar's cost + context-window indicators derive from
 * the *viewed* session (active sub-tab or selected historical session),
 * forwarded up from the embedded SessionLogPanel. They go empty only when
 * nothing is being viewed.
 */

// Coarse cadence for the elapsed-time re-render tick (#1680). "started 5m ago"
// doesn't need 1s granularity, and a 1s tick re-rendered this panel every
// second whenever it was open; 30s keeps the label fresh without the churn.
// (The active-sessions list itself is polled once for all consumers by
// SessionsActiveContext, #1678 — this panel no longer polls it locally.)
const ELAPSED_TICK_MS = 30_000;
const HISTORY_LIMIT = 100;

function formatElapsed(startedAtIso) {
  const start = new Date(startedAtIso).getTime();
  if (!Number.isFinite(start)) return '—';
  const ms = Math.max(0, Date.now() - start);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function formatAbsolute(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function typeIcon(session) {
  if (session.type === 'dm') return <MessageCircle size={12} />;
  if (session.type === 'trigger') {
    if (session.triggerType === 'cron') return <Clock size={12} />;
    if (session.triggerType === 'once') return <Clock size={12} />;
    if (session.triggerType === 'http') return <Zap size={12} />;
    if (session.triggerType === 'github-event') return <Github size={12} />;
    return <Zap size={12} />;
  }
  if (session.type === 'autonomous') return <Terminal size={12} />;
  return <Activity size={12} />;
}

function sourceLabel(session) {
  if (session.type === 'dm') return 'MANUAL';
  if (session.type === 'trigger') return (session.triggerType || 'trigger').toUpperCase();
  if (session.type === 'autonomous') return 'AUTONOMOUS';
  return (session.type || 'unknown').toUpperCase();
}

// A session spans its first run's start to its last run's end (#555). Collapse
// to a single timestamp when the two coincide (a one-run session).
function formatRange(startIso, endIso) {
  const start = formatAbsolute(startIso);
  const end = formatAbsolute(endIso);
  if (!start) return end || '';
  if (!end || end === start) return start;
  return `${start} – ${end}`;
}

// Run/message count so a multi-message session is recognisable as such (#555
// AC3). DM sessions count messages; everything else counts runs.
function countLabel(session) {
  const n = session.runCount || 1;
  const noun = session.type === 'dm' ? 'message' : 'run';
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function historyOptionLabel(session) {
  const parts = [
    sourceLabel(session),
    session.label || '(session)',
    formatRange(session.startedAt, session.endedAt),
    countLabel(session),
  ];
  return parts.filter(Boolean).join(' · ');
}

export default function SessionsPanel({
  agentId, roomId, active,
  onCostUpdate, onContextUpdate, todoCloseSignal = 0,
  hoveredCorrelationId, onHoverCorrelation,
  onResumeSession, selectRequest = null,
}) {
  // Active sessions come from the shared per-agent poll (#1678) — no rail-local
  // timer. `setSessions` is the shared optimistic surface (Stop, deep-link);
  // `pollError` is the poll's own failure. Action failures (Stop) keep a local
  // error so they surface in the same banner without being clobbered by a poll.
  const { sessions, loading, error: pollError, refresh, setSessions } = useSessionsActive();
  const [actionError, setActionError] = useState(null);
  const error = actionError || pollError;
  const [selectedId, setSelectedId] = useState(null);
  const [stoppingId, setStoppingId] = useState(null);
  // Force a re-render on a coarse cadence so elapsed-time labels stay fresh
  // between polls (see ELAPSED_TICK_MS — #1680).
  const [, setTick] = useState(0);

  // Historical sessions (#544). The dropdown is collapsed by default; the list
  // itself is fetched regardless since the newest entry is the default view
  // (#910) — collapsed we only pull a small slice (see historyFetchLimit).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  // session id (Claude session-ID, or a correlationId fallback) of the
  // finished session currently being viewed (or null) — #555.
  const [historicalId, setHistoricalId] = useState(null);
  // Whether that view was *chosen* (dropdown pick or #642 deep-link) rather
  // than auto-defaulted to the newest finished session (#910). A chosen session
  // is never replaced behind the user's back; the auto-default is.
  const [historyPinned, setHistoryPinned] = useState(false);

  // Guards against a superseded history response overwriting a newer one.
  const historyReqRef = useRef(0);

  // Non-blocking notice shown when a deep-link (#642) couldn't locate the
  // requested session (outside the history window, log pruned, no DM room, …).
  const [notFound, setNotFound] = useState(null); // { correlationId } | null
  const [confirmResume, setConfirmResume] = useState(false); // resume would replace an active session

  // The active-sessions list itself is polled once for all consumers by
  // SessionsActiveContext (#1678); this panel only keeps a per-second tick so
  // the elapsed-time labels advance between polls while the tab is visible.
  useEffect(() => {
    if (!active || !agentId) return undefined;
    const tickTimer = setInterval(() => setTick(t => t + 1), ELAPSED_TICK_MS);
    return () => clearInterval(tickTimer);
  }, [active, agentId]);

  // Only the expanded dropdown (or a session picked out of it) needs the whole
  // page; resolving the default view needs just the newest slice (#910).
  const fetchLimit = historyFetchLimit({
    historyOpen, pinned: historyPinned, fullLimit: HISTORY_LIMIT,
  });

  const fetchHistory = useCallback(async () => {
    if (!agentId || !roomId) {
      setHistory([]);
      return;
    }
    // History is now fetched on its own (poll-driven) schedule, so an in-flight
    // request can be superseded by an agent/room switch or a newer refresh —
    // drop its result rather than leak it into the new view (AC8).
    const reqId = ++historyReqRef.current;
    setHistoryLoading(true);
    try {
      const data = await apiCall(
        'GET',
        `/api/agents/${encodeURIComponent(agentId)}/sessions/history`
          + `?roomId=${encodeURIComponent(roomId)}&limit=${fetchLimit}`,
      );
      if (historyReqRef.current !== reqId) return;
      setHistory(Array.isArray(data?.sessions) ? data.sessions : []);
      // "…showing the N most recent" only means something once we asked for the
      // full page; a deliberately short idle slice isn't a truncation notice.
      setHistoryTruncated(fetchLimit >= HISTORY_LIMIT && !!data?.truncated);
      setHistoryError(null);
    } catch (err) {
      if (historyReqRef.current !== reqId) return;
      setHistoryError(err.message || 'failed to load history');
    } finally {
      if (historyReqRef.current === reqId) setHistoryLoading(false);
    }
  }, [agentId, roomId, fetchLimit]);

  // Fetch history up front — the newest finished session is the default view
  // (#910 AC1/AC5), so it can no longer wait for the control to be expanded —
  // and refresh it whenever the set of active sessions changes, so a run that
  // just ended (dropped from the active poll) becomes the default without a
  // manual refresh (AC4).
  const activeCidKey = useMemo(
    () => sessions.map(s => s.correlationId || s.id).join(','),
    [sessions],
  );
  useEffect(() => {
    fetchHistory();
  }, [activeCidKey, fetchHistory]);

  // Switching agent/room invalidates the historical selection and list.
  useEffect(() => {
    setHistoricalId(null);
    setHistoryPinned(false);
    setHistory([]);
    setHistoryOpen(false);
    setNotFound(null);
  }, [agentId, roomId]);

  // Deep-link preselection (#642): a delivered GitHub-event chip asks us to open
  // the session whose correlationId is `trigger:<triggerId>:gh:<eventId>`. Match
  // an active session first (select its sub-tab), otherwise the finished-session
  // group (open + select it); if neither exists, surface a graceful notice (AC6).
  // We fetch fresh here rather than trust the polled state so a cold navigation
  // (tab just became visible) doesn't race the first poll.
  useEffect(() => {
    if (!selectRequest || !selectRequest.correlationId || !agentId) return undefined;
    const target = selectRequest.correlationId;
    let cancelled = false;
    (async () => {
      setNotFound(null);

      // 1) Active sessions — a still-running session is selected as a sub-tab.
      let activeList = [];
      try {
        const data = await apiCall('GET', `/api/agents/${encodeURIComponent(agentId)}/sessions/active`);
        activeList = Array.isArray(data?.sessions) ? data.sessions : [];
      } catch { /* fall through to history */ }
      if (cancelled) return;
      const activeMatch = findActiveSessionMatch(activeList, target);
      if (activeMatch) {
        setSessions(activeList);
        setHistoricalId(null);
        setHistoryPinned(false);
        setSelectedId(activeMatch.id);
        return;
      }

      // 2) Finished sessions — needs a room to query the per-room history.
      if (!roomId) { setNotFound({ correlationId: target }); return; }
      let hist = [];
      try {
        const data = await apiCall(
          'GET',
          `/api/agents/${encodeURIComponent(agentId)}/sessions/history`
            + `?roomId=${encodeURIComponent(roomId)}&limit=${HISTORY_LIMIT}`,
        );
        hist = Array.isArray(data?.sessions) ? data.sessions : [];
      } catch {
        if (!cancelled) setNotFound({ correlationId: target });
        return;
      }
      if (cancelled) return;
      const histMatch = findFinishedSessionMatch(hist, target);
      if (histMatch) {
        setHistory(hist);
        setHistoryOpen(true);
        // An explicit preselection outranks the #910 auto-default.
        setHistoryPinned(true);
        setHistoricalId(histMatch.id);
        return;
      }
      setNotFound({ correlationId: target });
    })();
    return () => { cancelled = true; };
  }, [selectRequest, agentId, roomId]);

  // Keep the selection stable across polls: hold the selected id while it is
  // still running; fall back to the first session when it disappears (a
  // stopped/finished session), and null when there are none. New sessions
  // arriving never steal the current selection.
  useEffect(() => {
    setSelectedId(prev => {
      if (prev && sessions.some(s => s.id === prev)) return prev;
      return sessions.length ? sessions[0].id : null;
    });
  }, [sessions]);

  const hasActive = sessions.length > 0;

  // Default view (#910): with nothing running, show the most recently finished
  // session; when a session starts, hand the view back to it. A session the user
  // picked (or a #642 deep-link preselected) is pinned and left alone — the
  // toolbar's Live button is how they go back to a live session.
  useEffect(() => {
    setHistoricalId(prev => resolveHistoricalId({
      pinned: historyPinned, hasActive, history, current: prev,
    }));
  }, [historyPinned, hasActive, history]);

  const selected = useMemo(
    () => sessions.find(s => s.id === selectedId) || null,
    [sessions, selectedId],
  );

  const historical = useMemo(
    () => (historicalId ? history.find(s => s.id === historicalId) || null : null),
    [historicalId, history],
  );

  // With nothing selected the embedded log unmounts and stops feeding the
  // toolbar, so clear the cost/context indicators ourselves — otherwise the
  // last session's numbers would linger. A historical selection counts as
  // "being viewed" and keeps feeding the toolbar, so don't clear then.
  useEffect(() => {
    if (selected || historical) return;
    if (onCostUpdate) onCostUpdate(0, 0, 0);
    if (onContextUpdate) onContextUpdate(null);
  }, [selected, historical, onCostUpdate, onContextUpdate]);

  const handleStop = useCallback(async (sessionId) => {
    if (!agentId || !sessionId || stoppingId) return;
    setStoppingId(sessionId);
    setActionError(null);
    try {
      await apiCall('POST', `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/stop`);
      // Optimistically drop it from the shared state — the badge and every
      // consumer update at once; the next poll (or this refresh) confirms. The
      // runner posts the cancellation message to Matrix itself.
      setSessions(prev => removeSession(prev, sessionId));
      refresh();
    } catch (err) {
      setActionError(err.message || 'stop failed');
    } finally {
      setStoppingId(null);
    }
  }, [agentId, stoppingId, setSessions, refresh]);

  const selectActive = useCallback((id) => {
    setHistoricalId(null);
    setHistoryPinned(false);
    setSelectedId(id);
  }, []);

  // Still working out what to show: either the active poll or the first history
  // load is outstanding. Without this the panel would flash "No active
  // sessions." before the finished-session default resolves (#910).
  const resolving = loading || (!!roomId && historyLoading && history.length === 0);

  // Dropdown pick: an empty value releases the pin and hands the view back to
  // the #910 auto-default.
  const selectHistorical = useCallback((id) => {
    setHistoryPinned(!!id);
    setHistoricalId(id || null);
  }, []);

  // Resume the selected finished session (#574). There is exactly one pointer
  // per room, so if a healthy session is already active this overwrites it —
  // confirm first (Open Question B). ChatPanel owns the pointer PUT + sending
  // the predefined message; we just hand it the chosen session-ID and switch
  // back to the live view so the resumed session shows as active (AC4).
  // Actually perform the resume (after any confirmation). ChatPanel owns the
  // pointer PUT; we hand it the chosen session-ID and switch back to the live
  // view so the resumed session shows as active (AC4).
  const proceedResume = useCallback(() => {
    if (!historical || !onResumeSession) return;
    setConfirmResume(false);
    onResumeSession(historical.sessionId);
    // Switch from the read-only historical view to the live view; the resumed
    // session appears as the active session once the run starts.
    setHistoryPinned(false);
    setHistoricalId(null);
  }, [historical, onResumeSession]);

  const handleResume = useCallback(() => {
    if (!historical || !canResumeSession(historical) || !onResumeSession) return;
    if (resumeNeedsConfirm(sessions)) {
      // Overwriting a live session is irreversible — confirm through the shared
      // styled dialog (consistent with every other console confirmation).
      setConfirmResume(true);
      return;
    }
    proceedResume();
  }, [historical, onResumeSession, sessions, proceedResume]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {error && (
        <div role="alert" style={{
          padding: 'var(--eb-space-2) var(--eb-space-4)',
          background: 'var(--eb-status-error-bg)',
          borderBottom: '1px solid var(--eb-status-error)',
          color: 'var(--eb-text-primary)',
          fontSize: 'var(--eb-text-xs)',
          flexShrink: 0,
        }}>
          {error}
        </div>
      )}

      {notFound && (
        <div role="status" style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 'var(--eb-space-2)',
          padding: 'var(--eb-space-2) var(--eb-space-4)',
          background: 'var(--eb-status-warning-bg)',
          borderBottom: '1px solid var(--eb-status-warning)',
          color: 'var(--eb-text-primary)',
          fontSize: 'var(--eb-text-xs)',
          lineHeight: 1.5,
          flexShrink: 0,
        }}>
          <span style={{ flex: 1 }}>
            Couldn't locate the session this event triggered — it may be older
            than the retained history, its log may have been pruned, or the agent
            has no chat room yet.
          </span>
          <button
            type="button"
            onClick={() => setNotFound(null)}
            aria-label="Dismiss"
            title="Dismiss"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--eb-text-secondary)',
              cursor: 'pointer',
              padding: 0,
              fontSize: 'var(--eb-text-sm)',
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Sub-tab strip: one per active session. Hidden while viewing history so
          the finished-session log gets the full height; still shown so the user
          can jump back to a live session by clicking its tab. */}
      {hasActive && (
        <div
          role="tablist"
          aria-label="Active sessions"
          style={{
            display: 'flex',
            gap: 'var(--eb-space-1)',
            padding: 'var(--eb-space-2) var(--eb-space-2)',
            borderBottom: '1px solid var(--eb-border-default)',
            background: 'var(--eb-bg-surface)',
            overflowX: 'auto',
            flexShrink: 0,
          }}
        >
          {sessions.map(session => {
            const isSel = !historical && session.id === selectedId;
            return (
              <button
                key={session.id}
                role="tab"
                aria-selected={isSel}
                type="button"
                onClick={() => selectActive(session.id)}
                title={`${sourceLabel(session)} · ${session.label || '(no label)'}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '4px 10px',
                  maxWidth: 220,
                  background: isSel ? 'var(--eb-accent-muted)' : 'transparent',
                  color: isSel ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
                  border: `1px solid ${isSel ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
                  borderRadius: 'var(--eb-radius-full)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 'var(--eb-text-xs)',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {typeIcon(session)}
                <span style={{ fontWeight: 'var(--eb-font-medium)', letterSpacing: 0.3 }}>
                  {sourceLabel(session)}
                </span>
                <span style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  opacity: 0.85,
                }}>
                  · {session.label || '(no label)'}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Main area: historical view takes precedence, else the active session,
          else the idle empty state. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {historical ? (
          <>
            {/* Historical-session toolbar: read-only meta + return-to-live. */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--eb-space-1)',
              padding: 'var(--eb-space-2) var(--eb-space-4)',
              borderBottom: '1px solid var(--eb-border-default)',
              fontSize: 'var(--eb-text-xs)',
              color: 'var(--eb-text-muted)',
              flexShrink: 0,
            }}>
              {/* Row 1: source type + session name (truncates) + action buttons */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', minWidth: 0 }}>
                <History size={12} style={{ flexShrink: 0 }} />
                <span style={{ fontWeight: 'var(--eb-font-medium)', letterSpacing: 0.3, color: 'var(--eb-text-secondary)', flexShrink: 0 }}>
                  {sourceLabel(historical)}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                  · {historical.label || '(session)'}
                </span>
                {canResumeSession(historical) && onResumeSession && (
                  <button
                    type="button"
                    onClick={handleResume}
                    title="Resume this session and continue the conversation"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '4px 8px',
                      background: 'none',
                      border: '1px solid var(--eb-accent-primary)',
                      borderRadius: 'var(--eb-radius-sm)',
                      color: 'var(--eb-accent-primary)',
                      cursor: 'pointer',
                      fontSize: 'var(--eb-text-xs)',
                      fontFamily: 'inherit',
                      flexShrink: 0,
                    }}
                  >
                    <RotateCcw size={11} />
                    Resume session
                  </button>
                )}
                {/* Only offered when there IS a live session to return to: with
                    nothing running this view *is* the default (#910). */}
                {hasActive && (
                  <button
                    type="button"
                    onClick={() => selectHistorical(null)}
                    title="A session is running — return to it"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '4px 8px',
                      background: 'none',
                      border: '1px solid var(--eb-accent-primary)',
                      borderRadius: 'var(--eb-radius-sm)',
                      color: 'var(--eb-accent-primary)',
                      cursor: 'pointer',
                      fontSize: 'var(--eb-text-xs)',
                      fontFamily: 'inherit',
                      flexShrink: 0,
                    }}
                  >
                    <ArrowLeft size={11} />
                    Live
                  </button>
                )}
                {/* #1972: the same session-log "?" as on the live toolbar — a
                    finished run's log is read exactly the same way. */}
                <PageHelpButton
                  label="How to read the session log"
                  size={13}
                  section={AGENT_CHAT_HELP_SECTIONS.sessionLog}
                  style={{ padding: 2, flexShrink: 0 }}
                />
              </div>
              {/* Row 2: timestamp + count + "last session" badge — all nowrap so
                  the date string never breaks mid-word at narrow widths. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
                <span style={{ whiteSpace: 'nowrap' }} title={`${historical.startedAt || ''} – ${historical.endedAt || ''}`}>
                  {formatRange(historical.startedAt, historical.endedAt)}
                </span>
                <span style={{ whiteSpace: 'nowrap' }}>· {countLabel(historical)}</span>
                {!historyPinned && (
                  <span
                    title="Shown by default because no session is running"
                    style={{
                      padding: '1px 6px',
                      borderRadius: 'var(--eb-radius-full)',
                      background: 'var(--eb-bg-app)',
                      border: '1px solid var(--eb-border-default)',
                      color: 'var(--eb-text-muted)',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    last session
                  </span>
                )}
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <SessionLogPanel
                key={`hist-${historical.id}`}
                agentId={agentId}
                roomId={roomId}
                scopeCorrelationId={historical.correlationIds}
                staticOnly
                embedded
                onCostUpdate={onCostUpdate}
                onContextUpdate={onContextUpdate}
                todoCloseSignal={todoCloseSignal}
                hoveredCorrelationId={hoveredCorrelationId}
                onHoverCorrelation={onHoverCorrelation}
              />
            </div>
          </>
        ) : selected ? (
          <>
            {/* Selected-session toolbar: meta + Stop. */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--eb-space-2)',
              padding: 'var(--eb-space-2) var(--eb-space-4)',
              borderBottom: '1px solid var(--eb-border-default)',
              fontSize: 'var(--eb-text-xs)',
              color: 'var(--eb-text-muted)',
              flexShrink: 0,
            }}>
              <span title={selected.startedAt}>
                started {formatElapsed(selected.startedAt)} ago
              </span>
              {selected.triggerId && (
                <span style={{ fontFamily: 'var(--eb-font-mono)' }}>· {selected.triggerId}</span>
              )}
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => handleStop(selected.id)}
                disabled={stoppingId === selected.id}
                title="Stop this session"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 8px',
                  background: 'none',
                  border: '1px solid var(--eb-status-error)',
                  borderRadius: 'var(--eb-radius-sm)',
                  color: 'var(--eb-status-error)',
                  cursor: stoppingId === selected.id ? 'wait' : 'pointer',
                  fontSize: 'var(--eb-text-xs)',
                  fontFamily: 'inherit',
                  flexShrink: 0,
                }}
              >
                {stoppingId === selected.id
                  ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                  : <Square size={11} />}
                Stop
              </button>
              {/* #1972: the session log's own "?" — it sits on the toolbar
                  directly above the timeline, which is the only header the log
                  has inside the rail (SessionLogPanel's own is suppressed when
                  embedded). */}
              <PageHelpButton
                label="How to read the session log"
                size={13}
                section={AGENT_CHAT_HELP_SECTIONS.sessionLog}
                style={{ padding: 2, flexShrink: 0 }}
              />
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <SessionLogPanel
                key={selected.id}
                agentId={agentId}
                roomId={selected.roomId || roomId}
                scopeCorrelationId={selected.correlationId || null}
                embedded
                onCostUpdate={onCostUpdate}
                onContextUpdate={onContextUpdate}
                todoCloseSignal={todoCloseSignal}
                hoveredCorrelationId={hoveredCorrelationId}
                onHoverCorrelation={onHoverCorrelation}
              />
            </div>
          </>
        ) : (
          <div style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--eb-space-2)',
            padding: 'var(--eb-space-6)',
            color: 'var(--eb-text-muted)',
            fontSize: 'var(--eb-text-xs)',
            textAlign: 'center',
          }}>
            {resolving
              ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
              : <Activity size={16} style={{ opacity: 0.5 }} />}
            <span>{resolving ? 'Loading sessions…' : 'No active sessions.'}</span>
            {!resolving && (
              <span style={{ maxWidth: 240, lineHeight: 1.5 }}>
                Send a message or wait for a trigger to fire — running sessions
                appear here as sub-tabs, and once a run has finished its log is
                shown here by default.
              </span>
            )}
          </div>
        )}
      </div>

      {/* Historical-sessions control (#544). Collapsed by default so it doesn't
          clutter the view — the dropdown only renders once expanded. */}
      <div style={{
        borderTop: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => setHistoryOpen(o => !o)}
            aria-expanded={historyOpen}
            title="Browse finished sessions"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
              padding: 'var(--eb-space-2) var(--eb-space-4)',
              background: 'none',
              border: 'none',
              color: 'var(--eb-text-secondary)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 'var(--eb-text-xs)',
              textAlign: 'left',
            }}
          >
            <History size={13} />
            <span style={{ fontWeight: 'var(--eb-font-medium)' }}>Finished sessions</span>
            <div style={{ flex: 1 }} />
            {historyOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
          {/* #1972: the Sessions tab's own "?". It rides this row rather than a
              toolbar because this is the one control the tab always shows — the
              per-session toolbars above it only exist once a run is selected. */}
          <PageHelpButton
            label="What the Sessions tab shows"
            size={13}
            section={AGENT_CHAT_HELP_SECTIONS.sessions}
            style={{ padding: '0 var(--eb-space-3) 0 0', flexShrink: 0 }}
          />
        </div>

        {historyOpen && (
          <div style={{
            padding: '0 var(--eb-space-4) var(--eb-space-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--eb-space-2)',
          }}>
            {historyError && (
              <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-xs)' }}>
                {historyError}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
              <select
                aria-label="Select a finished session"
                value={historicalId || ''}
                disabled={historyLoading || history.length === 0}
                onChange={(e) => selectHistorical(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '5px 8px',
                  background: 'var(--eb-bg-app)',
                  border: '1px solid var(--eb-border-default)',
                  borderRadius: 'var(--eb-radius-sm)',
                  color: 'var(--eb-text-primary)',
                  fontFamily: 'inherit',
                  fontSize: 'var(--eb-text-xs)',
                }}
              >
                <option value="">
                  {history.length === 0
                    ? (historyLoading ? 'Loading…' : 'No finished sessions yet')
                    : 'Select a finished session…'}
                </option>
                {history.map(s => (
                  <option key={s.id} value={s.id}>
                    {historyOptionLabel(s)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={fetchHistory}
                disabled={historyLoading}
                title="Refresh finished sessions"
                aria-label="Refresh finished sessions"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: 5,
                  background: 'none',
                  border: '1px solid var(--eb-border-default)',
                  borderRadius: 'var(--eb-radius-sm)',
                  color: 'var(--eb-text-secondary)',
                  cursor: historyLoading ? 'wait' : 'pointer',
                  flexShrink: 0,
                }}
              >
                <RefreshCw size={12} style={historyLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
              </button>
            </div>

            {historyTruncated && (
              <span style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)' }}>
                Showing the {HISTORY_LIMIT} most recent finished sessions.
              </span>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      <ConfirmDialog
        open={confirmResume}
        title="Replace the active session?"
        message={
          'A session is currently active in this room. Resuming this finished '
          + 'session will replace the active one — there is a single session per '
          + 'room. Continue?'
        }
        variant="warning"
        confirmLabel="Resume"
        onConfirm={proceedResume}
        onCancel={() => setConfirmResume(false)}
      />
    </div>
  );
}
