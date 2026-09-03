import React, { useState, useEffect, useRef } from 'react';
import {
  Trash2, Pencil, Plus, KeyRound, Github, ClipboardPaste, Copy, Check,
  ExternalLink, RefreshCw, Lock,
} from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import WhenCell from '../components/WhenCell';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import IdField from '../components/IdField';
import { ID_FORMAT_HINT } from '../components/id-field-view';
import GithubTokenHint from '../components/GithubTokenHint';
import { GITHUB_TOKEN_PREFIX_HINT } from './github-token-view';
import IconButton from '../components/IconButton';
import PageHelpButton from '../components/PageHelpButton';
import useAutoDerivedId from '../hooks/useAutoDerivedId';
import { useAuth } from '../auth/AuthContext';
import {
  canOwnPersonalCredentials, personalOwnerId, personalCredentials, personalCreateBody,
} from './my-credentials-view';
import { CREDENTIALS_HELP_SECTIONS } from './credentials-help-sections.js';

// Self-service surface for a human's OWN personal SSH keys & GitHub tokens
// (#1568, epic #1558 Phase 2). Built on the Phase 1 (#1567) `personal`
// ownership tier + RBAC: the API only ever returns / mutates the caller's own
// personal credentials — this page is a thin UI over that. Team/system
// credentials are NOT shown here; those stay on the admin SSH Keys / GitHub
// Tokens pages.

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

const primaryBtn = (disabled, busy) => ({
  display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
  border: 'none', borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
  cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit',
  opacity: disabled ? 0.6 : 1,
});

const secondaryBtn = {
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
  cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
};

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

function FormError({ error }) {
  if (!error) return null;
  return (
    <div role="alert" style={{
      color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
      padding: 'var(--eb-space-2) var(--eb-space-3)',
      background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
    }}>{error}</div>
  );
}

function InfoNote({ children }) {
  return (
    <div style={{
      padding: 'var(--eb-space-3)', background: 'var(--eb-bg-surface)',
      border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
      fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.6,
    }}>{children}</div>
  );
}

// Shown once after a server-side keypair generation (create or rotate) — the
// public key is the only chance to copy it out.
function PublicKeyReveal({ publicKey, onDone }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be unavailable */ }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
        color: 'var(--eb-status-success)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
      }}>
        <Check size={15} /> Keypair ready — copy the public key to GitHub now
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
        This is <strong>account-wide</strong> — one key authenticates every repository you use SSH for.
        For a SAML-SSO org, click <strong>Configure SSO</strong> next to the key in GitHub after adding it.
      </div>
      <div style={{ paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button onClick={onDone} style={primaryBtn(false, false)}>Done</button>
      </div>
    </div>
  );
}

// A rotation replaces the secret in place and (Phase 4, #1570) automatically
// restarts the owner's affected running agents so they pick up the new secret.
// Surfaced on every rotate panel per the #1568 edge case; the warning now
// states the in-flight-work interruption that restart causes (AC5).
function RotationCaveat() {
  return (
    <InfoNote>
      Rotating replaces the stored secret in place, keeping the same credential. Your affected running
      agents are <strong>automatically restarted</strong> so they pick up the new secret right away — only
      yours, not anyone else's. That restart <strong>interrupts any in-flight work</strong> in those agents
      (a running loop or trigger is cut off), so rotate at a quiet moment.
    </InfoNote>
  );
}

/* ── SSH key form (create OR rotate) ─────────────────────────────────────── */

