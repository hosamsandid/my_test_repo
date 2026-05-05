import React, { useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';

const inputStyle = {
  width: '100%',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box',
};

function CreateForm({ onSave, onCancel, saving, error }) {
  const [name, setName] = useState('');
  const [token, setToken] = useState('');

  const canSubmit = name.trim() && token.trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{error}</div>
      )}

      <FormInput
        label="Name *"
        value={name}
        onChange={setName}
        placeholder="e.g. AccentureCodeFoundry PAT"
      />

      <div>
        <div style={{
          fontSize: 'var(--eb-text-sm)',
          fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-secondary)',
          marginBottom: 'var(--eb-space-1)',
        }}>
          GitHub token <span style={{ color: 'var(--eb-status-error)' }}>*</span>
        </div>
        <textarea
          value={token}
          onChange={e => setToken(e.target.value)}
          rows={3}
          placeholder="github_pat_… or ghp_…"
          style={{
            ...inputStyle,
            resize: 'vertical',
            fontFamily: 'var(--eb-font-mono)',
            fontSize: 'var(--eb-text-xs)',
          }}
        />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Personal Access Token (fine-grained or classic). Stored in the workspace volume (chmod 600) and never returned by the API again — you will only see a preview and fingerprint.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={() => onSave({ name: name.trim(), token: token.trim() })}
          disabled={saving || !canSubmit}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit',
            opacity: (saving || !canSubmit) ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save token'}
        </button>
        <button
          onClick={onCancel}
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

export default function GithubTokens() {
  const { data: tokens, loading, error, refetch } = useApi('/api/github-tokens');
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const COLUMNS = [
    { key: 'id', label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'name', label: 'Name' },
    { key: 'preview', label: 'Token', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v}</span> },
    { key: 'fingerprint', label: 'Fingerprint', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{v}</span> },
    { key: 'createdAt', label: 'Added', render: v => v ? new Date(v).toLocaleString() : '—' },
    {
      key: '_actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
          <button
            aria-label="Delete"
            onClick={() => setDeleteTarget(row)}
            title="Delete"
            style={{
              display: 'flex', alignItems: 'center',
              padding: 'var(--eb-space-1) var(--eb-space-2)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-status-error)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-status-error)',
              cursor: 'pointer', fontSize: 'var(--eb-text-xs)',
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ),
    },
  ];

  async function handleSave({ name, token }) {
    setSaving(true); setFormError(null);
    try {
      await apiCall('POST', '/api/github-tokens', { name, token });
      setCreating(false);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await apiCall('DELETE', `/api/github-tokens/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetch();
    } catch (e) {
      setActionError(e.message);
      setDeleteTarget(null);
    }
  }

  if (loading) {
    return <div aria-busy="true" style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }
  if (error) {
    return <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>Failed to load: {error}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
          GitHub Tokens
        </h1>
        <button
          onClick={() => { setCreating(true); setFormError(null); }}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <Plus size={15} /> New Token
        </button>
      </div>

      <div style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
      }}>
        GitHub Personal Access Tokens are exposed to agents as <code>GH_TOKEN</code> / <code>GITHUB_TOKEN</code> when their Working Environment references the token. The raw value is stored in the workspace volume and never returned again — only a preview and fingerprint are visible.
      </div>

      {actionError && (
        <div role="alert" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)' }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer' }}>Dismiss</button>
        </div>
      )}

      <DataTable
        columns={COLUMNS}
        data={tokens ?? []}
        emptyText="No GitHub tokens stored yet."
      />

      <SidePanel
        open={creating}
        onClose={() => setCreating(false)}
        title="New GitHub token"
        width="560px"
      >
        {creating && (
          <CreateForm
            onSave={handleSave}
            onCancel={() => setCreating(false)}
            saving={saving}
            error={formError}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete GitHub token"
        message={`Really delete "${deleteTarget?.name || deleteTarget?.id}"? Working Environments using this token must remove it first.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
