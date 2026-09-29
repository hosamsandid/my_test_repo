import React, { useState, useEffect, useRef } from 'react';
import { Trash2, Pencil, Plus, ChevronDown, ChevronRight, KeyRound, ClipboardPaste, Copy, Check, ExternalLink, RefreshCw } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import WhenCell from '../components/WhenCell';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import IdField from '../components/IdField';
import { ID_FORMAT_HINT } from '../components/id-field-view';
import IconButton from '../components/IconButton';
import PageHelpButton from '../components/PageHelpButton';
import ModeToggle from '../components/ModeToggle';
import useAutoDerivedId from '../hooks/useAutoDerivedId';
import CredentialOwnership from '../components/CredentialOwnership';
import ReassignPanel from '../components/CredentialReassignPanel';
import { useAuth } from '../auth/AuthContext';
import {
  teamsById, credentialOwnershipLabel, defaultOwnership, ownershipPayload,
  canManageCredentialClient, canReassignCredentialClient, adminTeamIdsOf,
  isPersonalCredential,
} from './credential-scope-view';
import { environmentsUsingSshKey, usageCountLabel, usageTooltip } from './credential-usage';
import { CREDENTIALS_HELP_SECTIONS } from './credentials-help-sections.js';
import { usePageActions } from '../context/PageActionsContext';

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
        <div style={{ marginTop: 4 }}>
          <strong>SAML SSO orgs:</strong> after adding the public key, click <strong>Configure SSO</strong> next to it in the GitHub
          SSH key list and authorise it for the relevant orgs — otherwise SSO-protected repos won't accept SSH connections.
        </div>
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

