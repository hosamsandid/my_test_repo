import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Clock, CalendarClock, CheckCircle2, XCircle, Loader2, AlertCircle, Trash2, Globe, Github, Info } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import ConfirmDialog from '../../components/ConfirmDialog';

const POLL_MS = 30_000;

/* ── Toggle switch ──────────────────────────────────────────────────── */
function ToggleSwitch({ checked, onChange }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      style={{
        width: 28, height: 16,
        borderRadius: 'var(--eb-radius-full)',
        border: 'none',
        background: checked ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)',
        position: 'relative',
        cursor: 'pointer',
        transition: 'background var(--eb-transition-fast)',
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 12 : 2,
        width: 12, height: 12, borderRadius: '50%',
        background: 'white',
        transition: 'left var(--eb-transition-fast)',
      }} />
    </button>
  );
}

/* ── Type badge ─────────────────────────────────────────────────────── */
function TypeBadge({ type }) {
  const isCron   = type === 'cron' || type === 'recurring';
  const isOnce   = type === 'once';
  const isHttp   = type === 'http';
  const isGithub = type === 'github-event';
  let bg, color, label, Icon;
  if (isCron) {
    bg = 'var(--eb-accent-muted)'; color = 'var(--eb-accent-primary)'; label = 'cron'; Icon = Clock;
  } else if (isOnce) {
    bg = 'var(--eb-bg-elevated)'; color = 'var(--eb-text-secondary)'; label = 'once'; Icon = CalendarClock;
  } else if (isHttp) {
    bg = 'var(--eb-status-success-bg)'; color = 'var(--eb-status-success)'; label = 'http'; Icon = Globe;
  } else if (isGithub) {
    bg = 'var(--eb-status-info-bg, var(--eb-accent-muted))'; color = 'var(--eb-status-info, var(--eb-accent-primary))'; label = 'github'; Icon = Github;
  } else {
    bg = 'var(--eb-status-warning-bg)'; color = 'var(--eb-status-warning)'; label = type || 'unknown'; Icon = AlertCircle;
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '1px 6px', borderRadius: 'var(--eb-radius-full)',
      fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
      background: bg, color, border: `1px solid ${color}`, whiteSpace: 'nowrap',
    }}>
      <Icon size={10} />
      {label}
    </span>
  );
}

