import React, { useState } from 'react';
import { Trash2, Pencil, Plus } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import IdField from '../components/IdField';
import IconButton from '../components/IconButton';
import useAutoDerivedId from '../hooks/useAutoDerivedId';
import CredentialOwnership from '../components/CredentialOwnership';
import { useAuth } from '../auth/AuthContext';
import {
  teamsById, credentialScopeLabel, defaultOwnership, ownershipPayload,
  canManageCredentialClient, canReassignCredentialClient, adminTeamIdsOf,
  normalizeCredential,
} from './credential-scope-view';

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

const labelStyle = {
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-secondary)',
  marginBottom: 'var(--eb-space-1)',
};

function CreateForm({ onSave, onCancel, saving, error, teams, isSysAdmin, adminTeamIds }) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [ownership, setOwnership] = useState(() => defaultOwnership({ isSysAdmin, adminTeamIds }));
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName,
    setId,
    getName: () => name,
  });

  const ownershipReady = ownership.scope === 'system' || !!ownership.teamId;
  const canSubmit = name.trim() && siteUrl.trim() && email.trim() && token.trim() && ownershipReady;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{error}</div>
      )}

      <div style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-xs)',
        color: 'var(--eb-text-secondary)',
        lineHeight: '1.6',
      }}>
        Create an API token at <code style={{ fontFamily: 'var(--eb-font-mono)' }}>id.atlassian.com/manage-profile/security/api-tokens</code>{' '}
        while signed in as the account this integration should act as. The token pairs with the account's
        email for Basic Auth against the Jira Cloud REST API.
      </div>

      <FormInput
        label="Name *"
        value={name}
        onChange={handleNameChange}
        placeholder="e.g. Engineering Jira"
        hint="A label to identify this credential — for example the Jira site or team it belongs to."
      />

      <IdField
        value={id}
        onChange={handleIdChange}
        isAutoDerived={isAutoDerived()}
        onResetAuto={resetAutoDerive}
        placeholder="e.g. engineering-jira"
        helpText={<>Auto-derived from Name; edit to override. Lowercase letters, digits and hyphens only. Used as the filename of the stored token.</>}
      />

      <FormInput
        label="Jira site *"
        value={siteUrl}
        onChange={setSiteUrl}
        placeholder="yourcompany (or https://yourcompany.atlassian.net)"
        hint="The Atlassian subdomain, or a full origin for a custom domain / test fixture."
      />

      <FormInput
        label="Email *"
        value={email}
        onChange={setEmail}
        placeholder="agent@yourcompany.com"
        hint="The Jira Cloud account the API token belongs to — used as the Basic-Auth username."
      />

      <div>
        <div style={labelStyle}>
          API token <span style={{ color: 'var(--eb-status-error)' }}>*</span>
        </div>
        <textarea
          value={token}
          onChange={e => setToken(e.target.value)}
          rows={3}
          placeholder="paste the Jira API token"
          style={{
            ...inputStyle,
            resize: 'vertical',
            fontFamily: 'var(--eb-font-mono)',
            fontSize: 'var(--eb-text-xs)',
          }}
        />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          The value is stored securely and will never be shown again — only a preview and fingerprint remain visible.
        </div>
      </div>

      <CredentialOwnership
        value={ownership}
        onChange={setOwnership}
        teams={teams}
        isSysAdmin={isSysAdmin}
        adminTeamIds={adminTeamIds}
      />

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={() => onSave({
            name: name.trim(), id: id.trim() || undefined,
            siteUrl: siteUrl.trim(), email: email.trim(), token: token.trim(),
            ...ownershipPayload(ownership),
          })}
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
          {saving ? 'Saving…' : 'Save credential'}
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

// Jira credentials carry siteUrl/email alongside name/scope/team, which the
// generic CredentialReassignPanel (shared by SSH keys / GitHub tokens) has no
// room for — so this is its own small edit form rather than a shared one.
function EditForm({ cred, onSave, onCancel, saving, error, teams, isSysAdmin, adminTeamIds, canReassign }) {
  const norm = normalizeCredential(cred || {});
  const [name, setName] = useState(cred?.name || '');
  const [siteUrl, setSiteUrl] = useState(cred?.siteUrl || '');
  const [email, setEmail] = useState(cred?.email || '');
  const [ownership, setOwnership] = useState({
    scope: norm.scope,
    teamId: norm.teamId || '',
    assignedTeamIds: norm.assignedTeamIds || [],
  });

  const ownershipReady = !canReassign || ownership.scope === 'system' || !!ownership.teamId;

  function handleSave() {
    const body = {
      name: name.trim() || cred?.name,
      siteUrl: siteUrl.trim() || cred?.siteUrl,
      email: email.trim() || cred?.email,
    };
    if (canReassign) Object.assign(body, ownershipPayload(ownership));
    onSave(body);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{error}</div>
      )}

      <div>
        <div style={labelStyle}>Name</div>
        <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
      </div>

      <div>
        <div style={labelStyle}>Jira site</div>
        <input value={siteUrl} onChange={e => setSiteUrl(e.target.value)} style={inputStyle} />
      </div>

      <div>
        <div style={labelStyle}>Email</div>
        <input value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} />
      </div>

      {canReassign ? (
        <CredentialOwnership
          value={ownership}
          onChange={setOwnership}
          teams={teams}
          isSysAdmin={isSysAdmin}
          adminTeamIds={adminTeamIds}
        />
      ) : (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Only a System Admin can change which team owns a credential or reassign a system-scoped one.
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={handleSave}
          disabled={saving || !name.trim() || !ownershipReady}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit',
            opacity: (saving || !name.trim() || !ownershipReady) ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button onClick={onCancel} style={{
          padding: 'var(--eb-space-2) var(--eb-space-4)',
          background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
          cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
        }}>Cancel</button>
      </div>
    </div>
  );
}

