import React, { useState, useEffect, useRef } from 'react';
import { Trash2, Plus, ChevronDown, ChevronRight, Terminal, KeyRound, ClipboardPaste, Copy, Check, ExternalLink } from 'lucide-react';
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

function CodeLine({ children }) {
  return (
    <code style={{
      display: 'block',
      margin: 'var(--eb-space-1) 0',
      padding: 'var(--eb-space-1) var(--eb-space-2)',
      background: 'var(--eb-bg-elevated)',
      borderRadius: 'var(--eb-radius-sm)',
      fontFamily: 'var(--eb-font-mono)',
      fontSize: 'var(--eb-text-xs)',
      color: 'var(--eb-text-primary)',
      wordBreak: 'break-all',
    }}>{children}</code>
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

function ModeTab({ active, onClick, icon: Icon, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
        padding: 'var(--eb-space-2) var(--eb-space-3)',
        background: active ? 'var(--eb-bg-elevated)' : 'transparent',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
        fontSize: 'var(--eb-text-sm)', fontWeight: active ? 'var(--eb-font-medium)' : 'normal',
        cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      <Icon size={13} /> {children}
    </button>
  );
}

function PublicKeyReveal({ publicKey, onDone }) {
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(copyResetTimerRef.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
      clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be unavailable */ }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
        color: 'var(--eb-status-success)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
      }}>
        <Check size={15} /> Keypair generated — copy the public key to GitHub
      </div>
      <textarea
        readOnly value={publicKey} rows={4}
        onFocus={e => e.target.select()}
        style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}
      />
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" onClick={copy} style={{
          display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
          padding: 'var(--eb-space-1) var(--eb-space-3)',
          background: 'transparent', border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
          cursor: 'pointer', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
        }}>
          <Copy size={13} /> {copied ? 'Copied' : 'Copy public key'}
        </button>
        <a
          href="https://github.com/settings/ssh/new" target="_blank" rel="noreferrer"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
            padding: 'var(--eb-space-1) var(--eb-space-3)',
            background: 'transparent', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
            textDecoration: 'none', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
          }}
        >
          <ExternalLink size={13} /> Open GitHub SSH settings
        </a>
      </div>
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.6 }}>
        The matching private key is stored in the workspace (mode 600) and is never returned by the API.
        For GitHub Enterprise, paste the key into <strong>your-host/settings/ssh/new</strong> instead.
      </div>
      <div style={{ paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button onClick={onDone} style={{
          padding: 'var(--eb-space-2) var(--eb-space-4)',
          background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
          border: 'none', borderRadius: 'var(--eb-radius-md)',
          fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
          cursor: 'pointer', fontFamily: 'inherit',
        }}>Done</button>
      </div>
    </div>
  );
}