function SshKeyForm({ rotateTarget, onCreatePaste, onCreateGenerate, onRotatePaste, onRotateGenerate,
                      onCancel, saving, error, generated, onDoneGenerated }) {
  const rotating = !!rotateTarget;
  const [mode, setMode] = useState('generate');
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName, setId, getName: () => name,
  });

  if (generated) return <PublicKeyReveal publicKey={generated} onDone={onDoneGenerated} />;

  const canPaste    = rotating ? !!privateKey.trim() : (name.trim() && privateKey.trim());
  const canGenerate = rotating ? true : !!name.trim();

  const submit = () => {
    if (mode === 'generate') {
      rotating ? onRotateGenerate(rotateTarget) : onCreateGenerate(personalCreateBody({ name, id }));
    } else {
      rotating
        ? onRotatePaste(rotateTarget, { privateKey: privateKey.trim() })
        : onCreatePaste({ ...personalCreateBody({ name, id }), privateKey: privateKey.trim() });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <FormError error={error} />
      {rotating && <RotationCaveat />}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
        <ModeTab active={mode === 'generate'} onClick={() => setMode('generate')} icon={KeyRound}>
          Generate new keypair
        </ModeTab>
        <ModeTab active={mode === 'paste'} onClick={() => setMode('paste')} icon={ClipboardPaste}>
          Paste existing key
        </ModeTab>
      </div>

      {mode === 'generate' ? (
        <InfoNote>
          We'll create a fresh ed25519 keypair on the server. The private key stays in the workspace; you'll
          get the public key <strong>once</strong> to paste into GitHub → Settings → SSH and GPG keys → New SSH key.
          Personal SSH keys are <strong>account-wide</strong> — one key covers all your repositories.
        </InfoNote>
      ) : (
        <InfoNote>
          Paste the full <strong>private</strong> key (the file without the <code>.pub</code> extension, starting
          with <code>-----BEGIN OPENSSH PRIVATE KEY-----</code>). Add the matching <strong>public</strong> key to
          GitHub yourself. The value is stored securely (mode 600) and never shown again — only its fingerprint.
        </InfoNote>
      )}

      {!rotating && (
        <>
          <FormInput
            label="Name *" value={name} onChange={handleNameChange}
            placeholder="e.g. My laptop key"
            hint="A label so you can recognise this key later."
          />
          <IdField
            value={id} onChange={handleIdChange}
            isAutoDerived={isAutoDerived()} onResetAuto={resetAutoDerive}
            placeholder="e.g. my-laptop-key"
            helpText={<>Auto-derived from Name; edit to override. {ID_FORMAT_HINT}</>}
          />
        </>
      )}
      {rotating && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          Rotating <strong>{rotateTarget.name || rotateTarget.id}</strong>
          <span style={{ color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', marginLeft: 8 }}>
            {rotateTarget.id}
          </span>
        </div>
      )}

      {mode === 'paste' && (
        <div>
          <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)' }}>
            Private SSH key <span style={{ color: 'var(--eb-status-error)' }}>*</span>
          </div>
          <textarea
            value={privateKey} onChange={e => setPrivateKey(e.target.value)} rows={10}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={submit}
          disabled={saving || (mode === 'generate' ? !canGenerate : !canPaste)}
          style={primaryBtn(saving || (mode === 'generate' ? !canGenerate : !canPaste), saving)}
        >
          {mode === 'generate' ? <KeyRound size={13} /> : null}
          {saving ? (mode === 'generate' ? 'Generating…' : 'Saving…')
                  : (rotating ? (mode === 'generate' ? 'Generate & replace' : 'Replace key')
                              : (mode === 'generate' ? 'Generate keypair' : 'Save key'))}
        </button>
        <button onClick={onCancel} style={secondaryBtn}>Cancel</button>
      </div>
    </div>
  );
}

/* ── GitHub token form (create OR rotate) ────────────────────────────────── */

function GithubTokenForm({ rotateTarget, onCreate, onRotate, onCancel, saving, error }) {
  const rotating = !!rotateTarget;
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [token, setToken] = useState('');
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName, setId, getName: () => name,
  });

  const canSubmit = rotating ? !!token.trim() : (name.trim() && token.trim());
  const submit = () => {
    if (rotating) onRotate(rotateTarget, { token: token.trim() });
    else onCreate({ ...personalCreateBody({ name, id }), token: token.trim() });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <FormError error={error} />
      {rotating && <RotationCaveat />}

      <InfoNote>
        Create a GitHub Personal Access Token (Settings → Developer settings → Personal access tokens) with the{' '}
        <code>repo</code> and <code>workflow</code> scopes (plus <code>read:org</code> for org repos), then paste it
        below. It is stored securely (mode 600) and never shown again — only a short preview and fingerprint remain.
      </InfoNote>

      {!rotating && (
        <>
          <FormInput
            label="Name *" value={name} onChange={handleNameChange}
            placeholder="e.g. My GitHub PAT"
            hint="A label so you can recognise this token later."
          />
          <IdField
            value={id} onChange={handleIdChange}
            isAutoDerived={isAutoDerived()} onResetAuto={resetAutoDerive}
            placeholder="e.g. my-github-pat"
            helpText={<>Auto-derived from Name; edit to override. {ID_FORMAT_HINT}</>}
          />
        </>
      )}
      {rotating && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          Rotating <strong>{rotateTarget.name || rotateTarget.id}</strong>
          <span style={{ color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', marginLeft: 8 }}>
            {rotateTarget.id}
          </span>
        </div>
      )}

      <div>
        <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)', marginBottom: 'var(--eb-space-1)' }}>
          GitHub token <span style={{ color: 'var(--eb-status-error)' }}>*</span>
        </div>
        <textarea
          value={token} onChange={e => setToken(e.target.value)} rows={3}
          placeholder="github_pat_… or ghp_…"
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}
        />
        <GithubTokenHint value={token} />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Paste the full token value. {GITHUB_TOKEN_PREFIX_HINT}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button onClick={submit} disabled={saving || !canSubmit} style={primaryBtn(saving || !canSubmit, saving)}>
          {saving ? 'Saving…' : (rotating ? 'Replace token' : 'Save token')}
        </button>
        <button onClick={onCancel} style={secondaryBtn}>Cancel</button>
      </div>
    </div>
  );
}

