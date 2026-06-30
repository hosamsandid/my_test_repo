import React, { useState, useMemo } from 'react';
import { Plus, Trash2, Users2, UserPlus, Settings2, ShieldCheck, KeyRound } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import IdField from '../components/IdField';
import useAutoDerivedId from '../hooks/useAutoDerivedId';

const DEFAULT_TEAM_ID = 'default';
const ROLE_LABELS = { 'team-admin': 'Team Admin', 'team-member': 'Team Member' };
const ROLE_OPTIONS = ['team-admin', 'team-member'];

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

const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
  border: 'none', borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
  cursor: 'pointer', fontFamily: 'inherit',
};

const ghostBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
  padding: 'var(--eb-space-1) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
  cursor: 'pointer', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
};

function Section({ title, children, right }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)' }}>{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function ErrorBar({ error, onDismiss }) {
  if (!error) return null;
  return (
    <div role="alert" style={{
      padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-error-bg)',
      border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)',
      color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)',
    }}>
      {error}
      {onDismiss && (
        <button onClick={onDismiss} style={{ marginLeft: 'var(--eb-space-3)', background: 'none', border: 'none', color: 'var(--eb-status-error)', cursor: 'pointer' }}>Dismiss</button>
      )}
    </div>
  );
}

/* ── Create-team form ─────────────────────────────────────────────────── */
function CreateTeamForm({ onSave, onCancel, saving, error }) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [description, setDescription] = useState('');
  const { handleNameChange, handleIdChange, resetAutoDerive, isAutoDerived } =
    useAutoDerivedId({ setName, setId, getName: () => name });

  const canSave = name.trim() && id.trim();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <ErrorBar error={error} />
      <FormInput label="Name *" value={name} onChange={handleNameChange} placeholder="e.g. Payments Squad" />
      <IdField
        value={id} onChange={handleIdChange}
        isAutoDerived={isAutoDerived()} onResetAuto={resetAutoDerive}
        placeholder="e.g. payments"
        helpText="Auto-derived from Name; edit to override. Lowercase letters, digits and hyphens; must start alphanumeric."
      />
      <FormInput label="Description" value={description} onChange={setDescription} multiline rows={3} placeholder="What this team owns" />
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={() => onSave({ id: id.trim(), name: name.trim(), description: description.trim() })}
          disabled={saving || !canSave}
          style={{ ...primaryBtn, opacity: (saving || !canSave) ? 0.6 : 1, cursor: saving ? 'wait' : 'pointer' }}
        >
          {saving ? 'Creating…' : 'Create team'}
        </button>
        <button onClick={onCancel} style={{ ...ghostBtn, padding: 'var(--eb-space-2) var(--eb-space-4)', fontSize: 'var(--eb-text-sm)' }}>Cancel</button>
      </div>
    </div>
  );
}