/* ── Trigger row ────────────────────────────────────────────────────── */
function TriggerRow({ trigger, agentId, onDeleted, onToggled }) {
  const [toggling, setToggling] = useState(false);
  let schedule;
  if (trigger.type === 'http') {
    schedule = `/hooks/${agentId}/${trigger.id}`;
  } else if (trigger.type === 'github-event') {
    const evCount = Array.isArray(trigger.events) ? trigger.events.length : 0;
    schedule = `${trigger.repo || '?'} · ${evCount} event${evCount === 1 ? '' : 's'}`;
  } else {
    schedule = trigger.cron || trigger.at || '—';
  }

  async function handleToggle(val) {
    setToggling(true);
    try {
      await apiCall('PUT', `/api/agents/${agentId}/triggers/${trigger.id}`, { enabled: val });
      onToggled();
    } catch { /* surface via refresh */ }
    finally { setToggling(false); }
  }

  const iconBtn = {
    background: 'none', border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-sm)', color: 'var(--eb-text-muted)',
    cursor: 'pointer', padding: '1px 5px', display: 'flex', alignItems: 'center', flexShrink: 0,
  };

  return (
    <div style={{
      padding: 'var(--eb-space-3) var(--eb-space-4)',
      borderBottom: '1px solid var(--eb-border-default)',
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <TypeBadge type={trigger.type} />
        <code style={{
          flex: 1, fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)',
          color: 'var(--eb-text-primary)', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {schedule}
        </code>
        {toggling
          ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', color: 'var(--eb-text-muted)', flexShrink: 0 }} />
          : trigger.enabled !== false
            ? <CheckCircle2 size={14} style={{ color: 'var(--eb-status-success)', flexShrink: 0 }} title="Enabled" />
            : <XCircle     size={14} style={{ color: 'var(--eb-text-muted)',      flexShrink: 0 }} title="Disabled" />
        }
        <button
          onClick={() => onDeleted(trigger)}
          title="Delete trigger"
          style={{ ...iconBtn, border: '1px solid var(--eb-status-error)', color: 'var(--eb-status-error)' }}
        >
          <Trash2 size={11} />
        </button>
      </div>

      {trigger.id && (
        <div style={{ fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-muted)' }}>
          {trigger.id}
        </div>
      )}

      {trigger.description && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.4 }}>
          {trigger.description}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginTop: 2 }}>
        <ToggleSwitch checked={trigger.enabled !== false} onChange={handleToggle} />
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          {trigger.enabled !== false ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      {trigger.prompt && (
        <div style={{
          fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.4,
          padding: 'var(--eb-space-1) var(--eb-space-2)', background: 'var(--eb-bg-elevated)',
          borderRadius: 'var(--eb-radius-sm)', overflow: 'hidden',
          display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
        }}>
          {trigger.prompt}
        </div>
      )}
    </div>
  );
}

/* ── Info box ───────────────────────────────────────────────────────── */
function InfoBox() {
  return (
    <div style={{
      margin: 'var(--eb-space-3) var(--eb-space-4)',
      padding: 'var(--eb-space-3)',
      background: 'var(--eb-accent-muted)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-md)',
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', color: 'var(--eb-accent-primary)' }}>
        <Info size={13} style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)' }}>
          About Triggers
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
        Triggers define when this agent runs automatically — without a human message. The agent
        manages its own <code style={{ fontFamily: 'var(--eb-font-mono)' }}>triggers.json</code> and
        can add, modify, or remove entries at any time.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[
          { badge: 'cron',   color: 'var(--eb-accent-primary)',   bg: 'var(--eb-accent-muted)',        desc: 'Recurring schedule (cron expression)' },
          { badge: 'once',   color: 'var(--eb-text-secondary)',    bg: 'var(--eb-bg-elevated)',          desc: 'One-shot run at a specific date/time' },
          { badge: 'http',   color: 'var(--eb-status-success)',    bg: 'var(--eb-status-success-bg)',    desc: 'Fired by an external HTTP webhook POST' },
          { badge: 'github', color: 'var(--eb-status-info, var(--eb-accent-primary))', bg: 'var(--eb-status-info-bg, var(--eb-accent-muted))', desc: 'Fires on matching GitHub repository events' },
        ].map(({ badge, color, bg, desc }) => (
          <div key={badge} style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', padding: '1px 6px',
              borderRadius: 'var(--eb-radius-full)', fontSize: 'var(--eb-text-xs)',
              fontWeight: 'var(--eb-font-medium)', background: bg, color,
              border: `1px solid ${color}`, whiteSpace: 'nowrap', minWidth: 52, justifyContent: 'center',
            }}>
              {badge}
            </span>
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{desc}</span>
          </div>
        ))}
      </div>
      <p style={{ margin: 0, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>
        To add new triggers, ask the agent directly in the chat. You can enable, disable, or delete
        existing triggers here.
      </p>
    </div>
  );
}

/* ── Main panel ─────────────────────────────────────────────────────── */
export default function TriggersPanel({ agentId, active }) {
  const [triggers, setTriggers]   = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const fetchTriggers = useCallback(async (id) => {
    if (!id) { setTriggers([]); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${id}/triggers`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTriggers(Array.isArray(data) ? data : []);
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

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await apiCall('DELETE', `/api/agents/${agentId}/triggers/${deleteTarget.id}`);
      setDeleteTarget(null);
      fetchTriggers(agentId);
    } catch (e) {
      setError(`Delete failed: ${e.message}`);
      setDeleteTarget(null);
    }
  }

  /* ── Toolbar ──────────────────────────────────────────────────────── */
  const toolbar = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-2) var(--eb-space-4)',
      borderBottom: '1px solid var(--eb-border-default)',
      flexShrink: 0, background: 'var(--eb-bg-surface)', minHeight: 36,
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
          background: 'none', border: 'none', color: 'var(--eb-text-muted)',
          cursor: agentId ? 'pointer' : 'default', padding: 2,
          display: 'flex', alignItems: 'center',
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
        <InfoBox />

        {loading && triggers.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-6)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            Loading triggers…
          </div>
        )}

        {error && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-4)', color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            {error}
          </div>
        )}

        {!loading && !error && triggers.length === 0 && (
          <div style={{ padding: 'var(--eb-space-6)', textAlign: 'center', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', lineHeight: 1.5 }}>
            No scheduled triggers configured for this agent.
          </div>
        )}

        {triggers.map((t, i) => (
          <TriggerRow
            key={t.id || i}
            trigger={t}
            agentId={agentId}
            onDeleted={setDeleteTarget}
            onToggled={() => fetchTriggers(agentId)}
          />
        ))}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Trigger"
        message={`Delete trigger "${deleteTarget?.id}"? This cannot be undone.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
