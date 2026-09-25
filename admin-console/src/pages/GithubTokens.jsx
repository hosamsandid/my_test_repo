import React, { useState } from 'react';
import { Trash2, Pencil, Plus, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import WhenCell from '../components/WhenCell';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import IdField from '../components/IdField';
import { ID_FORMAT_HINT } from '../components/id-field-view';
import GithubTokenHint from '../components/GithubTokenHint';
import IconButton from '../components/IconButton';
import PageHelpButton from '../components/PageHelpButton';
import useAutoDerivedId from '../hooks/useAutoDerivedId';
import CredentialOwnership from '../components/CredentialOwnership';
import { useResourceAccessV2 } from '../context/ResourceAccessContext';
import ReassignPanel from '../components/CredentialReassignPanel';
import { useAuth } from '../auth/AuthContext';
import {
  teamsById, credentialScopeLabel, credentialOwnershipLabel, defaultOwnership, ownershipPayload,
  canManageCredentialClient, canReassignCredentialClient, adminTeamIdsOf,
  isPersonalCredential,
} from './credential-scope-view';
import { adminManagedCredentials } from './my-credentials-view';
import { environmentsUsingGithubToken, usageCountLabel, usageTooltip } from './credential-usage';
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

function CreateForm({ onSave, onCancel, saving, error, teams, isSysAdmin, adminTeamIds }) {
  const v2 = useResourceAccessV2();
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [token, setToken] = useState('');
  const [ownership, setOwnership] = useState(() => defaultOwnership({ isSysAdmin, adminTeamIds, v2 }));
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } = useAutoDerivedId({
    setName,
    setId,
    getName: () => name,
  });

  const ownershipReady = ownership.scope === 'system' || ownership.scope === 'personal' || !!ownership.teamId;
  const canSubmit = name.trim() && token.trim() && ownershipReady;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {error && (
        <div role="alert" style={{
          color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-status-error-bg)', borderRadius: 'var(--eb-radius-md)',
        }}>{error}</div>
      )}

      <StepGuide title="How to create a GitHub Personal Access Token" defaultOpen={true}>
        <Step n={1}>
          Sign in to GitHub. For GitHub Enterprise use your enterprise URL (e.g.{' '}
          <code style={{ fontFamily: 'var(--eb-font-mono)' }}>https://github.example.com</code>);
          for github.com use <code style={{ fontFamily: 'var(--eb-font-mono)' }}>https://github.com</code>.
        </Step>
        <Step n={2}>
          Click your <strong>profile picture</strong> in the top-right corner → <strong>Settings</strong> →
          <strong> Developer settings</strong> (bottom of the left sidebar) → <strong>Personal access tokens</strong>.
        </Step>
        <Step n={3}>
          Pick the token type. GitHub offers two tabs in the sidebar:
          <div style={{ marginTop: 'var(--eb-space-2)', paddingLeft: 'var(--eb-space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
            <div>
              <strong>Tokens (classic)</strong> — <span style={{ color: 'var(--eb-accent-primary)', fontWeight: 'var(--eb-font-medium)' }}>recommended</span>.
              This is what we test against. Scope selection below is straightforward and works for any repository the user can access.
            </div>
            <div style={{ color: 'var(--eb-text-muted)' }}>
              <strong>Fine-grained tokens</strong> — alternative for tighter scoping. Permissions are granted per repository
              and use a different (more granular) permission model. Use only if your org policy requires it.
            </div>
          </div>
        </Step>
        <Step n={4}>
          Click <strong>Generate new token</strong>. Enter a descriptive note (e.g. <em>Agent Studio Agent Token</em>) and set an expiry date.
          For fine-grained tokens, also select the repositories the agents should have access to.
        </Step>
        <Step n={5}>
          Select the required scopes / permissions:
          <div style={{ marginTop: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-1)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
            Tokens (classic) — tick these scopes:
          </div>
          <div style={{ paddingLeft: 'var(--eb-space-2)' }}>
            <PermissionRow scope="repo" access="Full control" note="clone, commit, push, PRs, repo metadata" />
            <PermissionRow scope="workflow" access="Update" note="needed when agents touch GitHub Actions workflow files" />
            <PermissionRow scope="read:org" access="Read-only" note="under admin:org — lets the gh CLI resolve org/team membership" />
          </div>
          <div style={{ marginTop: 'var(--eb-space-1)', color: 'var(--eb-text-muted)', fontSize: '0.9em', paddingLeft: 'var(--eb-space-2)' }}>
            Ticking the parent <code>repo</code> box auto-selects all five sub-scopes
            (<code>repo:status</code>, <code>repo_deployment</code>, <code>public_repo</code>, <code>repo:invite</code>, <code>security_events</code>) — leave them on.
            <br />
            For <code>read:org</code>: expand <code>admin:org</code> and tick only the <code>read:org</code> child — the parent and other children stay unchecked.
          </div>
          <div style={{ marginTop: 'var(--eb-space-3)', marginBottom: 'var(--eb-space-1)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
            Fine-grained token — Repository permissions (alternative):
          </div>
          <div style={{ paddingLeft: 'var(--eb-space-2)' }}>
            <PermissionRow scope="Contents" access="Read & write" note="clone, commit, push" />
            <PermissionRow scope="Metadata" access="Read-only" note="required baseline" />
            <PermissionRow scope="Pull requests" access="Read & write" note="if agents open PRs" />
            <PermissionRow scope="Workflows" access="Read & write" note="if agents touch GitHub Actions" />
          </div>
          <div style={{ marginTop: 'var(--eb-space-1)', color: 'var(--eb-text-muted)', fontSize: '0.9em', paddingLeft: 'var(--eb-space-2)' }}>
            Plus, under <strong>Organization permissions</strong>: <code>Members</code> = <strong>Read-only</strong> (equivalent to <code>read:org</code>).
          </div>
        </Step>
        <Step n={6}>
          Click <strong>Generate token</strong>. Copy the token value immediately — GitHub will not show it again.
          Then paste it in the field below.
        </Step>
        <Step n={7}>
          <strong>If your organisation enforces SAML SSO:</strong> open the token in the GitHub token list and
          click <strong>Configure SSO</strong> next to it, then authorise the token for every org whose repos the
          agents need to access. Without this step the token will work against personal repos but be rejected by
          SSO-protected org repos.
        </Step>
        <div style={{ marginTop: 'var(--eb-space-1)', color: 'var(--eb-text-muted)', fontSize: '0.9em' }}>
          The token is stored securely in the workspace volume (mode 600) and is never returned by the API —
          only a short preview and fingerprint are shown afterwards.
        </div>
      </StepGuide>

      <FormInput
        label="Name *"
        value={name}
        onChange={handleNameChange}
        placeholder="e.g. AccentureCodeFoundry PAT"
        hint="A label to identify this token — for example the GitHub account or organisation it belongs to."
      />

      <IdField
        value={id}
        onChange={handleIdChange}
        isAutoDerived={isAutoDerived()}
        onResetAuto={resetAutoDerive}
        placeholder="e.g. accenture-pat"
        helpText={<>Auto-derived from Name; edit to override. {ID_FORMAT_HINT} Used as the filename of the stored token.</>}
      />

      <CredentialOwnership
        value={ownership}
        onChange={setOwnership}
        teams={teams}
        isSysAdmin={isSysAdmin}
        adminTeamIds={adminTeamIds}
        v2={v2}
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
        <GithubTokenHint value={token} />
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>
          Paste the full token value. Fine-grained tokens start with <code style={{ fontFamily: 'var(--eb-font-mono)' }}>github_pat_</code>,
          classic tokens with <code style={{ fontFamily: 'var(--eb-font-mono)' }}>ghp_</code>.
          The value is stored securely and will never be shown again — only a preview and fingerprint remain visible.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={() => onSave({ name: name.trim(), id: id.trim() || undefined, token: token.trim(), ...ownershipPayload(ownership, { v2 }) })}
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
  const { data: teamsData } = useApi('/api/admin/teams');
  const { data: envsData } = useApi('/api/environments');
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [rotateTarget, setRotateTarget] = useState(null);
  const [rotateToken, setRotateToken] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const teams = Array.isArray(teamsData) ? teamsData : [];
  const names = teamsById(teams);
  const resourceAccessV2 = useResourceAccessV2();
  // #2360 consolidation: under the flag this page opens to every authenticated
  // user and shows EVERY token the caller may see — their own personal tokens (the
  // dissolved "My Credentials" self-service folds in here) plus the team/system
  // tokens they manage. The server already returns own-personal entries
  // (visibleCredential). Off the flag we keep the admin-managed-only view.
  const rows = resourceAccessV2 ? (tokens ?? []) : adminManagedCredentials(tokens ?? []);
  const isSysAdmin = !!user?.admin;
  const adminTeamIds = adminTeamIdsOf(user);
  // `userId` for the personal-tier manage check — the OWNER of a personal row must
  // get edit/rotate/delete, not a lock (mirrors ModelRegistry #2403). Harmless off
  // the flag, where personal rows are filtered out.
  const caller = { isSysAdmin, adminTeamIds, userId: user?.userId };

  // Which Working Environments reference each token (#1141). `envs` is null until
  // /api/environments resolves (or if the caller may not read it) — the "Used by"
  // column shows "—" in that case rather than a misleading "None".
  const envsLoaded = Array.isArray(envsData);
  const envs = envsLoaded ? envsData : [];
  const deleteUsage = deleteTarget && envsLoaded ? environmentsUsingGithubToken(envs, deleteTarget.id) : [];

  const COLUMNS = [
    { key: 'id', label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'name', label: 'Name' },
    {
      // #2360: under v2 the column mirrors the create/edit dialog taxonomy
      // (identity + Personal/Team/System/Global) via `credentialOwnershipLabel`,
      // so the row and the dialog can never disagree. Off the flag it stays the
      // legacy `credentialScopeLabel` "Scope / Teams" column (byte-identical).
      key: '_scope', label: resourceAccessV2 ? 'Ownership' : 'Scope / Teams', sortable: false,
      // #2442: `_scope` is synthetic (no `row['_scope']`), so filter on the text
      // this column actually displays — the ownership/scope label plus its detail
      // (which carries the team names), or "Global".
      filterValue: (_, row) => {
        const s = resourceAccessV2 ? credentialOwnershipLabel(row, names) : credentialScopeLabel(row, names);
        if (resourceAccessV2 && s.scope === 'global') return 'Global';
        return [s.label, s.detail].filter(Boolean).join(' ');
      },
      render: (_, row) => {
        const s = resourceAccessV2 ? credentialOwnershipLabel(row, names) : credentialScopeLabel(row, names);
        if (resourceAccessV2 && s.scope === 'global') {
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
    { key: 'preview', label: 'Token', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{v}</span> },
    { key: 'fingerprint', label: 'Fingerprint', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{v}</span> },
    { key: 'createdAt', label: 'Added', render: v => <WhenCell iso={v} /> },
    {
      key: '_usedBy', label: 'Used by', sortable: false,
      render: (_, row) => {
        if (!envsLoaded) {
          return <span title="Environment usage is loading or unavailable" style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>—</span>;
        }
        const using = environmentsUsingGithubToken(envs, row.id);
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
            {manageable && <IconButton icon={RefreshCw} label="Replace value" onClick={() => { setRotateTarget(row); setRotateToken(''); setFormError(null); }} />}
            {manageable && <IconButton icon={Trash2} label="Delete" danger onClick={() => setDeleteTarget(row)} />}
          </div>
        );
      },
    },
  ];

  async function handleSave({ name, id, token, scope, teamId, assignedTeamIds, identity }) {
    setSaving(true); setFormError(null);
    try {
      await apiCall('POST', '/api/github-tokens', { name, id, token, scope, teamId, assignedTeamIds, identity });
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
      await apiCall('PATCH', `/api/github-tokens/${editTarget.id}`, body);
      setEditTarget(null);
      refetch();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRotate() {
    setSaving(true); setFormError(null);
    try {
      await apiCall('POST', `/api/github-tokens/${rotateTarget.id}/rotate`, { token: rotateToken.trim() });
      setRotateTarget(null); setRotateToken('');
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

  const headerAction = usePageActions(
    <button
      onClick={() => { setCreating(true); setFormError(null); }}
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer', fontFamily: 'inherit' }}
    >
      <Plus size={15} /> New Token
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

      {/* Intro box + the mirrored "Why both a GitHub Token and an SSH key?"
          note extracted in E10 (#1884) into the shared Credentials help topic
          (api/helper-chat/help-topics/credentials.md), which all three
          credential routes claim. The create dialog keeps GitHub's
          shown-only-once warning, the scope checklist and the SAML-SSO step.

          #1993 (epic #1981) split that topic into chapters, so this page's "?"
          lands on the GitHub-tokens chapter instead of the top of a shared
          explanation that opens with SSH. */}
      <p style={{
        margin: 0,
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)',
        fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
      }}>
        <span>
          {resourceAccessV2 ? 'Your GitHub Personal Access Tokens — personal, team and platform' : 'Shared team and platform GitHub Personal Access Tokens'} — injected as <code>GH_TOKEN</code> /{' '}
          <code>GITHUB_TOKEN</code> into every agent of the environment they are linked to.
        </span>
        <PageHelpButton
          label="Why both a GitHub token and an SSH key?"
          section={CREDENTIALS_HELP_SECTIONS.githubTokens}
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
            teams={teams}
            isSysAdmin={isSysAdmin}
            adminTeamIds={adminTeamIds}
          />
        )}
      </SidePanel>

      <SidePanel
        open={!!editTarget}
        onClose={() => { setEditTarget(null); setFormError(null); }}
        title="Edit GitHub token"
        width="560px"
      >
        {editTarget && (
          <ReassignPanel
            cred={editTarget}
            secretHelp={(
              <>
                This dialog changes only the name and ownership. <strong>To replace an expiring or
                leaked token value in place,</strong> close this and use <strong>Replace value</strong>{' '}
                (the <RefreshCw size={12} style={{ verticalAlign: 'middle' }} /> action on the row). Any
                running agents in an environment that references this token are restarted so they
                pick up the new value — in-flight work is interrupted, so replace at a quiet moment.
              </>
            )}
            teams={teams}
            isSysAdmin={isSysAdmin}
            adminTeamIds={adminTeamIds}
            canReassign={canReassignCredentialClient(caller) && !isPersonalCredential(editTarget)}
            v2={resourceAccessV2}
            onSave={handleEditSave}
            onCancel={() => { setEditTarget(null); setFormError(null); }}
            saving={saving}
            error={formError}
          />
        )}
      </SidePanel>

      <SidePanel
        open={!!rotateTarget}
        onClose={() => { setRotateTarget(null); setRotateToken(''); setFormError(null); }}
        title="Replace GitHub token value"
        width="560px"
      >
        {rotateTarget && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
            <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
              Replacing the value for <strong>{rotateTarget.name || rotateTarget.id}</strong>
              <code style={{ display: 'block', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 'var(--eb-space-1)' }}>{rotateTarget.id}</code>
            </p>
            <div style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-status-warning-bg)', border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)' }}>
              Keeps the same id, name and ownership. Every environment that references this token
              has its running agents <strong>restarted</strong> so they pick up the new value — a running
              loop or trigger is cut off, so replace at a quiet moment.
            </div>
            <GithubTokenHint />
            <label style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>
              New token value
              <textarea
                value={rotateToken}
                onChange={e => setRotateToken(e.target.value)}
                placeholder="github_pat_… or ghp_…"
                rows={3}
                autoFocus
                style={{ width: '100%', marginTop: 'var(--eb-space-2)', padding: 'var(--eb-space-2)', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', resize: 'vertical', boxSizing: 'border-box' }}
              />
            </label>
            {formError && (
              <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{formError}</div>
            )}
            <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
              <button
                disabled={saving || !rotateToken.trim()}
                onClick={handleRotate}
                style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: saving || !rotateToken.trim() ? 'not-allowed' : 'pointer', opacity: saving || !rotateToken.trim() ? 0.6 : 1, fontFamily: 'inherit' }}
              >
                {saving ? 'Replacing…' : 'Replace & restart agents'}
              </button>
              <button
                onClick={() => { setRotateTarget(null); setRotateToken(''); setFormError(null); }}
                style={{ padding: 'var(--eb-space-2) var(--eb-space-4)', background: 'transparent', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-sm)', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete GitHub token"
        message={
          <>
            <p style={{ margin: 0 }}>
              Really delete "<strong>{deleteTarget?.name || deleteTarget?.id}</strong>"?
            </p>
            {!envsLoaded ? (
              <p style={{ margin: 'var(--eb-space-3) 0 0', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
                Any environment still referencing this token must detach it first.
              </p>
            ) : deleteUsage.length > 0 ? (
              <div style={{ marginTop: 'var(--eb-space-3)' }}>
                <p style={{ margin: '0 0 var(--eb-space-1)', fontSize: 'var(--eb-text-sm)' }}>
                  {deleteUsage.length === 1
                    ? '1 environment still uses this token — detach it there first:'
                    : `${deleteUsage.length} environments still use this token — detach it there first:`}
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