/* ── Manage-team panel (details + members) ────────────────────────────── */
function ManageTeamPanel({ team, users, memberships, onRefresh, onError }) {
  const [name, setName] = useState(team.name || '');
  const [description, setDescription] = useState(team.description || '');
  const [savingDetails, setSavingDetails] = useState(false);
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState('team-member');
  const [busy, setBusy] = useState(false);

  const teamMembers = useMemo(
    () => memberships.filter(m => m.teamId === team.id),
    [memberships, team.id],
  );
  const memberUserIds = new Set(teamMembers.map(m => m.userId));
  const candidateUsers = users.filter(u => !memberUserIds.has(u.id));

  async function saveDetails() {
    setSavingDetails(true);
    try {
      await apiCall('PUT', `/api/admin/teams/${encodeURIComponent(team.id)}`, { name: name.trim(), description: description.trim() });
      onRefresh();
    } catch (e) { onError(e.message); }
    finally { setSavingDetails(false); }
  }

  async function setRole(userId, role) {
    setBusy(true);
    try {
      await apiCall('POST', '/api/admin/memberships', { userId, teamId: team.id, role });
      onRefresh();
    } catch (e) { onError(e.message); }
    finally { setBusy(false); }
  }

  async function removeMember(userId) {
    setBusy(true);
    try {
      await apiCall('DELETE', `/api/admin/memberships?userId=${encodeURIComponent(userId)}&teamId=${encodeURIComponent(team.id)}`);
      onRefresh();
    } catch (e) { onError(e.message); }
    finally { setBusy(false); }
  }

  async function addMember() {
    if (!addUserId) return;
    await setRole(addUserId, addRole);
    setAddUserId('');
    setAddRole('team-member');
  }

  const userById = useMemo(() => Object.fromEntries(users.map(u => [u.id, u])), [users]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-6)' }}>
      <Section title="Team details">
        <FormInput label="Name" value={name} onChange={setName} />
        <FormInput label="Description" value={description} onChange={setDescription} multiline rows={3} />
        <div>
          <button onClick={saveDetails} disabled={savingDetails || !name.trim()} style={{ ...primaryBtn, opacity: (savingDetails || !name.trim()) ? 0.6 : 1 }}>
            {savingDetails ? 'Saving…' : 'Save details'}
          </button>
        </div>
      </Section>

      <Section title={`Members (${teamMembers.length})`}>
        {teamMembers.length === 0 && (
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>No members yet.</div>
        )}
        {teamMembers.map(m => {
          const u = userById[m.userId];
          return (
            <div key={m.id || m.userId} style={{
              display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>
                  {u ? (u.displayName || u.subject) : <em style={{ color: 'var(--eb-text-muted)' }}>unknown user ({m.userId})</em>}
                  {u?.systemAdmin && (
                    <span title="System Admin" style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--eb-accent-primary)', fontSize: 'var(--eb-text-xs)' }}>
                      <ShieldCheck size={12} /> sysadmin
                    </span>
                  )}
                </div>
                {u?.email && <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{u.email}</div>}
              </div>
              <select value={m.role} onChange={e => setRole(m.userId, e.target.value)} disabled={busy} style={{ ...inputStyle, width: 'auto' }}>
                {ROLE_OPTIONS.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
              <button onClick={() => removeMember(m.userId)} disabled={busy} title="Remove from team" style={{ ...ghostBtn, borderColor: 'var(--eb-status-error)', color: 'var(--eb-status-error)' }}>
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}

        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', paddingTop: 'var(--eb-space-2)' }}>
          <select value={addUserId} onChange={e => setAddUserId(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
            <option value="">{candidateUsers.length ? 'Select a user to add…' : 'No more users — create one first'}</option>
            {candidateUsers.map(u => <option key={u.id} value={u.id}>{(u.displayName || u.subject)}{u.email ? ` — ${u.email}` : ''}</option>)}
          </select>
          <select value={addRole} onChange={e => setAddRole(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
            {ROLE_OPTIONS.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
          <button onClick={addMember} disabled={busy || !addUserId} style={{ ...primaryBtn, padding: 'var(--eb-space-2) var(--eb-space-3)', opacity: (busy || !addUserId) ? 0.6 : 1 }}>
            <UserPlus size={14} /> Add
          </button>
        </div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          Users are created under <strong>Manage Users</strong>. System Admins have global access regardless of team membership.
        </div>
      </Section>
    </div>
  );
}

/* ── Manage-users panel ───────────────────────────────────────────────── */
function ManageUsersPanel({ users, onRefresh, onError }) {
  const [subject, setSubject] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [systemAdmin, setSystemAdmin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  // Inline per-user password setting (#374).
  const [pwUserId, setPwUserId] = useState(null);
  const [pwValue, setPwValue] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState(null);

  async function savePassword(userId) {
    if (!pwValue) return;
    setPwSaving(true);
    try {
      await apiCall('POST', `/api/admin/users/${encodeURIComponent(userId)}/password`, { password: pwValue });
      setPwUserId(null); setPwValue(''); setPwMsg(userId);
      setTimeout(() => setPwMsg(null), 2500);
    } catch (e) { onError(e.message); }
    finally { setPwSaving(false); }
  }

  async function createUser() {
    if (!subject.trim()) return;
    setSaving(true);
    try {
      await apiCall('POST', '/api/admin/users', {
        subject: subject.trim(),
        displayName: displayName.trim() || undefined,
        email: email.trim() || undefined,
        systemAdmin,
      });
      setSubject(''); setDisplayName(''); setEmail(''); setSystemAdmin(false);
      onRefresh();
    } catch (e) { onError(e.message); }
    finally { setSaving(false); }
  }

  async function toggleSysadmin(u) {
    try {
      await apiCall('PUT', `/api/admin/users/${encodeURIComponent(u.id)}`, { systemAdmin: !u.systemAdmin });
      onRefresh();
    } catch (e) { onError(e.message); }
  }

  async function doDelete() {
    try {
      await apiCall('DELETE', `/api/admin/users/${encodeURIComponent(deleteTarget.id)}`);
      setDeleteTarget(null);
      onRefresh();
    } catch (e) { onError(e.message); setDeleteTarget(null); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-6)' }}>
      <Section title="Add user">
        <FormInput label="Subject (stable identity) *" value={subject} onChange={setSubject} placeholder="e.g. jane.doe@corp.com or OIDC subject" />
        <FormInput label="Display name" value={displayName} onChange={setDisplayName} placeholder="e.g. Jane Doe" />
        <FormInput label="Email" value={email} onChange={setEmail} placeholder="jane.doe@corp.com" />
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          <input type="checkbox" checked={systemAdmin} onChange={e => setSystemAdmin(e.target.checked)} />
          System Admin (global access)
        </label>
        <div>
          <button onClick={createUser} disabled={saving || !subject.trim()} style={{ ...primaryBtn, opacity: (saving || !subject.trim()) ? 0.6 : 1 }}>
            <UserPlus size={14} /> {saving ? 'Adding…' : 'Add user'}
          </button>
        </div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          The <strong>subject</strong> is the stable identifier a future SSO login maps onto (OIDC subject claim or corporate email).
          To let a user log in <em>today</em>, set a password with the <KeyRound size={11} style={{ verticalAlign: 'middle' }} /> button below — they then sign in with their <strong>subject</strong> + that password. This is interim until enterprise SSO (#307); the operator's env admin login always keeps working.
        </div>
      </Section>

      <Section title={`Users (${users.length})`}>
        {users.length === 0 && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>No users yet.</div>}
        {users.map(u => (
          <div key={u.id} style={{
            display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--eb-text-sm)' }}>{u.displayName || u.subject}</div>
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{u.email || u.subject}</div>
              </div>
              {pwMsg === u.id && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-success)' }}>password set</span>}
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
                <input type="checkbox" checked={!!u.systemAdmin} onChange={() => toggleSysadmin(u)} /> sysadmin
              </label>
              <button onClick={() => { setPwUserId(pwUserId === u.id ? null : u.id); setPwValue(''); }} title="Set login password" style={ghostBtn}>
                <KeyRound size={13} />
              </button>
              <button onClick={() => setDeleteTarget(u)} title="Delete user" style={{ ...ghostBtn, borderColor: 'var(--eb-status-error)', color: 'var(--eb-status-error)' }}>
                <Trash2 size={13} />
              </button>
            </div>
            {pwUserId === u.id && (
              <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
                <input
                  type="password"
                  value={pwValue}
                  onChange={e => setPwValue(e.target.value)}
                  placeholder={`New login password for "${u.subject}"`}
                  autoComplete="new-password"
                  onKeyDown={e => { if (e.key === 'Enter') savePassword(u.id); }}
                  style={{
                    flex: 1, padding: 'var(--eb-space-2) var(--eb-space-3)',
                    background: 'var(--eb-bg-app)', border: '1px solid var(--eb-border-default)',
                    borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)',
                    fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', boxSizing: 'border-box',
                  }}
                />
                <button onClick={() => savePassword(u.id)} disabled={pwSaving || !pwValue} style={{ ...primaryBtn, padding: 'var(--eb-space-2) var(--eb-space-3)', opacity: (pwSaving || !pwValue) ? 0.6 : 1 }}>
                  {pwSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}
          </div>
        ))}
      </Section>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete user"
        message={`Delete "${deleteTarget?.displayName || deleteTarget?.subject}"? Their team memberships will be removed too.`}
        variant="danger" confirmLabel="Delete"
        onConfirm={doDelete} onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

/* ── Resource ownership (assign agents / environments to a team) ──────── */
function ResourceOwnership({ teams, agents, environments, onError, onRefreshAgents, onRefreshEnvs }) {
  const teamName = id => teams.find(t => t.id === id)?.name || id;
  const teamOptions = teams.map(t => t.id);

  async function reassign(kind, id, teamId) {
    try {
      if (kind === 'agent') await apiCall('PUT', `/api/agents/${encodeURIComponent(id)}`, { teamId });
      else await apiCall('PUT', `/api/environments/${encodeURIComponent(id)}`, { teamId });
      if (kind === 'agent') onRefreshAgents(); else onRefreshEnvs();
    } catch (e) { onError(e.message); }
  }

  const TeamSelect = ({ value, onChange }) => (
    <select value={value || DEFAULT_TEAM_ID} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
      {teamOptions.map(tid => <option key={tid} value={tid}>{teamName(tid)}</option>)}
    </select>
  );

  const row = (kind, item, label, sub) => (
    <div key={`${kind}:${item.id}`} style={{
      display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-2) var(--eb-space-3)',
      background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--eb-text-sm)' }}>{label}</div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>{sub}</div>
      </div>
      <TeamSelect value={item.teamId} onChange={tid => reassign(kind, item.id, tid)} />
    </div>
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--eb-space-6)' }}>
      <Section title={`Agents (${agents.length})`}>
        {agents.length === 0 && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>No agents.</div>}
        {agents.map(a => row('agent', a, a.displayName || a.id, `${a.id} · ${a.role || 'agent'}`))}
      </Section>
      <Section title={`Working Environments (${environments.length})`}>
        {environments.length === 0 && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>No environments.</div>}
        {environments.map(e => row('env', e, e.name || e.id, e.id))}
      </Section>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────── */
export default function Teams() {
  const { data: teams, loading: lt, error: et, refetch: refetchTeams } = useApi('/api/admin/teams');
  const { data: users, loading: lu, error: eu, refetch: refetchUsers } = useApi('/api/admin/users');
  const { data: memberships, refetch: refetchMemberships } = useApi('/api/admin/memberships');
  const { data: agents, refetch: refetchAgents } = useApi('/api/agents');
  const { data: environments, refetch: refetchEnvs } = useApi('/api/environments');

  const [creating, setCreating] = useState(false);
  const [savingCreate, setSavingCreate] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [manageTeam, setManageTeam] = useState(null);
  const [managingUsers, setManagingUsers] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState(null);

  const teamList = teams ?? [];
  const userList = users ?? [];
  const membershipList = memberships ?? [];

  const memberCount = useMemo(() => {
    const counts = {};
    for (const m of membershipList) counts[m.teamId] = (counts[m.teamId] || 0) + 1;
    return counts;
  }, [membershipList]);

  const COLUMNS = [
    { key: 'id', label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'name', label: 'Name' },
    { key: 'description', label: 'Description', render: v => <span style={{ color: 'var(--eb-text-secondary)' }}>{v || '—'}</span> },
    { key: '_members', label: 'Members', sortable: false, render: (_, row) => memberCount[row.id] || 0 },
    {
      key: '_actions', label: '', sortable: false,
      render: (_, row) => (
        <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
          <button onClick={() => setManageTeam(row)} title="Manage" style={ghostBtn}><Settings2 size={13} /> Manage</button>
          <button
            onClick={() => setDeleteTarget(row)}
            disabled={row.id === DEFAULT_TEAM_ID}
            title={row.id === DEFAULT_TEAM_ID ? 'The default team cannot be deleted' : 'Delete'}
            style={{ ...ghostBtn, borderColor: 'var(--eb-status-error)', color: 'var(--eb-status-error)', opacity: row.id === DEFAULT_TEAM_ID ? 0.4 : 1, cursor: row.id === DEFAULT_TEAM_ID ? 'not-allowed' : 'pointer' }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ),
    },
  ];

  async function handleCreate(body) {
    setSavingCreate(true); setCreateError(null);
    try {
      await apiCall('POST', '/api/admin/teams', body);
      setCreating(false);
      refetchTeams();
    } catch (e) { setCreateError(e.message); }
    finally { setSavingCreate(false); }
  }

  async function handleDelete() {
    try {
      await apiCall('DELETE', `/api/admin/teams/${encodeURIComponent(deleteTarget.id)}`);
      setDeleteTarget(null);
      refetchTeams(); refetchMemberships();
    } catch (e) { setActionError(e.message); setDeleteTarget(null); }
  }

  function refreshAll() {
    refetchTeams(); refetchUsers(); refetchMemberships();
  }

  if (lt || lu) {
    return <div aria-busy="true" style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }
  if (et || eu) {
    return (
      <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>
        Failed to load teams: {et || eu}. The orchestrator must be reachable for team management.
      </div>
    );
  }

  // Keep the manage panel's team in sync with refetched data.
  const liveManageTeam = manageTeam ? (teamList.find(t => t.id === manageTeam.id) || manageTeam) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-5)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>Teams</h1>
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
          <button onClick={() => setManagingUsers(true)} style={{ ...ghostBtn, padding: 'var(--eb-space-2) var(--eb-space-4)', fontSize: 'var(--eb-text-sm)' }}>
            <Users2 size={15} /> Manage Users
          </button>
          <button onClick={() => { setCreating(true); setCreateError(null); }} style={primaryBtn}>
            <Plus size={15} /> New Team
          </button>
        </div>
      </div>

      <div style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)', background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6,
      }}>
        A <strong>Team</strong> is a <em>human</em> collaboration & visibility scope (the tenant). Every agent, Agent Team,
        orchestrator and Working Environment is owned by exactly one Team. Add human users as <strong>Team Admins</strong> or
        <strong> Team Members</strong>; <strong>System Admins</strong> have global access. This is distinct from the
        <em> Agent Team</em> construct (a squad of agents) created via the Team Wizard.
      </div>

      <ErrorBar error={actionError} onDismiss={() => setActionError(null)} />

      <DataTable columns={COLUMNS} data={teamList} emptyText="No teams yet. Click 'New Team' to add one." getRowKey={r => r.id} onRowClick={r => setManageTeam(r)} />

      <ResourceOwnership
        teams={teamList}
        agents={agents ?? []}
        environments={environments ?? []}
        onError={setActionError}
        onRefreshAgents={refetchAgents}
        onRefreshEnvs={refetchEnvs}
      />

      <SidePanel open={creating} onClose={() => setCreating(false)} title="New team" width="520px">
        {creating && <CreateTeamForm onSave={handleCreate} onCancel={() => setCreating(false)} saving={savingCreate} error={createError} />}
      </SidePanel>

      <SidePanel open={!!liveManageTeam} onClose={() => setManageTeam(null)} title={liveManageTeam ? `Manage: ${liveManageTeam.name}` : ''} width="560px">
        {liveManageTeam && (
          <ManageTeamPanel
            team={liveManageTeam}
            users={userList}
            memberships={membershipList}
            onRefresh={refreshAll}
            onError={setActionError}
          />
        )}
      </SidePanel>

      <SidePanel open={managingUsers} onClose={() => setManagingUsers(false)} title="Manage users" width="560px">
        {managingUsers && <ManageUsersPanel users={userList} onRefresh={refreshAll} onError={setActionError} />}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete team"
        message={`Delete team "${deleteTarget?.name}"? Members lose this team membership. Agents/environments owned by it should be reassigned first.`}
        variant="danger" confirmLabel="Delete"
        onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
