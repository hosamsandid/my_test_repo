import React, { useState, useCallback } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';

/* ── Tab bar ───────────────────────────────────────────────────────── */
function TabBar({ tabs, active, onChange }) {
  return (
    <div role="tablist" style={{
      display: 'flex', gap: 'var(--eb-space-1)',
      borderBottom: '1px solid var(--eb-border-default)',
      marginBottom: 'var(--eb-space-4)',
    }}>
      {tabs.map(tab => (
        <button
          key={tab}
          role="tab"
          aria-selected={active === tab}
          onClick={() => onChange(tab)}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: active === tab ? 'var(--eb-bg-selected)' : 'transparent',
            border: 'none',
            borderBottom: active === tab ? '2px solid var(--eb-accent-primary)' : '2px solid transparent',
            color: active === tab ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
            cursor: 'pointer',
            fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)',
            fontFamily: 'inherit',
          }}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

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

/* ── Job form ──────────────────────────────────────────────────────── */
function JobForm({ onSave, onCancel, agentOptions, showAgentSelect }) {
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
      {showAgentSelect && agentOptions && agentOptions.length > 0 && (
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
          Add Job
        </button>
        <button onClick={onCancel} style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)', cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Bridge jobs tab ───────────────────────────────────────────────── */
function BridgeJobsTab() {
  const { data: jobs, loading, error, refetch } = useApi('/api/jobs');
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const COLS = [
    { key: 'id',          label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'type',        label: 'Type' },
    { key: 'schedule',    label: 'Schedule', render: (_, row) => row.cron || row.at || '—' },
    { key: 'description', label: 'Description' },
    { key: 'enabled',     label: 'Enabled', sortable: false, render: (v, row) => (
      <ToggleSwitch
        checked={v !== false}
        label="Toggle enabled"
        onChange={async (val) => {
          await apiCall('PUT', `/api/jobs/${row.id}`, { enabled: val });
          refetch();
        }}
      />
    )},
    { key: '_del', label: '', sortable: false, render: (_, row) => (
      <button
        onClick={e => { e.stopPropagation(); setDeleteTarget(row); }}
        title="Delete job"
        style={{ background: 'none', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-status-error)', cursor: 'pointer', padding: '2px 6px' }}
      >
        <Trash2 size={13} />
      </button>
    )},
  ];

  if (loading) return <div style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  if (error) return <div role="alert" style={{ color: 'var(--eb-status-error)' }}>Failed to load jobs: {error}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => setAddOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit' }}>
          <Plus size={14} /> Add Job
        </button>
      </div>
      <DataTable columns={COLS} data={jobs ?? []} emptyText="No bridge jobs configured." />

      <SidePanel open={addOpen} onClose={() => setAddOpen(false)} title="Add Bridge Job">
        <JobForm
          onSave={async form => {
            const body = { id: form.id || undefined, type: form.type, description: form.description, prompt: form.prompt, enabled: form.enabled };
            if (form.type === 'cron') body.cron = form.cron;
            else body.at = form.at;
            await apiCall('POST', '/api/jobs', body);
            setAddOpen(false);
            refetch();
          }}
          onCancel={() => setAddOpen(false)}
          showAgentSelect={false}
        />
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Job"
        message={`Delete job "${deleteTarget?.id}"?`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={async () => { await apiCall('DELETE', `/api/jobs/${deleteTarget.id}`); setDeleteTarget(null); refetch(); }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

/* ── Agent triggers tab ────────────────────────────────────────────── */
function AgentTriggersTab() {
  const { data: agents, loading: agentsLoading } = useApi('/api/agents');
  const [triggers, setTriggers] = useState([]);
  const [triggersLoading, setTriggersLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const loadAllTriggers = useCallback(async (agentList) => {
    if (!agentList || agentList.length === 0) return;
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

  if (agentsLoading || triggersLoading) return <div style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => setAddOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit' }}>
          <Plus size={14} /> Add Trigger
        </button>
      </div>
      <DataTable columns={COLS} data={triggers} emptyText="No agent triggers configured." />

      <SidePanel open={addOpen} onClose={() => setAddOpen(false)} title="Add Agent Trigger">
        <JobForm
          showAgentSelect
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

/* ── Main ──────────────────────────────────────────────────────────── */
export default function ScheduledJobs() {
  const [tab, setTab] = useState('Bridge Jobs');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
        Scheduled Jobs
      </h1>
      <TabBar tabs={['Bridge Jobs', 'Agent Triggers']} active={tab} onChange={setTab} />
      {tab === 'Bridge Jobs' ? <BridgeJobsTab /> : <AgentTriggersTab />}
    </div>
  );
}
