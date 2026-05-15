import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Activity, Loader2, Square, MessageCircle, Clock, Zap, Github, Terminal } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';

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

function typeLabel(session) {
  if (session.type === 'dm') return 'manual';
  if (session.type === 'trigger') return session.triggerType || 'trigger';
  if (session.type === 'autonomous') return 'autonomous';
  return session.type || 'unknown';
}

export default function RunningSessionsPanel({ agentId, active }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stoppingId, setStoppingId] = useState(null);
  // Force a re-render every second so the elapsed-time column ticks even
  // between server polls.
  const [, setTick] = useState(0);
  const tickIntervalRef = useRef(null);

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
    tickIntervalRef.current = setInterval(() => setTick(t => t + 1), 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (tickIntervalRef.current) clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    };
  }, [active, agentId, fetchSessions]);

  const handleStop = useCallback(async (sessionId) => {
    if (!agentId || !sessionId || stoppingId) return;
    setStoppingId(sessionId);
    try {
      await apiCall('POST', `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/stop`);
      // Optimistically drop the session from the list — the next poll will
      // confirm. The runner posts the cancellation message to Matrix itself.
      setSessions(prev => prev.filter(s => s.id !== sessionId));
    } catch (err) {
      setError(err.message || 'stop failed');
    } finally {
      setStoppingId(null);
    }
  }, [agentId, stoppingId]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      fontSize: 'var(--eb-text-sm)',
    }}>
      <div style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        borderBottom: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-2)',
        color: 'var(--eb-text-muted)',
        fontSize: 'var(--eb-text-xs)',
        flexShrink: 0,
      }}>
        <Activity size={13} />
        <span style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)' }}>
          {sessions.length} running session{sessions.length === 1 ? '' : 's'}
        </span>
        {loading && sessions.length === 0 && (
          <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
        )}
      </div>

      {error && (
        <div role="alert" style={{
          padding: 'var(--eb-space-2) var(--eb-space-4)',
          background: 'var(--eb-status-error-bg)',
          borderBottom: '1px solid var(--eb-status-error)',
          color: 'var(--eb-text-primary)',
          fontSize: 'var(--eb-text-xs)',
        }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {sessions.length === 0 ? (
          <div style={{
            padding: 'var(--eb-space-6) var(--eb-space-4)',
            color: 'var(--eb-text-muted)',
            fontSize: 'var(--eb-text-xs)',
            textAlign: 'center',
          }}>
            No active sessions.
          </div>
        ) : (
          sessions.map(session => {
            const stopping = stoppingId === session.id;
            return (
              <div
                key={session.id}
                style={{
                  padding: 'var(--eb-space-3) var(--eb-space-4)',
                  borderBottom: '1px solid var(--eb-border-default)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--eb-space-3)',
                }}
              >
                <div style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}>
                  <div style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    color: 'var(--eb-text-secondary)',
                    fontSize: 'var(--eb-text-xs)',
                    fontWeight: 'var(--eb-font-medium)',
                  }}>
                    {typeIcon(session)}
                    <span style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
                      {typeLabel(session)}
                    </span>
                  </div>
                  <div style={{
                    color: 'var(--eb-text-primary)',
                    fontSize: 'var(--eb-text-sm)',
                    wordBreak: 'break-word',
                  }}>
                    {session.label || '(no label)'}
                  </div>
                  <div style={{
                    color: 'var(--eb-text-muted)',
                    fontSize: 'var(--eb-text-xs)',
                    display: 'flex',
                    gap: 'var(--eb-space-2)',
                    flexWrap: 'wrap',
                  }}>
                    <span title={session.startedAt}>started {formatElapsed(session.startedAt)} ago</span>
                    {session.triggerId && (
                      <span style={{ fontFamily: 'var(--eb-font-mono)' }}>· {session.triggerId}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleStop(session.id)}
                  disabled={stopping}
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
                    cursor: stopping ? 'wait' : 'pointer',
                    fontSize: 'var(--eb-text-xs)',
                    fontFamily: 'inherit',
                    flexShrink: 0,
                  }}
                >
                  {stopping
                    ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                    : <Square size={11} />}
                  Stop
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
