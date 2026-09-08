import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { Trash2, Users2, UserPlus, Settings2, ShieldCheck } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import { useAuth } from '../auth/AuthContext';
import DataTable from '../components/DataTable';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import IconButton from '../components/IconButton';
import PageHelpButton from '../components/PageHelpButton';
import LearningBadge from '../components/LearningBadge';
import { groupAgentsForOwnership } from './teams-ownership';
import { ACCESS_HELP_SECTIONS } from './access-help-sections.js';
import { useHelpSubject } from '../context/HelperChatContext.jsx';
import { OVERLAY_TEAM_MANAGE } from '../context/page-help-view.js';
import { usePageActions } from '../context/PageActionsContext';

const DEFAULT_TEAM_ID = 'default';
const ROLE_LABELS = { 'team-admin': 'Team Admin', 'team-member': 'Team Member' };
const ROLE_OPTIONS = ['team-admin', 'team-member'];
const ROLE_HINTS = {
  'team-admin': 'manages this team’s members and details',
  'team-member': 'sees this team’s resources, no management',
};

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

/* ── Creating a scope is retired ──────────────────────────────────────────
   #2081 AC3: an access scope is no longer created here. `POST /api/admin/teams`
   answers 410 and the one creation path is `POST /api/teams` — an **Agent
   Team**, self-service, whose creator becomes its Team Admin in the same
   operation. The `CreateTeamForm` that used to live here is deleted rather
   than hidden: a form posting to a retired route is a button that 410s.
   Existing scopes stay fully manageable below (rename, membership, delete). */

