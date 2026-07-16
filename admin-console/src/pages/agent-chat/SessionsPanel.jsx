import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Activity, Loader2, Square, MessageCircle, Clock, Zap, Github, Terminal,
  History, ChevronDown, ChevronUp, ArrowLeft, RefreshCw, RotateCcw,
} from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import SessionLogPanel from './SessionLogPanel';
import { canResumeSession, resumeNeedsConfirm } from './resume-session';
import { findActiveSessionMatch, findFinishedSessionMatch } from '../github-event-session';

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
 * Cost/context: the chat toolbar's cost + context-window indicators derive from
 * the *viewed* session (active sub-tab or selected historical session),
 * forwarded up from the embedded SessionLogPanel. They go empty only when
 * nothing is being viewed.
 */

const POLL_MS = 3_000;
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
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [stoppingId, setStoppingId] = useState(null);
  // Force a re-render every second so elapsed-time labels tick between polls.
  const [, setTick] = useState(0);

  // Historical sessions (#544). Collapsed by default — only fetched/rendered
  // once the user expands the control.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  // session id (Claude session-ID, or a correlationId fallback) of the
  // finished session currently being viewed (or null) — #555.
  const [historicalId, setHistoricalId] = useState(null);

  // Non-blocking notice shown when a deep-link (#642) couldn't locate the
  // requested session (outside the history window, log pruned, no DM room, …).
  const [notFound, setNotFound] = useState(null); // { correlationId } | null

  const fetchSessions = useCallback(async () => {
    if (!agentId) return;
    try {
      const data = await apiCall('GET', `/api/agents/${encodeURIComponent(agentId)}/sessions/active`);
      setSessions(Array.isArray(data?.sessions) ? data.sessions : []);
      setError(null);
    } catch (err) {
      setError(err.message || 'failed to load');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (!active || !agentId) return undefined;
    setLoading(true);
    let cancelled = false;
    let timer = null;
    const loop = async () => {
      if (cancelled) return;
      await fetchSessions();
      if (cancelled) return;
      timer = setTimeout(loop, POLL_MS);
    };
    loop();
    const tickTimer = setInterval(() => setTick(t => t + 1), 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(tickTimer);
    };
  }, [active, agentId, fetchSessions]);

  const fetchHistory = useCallback(async () => {
    if (!agentId || !roomId) {
      setHistory([]);
      return;
    }
    setHistoryLoading(true);
    try {
      const data = await apiCall(
        'GET',
        `/api/agents/${encodeURIComponent(agentId)}/sessions/history`
          + `?roomId=${encodeURIComponent(roomId)}&limit=${HISTORY_LIMIT}`,
      );
      setHistory(Array.isArray(data?.sessions) ? data.sessions : []);
      setHistoryTruncated(!!data?.truncated);
      setHistoryError(null);
    } catch (err) {
      setHistoryError(err.message || 'failed to load history');
    } finally {
      setHistoryLoading(false);
    }
  }, [agentId, roomId]);

  // Fetch history when the control is open, and refresh it whenever the set of
  // active sessions changes — so a run that just ended (dropped from the active
  // poll) shows up as a finished session without a manual refresh (AC4).
  const activeCidKey = useMemo(
    () => sessions.map(s => s.correlationId || s.id).join(','),
    [sessions],
  );
  useEffect(() => {
    if (!historyOpen) return;
    fetchHistory();
  }, [historyOpen, activeCidKey, fetchHistory]);

  // Switching agent/room invalidates the historical selection and list.
  useEffect(() => {
    setHistoricalId(null);
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
    try {
      await apiCall('POST', `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/stop`);
      // Optimistically drop it — the next poll confirms. The runner posts the
      // cancellation message to Matrix itself.
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch (err) {
      setError(err.message || 'stop failed');
    } finally {
      setStoppingId(null);
    }
  }, [agentId, stoppingId]);

  const selectActive = useCallback((id) => {
    setHistoricalId(null);
    setSelectedId(id);
  }, []);

  // Resume the selected finished session (#574). There is exactly one pointer
  // per room, so if a healthy session is already active this overwrites it —
  // confirm first (Open Question B). ChatPanel owns the pointer PUT + sending
  // the predefined message; we just hand it the chosen session-ID and switch
  // back to the live view so the resumed session shows as active (AC4).
  const handleResume = useCallback(() => {
    if (!historical || !canResumeSession(historical) || !onResumeSession) return;
    if (resumeNeedsConfirm(sessions)) {
      const ok = window.confirm(
        'A session is currently active in this room. Resuming this finished '
        + 'session will replace the active one (there is a single session per '
        + 'room). Continue?',
      );
      if (!ok) return;
    }
    onResumeSession(historical.sessionId);
    // Switch from the read-only historical view to the live view; the resumed
    // session appears as the active session once the run starts.
    setHistoricalId(null);
  }, [historical, onResumeSession, sessions]);

  const hasActive = sessions.length > 0;

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
              alignItems: 'center',
              gap: 'var(--eb-space-2)',
              padding: 'var(--eb-space-2) var(--eb-space-4)',
              borderBottom: '1px solid var(--eb-border-default)',
              fontSize: 'var(--eb-text-xs)',
              color: 'var(--eb-text-muted)',
              flexShrink: 0,
            }}>
              <History size={12} />
              <span style={{ fontWeight: 'var(--eb-font-medium)', letterSpacing: 0.3, color: 'var(--eb-text-secondary)' }}>
                {sourceLabel(historical)}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                · {historical.label || '(session)'}
              </span>
              <span title={`${historical.startedAt || ''} – ${historical.endedAt || ''}`}>
                · {formatRange(historical.startedAt, historical.endedAt)}
              </span>
              <span>· {countLabel(historical)}</span>
              <div style={{ flex: 1 }} />
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
              <button
                type="button"
                onClick={() => setHistoricalId(null)}
                title="Return to live sessions"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 8px',
                  background: 'none',
                  border: '1px solid var(--eb-border-default)',
                  borderRadius: 'var(--eb-radius-sm)',
                  color: 'var(--eb-text-secondary)',
                  cursor: 'pointer',
                  fontSize: 'var(--eb-text-xs)',
                  fontFamily: 'inherit',
                  flexShrink: 0,
                }}
              >
                <ArrowLeft size={11} />
                Live
              </button>
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
            {loading
              ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
              : <Activity size={16} style={{ opacity: 0.5 }} />}
            <span>{loading ? 'Loading sessions…' : 'No active sessions.'}</span>
            {!loading && (
              <span style={{ maxWidth: 240, lineHeight: 1.5 }}>
                Send a message or wait for a trigger to fire — running sessions
                appear here as sub-tabs. Finished sessions are available below.
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
                onChange={(e) => setHistoricalId(e.target.value || null)}
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
    </div>
  );
}
