import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Clock, CalendarClock, CheckCircle2, XCircle, Loader2, AlertCircle, Plus, Trash2 } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import SidePanel from '../../components/SidePanel';
import ConfirmDialog from '../../components/ConfirmDialog';
import FormInput from '../../components/FormInput';

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
  const isCron = type === 'cron' || type === 'recurring';
  const isOnce = type === 'once';
  const bg    = isCron ? 'var(--eb-accent-muted)'    : isOnce ? 'var(--eb-bg-elevated)'    : 'var(--eb-status-warning-bg)';
  const color = isCron ? 'var(--eb-accent-primary)'  : isOnce ? 'var(--eb-text-secondary)' : 'var(--eb-status-warning)';
  const label = isCron ? 'cron' : isOnce ? 'once' : type || 'unknown';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '1px 6px', borderRadius: 'var(--eb-radius-full)',
      fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
      background: bg, color, border: `1px solid ${color}`, whiteSpace: 'nowrap',
    }}>
      {isCron ? <Clock size={10} /> : <CalendarClock size={10} />}
      {label}
    </span>
  );
}

/* ── Trigger row ────────────────────────────────────────────────────── */
function TriggerRow({ trigger, agentId, onDeleted, onToggled }) {
  const [toggling, setToggling] = useState(false);
  const schedule = trigger.cron || trigger.at || '—';

  async function handleToggle(val) {
    setToggling(true);
    try {
      await apiCall('PUT', `/api/agents/${agentId}/triggers/${trigger.id}`, { enabled: val });
      onToggled();
    } catch { /* surface via refresh */ }
    finally { setToggling(false); }
  }

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
          style={{
            background: 'none', border: '1px solid var(--eb-status-error)',
            borderRadius: 'var(--eb-radius-sm)', color: 'var(--eb-status-error)',
            cursor: 'pointer', padding: '1px 5px', display: 'flex', alignItems: 'center', flexShrink: 0,
          }}
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

/* ── Add-trigger form ───────────────────────────────────────────────── */
function TriggerForm({ onSave, onCancel, saving }) {
  const [form, setForm] = useState({
    id: '', type: 'cron', cron: '', at: '',
    description: '', prompt: '', enabled: true,
  });
  const [error, setError] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function submit() {
    setError(null);
    if (form.type === 'cron' && !form.cron.trim()) { setError('Cron expression is required.'); return; }
    if (form.type === 'once' && !form.at.trim())   { setError('Run-at timestamp is required.'); return; }
    if (!form.prompt.trim()) { setError('Prompt is required.'); return; }
    const body = {
      id: form.id.trim() || undefined,
      type: form.type,
      description: form.description.trim() || undefined,
      prompt: form.prompt.trim(),
      enabled: form.enabled,
    };
    if (form.type === 'cron') body.cron = form.cron.trim();
    else body.at = form.at.trim();
    await onSave(body);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>

      <FormInput
        label="ID (optional)"
        value={form.id}
        onChange={v => set('id', v)}
        placeholder="e.g. daily-report (auto-generated if empty)"
      />

      <div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-0-5)' }}>
          Type
        </div>
        <select
          value={form.type}
          onChange={e => set('type', e.target.value)}
          style={{
            width: '100%', padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)',
            fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', outline: 'none',
          }}
        >
          <option value="cron">Cron (recurring)</option>
          <option value="once">Once (one-shot)</option>
        </select>
      </div>

      {form.type === 'cron' ? (
        <FormInput
          label="Cron expression"
          value={form.cron}
          onChange={v => set('cron', v)}
          placeholder="48 * * * *  (every hour at :48)"
        />
      ) : (
        <FormInput
          label="Run at (ISO timestamp)"
          value={form.at}
          onChange={v => set('at', v)}
          placeholder="2026-05-07T15:00:00"
        />
      )}

      <FormInput
        label="Description (optional)"
        value={form.description}
        onChange={v => set('description', v)}
      />

      <FormInput
        label="Prompt"
        value={form.prompt}
        onChange={v => set('prompt', v)}
        multiline
        rows={4}
        placeholder="What should the agent do when this trigger fires?"
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
        <ToggleSwitch checked={form.enabled} onChange={v => set('enabled', v)} />
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          Enabled
        </span>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>
          <AlertCircle size={13} style={{ flexShrink: 0 }} />
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={submit}
          disabled={saving}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />}
          Add Trigger
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
            cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Main panel ─────────────────────────────────────────────────────── */
/**
 * Read/write panel listing and managing the scheduled triggers for the
 * selected agent. Polls every 30 s for changes the agent itself makes.
 */
export default function TriggersPanel({ agentId, active }) {
  const [triggers, setTriggers]   = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);

  const [addOpen, setAddOpen]       = useState(false);
  const [saving, setSaving]         = useState(false);
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

  async function handleSave(body) {
    setSaving(true);
    try {
      await apiCall('POST', `/api/agents/${agentId}/triggers`, body);
      setAddOpen(false);
      fetchTriggers(agentId);
    } catch (e) {
      // Re-throw so TriggerForm can show the error
      throw e;
    } finally {
      setSaving(false);
    }
  }

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
      <button
        onClick={() => setAddOpen(true)}
        disabled={!agentId}
        title="Add trigger"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          padding: '2px 8px', fontSize: 'var(--eb-text-xs)',
          fontFamily: 'inherit', fontWeight: 'var(--eb-font-medium)',
          background: agentId ? 'var(--eb-accent-primary)' : 'var(--eb-bg-elevated)',
          color: agentId ? 'var(--eb-text-inverted)' : 'var(--eb-text-muted)',
          border: 'none', borderRadius: 'var(--eb-radius-sm)',
          cursor: agentId ? 'pointer' : 'not-allowed',
          opacity: agentId ? 1 : 0.5,
        }}
      >
        <Plus size={11} /> Add
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

      <SidePanel open={addOpen} onClose={() => setAddOpen(false)} title="Add Trigger">
        <TriggerForm
          saving={saving}
          onSave={handleSave}
          onCancel={() => setAddOpen(false)}
        />
      </SidePanel>

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