/* ── Rename form (both credential types) ─────────────────────────────────── */

function RenameForm({ target, onSave, onCancel, saving, error }) {
  const [name, setName] = useState(target?.name || '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <FormError error={error} />
      <FormInput label="Name *" value={name} onChange={setName} placeholder="A descriptive label" />
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button onClick={() => onSave({ name: name.trim() })} disabled={saving || !name.trim()} style={primaryBtn(saving || !name.trim(), saving)}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} style={secondaryBtn}>Cancel</button>
      </div>
    </div>
  );
}

/* ── A credential section (SSH keys or GitHub tokens) ─────────────────────── */

function CredentialSection({
  kind,            // 'ssh' | 'github'
  title, Icon, blurb, emptyText, columns,
  apiBase,         // '/api/ssh-keys' | '/api/github-tokens'
  rows, refetch, disabled,
}) {
  const isSsh = kind === 'ssh';
  const [creating, setCreating] = useState(false);
  const [rotateTarget, setRotateTarget] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [generated, setGenerated] = useState(null);

  const closeCreate = () => { setCreating(false); setRotateTarget(null); setGenerated(null); setFormError(null); };

  // Run a mutation, surfacing any error in the panel. Never rethrows — the form
  // submit handlers call these without awaiting, so a rethrow would become an
  // unhandled rejection. On failure the panel stays open with the error shown.
  const run = async (fn) => {
    setSaving(true); setFormError(null);
    try { await fn(); }
    catch (e) { setFormError(e.message); }
    finally { setSaving(false); }
  };

  // create handlers
  const createPaste    = (body) => run(async () => { await apiCall('POST', apiBase, body); closeCreate(); refetch(); });
  const createGenerate = (body) => run(async () => {
    const r = await apiCall('POST', `${apiBase}/generate`, body); setGenerated(r.publicKey); refetch();
  });
  const createToken    = (body) => run(async () => { await apiCall('POST', apiBase, body); closeCreate(); refetch(); });

  // rotate handlers
  const rotatePaste    = (t, body) => run(async () => { await apiCall('POST', `${apiBase}/${t.id}/rotate`, body); closeCreate(); refetch(); });
  const rotateGenerate = (t)       => run(async () => {
    const r = await apiCall('POST', `${apiBase}/${t.id}/rotate`, { generate: true }); setGenerated(r.publicKey); refetch();
  });
  const rotateToken    = (t, body) => run(async () => { await apiCall('POST', `${apiBase}/${t.id}/rotate`, body); closeCreate(); refetch(); });

  const rename = (body) => run(async () => { await apiCall('PATCH', `${apiBase}/${renameTarget.id}`, body); setRenameTarget(null); refetch(); });

  const doDelete = async () => {
    try { await apiCall('DELETE', `${apiBase}/${deleteTarget.id}`); setDeleteTarget(null); refetch(); }
    catch (e) { setActionError(e.message); setDeleteTarget(null); }
  };

  const actionColumn = {
    key: '_actions', label: '', sortable: false,
    render: (_, row) => (
      <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
        <IconButton icon={Pencil} label="Rename" onClick={() => { setRenameTarget(row); setFormError(null); }} />
        <IconButton icon={RefreshCw} label="Rotate" onClick={() => { setRotateTarget(row); setGenerated(null); setFormError(null); }} />
        <IconButton icon={Trash2} label="Delete" danger onClick={() => setDeleteTarget(row)} />
      </div>
    ),
  };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
          <Icon size={18} /> {title}
        </h2>
        {!disabled && (
          <button onClick={() => { setCreating(true); setGenerated(null); setFormError(null); }} style={{ ...primaryBtn(false, false) }}>
            <Plus size={15} /> {isSsh ? 'New key' : 'New token'}
          </button>
        )}
      </div>

      <InfoNote>{blurb}</InfoNote>

      {actionError && (
        <div role="alert" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)' }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer' }}>Dismiss</button>
        </div>
      )}

      <DataTable columns={[...columns, actionColumn]} data={rows} emptyText={emptyText} />

      {/* Create / rotate panel */}
      <SidePanel
        open={creating || !!rotateTarget}
        onClose={closeCreate}
        title={rotateTarget ? (isSsh ? 'Rotate SSH key' : 'Rotate GitHub token') : (isSsh ? 'New personal SSH key' : 'New personal GitHub token')}
        width="560px"
      >
        {(creating || rotateTarget) && (isSsh ? (
          <SshKeyForm
            rotateTarget={rotateTarget}
            onCreatePaste={createPaste}
            onCreateGenerate={createGenerate}
            onRotatePaste={rotatePaste}
            onRotateGenerate={rotateGenerate}
            onCancel={closeCreate}
            saving={saving}
            error={formError}
            generated={generated}
            onDoneGenerated={closeCreate}
          />
        ) : (
          <GithubTokenForm
            rotateTarget={rotateTarget}
            onCreate={createToken}
            onRotate={rotateToken}
            onCancel={closeCreate}
            saving={saving}
            error={formError}
          />
        ))}
      </SidePanel>

      {/* Rename panel */}
      <SidePanel open={!!renameTarget} onClose={() => { setRenameTarget(null); setFormError(null); }} title={isSsh ? 'Rename SSH key' : 'Rename GitHub token'} width="460px">
        {renameTarget && (
          <RenameForm target={renameTarget} onSave={rename} onCancel={() => { setRenameTarget(null); setFormError(null); }} saving={saving} error={formError} />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title={isSsh ? 'Delete SSH key' : 'Delete GitHub token'}
        message={
          <>
            <p style={{ margin: 0 }}>Really delete "<strong>{deleteTarget?.name || deleteTarget?.id}</strong>"?</p>
            <p style={{ margin: 'var(--eb-space-3) 0 0', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
              This is your personal credential — deleting it is permanent and affects only you. Agents that rely on it
              will fail to authenticate until you add a replacement.
            </p>
          </>
        }
        variant="danger"
        confirmLabel="Delete"
        onConfirm={doDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

const mono = v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v}</span>;
const muted = v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{v}</span>;

const SSH_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'fingerprint', label: 'Fingerprint', render: mono },
  { key: 'createdAt', label: 'Added', render: v => <WhenCell iso={v} /> },
];
const GH_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'preview', label: 'Token', render: mono },
  { key: 'fingerprint', label: 'Fingerprint', render: muted },
  { key: 'createdAt', label: 'Added', render: v => <WhenCell iso={v} /> },
];