export default function JiraTokens() {
  const { data: tokens, loading, error, refetch } = useApi('/api/jira-tokens');
  const { data: teamsData } = useApi('/api/admin/teams');
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const teams = Array.isArray(teamsData) ? teamsData : [];
  const names = teamsById(teams);
  const isSysAdmin = !!user?.admin;
  const adminTeamIds = adminTeamIdsOf(user);
  const caller = { isSysAdmin, adminTeamIds };

  const COLUMNS = [
    { key: 'id', label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'name', label: 'Name' },
    { key: 'siteUrl', label: 'Site', render: v => <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v || '—'}</span> },
    { key: 'email', label: 'Email', render: v => <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v || '—'}</span> },
    {
      key: '_scope', label: 'Scope / Teams', sortable: false,
      render: (_, row) => {
        const s = credentialScopeLabel(row, names);
        return (
          <span style={{ fontSize: 'var(--eb-text-xs)' }}>
            <span style={{
              display: 'inline-block', padding: '1px 6px', borderRadius: 'var(--eb-radius-sm)',
              background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-secondary)',
              fontWeight: 'var(--eb-font-medium)', marginRight: 'var(--eb-space-2)',
            }}>{s.label}</span>
            <span style={{ color: 'var(--eb-text-muted)' }}>{s.detail}</span>
          </span>
        );
      },
    },
    { key: 'preview', label: 'Token', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v}</span> },
    { key: 'fingerprint', label: 'Fingerprint', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{v}</span> },
    { key: 'createdAt', label: 'Added', render: v => v ? new Date(v).toLocaleString() : '—' },
    {
      key: '_actions',
      label: '',
      sortable: false,
      render: (_, row) => {
        const manageable = canManageCredentialClient(row, caller);
        return (
          <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
            {manageable && <IconButton icon={Pencil} label="Edit" onClick={() => { setEditTarget(row); setFormError(null); }} />}
            {manageable && <IconButton icon={Trash2} label="Delete" danger onClick={() => setDeleteTarget(row)} />}
          </div>
        );
      },
    },
  ];

  async function handleSave(body) {
    setSaving(true); setFormError(null);
    try {
      await apiCall('POST', '/api/jira-tokens', body);
      setCreating(false);
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
      await apiCall('PATCH', `/api/jira-tokens/${editTarget.id}`, body);
      setEditTarget(null);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await apiCall('DELETE', `/api/jira-tokens/${deleteTarget.id}`);
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
          Jira Credentials
        </h1>
        <button
          onClick={() => { setCreating(true); setFormError(null); }}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          <Plus size={15} /> New Credential
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
        <strong>Jira credentials</strong> pair a Jira Cloud site with an account email + API token, used by the
        Jira poller to detect issue status changes for <code>jira-event</code> triggers. Bind a credential to a
        project on a Working Environment (see <code>Jira Projects</code> there) so the right agents' triggers
        resolve to the right site. The raw token value is stored securely and is <strong>never</strong> returned
        by the API after creation — only a preview (last 4 characters) and a fingerprint are displayed.
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
        emptyText="No Jira credentials stored yet. Click 'New Credential' to add one."
      />

      <SidePanel
        open={creating}
        onClose={() => setCreating(false)}
        title="New Jira credential"
        width="560px"
      >
        {creating && (
          <CreateForm
            onSave={handleSave}
            onCancel={() => setCreating(false)}
            saving={saving}
            error={formError}
            teams={teams}
            isSysAdmin={isSysAdmin}
            adminTeamIds={adminTeamIds}
          />
        )}
      </SidePanel>

      <SidePanel
        open={!!editTarget}
        onClose={() => { setEditTarget(null); setFormError(null); }}
        title="Edit Jira credential"
        width="560px"
      >
        {editTarget && (
          <EditForm
            cred={editTarget}
            teams={teams}
            isSysAdmin={isSysAdmin}
            adminTeamIds={adminTeamIds}
            canReassign={canReassignCredentialClient(caller)}
            onSave={handleEditSave}
            onCancel={() => { setEditTarget(null); setFormError(null); }}
            saving={saving}
            error={formError}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Jira credential"
        message={`Really delete "${deleteTarget?.name || deleteTarget?.id}"? Working Environments using this credential must remove it first.`}
        variant="danger"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
