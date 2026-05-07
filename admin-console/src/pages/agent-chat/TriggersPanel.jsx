import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Clock, CalendarClock, CheckCircle2, XCircle, Loader2, AlertCircle } from 'lucide-react';

const POLL_MS = 30_000;

function TypeBadge({ type }) {
  const isCron = type === 'cron';
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 3,
      padding: '1px 6px',
      borderRadius: 'var(--eb-radius-full)',
      fontSize: 'var(--eb-text-xs)',
      fontWeight: 'var(--eb-font-medium)',
      background: isCron ? 'var(--eb-accent-muted)' : 'var(--eb-bg-elevated)',
      color: isCron ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
      border: `1px solid ${isCron ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
      whiteSpace: 'nowrap',
    }}>
      {isCron ? <Clock size={10} /> : <CalendarClock size={10} />}
      {isCron ? 'cron' : 'once'}
    </span>
  );
}

function EnabledBadge({ enabled }) {
  return enabled !== false
    ? <CheckCircle2 size={14} style={{ color: 'var(--eb-status-success)', flexShrink: 0 }} title="Enabled" />
    : <XCircle     size={14} style={{ color: 'var(--eb-text-muted)',      flexShrink: 0 }} title="Disabled" />;
}

function TriggerRow({ trigger }) {
  const schedule = trigger.cron || trigger.at || '—';
  return (
    <div style={{
      padding: 'var(--eb-space-3) var(--eb-space-4)',
      borderBottom: '1px solid var(--eb-border-default)',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--eb-space-1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <TypeBadge type={trigger.type} />
        <code style={{
          flex: 1,
          fontSize: 'var(--eb-text-xs)',
          fontFamily: 'var(--eb-font-mono)',
          color: 'var(--eb-text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {schedule}
        </code>
        <EnabledBadge enabled={trigger.enabled} />
      </div>

      {trigger.id && (
        <div style={{
          fontSize: 'var(--eb-text-xs)',
          fontFamily: 'var(--eb-font-mono)',
          color: 'var(--eb-text-muted)',
        }}>
          {trigger.id}
        </div>
      )}

      {trigger.description && (
        <div style={{
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-secondary)',
          lineHeight: 1.4,
        }}>
          {trigger.description}
        </div>
      )}

      {trigger.prompt && (
        <div style={{
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-muted)',
          lineHeight: 1.4,
          padding: 'var(--eb-space-1) var(--eb-space-2)',
          background: 'var(--eb-bg-elevated)',
          borderRadius: 'var(--eb-radius-sm)',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
        }}>
          {trigger.prompt}
        </div>
      )}
    </div>
  );
}

/**
 * Read-only panel listing the scheduled triggers for the selected agent.
 * Data is fetched from /api/agents/:id/triggers (backed by triggers.json /
 * jobs.json in the agent workspace). Polling every 30 s so changes made by
 * the agent itself are reflected without a manual refresh.
 */
export default function TriggersPanel({ agentId, active }) {
  const [triggers, setTriggers] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchTriggers = useCallback(async (id) => {
    if (!id) { setTriggers([]); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${id}/triggers`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTriggers(Array.isArray(data) ? data : []);
      setLastFetch(Date.now());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    fetchTriggers(agentId);
    const timer = setInterval(() => fetchTriggers(agentId), POLL_MS);
    return () => clearInterval(timer);
  }, [agentId, active, fetchTriggers]);

  // Toolbar
  const toolbar = (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-2) var(--eb-space-4)',
      borderBottom: '1px solid var(--eb-border-default)',
      flexShrink: 0,
      background: 'var(--eb-bg-surface)',
      minHeight: 36,
    }}>
      <span style={{ flex: 1, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        {loading
          ? 'Loading…'
          : triggers.length > 0
            ? `${triggers.length} trigger${triggers.length === 1 ? '' : 's'}`
            : agentId ? 'No triggers' : ''}
      </span>
      <button
        onClick={() => fetchTriggers(agentId)}
        disabled={loading || !agentId}
        title="Refresh"
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--eb-text-muted)',
          cursor: agentId ? 'pointer' : 'default',
          padding: 2,
          display: 'flex',
          alignItems: 'center',
          opacity: (!agentId || loading) ? 0.4 : 1,
        }}
      >
        <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
      </button>
    </div>
  );

  if (!agentId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {toolbar}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-4)' }}>
          Select an agent to view its triggers.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {toolbar}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && triggers.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-6)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            Loading triggers…
          </div>
        )}

        {error && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-4)', color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            Failed to load triggers: {error}
          </div>
        )}

        {!loading && !error && triggers.length === 0 && (
          <div style={{ padding: 'var(--eb-space-6)', textAlign: 'center', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', lineHeight: 1.5 }}>
            No scheduled triggers configured for this agent.
          </div>
        )}

        {triggers.map((t, i) => (
          <TriggerRow key={t.id || i} trigger={t} />
        ))}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