export default function MyCredentials() {
  const { user } = useAuth();
  const canOwn = canOwnPersonalCredentials(user);
  const myId = personalOwnerId(user);

  const { data: sshData, loading: sshLoading, error: sshError, refetch: refetchSsh } = useApi('/api/ssh-keys');
  const { data: ghData, loading: ghLoading, error: ghError, refetch: refetchGh } = useApi('/api/github-tokens');

  const sshRows = personalCredentials(Array.isArray(sshData) ? sshData : [], myId);
  const ghRows = personalCredentials(Array.isArray(ghData) ? ghData : [], myId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-6)' }}>
      {/* The tier explanation, the strict-privacy guarantee and the SSH-vs-PAT
          "why both" rationale moved into the shared Credentials help topic in
          E10 (#1884) — api/helper-chat/help-topics/credentials.md, claimed by
          /ssh-keys, /github-tokens and this route. The create/rotate panels keep
          their one-time-secret warnings and SAML-SSO steps inline.

          #1993 (epic #1981) split that topic into chapters and points this "?"
          at the My-Credentials one. It stays wired outside the `canOwn` branch
          below on purpose: the single-admin who CANNOT own personal credentials
          is exactly the reader who needs the chapter explaining why. */}
      <div>
        <p style={{
          margin: 0,
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)',
          color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)', lineHeight: 1.6, maxWidth: 760,
        }}>
          <span>
            Your <strong>personal</strong> SSH key and GitHub token, private to you, so your agents can act
            under your own GitHub identity.
          </span>
          <PageHelpButton
            label="Why both an SSH key and a GitHub token, and who can see mine?"
            section={CREDENTIALS_HELP_SECTIONS.myCredentials}
            size={14}
            style={{ padding: 0, flexShrink: 0 }}
          />
        </p>
      </div>

      {!canOwn ? (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-3)',
          padding: 'var(--eb-space-4)', background: 'var(--eb-bg-surface)',
          border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
          color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)', lineHeight: 1.6,
        }}>
          <Lock size={18} style={{ flexShrink: 0, marginTop: 2, color: 'var(--eb-text-muted)' }} />
          <div>
            <strong>Personal credentials need a per-user account.</strong>
            <div style={{ marginTop: 'var(--eb-space-1)', color: 'var(--eb-text-muted)' }}>
              You're signed in as the environment administrator, which operates the platform rather than acting as a
              person. Sign in with your own user account to store a personal SSH key and GitHub token. Shared
              team/platform credentials are managed on the <em>SSH Keys</em> and <em>GitHub Tokens</em> pages.
            </div>
          </div>
        </div>
      ) : (sshError || ghError) ? (
        <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>
          Failed to load: {sshError || ghError}
        </div>
      ) : (sshLoading || ghLoading) ? (
        <div aria-busy="true" style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
      ) : (
        <>
          <CredentialSection
            kind="ssh"
            title="Personal SSH key"
            Icon={KeyRound}
            apiBase="/api/ssh-keys"
            columns={SSH_COLUMNS}
            rows={sshRows}
            refetch={refetchSsh}
            emptyText="No personal SSH key yet. Add one to clone/push under your own identity."
            blurb={<>Authenticates git transport over SSH; personal keys are <strong>account-wide</strong>. Register the private key here, add the matching public key to your GitHub account.</>}
          />
          <CredentialSection
            kind="github"
            title="Personal GitHub token"
            Icon={Github}
            apiBase="/api/github-tokens"
            columns={GH_COLUMNS}
            rows={ghRows}
            refetch={refetchGh}
            emptyText="No personal GitHub token yet. Add one so your agents open PRs and push under your name."
            blurb={<>Drives attributed writes — commits, pushes, pull requests and the <code>gh</code> CLI — under your identity.</>}
          />
        </>
      )}
    </div>
  );
}