/* ── Manage-team panel (details + members) ────────────────────────────── */
// `readOnly` (a Team Member viewing a team they don't administer, #584 AC9)
// renders details + members as a read-only view: no editing, adding, role
// changes or removals. The backend gates these mutations independently
// (canManageTeam → 403), so this only trims the UI to what's permitted.
function ManageTeamPanel({ team, users, memberships, onRefresh, onError, readOnly = false }) {
  const [name, setName] = useState(team.name || '');
  const [description, setDescription] = useState(team.description || '');
  const [savingDetails, setSavingDetails] = useState(false);
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState('team-member');
  const [busy, setBusy] = useState(false);

  // #1996: the Manage panel is a shared SidePanel (backdrop 60 / panel 61) and it
  // now hosts a "?". Publishing an overlay subject is what lifts the help panel
  // above that layer — without it the panel would open *behind* the very surface
  // it explains (the bug #1990 named and #1984 fixed on /flows). The key claims no
  // topic of its own: resolution falls through to `/teams`, whose chapters the "?"
  // deep-links into. This component only mounts while the panel is open, so the
  // subject comes and goes with it and `active` is unconditionally true.
  useHelpSubject({ overlay: OVERLAY_TEAM_MANAGE, active: true });

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
      <Section title="Team details" right={<LearningBadge scope={`team:${team.id}`} showZero title="Team knowledge learned" />}>
        <FormInput label="Name" value={name} onChange={setName} disabled={readOnly} />
        <FormInput label="Description" value={description} onChange={setDescription} multiline rows={3} disabled={readOnly} />
        {!readOnly && (
          <div>
            <button onClick={saveDetails} disabled={savingDetails || !name.trim()} style={{ ...primaryBtn, opacity: (savingDetails || !name.trim()) ? 0.6 : 1 }}>
              {savingDetails ? 'Saving…' : 'Save details'}
            </button>
          </div>
        )}
      </Section>

      {/* #1996: the Manage panel is the ticket's "second surface". Its "?" sits
          on the Members heading rather than on Team details, because that is the
          half with decisions in it — which role to grant, and what removing
          somebody does and does not do (it drops a membership, never the person).
          The chapter it opens covers both halves of the panel. */}
      <Section
        title={`Members (${teamMembers.length})`}
        right={(
          <PageHelpButton
            label="What managing a scope's members does — and what it does not"
            size={13}
            style={{ padding: 0, flexShrink: 0 }}
            section={ACCESS_HELP_SECTIONS.manage}
          />
        )}
      >
        {teamMembers.length === 0 && (
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>No members yet.</div>
        )}
        {teamMembers.map(m => {
          const u = userById[m.userId];
          return (
            <div key={m.id || m.userId} className="eb-wrap-md" style={{
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
              {readOnly ? (
                <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{ROLE_LABELS[m.role] || m.role}</span>
              ) : (
                <>
                  <select value={m.role} onChange={e => setRole(m.userId, e.target.value)} disabled={busy} title={`${ROLE_LABELS[m.role] || m.role} — ${ROLE_HINTS[m.role] || ''}`} style={{ ...inputStyle, width: 'auto' }}>
                    {ROLE_OPTIONS.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                  <IconButton icon={Trash2} label="Remove from team" danger onClick={() => removeMember(m.userId)} disabled={busy} />
                </>
              )}
            </div>
          );
        })}

        {!readOnly && (
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center', paddingTop: 'var(--eb-space-2)' }}>
            <select value={addUserId} onChange={e => setAddUserId(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
              <option value="">{candidateUsers.length ? 'Select a user to add…' : 'No more users — create one first'}</option>
              {candidateUsers.map(u => <option key={u.id} value={u.id}>{(u.displayName || u.subject)}{u.email ? ` — ${u.email}` : ''}</option>)}
            </select>
            <select value={addRole} onChange={e => setAddRole(e.target.value)} title={`${ROLE_LABELS[addRole] || addRole} — ${ROLE_HINTS[addRole] || ''}`} style={{ ...inputStyle, width: 'auto' }}>
              {ROLE_OPTIONS.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
            <button onClick={addMember} disabled={busy || !addUserId} style={{ ...primaryBtn, padding: 'var(--eb-space-2) var(--eb-space-3)', opacity: (busy || !addUserId) ? 0.6 : 1 }}>
              <UserPlus size={14} /> Add
            </button>
          </div>
        )}
        {!readOnly && (
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--eb-text-secondary)' }}>{ROLE_LABELS['team-admin']}</strong> — {ROLE_HINTS['team-admin']}.{' '}
            <strong style={{ color: 'var(--eb-text-secondary)' }}>{ROLE_LABELS['team-member']}</strong> — {ROLE_HINTS['team-member']}.
          </div>
        )}
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          {readOnly
            ? 'You have read-only access to this team. Team Admins can manage members.'
            : <>Users are managed on the <strong>Users</strong> page. System Admins have global access regardless of team membership.</>}
        </div>
      </Section>
    </div>
  );
}

/* ── Resource ownership (assign agents / environments to a team) ──────── */
function ResourceOwnership({ teams, agents, environments, onError, onRefreshAgents, onRefreshEnvs }) {
  const teamName = id => teams.find(t => t.id === id)?.name || id;
  const teamOptions = teams.map(t => t.id);

  // An Agent Team moves between tenants as one unit (#568): reassigning the
  // parent `team` agent cascades to all its members server-side, so the UI
  // fires a single call against the team agent and re-fetches.
  async function reassign(kind, id, teamId) {
    try {
      if (kind === 'agent') await apiCall('PUT', `/api/agents/${encodeURIComponent(id)}`, { teamId });
      else await apiCall('PUT', `/api/environments/${encodeURIComponent(id)}`, { teamId });
    } catch (e) { onError(e.message); }
    finally {
      if (kind === 'agent') onRefreshAgents(); else onRefreshEnvs();
    }
  }

  const { agentTeams, standaloneAgents } = useMemo(
    () => groupAgentsForOwnership(agents),
    [agents],
  );

  const TeamSelect = ({ value, onChange }) => (
    <select value={value || DEFAULT_TEAM_ID} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
      {teamOptions.map(tid => <option key={tid} value={tid}>{teamName(tid)}</option>)}
    </select>
  );

  const cardStyle = {
    display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
    padding: 'var(--eb-space-2) var(--eb-space-3)',
    background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  };

  // A standalone agent / environment: its own assignment control.
  const row = (kind, item, label, sub) => (
    <div key={`${kind}:${item.id}`} style={cardStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--eb-text-sm)' }}>{label}</div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>{sub}</div>
      </div>
      <TeamSelect value={item.teamId} onChange={tid => reassign(kind, item.id, tid)} />
    </div>
  );

  // An Agent Team: one assignment control for the whole squad; members are
  // listed read-only beneath it (no individual dropdown — they inherit).
  const teamGroup = ({ team, members }) => (
    <div key={`team:${team.id}`} style={{ ...cardStyle, flexDirection: 'column', alignItems: 'stretch', gap: 'var(--eb-space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--eb-text-sm)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
            <Users2 size={13} /> {team.displayName || team.id}
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Agent Team · {members.length} member{members.length === 1 ? '' : 's'}</span>
          </div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>{team.id}</div>
        </div>
        <TeamSelect value={team.teamId} onChange={tid => reassign('agent', team.id, tid)} />
      </div>
      {members.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)', paddingLeft: 'var(--eb-space-3)', borderLeft: '2px solid var(--eb-border-default)' }}>
          {members.map(m => (
            <div key={m.id} style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', display: 'flex', justifyContent: 'space-between', gap: 'var(--eb-space-2)' }}>
              <span>{m.displayName || m.id}</span>
              <span style={{ color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>{m.id}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--eb-space-6)' }}>
      <Section title={`Agents (${agentTeams.length})`}>
        {agentTeams.length === 0 && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>No agents.</div>}
        {agentTeams.map(teamGroup)}
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
  const { user } = useAuth();
  const navigate = useNavigate();
  // Full admins (env admin + System Admin) manage everything; a non-admin may
  // only manage a team they are the Team Admin of (#584 AC9). Mirrors the
  // backend's canManageTeam — the UI trims controls, the API enforces.
  const isAdmin = !!user?.admin;
  const canManage = (teamId) =>
    isAdmin || (user?.teams || []).some(t => t.teamId === teamId && t.role === 'team-admin');

  const { data: teams, loading: lt, error: et, refetch: refetchTeams } = useApi('/api/admin/teams');
  const { data: users, loading: lu, error: eu, refetch: refetchUsers } = useApi('/api/admin/users');
  const { data: memberships, refetch: refetchMemberships } = useApi('/api/admin/memberships');
  const { data: agents, refetch: refetchAgents } = useApi('/api/agents');
  const { data: environments, refetch: refetchEnvs } = useApi('/api/environments');

  const [manageTeam, setManageTeam] = useState(null);
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
      render: (_, row) => {
        const manageable = canManage(row.id);
        return (
          <div className="eb-wrap-md" style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
            <button onClick={() => setManageTeam(row)} title={manageable ? 'Manage' : 'View'} style={ghostBtn}>
              <Settings2 size={13} /> {manageable ? 'Manage' : 'View'}
            </button>
            {/* Delete is a management action: only shown to a full admin or the
                team's Team Admin (never for the default team). #584 AC9. */}
            {manageable && (
              <IconButton
                icon={Trash2}
                label="Delete"
                danger
                onClick={() => setDeleteTarget(row)}
                disabled={row.id === DEFAULT_TEAM_ID}
                title={row.id === DEFAULT_TEAM_ID ? 'The default team cannot be deleted' : 'Delete'}
              />
            )}
          </div>
        );
      },
    },
  ];

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

  const headerAction = usePageActions(
    isAdmin ? (
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
        <button onClick={() => navigate('/users')} style={{ ...ghostBtn, padding: 'var(--eb-space-2) var(--eb-space-4)', fontSize: 'var(--eb-text-sm)' }}>
          <Users2 size={15} /> Manage Users
        </button>
      </div>
    ) : null
  );

  return (
    <>
      {headerAction}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-5)' }}>

      {/* One-line description + the "?" that opens this page's help topic. The
          intro box that used to sit here — the access-scope definition, the
          Team-vs-Agent-Team distinction and the role list — now lives in that
          topic (api/helper-chat/help-topics/access-users.md, #1881), together
          with what a scope actually gates and the delete/ownership rules. The
          role hints inside the Manage panel stay at the point of decision. */}
      <p style={{
        margin: 0,
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)',
        fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
      }}>
        <span>
          Access scopes — internally <strong>Teams</strong> — are the human tenants that own your
          agents, environments and credentials, plus the people who may see and manage them.
        </span>
        <PageHelpButton
          label="What is an access scope, and how does it differ from an Agent Team?"
          size={14}
          style={{ padding: 0, flexShrink: 0 }}
          section={ACCESS_HELP_SECTIONS.page}
        />
      </p>

      <ErrorBar error={actionError} onDismiss={() => setActionError(null)} />

      <DataTable columns={COLUMNS} data={teamList} emptyText="No access scopes. Creating a team is self-service — use + Create." getRowKey={r => r.id} onRowClick={r => setManageTeam(r)} />

      {/* Reassigning agents/environments across teams is a global operation —
          System-Admin-only (#584). Non-admins never see this section. */}
      {isAdmin && (
        <ResourceOwnership
          teams={teamList}
          agents={agents ?? []}
          environments={environments ?? []}
          onError={setActionError}
          onRefreshAgents={refetchAgents}
          onRefreshEnvs={refetchEnvs}
        />
      )}

      <SidePanel open={!!liveManageTeam} onClose={() => setManageTeam(null)} title={liveManageTeam ? `Manage: ${liveManageTeam.name}` : ''} width="560px">
        {liveManageTeam && (
          <ManageTeamPanel
            team={liveManageTeam}
            users={userList}
            memberships={membershipList}
            onRefresh={refreshAll}
            onError={setActionError}
            readOnly={!canManage(liveManageTeam.id)}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete team"
        message={`Delete team "${deleteTarget?.name}"? Members lose this team membership. Agents/environments owned by it should be reassigned first.`}
        variant="danger" confirmLabel="Delete"
        onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)}
      />
    </div>
    </>
  );
}
