import React, { useState, useCallback } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';

/* ── Toggle switch ─────────────────────────────────────────────────── */
function ToggleSwitch({ checked, onChange, label }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      style={{
        width: 36, height: 20,
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
        position: 'absolute', top: 2, left: checked ? 18 : 2,
        width: 16, height: 16, borderRadius: '50%',
        background: 'white',
        transition: 'left var(--eb-transition-fast)',
      }} />
    </button>
  );
}

/* ── Trigger form ──────────────────────────────────────────────────── */
function TriggerForm({ onSave, onCancel, agentOptions }) {
  const [form, setForm] = useState({
    agentId: agentOptions?.[0]?.id || '',
    id: '',
    type: 'cron',
    cron: '',
    at: '',
    description: '',
    prompt: '',
    enabled: true,
  });
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {agentOptions && agentOptions.length > 0 && (
        <div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-0-5)' }}>Agent</div>
          <select
            value={form.agentId}
            onChange={e => update('agentId', e.target.value)}
            style={{ width: '100%', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', outline: 'none' }}
          >
            {agentOptions.map(a => <option key={a.id} value={a.id}>{a.displayName || a.id}</option>)}
          </select>
        </div>
      )}

      <FormInput label="ID" value={form.id} onChange={v => update('id', v)} placeholder="e.g. daily-report" />

      <div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-0-5)' }}>Type</div>
        <select value={form.type} onChange={e => update('type', e.target.value)}
          style={{ width: '100%', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', outline: 'none' }}
        >
          <option value="cron">Cron (recurring)</option>
          <option value="once">Once (one-shot)</option>
        </select>
      </div>

      {form.type === 'cron' ? (
        <FormInput label="Cron expression" value={form.cron} onChange={v => update('cron', v)} placeholder="0 9 * * 1-5" />
      ) : (
        <FormInput label="Run at (ISO timestamp)" value={form.at} onChange={v => update('at', v)} placeholder="2026-05-01T09:00:00Z" />
      )}

      <FormInput label="Description" value={form.description} onChange={v => update('description', v)} />

      <FormInput label="Prompt" value={form.prompt} onChange={v => update('prompt', v)} multiline rows={4} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
        <ToggleSwitch checked={form.enabled} onChange={v => update('enabled', v)} label="Enabled" />
        <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Enabled</span>
      </div>

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button onClick={() => onSave(form)} style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}>
          Add Trigger
        </button>
        <button onClick={onCancel} style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)', cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Main page ─────────────────────────────────────────────────────── */
export default function ScheduledJobs() {
  const { data: agents, loading: agentsLoading } = useApi('/api/agents');
  const [triggers, setTriggers] = useState([]);
  const [triggersLoading, setTriggersLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const loadAllTriggers = useCallback(async (agentList) => {
    if (!agentList || agentList.length === 0) {
      setTriggers([]);
      return;
    }
    setTriggersLoading(true);
    const results = await Promise.all(
      agentList.map(async a => {
        try {
          const res = await fetch(`/api/agents/${a.id}/triggers`);
          const data = res.ok ? await res.json() : [];
          return (Array.isArray(data) ? data : []).map(t => ({
            ...t,
            _agentId: a.id,
            _agentName: a.displayName || a.id,
          }));
        } catch { return []; }
      })
    );
    setTriggers(results.flat());
    setTriggersLoading(false);
  }, []);

  React.useEffect(() => {
    if (agents) loadAllTriggers(agents);
  }, [agents, loadAllTriggers]);

  const COLS = [
    { key: '_agentName', label: 'Agent' },
    { key: 'id',          label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'type',        label: 'Type' },
    { key: 'schedule',    label: 'Schedule', render: (_, row) => row.cron || row.at || '—' },
    { key: 'description', label: 'Description' },
    { key: 'enabled',     label: 'Enabled', sortable: false, render: (v, row) => (
      <ToggleSwitch
        checked={v !== false}
        label="Toggle enabled"
        onChange={async (val) => {
          await apiCall('PUT', `/api/agents/${row._agentId}/triggers/${row.id}`, { enabled: val });
          loadAllTriggers(agents);
        }}
      />
    )},
    { key: '_del', label: '', sortable: false, render: (_, row) => (
      <button
        onClick={e => { e.stopPropagation(); setDeleteTarget(row); }}
        title="Delete trigger"
        style={{ background: 'none', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-status-error)', cursor: 'pointer', padding: '2px 6px' }}
      >
        <Trash2 size={13} />
      </button>
    )},
  ];

  const skeleton = agentsLoading || triggersLoading;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
        Scheduled Triggers
      </h1>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => setAddOpen(true)} disabled={!agents || agents.length === 0} style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit', opacity: (!agents || agents.length === 0) ? 0.5 : 1 }}>
          <Plus size={14} /> Add Trigger
        </button>
      </div>

      {skeleton ? (
        <div style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
      ) : (
        <DataTable columns={COLS} data={triggers} emptyText="No triggers configured. Add one to schedule recurring or one-shot agent runs." />
      )}

      <SidePanel open={addOpen} onClose={() => setAddOpen(false)} title="Add Trigger">
        <TriggerForm
          agentOptions={agents ?? []}
          onSave={async form => {
            const body = { id: form.id || undefined, type: form.type, description: form.description, prompt: form.prompt, enabled: form.enabled };
            if (form.type === 'cron') body.cron = form.cron;
            else body.at = form.at;
            await apiCall('POST', `/api/agents/${form.agentId}/triggers`, body);
            setAddOpen(false);
            loadAllTriggers(agents);
          }}
          onCancel={() => setAddOpen(false)}
        />
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Trigger"
        message={`Delete trigger "${deleteTarget?.id}" from agent "${deleteTarget?._agentName}"?`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={async () => {
          await apiCall('DELETE', `/api/agents/${deleteTarget._agentId}/triggers/${deleteTarget.id}`);
          setDeleteTarget(null);
          loadAllTriggers(agents);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
