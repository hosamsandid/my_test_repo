import React, { useState } from 'react';
import { Plus, Edit, Trash2 } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';

function ModelForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({
    id:       initial?.id       || '',
    name:     initial?.name     || '',
    resource: initial?.resource || '',
  });
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isEdit = !!initial;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <FormInput label="ID" value={form.id} onChange={v => update('id', v)} disabled={isEdit} placeholder="e.g. default" />
      <FormInput label="Model Name (Azure deployment)" value={form.name} onChange={v => update('name', v)} placeholder="claude-sonnet-4-6" />
      <FormInput label="Azure Foundry Resource" value={form.resource} onChange={v => update('resource', v)} placeholder="claude-code-ai-eastus2" />

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={() => onSave(form)}
          style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          {isEdit ? 'Save Changes' : 'Add Model'}
        </button>
        <button
          onClick={onCancel}
          style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)', cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function ModelRegistry() {
  const { data: models, loading, error, refetch } = useApi('/api/models');
  const [panelOpen, setPanelOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);

  const COLS = [
    { key: 'id',       label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'name',     label: 'Model / Deployment' },
    { key: 'resource', label: 'Azure Resource' },
    { key: '_actions', label: '', sortable: false, render: (_, row) => (
      <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
        <button
          title="Edit"
          onClick={() => { setEditTarget(row); setPanelOpen(true); }}
          style={{ background: 'none', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)', cursor: 'pointer', padding: '2px 6px' }}
        ><Edit size={13} /></button>
        <button
          title="Delete"
          onClick={() => setDeleteTarget(row)}
          style={{ background: 'none', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-status-error)', cursor: 'pointer', padding: '2px 6px' }}
        ><Trash2 size={13} /></button>
      </div>
    )},
  ];

  if (loading) return <div style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  if (error) return <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>Failed to load models: {error}</div>;

  async function handleSave(form) {
    try {
      if (editTarget) {
        await apiCall('PUT', `/api/models/${editTarget.id}`, form);
      } else {
        await apiCall('POST', '/api/models', form);
      }
      setPanelOpen(false);
      setEditTarget(null);
      refetch();
    } catch (e) {
      setActionError(e.message);
    }
  }

  async function handleDelete() {
    try {
      await apiCall('DELETE', `/api/models/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetch();
    } catch (e) {
      setActionError(e.message);
      setDeleteTarget(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
          Model Registry
        </h1>
        <button
          onClick={() => { setEditTarget(null); setPanelOpen(true); }}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <Plus size={14} /> Add Model
        </button>
      </div>

      {actionError && (
        <div role="alert" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--eb-status-error)' }}>Dismiss</button>
        </div>
      )}

      <DataTable columns={COLS} data={models ?? []} emptyText="No models configured." />

      <SidePanel
        open={panelOpen}
        onClose={() => { setPanelOpen(false); setEditTarget(null); }}
        title={editTarget ? 'Edit Model' : 'Add Model'}
      >
        <ModelForm
          initial={editTarget}
          onSave={handleSave}
          onCancel={() => { setPanelOpen(false); setEditTarget(null); }}
        />
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Model"
        message={`Delete model "${deleteTarget?.id}" (${deleteTarget?.name})?`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
