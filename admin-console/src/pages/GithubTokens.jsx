import React, { useState } from 'react';
import { Trash2, Plus, ChevronDown, ChevronRight } from 'lucide-react';
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

function StepGuide({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-md)',
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
          width: '100%', textAlign: 'left',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-bg-elevated)',
          border: 'none', cursor: 'pointer',
          fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-secondary)', fontFamily: 'inherit',
        }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {title}
      </button>
      {open && (
        <div style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-bg-surface)',
          borderTop: '1px solid var(--eb-border-default)',
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-secondary)',
          lineHeight: '1.6',
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

function Step({ n, children }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-2)' }}>
      <span style={{
        flexShrink: 0,
        width: 18, height: 18,
        borderRadius: '50%',
        background: 'var(--eb-accent-primary)',
        color: 'var(--eb-text-inverted)',
        fontSize: 10,
        fontWeight: 'var(--eb-font-semibold)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{n}</span>
      <div style={{ paddingTop: 1 }}>{children}</div>
    </div>
  );
}

function PermissionRow({ scope, access, note }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'baseline', marginBottom: 2 }}>
      <code style={{ fontFamily: 'var(--eb-font-mono)', fontSize: '0.95em', minWidth: 120, color: 'var(--eb-text-primary)' }}>{scope}</code>
      <span style={{ color: 'var(--eb-accent-primary)', fontWeight: 'var(--eb-font-medium)', minWidth: 90 }}>{access}</span>
      {note && <span style={{ color: 'var(--eb-text-muted)' }}>{note}</span>}
    </div>
  );
}

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

      <StepGuide title="How to create a GitHub Enterprise Personal Access Token" defaultOpen={true}>
        <Step n={1}>
          Sign in to your <strong>GitHub Enterprise</strong> instance (e.g.{' '}
          <code style={{ fontFamily: 'var(--eb-font-mono)' }}>https://github.example.com</code>).
        </Step>
        <Step n={2}>
          Click your <strong>profile picture</strong> in the top-right corner, then choose <strong>Settings</strong>.
        </Step>
        <Step n={3}>
          Scroll down in the left sidebar to <strong>Developer settings</strong>, then open{' '}
          <strong>Personal access tokens</strong>.
          <div style={{ marginTop: 'var(--eb-space-1)', color: 'var(--eb-text-muted)' }}>
            Choose <strong>Fine-grained tokens</strong> (recommended — more precise control) or <strong>Tokens (classic)</strong>.
          </div>
        </Step>
        <Step n={4}>
          Click <strong>Generate new token</strong>. Enter a descriptive name (e.g. <em>AEE Agent Token</em>) and set an expiry date.
          For fine-grained tokens, select the repositories the agents should have access to.
        </Step>
        <Step n={5}>
          Set the required permissions:
          <div style={{ marginTop: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-1)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
            Fine-grained token — Repository permissions:
          </div>
          <div style={{ paddingLeft: 'var(--eb-space-2)' }}>
            <PermissionRow scope="Contents" access="Read & write" note="clone, commit, push" />
            <PermissionRow scope="Metadata" access="Read-only" note="required baseline" />
            <PermissionRow scope="Pull requests" access="Read & write" note="if agents open PRs" />
            <PermissionRow scope="Workflows" access="Read & write" note="if agents trigger CI" />
          </div>
          <div style={{ marginTop: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-1)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
            Classic token — select scope:
          </div>
          <div style={{ paddingLeft: 'var(--eb-space-2)' }}>
            <PermissionRow scope="repo" access="Full control" note="covers all repository operations" />
          </div>
        </Step>
        <Step n={6}>
          Click <strong>Generate token</strong>. Copy the token value immediately — GitHub will not show it again.
          Then paste it in the field below.
        </Step>
        <div style={{ marginTop: 'var(--eb-space-1)', color: 'var(--eb-text-muted)', fontSize: '0.9em' }}>
          The token is stored securely in the workspace volume (mode 600) and is never returned by the API —
          only a short preview and fingerprint are shown afterwards.
        </div>
      </StepGuide>

      <FormInput
        label="Name *"
        value={name}
        onChange={setName}
        placeholder="e.g. AccentureCodeFoundry PAT"
        hint="A label to identify this token — for example the GitHub account or organisation it belongs to."
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
          Paste the full token value. Fine-grained tokens start with <code style={{ fontFamily: 'var(--eb-font-mono)' }}>github_pat_</code>,
          classic tokens with <code style={{ fontFamily: 'var(--eb-font-mono)' }}>ghp_</code>.
          The value is stored securely and will never be shown again — only a preview and fingerprint remain visible.
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
        lineHeight: '1.6',
      }}>
        <strong>GitHub Personal Access Tokens (PAT)</strong> allow agents to interact with GitHub — for example to push commits, open pull requests, or use the <code>gh</code> CLI.
        Once a token is linked to a Working Environment it is injected as <code>GH_TOKEN</code> / <code>GITHUB_TOKEN</code> into every agent process in that environment.
        The raw token value is stored securely and is <strong>never</strong> returned by the API after creation — only a preview (prefix + last 4 characters) and a fingerprint are displayed.
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
        emptyText="No GitHub tokens stored yet. Click 'New Token' to add one."
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