function CreateForm({ onSavePaste, onSaveGenerate, onCancel, saving, error, generated, onDoneGenerated }) {
  const [mode, setMode] = useState('generate');
  const [name, setName] = useState('');
  const [privateKey, setPrivateKey] = useState('');

  if (generated) {
    return <PublicKeyReveal publicKey={generated} onDone={onDoneGenerated} />;
  }

  const canPaste    = name.trim() && privateKey.trim();
  const canGenerate = name.trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
        <ModeTab active={mode === 'generate'} onClick={() => setMode('generate')} icon={KeyRound}>
          Generate new keypair
        </ModeTab>
        <ModeTab active={mode === 'paste'} onClick={() => setMode('paste')} icon={ClipboardPaste}>
          Paste existing key
        </ModeTab>
      </div>

      {mode === 'generate' ? (
        <>
          <div style={{
            padding: 'var(--eb-space-3)', background: 'var(--eb-bg-surface)',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.6,
          }}>
            We'll create a fresh ed25519 keypair on the server. The private key stays in the workspace; you'll get the
            public key once to paste into <strong>GitHub → Settings → SSH and GPG keys → New SSH key</strong>
            (or your enterprise instance).
          </div>

          <FormInput
            label="Name *" value={name} onChange={setName}
            placeholder="e.g. GitHub Deploy Key"
            hint="A descriptive label so you can identify this key later (e.g. which GitHub account or project it belongs to)."
          />

          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
            <button
              onClick={() => onSaveGenerate({ name: name.trim() })}
              disabled={saving || !canGenerate}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
                padding: 'var(--eb-space-2) var(--eb-space-4)',
                background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
                border: 'none', borderRadius: 'var(--eb-radius-md)',
                fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
                cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit',
                opacity: (saving || !canGenerate) ? 0.6 : 1,
              }}
            >
              <KeyRound size={13} /> {saving ? 'Generating…' : 'Generate keypair'}
            </button>
            <button onClick={onCancel} style={{
              padding: 'var(--eb-space-2) var(--eb-space-4)',
              background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
              cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
            }}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <StepGuide title="How to create an SSH key pair manually" defaultOpen={true}>
            <Step n={1}>
              Open a terminal on your local machine and generate a new key pair:
              <CodeLine>ssh-keygen -t ed25519 -C "aee-deploy-key"</CodeLine>
              Accept the default file path (<code style={{ fontFamily: 'var(--eb-font-mono)' }}>~/.ssh/id_ed25519</code>).
              Leave the passphrase <strong>empty</strong> — agents cannot enter passphrases interactively.
            </Step>
            <Step n={2}>
              Add the <strong>public</strong> key to your GitHub Enterprise instance so the server recognises the key:
              <div style={{ marginTop: 'var(--eb-space-1)', color: 'var(--eb-text-muted)' }}>
                Profile picture → <strong>Settings</strong> → <strong>SSH and GPG keys</strong> → <strong>New SSH key</strong>
              </div>
              <div style={{ marginTop: 'var(--eb-space-1)', color: 'var(--eb-text-muted)' }}>
                Paste the contents of <code style={{ fontFamily: 'var(--eb-font-mono)' }}>~/.ssh/id_ed25519.pub</code> (the file ending in <code style={{ fontFamily: 'var(--eb-font-mono)' }}>.pub</code>).
              </div>
            </Step>
            <Step n={3}>
              Paste the <strong>private</strong> key in the field below. Copy the full contents of{' '}
              <code style={{ fontFamily: 'var(--eb-font-mono)' }}>~/.ssh/id_ed25519</code> — the file without the{' '}
              <code style={{ fontFamily: 'var(--eb-font-mono)' }}>.pub</code> extension. It starts with{' '}
              <code style={{ fontFamily: 'var(--eb-font-mono)' }}>-----BEGIN OPENSSH PRIVATE KEY-----</code>.
            </Step>
            <div style={{ marginTop: 'var(--eb-space-1)', color: 'var(--eb-text-muted)', fontSize: '0.9em' }}>
              The private key is stored securely in the workspace volume (mode 600) and is never returned by the API — only its fingerprint is displayed afterwards.
            </div>
          </StepGuide>

          <FormInput
            label="Name *" value={name} onChange={setName}
            placeholder="e.g. GitHub Deploy Key"
            hint="A descriptive label so you can identify this key later (e.g. which GitHub account or project it belongs to)."
          />

          <div>
            <div style={{
              fontSize: 'var(--eb-text-sm)',
              fontWeight: 'var(--eb-font-medium)',
              color: 'var(--eb-text-secondary)',
              marginBottom: 'var(--eb-space-1)',
            }}>
              Private SSH key <span style={{ color: 'var(--eb-status-error)' }}>*</span>
            </div>
            <textarea
              value={privateKey}
              onChange={e => setPrivateKey(e.target.value)}
              rows={12}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
              style={{
                ...inputStyle,
                resize: 'vertical',
                fontFamily: 'var(--eb-font-mono)',
                fontSize: 'var(--eb-text-xs)',
              }}
            />
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
              Paste the full private key including the <code style={{ fontFamily: 'var(--eb-font-mono)' }}>-----BEGIN</code> and <code style={{ fontFamily: 'var(--eb-font-mono)' }}>-----END</code> lines.
              The value is stored encrypted on disk and will never be shown again — only the fingerprint remains visible.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
            <button
              onClick={() => onSavePaste({ name: name.trim(), privateKey: privateKey.trim() })}
              disabled={saving || !canPaste}
              style={{
                padding: 'var(--eb-space-2) var(--eb-space-4)',
                background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
                border: 'none', borderRadius: 'var(--eb-radius-md)',
                fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
                cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit',
                opacity: (saving || !canPaste) ? 0.6 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save key'}
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
        </>
      )}
    </div>
  );
}

export default function SshKeys() {
  const { data: keys, loading, error, refetch } = useApi('/api/ssh-keys');
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [generatedPublicKey, setGeneratedPublicKey] = useState(null);

  const COLUMNS = [
    { key: 'id', label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'name', label: 'Name' },
    { key: 'fingerprint', label: 'Fingerprint', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v}</span> },
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

  async function handleSavePaste({ name, privateKey }) {
    setSaving(true); setFormError(null);
    try {
      await apiCall('POST', '/api/ssh-keys', { name, privateKey });
      setCreating(false);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveGenerate({ name }) {
    setSaving(true); setFormError(null);
    try {
      const r = await apiCall('POST', '/api/ssh-keys/generate', { name });
      setGeneratedPublicKey(r.publicKey);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function closeCreatePanel() {
    setCreating(false);
    setGeneratedPublicKey(null);
    setFormError(null);
  }

  async function handleDelete() {
    try {
      await apiCall('DELETE', `/api/ssh-keys/${deleteTarget.id}`);
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
          SSH Keys
        </h1>
        <button
          onClick={() => { setCreating(true); setFormError(null); setGeneratedPublicKey(null); }}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <Plus size={15} /> New Key
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
        <strong>SSH keys</strong> allow agents to authenticate to Git repositories via SSH — for example to clone a private GitHub Enterprise repository.
        You register the <em>private</em> key here; the corresponding <em>public</em> key must be added to the Git host (e.g. GitHub → Settings → SSH and GPG keys).
        Each Working Environment can be linked to one key per repository.
        The private key is stored securely in the workspace volume and is <strong>never</strong> returned by the API — only its fingerprint is shown afterwards.
      </div>

      {actionError && (
        <div role="alert" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)' }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer' }}>Dismiss</button>
        </div>
      )}

      <DataTable
        columns={COLUMNS}
        data={keys ?? []}
        emptyText="No SSH keys stored yet. Click 'New Key' to add one."
      />

      <SidePanel
        open={creating}
        onClose={closeCreatePanel}
        title="New SSH key"
        width="560px"
      >
        {creating && (
          <CreateForm
            onSavePaste={handleSavePaste}
            onSaveGenerate={handleSaveGenerate}
            onCancel={closeCreatePanel}
            saving={saving}
            error={formError}
            generated={generatedPublicKey}
            onDoneGenerated={closeCreatePanel}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete SSH key"
        message={`Really delete "${deleteTarget?.name || deleteTarget?.id}"? Working Environments using this key must remove it first.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