function CreateForm({ onSavePaste, onSaveGenerate, onCancel, saving, error, generated, onDoneGenerated,
                      teams, isSysAdmin, adminTeamIds }) {
  const [mode, setMode] = useState('generate');
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [ownership, setOwnership] = useState(() => defaultOwnership({ isSysAdmin, adminTeamIds }));
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName,
    setId,
    getName: () => name,
  });

  const idHelp = <>Auto-derived from Name; edit to override. {ID_FORMAT_HINT} Used as the filename of the stored key.</>;

  if (generated) {
    return <PublicKeyReveal publicKey={generated} onDone={onDoneGenerated} />;
  }

  // A team-scoped credential needs an owning team selected before it can be saved;
  // personal / system scopes are ready without one.
  const ownershipReady = ownership.scope === 'system' || ownership.scope === 'personal' || !!ownership.teamId;
  const canPaste    = name.trim() && privateKey.trim() && ownershipReady;
  const canGenerate = name.trim() && ownershipReady;

  const ownershipFields = (
    <CredentialOwnership
      value={ownership}
      onChange={setOwnership}
      teams={teams}
      isSysAdmin={isSysAdmin}
      adminTeamIds={adminTeamIds}
    />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{error}</div>
      )}

      <ModeToggle
        value={mode}
        onChange={setMode}
        question="Choose how you'd like to add a key:"
        options={[
          { id: 'generate', label: 'Generate new keypair', icon: KeyRound },
          { id: 'paste', label: 'Paste existing key', icon: ClipboardPaste },
        ]}
      />

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
            <div style={{ marginTop: 4 }}>
              <strong>SAML SSO orgs:</strong> once GitHub has the public key, open it in the SSH key list and click
              <strong> Configure SSO</strong> to authorise it for the relevant orgs — otherwise SSH access to SSO-protected repos is rejected.
            </div>
          </div>

          <FormInput
            label="Name *" value={name} onChange={handleNameChange}
            placeholder="e.g. GitHub Deploy Key"
            hint="A descriptive label so you can identify this key later (e.g. which GitHub account or project it belongs to)."
          />

          <IdField
            value={id}
            onChange={handleIdChange}
            isAutoDerived={isAutoDerived()}
            onResetAuto={resetAutoDerive}
            placeholder="e.g. github-deploy-key"
            helpText={idHelp}
          />

          {ownershipFields}

          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
            <button
              onClick={() => onSaveGenerate({ name: name.trim(), id: id.trim() || undefined, ...ownershipPayload(ownership) })}
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
              <CodeLine>ssh-keygen -t ed25519 -C "agent-studio-deploy-key"</CodeLine>
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
            <Step n={4}>
              <strong>If your organisation enforces SAML SSO:</strong> open the new SSH key in the GitHub key list and
              click <strong>Configure SSO</strong> next to it, then authorise it for every org whose repos the agents
              should clone. Without this step SSH access to SSO-protected repos is rejected.
            </Step>
            <div style={{ marginTop: 'var(--eb-space-1)', color: 'var(--eb-text-muted)', fontSize: '0.9em' }}>
              The private key is stored securely in the workspace volume (mode 600) and is never returned by the API — only its fingerprint is displayed afterwards.
            </div>
          </StepGuide>

          <FormInput
            label="Name *" value={name} onChange={handleNameChange}
            placeholder="e.g. GitHub Deploy Key"
            hint="A descriptive label so you can identify this key later (e.g. which GitHub account or project it belongs to)."
          />

          <IdField
            value={id}
            onChange={handleIdChange}
            isAutoDerived={isAutoDerived()}
            onResetAuto={resetAutoDerive}
            placeholder="e.g. github-deploy-key"
            helpText={idHelp}
          />

          {ownershipFields}

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
              onClick={() => onSavePaste({ name: name.trim(), id: id.trim() || undefined, privateKey: privateKey.trim(), ...ownershipPayload(ownership) })}
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
  const { data: teamsData } = useApi('/api/admin/teams');
  const { data: envsData } = useApi('/api/environments');
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [rotateTarget, setRotateTarget] = useState(null);
  const [rotateMode, setRotateMode] = useState('generate');
  const [rotatePrivateKey, setRotatePrivateKey] = useState('');
  const [rotateGenerated, setRotateGenerated] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [generatedPublicKey, setGeneratedPublicKey] = useState(null);

  const teams = Array.isArray(teamsData) ? teamsData : [];
  const names = teamsById(teams);
  // #2360 consolidation: this page is open to every authenticated user and shows
  // EVERY credential the caller may see — their own personal rows plus the
  // team/system rows they manage. The server already returns own-personal entries
  // (visibleCredential).
  const rows = keys ?? [];
  const isSysAdmin = !!user?.admin;
  const adminTeamIds = adminTeamIdsOf(user);
  // `userId` is required for the personal-tier manage check (canManageCredentialClient):
  // the OWNER of a personal row must get edit/rotate/delete, not a lock (mirrors
  // ModelRegistry #2403).
  const caller = { isSysAdmin, adminTeamIds, userId: user?.userId };

  // Which Working Environments reference each key (#1141). `envs` is null until
  // /api/environments resolves (or if the caller may not read it) — the "Used by"
  // column shows "—" in that case rather than a misleading "None".
  const envsLoaded = Array.isArray(envsData);
  const envs = envsLoaded ? envsData : [];
  const deleteUsage = deleteTarget && envsLoaded ? environmentsUsingSshKey(envs, deleteTarget.id) : [];

  const COLUMNS = [
    { key: 'id', label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'name', label: 'Name' },
    {
      // #2360: the column mirrors the create/edit dialog taxonomy
      // (identity + Personal/Team/System/Global) via `credentialOwnershipLabel`,
      // so the row and the dialog can never disagree.
      key: '_scope', label: 'Ownership', sortable: false,
      // #2442: `_scope` is synthetic (no `row['_scope']`), so filter on the text
      // this column actually displays — the ownership/scope label plus its detail
      // (which carries the team names), or "Global".
      filterValue: (_, row) => {
        const s = credentialOwnershipLabel(row, names);
        if (s.scope === 'global') return 'Global';
        return [s.label, s.detail].filter(Boolean).join(' ');
      },
      render: (_, row) => {
        const s = credentialOwnershipLabel(row, names);
        if (s.scope === 'global') {
          return (
            <span style={{ fontSize: 'var(--eb-text-xs)' }} title="Available to every user and team — no team required">
              <span style={{
                display: 'inline-block', padding: '1px 6px', borderRadius: 'var(--eb-radius-sm)',
                background: 'var(--eb-accent-subtle, var(--eb-bg-elevated))', color: 'var(--eb-accent, var(--eb-text-secondary))',
                fontWeight: 'var(--eb-font-medium)',
              }}>Global</span>
            </span>
          );
        }
        return (
          <span style={{ fontSize: 'var(--eb-text-xs)' }}>
            <span style={{
              display: 'inline-block', padding: '1px 6px', borderRadius: 'var(--eb-radius-sm)',
              background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-secondary)',
              fontWeight: 'var(--eb-font-medium)', marginRight: 'var(--eb-space-2)',
            }}>{s.label}</span>
            {s.detail && <span style={{ color: 'var(--eb-text-muted)' }}>{s.detail}</span>}
          </span>
        );
      },
    },
    { key: 'fingerprint', label: 'Fingerprint', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v}</span> },
    { key: 'createdAt', label: 'Added', render: v => <WhenCell iso={v} /> },
    {
      key: '_usedBy', label: 'Used by', sortable: false,
      render: (_, row) => {
        if (!envsLoaded) {
          return <span title="Environment usage is loading or unavailable" style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>—</span>;
        }
        const using = environmentsUsingSshKey(envs, row.id);
        return (
          <span
            title={usageTooltip(using)}
            style={{ fontSize: 'var(--eb-text-xs)', color: using.length > 0 ? 'var(--eb-text-secondary)' : 'var(--eb-text-muted)' }}
          >
            {usageCountLabel(using)}
          </span>
        );
      },
    },
    {
      key: '_actions',
      label: '',
      sortable: false,
      render: (_, row) => {
        const manageable = canManageCredentialClient(row, caller);
        return (
          <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
            {manageable && <IconButton icon={Pencil} label="Edit" onClick={() => { setEditTarget(row); setFormError(null); }} />}
            {manageable && <IconButton icon={RefreshCw} label="Replace key" onClick={() => { setRotateTarget(row); setRotateMode('generate'); setRotatePrivateKey(''); setRotateGenerated(null); setFormError(null); }} />}
            {manageable && <IconButton icon={Trash2} label="Delete" danger onClick={() => setDeleteTarget(row)} />}
          </div>
        );
      },
    },
  ];

  async function handleSavePaste({ name, id, privateKey, scope, teamId, assignedTeamIds, identity }) {
    setSaving(true); setFormError(null);
    try {
      await apiCall('POST', '/api/ssh-keys', { name, id, privateKey, scope, teamId, assignedTeamIds, identity });
      setCreating(false);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveGenerate({ name, id, scope, teamId, assignedTeamIds, identity }) {
    setSaving(true); setFormError(null);
    try {
      const r = await apiCall('POST', '/api/ssh-keys/generate', { name, id, scope, teamId, assignedTeamIds, identity });
      setGeneratedPublicKey(r.publicKey);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleEditSave(body) {
    setSaving(true); setFormError(null);
    try {
      await apiCall('PATCH', `/api/ssh-keys/${editTarget.id}`, body);
      setEditTarget(null);
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

  function closeRotatePanel() {
    setRotateTarget(null); setRotatePrivateKey(''); setRotateGenerated(null); setFormError(null);
  }

  async function handleRotate() {
    setSaving(true); setFormError(null);
    try {
      const body = rotateMode === 'generate'
        ? { generate: true }
        : { privateKey: rotatePrivateKey.trim() };
      const r = await apiCall('POST', `/api/ssh-keys/${rotateTarget.id}/rotate`, body);
      refetch();
      if (rotateMode === 'generate' && r?.publicKey) {
        setRotateGenerated(r.publicKey); // reveal the new public key to copy to GitHub
      } else {
        closeRotatePanel();
      }
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  const headerAction = usePageActions(
    <button
      onClick={() => { setCreating(true); setFormError(null); setGeneratedPublicKey(null); }}
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}
    >
      <Plus size={15} /> New Key
    </button>
  );

  if (loading) {
    return <div aria-busy="true" style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }
  if (error) {
    return <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>Failed to load: {error}</div>;
  }

  return (
    <>
      {headerAction}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>

      {/* The intro box + the repeated "Why both an SSH key and a GitHub Token?"
          note moved into the shared Credentials help topic in E10 (#1884):
          api/helper-chat/help-topics/credentials.md, claimed by all three
          credential routes. It carries the SSH-vs-PAT blast-radius rationale,
          the ownership tiers, the runtime resolution order and the rotation /
          deletion rules. The create dialogs keep their one-time-secret warning
          and SAML-SSO steps at the point of decision.

          #1993 (epic #1981) split that topic into chapters, so this page's "?"
          now lands on the SSH-keys chapter rather than the top of a shared
          explanation whose first third is about the token. */}
      <p style={{
        margin: 0,
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)',
        fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
      }}>
        <span>
          Your SSH keys — personal, team and platform — the private keys that authenticate git transport for the repositories your environments clone.
        </span>
        <PageHelpButton
          label="Why both an SSH key and a GitHub token?"
          section={CREDENTIALS_HELP_SECTIONS.sshKeys}
          size={14}
          style={{ padding: 0, flexShrink: 0 }}
        />
      </p>

      {actionError && (
        <div role="alert" style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-error-bg)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)' }}>
          {actionError}
          <button onClick={() => setActionError(null)} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer' }}>Dismiss</button>
        </div>
      )}

      <DataTable
        columns={COLUMNS}
        data={rows}
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
            teams={teams}
            isSysAdmin={isSysAdmin}
            adminTeamIds={adminTeamIds}
          />
        )}
      </SidePanel>

      <SidePanel
        open={!!editTarget}
        onClose={() => { setEditTarget(null); setFormError(null); }}
        title="Edit SSH key"
        width="560px"
      >
        {editTarget && (
          <ReassignPanel
            cred={editTarget}
            teams={teams}
            isSysAdmin={isSysAdmin}
            adminTeamIds={adminTeamIds}
            canReassign={canReassignCredentialClient(caller) && !isPersonalCredential(editTarget)}
            onSave={handleEditSave}
            onCancel={() => { setEditTarget(null); setFormError(null); }}
            saving={saving}
            error={formError}
          />
        )}
      </SidePanel>

      <SidePanel
        open={!!rotateTarget}
        onClose={closeRotatePanel}
        title="Replace SSH key"
        width="560px"
      >
        {rotateTarget && (rotateGenerated
          ? <PublicKeyReveal publicKey={rotateGenerated} onDone={closeRotatePanel} />
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
              <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
                Replacing the private key for <strong>{rotateTarget.name || rotateTarget.id}</strong>
                <code style={{ display: 'block', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>{rotateTarget.id}</code>
              </p>
              <div style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-warning-bg)', border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)' }}>
                Keeps the same id, name and ownership. Every environment that references this key
                has its running agents <strong>restarted</strong> so they pick up the new key — a running
                loop or trigger is cut off, so replace at a quiet moment. Remember to add the new public
                key as a deploy key on GitHub.
              </div>
              <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
                <button
                  onClick={() => setRotateMode('generate')}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2)', background: rotateMode === 'generate' ? 'var(--eb-accent-primary)' : 'transparent', color: rotateMode === 'generate' ? 'var(--eb-text-inverted)' : 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  <KeyRound size={14} /> Generate new keypair
                </button>
                <button
                  onClick={() => setRotateMode('paste')}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2)', background: rotateMode === 'paste' ? 'var(--eb-accent-primary)' : 'transparent', color: rotateMode === 'paste' ? 'var(--eb-text-inverted)' : 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  <ClipboardPaste size={14} /> Paste a private key
                </button>
              </div>
              {rotateMode === 'paste' && (
                <label style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
                  New private key
                  <textarea
                    value={rotatePrivateKey}
                    onChange={e => setRotatePrivateKey(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    rows={5}
                    autoFocus
                    style={{ width: '100%', marginTop: 'var(--eb-space-2)', padding: 'var(--eb-space-2)', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', resize: 'vertical', boxSizing: 'border-box' }}
                  />
                </label>
              )}
              {formError && (
                <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{formError}</div>
              )}
              <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
                <button
                  disabled={saving || (rotateMode === 'paste' && !rotatePrivateKey.trim())}
                  onClick={handleRotate}
                  style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: (saving || (rotateMode === 'paste' && !rotatePrivateKey.trim())) ? 'not-allowed' : 'pointer', opacity: (saving || (rotateMode === 'paste' && !rotatePrivateKey.trim())) ? 0.6 : 1, fontFamily: 'inherit' }}
                >
                  {saving ? 'Replacing…' : (rotateMode === 'generate' ? 'Generate & restart agents' : 'Replace & restart agents')}
                </button>
                <button
                  onClick={closeRotatePanel}
                  style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'transparent', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ))}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete SSH key"
        message={
          <>
            <p style={{ margin: 0 }}>
              Really delete "<strong>{deleteTarget?.name || deleteTarget?.id}</strong>"?
            </p>
            {!envsLoaded ? (
              <p style={{ margin: 'var(--eb-space-3) 0 0', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
                Any environment still referencing this key must detach it first.
              </p>
            ) : deleteUsage.length > 0 ? (
              <div style={{ marginTop: 'var(--eb-space-3)' }}>
                <p style={{ margin: '0 0 var(--eb-space-1)', fontSize: 'var(--eb-text-sm)' }}>
                  {deleteUsage.length === 1
                    ? '1 environment still uses this key — detach it there first:'
                    : `${deleteUsage.length} environments still use this key — detach it there first:`}
                </p>
                <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: 'var(--eb-text-sm)' }}>
                  {deleteUsage.map(e => <li key={e.id}>{e.name || e.id}</li>)}
                </ul>
              </div>
            ) : (
              <p style={{ margin: 'var(--eb-space-3) 0 0', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
                Not in use by any environment.
              </p>
            )}
          </>
        }
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
    </>
  );
}
