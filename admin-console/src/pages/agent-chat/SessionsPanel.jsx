import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Activity, Loader2, Square, MessageCircle, Clock, Zap, Github, Terminal } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import SessionLogPanel from './SessionLogPanel';

/**
 * Merged "Sessions" tab (#543). Replaces the old standalone Log tab and the
 * standalone running-Sessions tab with a single tab that shows one sub-tab per
 * active session; the selected sub-tab renders that session's log (scoped to
 * its correlationId via SessionLogPanel) plus an in-tab Stop button.
 *
 * Only currently-running sessions are listed — historical/finished sessions
 * are #544 (out of scope here). When the agent has no active session the panel
 * shows an explicit empty state.
 *
 * Cost/context: because the whole-room interleaved log tab is gone, the chat
 * toolbar's cost + context-window indicators now derive from the *selected*
 * session (forwarded up from the embedded SessionLogPanel). They go empty when
 * there is no active session — restoring idle-time viewing is #544.
 */

const POLL_MS = 3_000;

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

export default function SessionsPanel({
  agentId, roomId, active,
  onCostUpdate, onContextUpdate, todoCloseSignal = 0,
  hoveredCorrelationId, onHoverCorrelation,
}) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [stoppingId, setStoppingId] = useState(null);
  // Force a re-render every second so elapsed-time labels tick between polls.
  const [, setTick] = useState(0);

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

  // With no session selected the embedded log unmounts and stops feeding the
  // toolbar, so clear the cost/context indicators ourselves — otherwise the
  // last session's numbers would linger after every session ends.
  useEffect(() => {
    if (selected) return;
    if (onCostUpdate) onCostUpdate(0, 0, 0);
    if (onContextUpdate) onContextUpdate(null);
  }, [selected, onCostUpdate, onContextUpdate]);

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

      {sessions.length === 0 ? (
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
              appear here as sub-tabs.
            </span>
          )}
        </div>
      ) : (
        <>
          {/* Sub-tab strip: one per active session. Horizontally scrollable so
              many concurrent sessions stay reachable without a nested menu. */}
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
              const isSel = session.id === selectedId;
              return (
                <button
                  key={session.id}
                  role="tab"
                  aria-selected={isSel}
                  type="button"
                  onClick={() => setSelectedId(session.id)}
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

          {/* Selected-session toolbar: meta + Stop. */}
          {selected && (
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
          )}

          {/* Selected-session log, scoped to its correlationId. Keyed by id so
              switching sub-tabs remounts a clean log stream for the session. */}
          <div style={{ flex: 1, minHeight: 0 }}>
            {selected && (
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
            )}
          </div>
        </>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
