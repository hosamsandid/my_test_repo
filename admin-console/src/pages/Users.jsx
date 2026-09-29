import React, { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { Plus, Pencil, Trash2, ShieldCheck, KeyRound, Users2, AlertTriangle } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import { useAuth } from '../auth/AuthContext';
import DataTable from '../components/DataTable';
import PageHelpButton from '../components/PageHelpButton';
import EnvironmentOwnership from '../components/EnvironmentOwnership';
import { ADMINISTRATION_HELP_SECTIONS } from './administration-help-sections.js';
import { useHelpSubject } from '../context/HelperChatContext.jsx';
import { OVERLAY_USER_EDIT, OVERLAY_USER_DELETE, OVERLAY_TEAM_DELETE } from '../context/page-help-view.js';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import PasswordField from '../components/PasswordField';
import IconButton from '../components/IconButton';
import {
  usersToRows, isSelf, selfActionWarning, validateUserForm, lastSystemAdminGuard,
} from './users-view';
import {
  ADMIN_TABS, resolveAdminTab,
  allTeamRows, isUnadministered, teamDeleteImpact,
  groupAgentsForOwnership,
  environmentTierSummary, environmentOwnershipError, environmentOwnershipPatch,
  ownershipUnchanged,
} from './administration-view.js';
import { ownershipFromRecord, teamsById } from './credential-scope-view.js';

// The page's one-liner under the title. #1996 wrote it for the Users page; #2085
// widened it when the Access page was dissolved onto this one (D10) — the whole
// System-Admin surface is here now, so the pointer that used to send readers to
// Access has nowhere left to point and is replaced by what the tabs do.
const PAGE_DESCRIPTION = 'Everything only a System Admin manages: the user records, every team on the platform, and who owns each agent and environment.';

const DEFAULT_TEAM_ID = 'default';

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
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
  cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
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

const cardStyle = {
  display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
};

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

function WarnNote({ children }) {
  return (
    <div style={{
      padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-status-warning-bg)',
      border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)',
      color: 'var(--eb-status-warning)', fontSize: 'var(--eb-text-xs)', lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}

// One tab's toolbar: a one-line lead plus the "?" that opens this tab's chapter.
// The "?" hangs off the toolbar rather than the tab strip on purpose — the strip
// is one control serving three chapters, so a fixed chapter on it would be wrong
// two thirds of the time.
function TabLead({ children, label, section }) {
  return (
    <p style={{
      margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
      fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
    }}>
      <span>{children}</span>
      <PageHelpButton label={label} size={14} style={{ padding: 0, flexShrink: 0 }} section={section} />
    </p>
  );
}

// `lockedReason` (#2059 AC7) is the store's own refusal sentence when this
// record is the last System Admin: the box stays ticked and un-untickable, with
// the reason both in the tooltip and in visible text, because a control that is
// merely disabled leaves the reader guessing. Ticking it ON is never blocked —
// only demotion is — so the guard is asked about 'demote' and applied to the
// checkbox rather than to the whole field.
function SysAdminField({ checked, onChange, lockedReason }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
      <label
        title={lockedReason || undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
          fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
          cursor: lockedReason ? 'not-allowed' : 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={!!lockedReason}
          onChange={e => onChange(e.target.checked)}
        />
        System Admin (global access)
      </label>
      {lockedReason && (
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          {lockedReason}
        </span>
      )}
    </div>
  );
}

/* ── Create-user form ─────────────────────────────────────────────────── */
function CreateUserPanel({ onSave, onCancel, saving, error }) {
  const [subject, setSubject] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [systemAdmin, setSystemAdmin] = useState(false);

  const validation = validateUserForm({ subject, displayName }, 'create');
  const canSave = !validation && !saving;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <ErrorBar error={error} />
      <FormInput label="Subject (stable identity)" required value={subject} onChange={setSubject} placeholder="e.g. jane.doe@corp.com or OIDC subject" />
      <FormInput label="Display name" value={displayName} onChange={setDisplayName} placeholder="e.g. Jane Doe" />
      <FormInput label="Email" type="email" value={email} onChange={setEmail} placeholder="jane.doe@corp.com" />
      <SysAdminField checked={systemAdmin} onChange={setSystemAdmin} />
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>
        The <strong>subject</strong> is the stable identifier a future SSO login maps onto (OIDC subject claim or corporate email) and cannot be changed later. To let a user log in today, set a login password after creating them.
      </div>
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-3)', borderTop: '1px solid var(--eb-border-default)' }}>
        <button
          onClick={() => onSave({ subject: subject.trim(), displayName: displayName.trim() || undefined, email: email.trim() || undefined, systemAdmin })}
          disabled={!canSave}
          style={{ ...primaryBtn, opacity: canSave ? 1 : 0.6, cursor: saving ? 'wait' : 'pointer' }}
        >
          <Plus size={14} /> {saving ? 'Creating…' : 'Create user'}
        </button>
        <button onClick={onCancel} style={ghostBtn}>Cancel</button>
      </div>
    </div>
  );
}

/* ── Edit-user form (details + login password) ────────────────────────── */
// `user` is kept live by the parent (re-found in the refetched list by id), so
// the password section reflects the current `hasPassword` state after a set or
// clear without this panel owning that flag.
function EditUserPanel({ user, me, users, onSave, saving, error, onError, onRefresh }) {
  const [displayName, setDisplayName] = useState(user.displayName || '');
  const [email, setEmail] = useState(user.email || '');
  const [systemAdmin, setSystemAdmin] = useState(!!user.systemAdmin);
  const [pwValue, setPwValue] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState(null);

  const validation = validateUserForm({ subject: user.subject, displayName }, 'edit');
  const canSave = !validation && !saving;
  const lockoutWarn = selfActionWarning({ me, target: user, action: 'edit', nextSystemAdmin: systemAdmin });
  // The server refuses to demote the last System Admin (#2059 AC7); mirror it
  // so the box cannot be unticked in the first place. This is a different
  // concern from `lockoutWarn`, which is advisory and about *your own* account:
  // both can be live at once, and the estate-level rule is the one that blocks.
  const demoteGuard = lastSystemAdminGuard({ users, target: user, action: 'demote' });

  async function setPassword() {
    if (!pwValue) return;
    setPwSaving(true);
    try {
      await apiCall('POST', `/api/admin/users/${encodeURIComponent(user.id)}/password`, { password: pwValue });
      setPwValue(''); setPwMsg('Login password set.');
      onRefresh();
    } catch (e) { onError(e.message); }
    finally { setPwSaving(false); }
  }

  async function clearPassword() {
    setPwSaving(true);
    try {
      await apiCall('DELETE', `/api/admin/users/${encodeURIComponent(user.id)}/password`);
      setPwValue(''); setPwMsg('Login password cleared.');
      onRefresh();
    } catch (e) { onError(e.message); }
    finally { setPwSaving(false); }
  }

  // #1996: the edit panel is a shared SidePanel (backdrop 60 / panel 61) and now
  // hosts a "?". Publishing an overlay subject is what lifts the help panel above
  // that layer — without it it would open *behind* the panel it explains. The key
  // claims no topic of its own; resolution falls through to `/users`. This
  // component only mounts while the panel is open, so the subject is scoped to it.
  useHelpSubject({ overlay: OVERLAY_USER_EDIT, active: true });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-5)' }}>
      <ErrorBar error={error} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        {/* Subject is the stable identity — shown for context but never editable (AC8).
            The "?" rides this row because the disabled field is the panel's most-asked
            question ("why can I not change this?"), and the chapter it opens answers
            that plus the panel's two independent halves. */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--eb-space-1)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <FormInput label="Subject (stable identity)" value={user.subject} onChange={() => {}} disabled />
          </div>
          <PageHelpButton
            label="Why the Subject cannot be changed, and how the password section works"
            size={13}
            style={{ padding: 0, flexShrink: 0, marginBottom: 'var(--eb-space-2)' }}
            section={ADMINISTRATION_HELP_SECTIONS.edit}
          />
        </div>
        <FormInput label="Display name" required value={displayName} onChange={setDisplayName} error={validation || undefined} />
        <FormInput label="Email" type="email" value={email} onChange={setEmail} placeholder="jane.doe@corp.com" />
        <SysAdminField
          checked={systemAdmin}
          onChange={setSystemAdmin}
          lockedReason={demoteGuard.ok ? null : demoteGuard.reason}
        />
        {lockoutWarn && <WarnNote>{lockoutWarn}</WarnNote>}
        <div>
          <button
            onClick={() => onSave({ displayName: displayName.trim(), email: email.trim(), systemAdmin })}
            disabled={!canSave}
            style={{ ...primaryBtn, opacity: canSave ? 1 : 0.6, cursor: saving ? 'wait' : 'pointer' }}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      {/* Login password (#374) — set or clear the interim local password. The
          affordance reflects whether one is currently set (AC9 + edge case). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-4)', borderTop: '1px solid var(--eb-border-default)' }}>
        <h3 style={{ margin: 0, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <KeyRound size={15} /> Login password
        </h3>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          {user.hasPassword
            ? <>This user has a login password set. They sign in with their <strong>subject</strong> + password.</>
            : <>No login password set. Set one to let this user sign in with their <strong>subject</strong> + password (interim until SSO).</>}
        </div>
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
          <PasswordField
            value={pwValue}
            onChange={e => setPwValue(e.target.value)}
            placeholder={user.hasPassword ? 'New login password' : 'Set login password'}
            autoComplete="new-password"
            onKeyDown={e => { if (e.key === 'Enter') setPassword(); }}
            wrapperStyle={{ flex: 1, minWidth: 0 }}
            style={{
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)',
              fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
            }}
          />
          <button onClick={setPassword} disabled={pwSaving || !pwValue} style={{ ...primaryBtn, opacity: (pwSaving || !pwValue) ? 0.6 : 1 }}>
            {pwSaving ? 'Saving…' : 'Set'}
          </button>
          {user.hasPassword && (
            <button onClick={clearPassword} disabled={pwSaving} style={{ ...ghostBtn, opacity: pwSaving ? 0.6 : 1 }}>
              Clear
            </button>
          )}
        </div>
        {pwMsg && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-success)' }}>{pwMsg}</span>}
      </div>
    </div>
  );
}

/* ── Delete confirmation body (#1996) ─────────────────────────────────── */
//
// The confirmation's message is its own component for two reasons. A hook cannot
// live inside a prop expression, and this body needs one: ConfirmDialog is the
// shared Modal at z-index 9999, so without an overlay subject the help panel
// (50) would open BEHIND the decision it is there to inform — the worst place
// for it, given this is the page's only irreversible action. And because
// ConfirmDialog renders null while closed, the subject is mounted exactly when
// the dialog is, with no `active` flag to keep in step.
//
// The dialog's own sentence stays verbatim: it is point-of-decision copy. The
// "?" is an addition beside it, opening the chapter that spells out what the
// sentence summarises — the agents that get paused (which the sentence does not
// mention) and the personal-credential deletion.
//
// #2059 removed one item from that chapter: deleting the LAST System Admin is
// now refused by the store, so this dialog can no longer be reached for such a
// record (the row's Delete is disabled with the reason on it). Deleting your
// OWN account is still only warned about, not blocked — that is `warning`.
function DeleteUserMessage({ target, warning }) {
  useHelpSubject({ overlay: OVERLAY_USER_DELETE, active: true });
  return (
    <>
      <p style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--eb-space-1)' }}>
        <span>
          Delete "{target?.displayName || target?.subject}"? Their team memberships and personal credentials will be removed too.
        </span>
        <PageHelpButton
          label="What deleting a user does to their agents and credentials"
          size={13}
          style={{ padding: 0, flexShrink: 0 }}
          section={ADMINISTRATION_HELP_SECTIONS.offboarding}
        />
      </p>
      {warning && <p style={{ color: 'var(--eb-status-warning)' }}>{warning}</p>}
    </>
  );
}

/* ── Users tab ────────────────────────────────────────────────────────── */
// `creating` is owned by the page, not by this tab: the New User button lives in
// the page header (where every other page's primary action is) and the panel it
// opens lives here. Lifting the one boolean is what keeps them in step without
// the tab reaching up into the header during render.
function UsersTab({ me, creating, onCreatingChange }) {
  const { data: users, loading, error, refetch } = useApi('/api/admin/users');

  const [savingCreate, setSavingCreate] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [editId, setEditId] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState(null);

  const userList = users ?? [];
  // Sensible default sort on load (AC4): alphabetical by display name. DataTable
  // leaves the input order untouched until a header is clicked, so pre-sorting
  // here is what gives the page its default sort while keeping columns sortable.
  const rows = useMemo(
    () => usersToRows(userList).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [userList],
  );
  const editUser = editId ? userList.find(u => u.id === editId) || null : null;

  // One helper for the row action, so the column renderer and the dialog cannot
  // disagree about whether this record may go.
  const deleteGuardFor = (user) => lastSystemAdminGuard({ users: userList, target: user, action: 'delete' });

  function closeCreate() {
    onCreatingChange(false);
    setCreateError(null);
  }

  const COLUMNS = [
    { key: 'displayName', label: 'Display name' },
    { key: 'subject', label: 'Subject', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'email', label: 'Email', render: v => <span style={{ color: 'var(--eb-text-secondary)' }}>{v || '—'}</span> },
    {
      key: 'systemAdminLabel', label: 'System Admin',
      render: (v, row) => row.systemAdmin
        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--eb-accent-primary)', fontSize: 'var(--eb-text-xs)' }}><ShieldCheck size={13} /> System Admin</span>
        : <span style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)' }}>Member</span>,
    },
    { key: 'passwordLabel', label: 'Password', render: v => <span style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    {
      key: '_actions', label: '', sortable: false,
      render: (_, row) => (
        <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
          <IconButton icon={Pencil} label="Edit user" onClick={() => { setEditId(row.id); setEditError(null); }} />
          {/* The store refuses to delete the last System Admin (#2059 AC7).
              Mirrored as disabled + the store's own sentence in the tooltip, the
              shape Teams.jsx uses for the default team; the server stays the
              authority and its 409 message renders verbatim in `actionError`
              if a request is made anyway. */}
          <IconButton
            icon={Trash2}
            label="Delete user"
            danger
            onClick={() => setDeleteTarget(row._user)}
            disabled={!deleteGuardFor(row._user).ok}
            title={deleteGuardFor(row._user).reason || 'Delete user'}
          />
        </div>
      ),
    },
  ];

  async function handleCreate(body) {
    setSavingCreate(true); setCreateError(null);
    try {
      await apiCall('POST', '/api/admin/users', body);
      closeCreate();
    } catch (e) { setCreateError(e.message); }
    finally {
      setSavingCreate(false);
      // In `finally`, not after the await (#2135 AC8): the create route persists
      // the record BEFORE its last steps, so a rejection can arrive for a user
      // that already exists. Refetching only on success left the operator with
      // an error banner over a stale list and no way to see the truth but a
      // manual reload. The dialog deliberately stays open on failure — the
      // refreshed list behind it is what shows whether the record landed.
      refetch();
    }
  }

  async function handleEditSave(patch) {
    if (!editUser) return;
    setSavingEdit(true); setEditError(null);
    try {
      await apiCall('PUT', `/api/admin/users/${encodeURIComponent(editUser.id)}`, patch);
      setEditId(null);
      refetch();
    } catch (e) { setEditError(e.message); }
    finally { setSavingEdit(false); }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiCall('DELETE', `/api/admin/users/${encodeURIComponent(deleteTarget.id)}`);
      setDeleteTarget(null);
      refetch();
    } catch (e) { setActionError(e.message); setDeleteTarget(null); }
    finally { setDeleting(false); }
  }

  if (loading) {
    return <div aria-busy="true" style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }
  if (error) {
    return (
      <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>
        Failed to load users: {error}. The orchestrator must be reachable for user management.
      </div>
    );
  }

  const deleteWarn = deleteTarget ? selfActionWarning({ me, target: deleteTarget, action: 'delete' }) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <ErrorBar error={actionError} onDismiss={() => setActionError(null)} />

      <DataTable
        columns={COLUMNS}
        data={rows}
        emptyText="No users yet. Click 'New User' to add one."
        getRowKey={r => r.id}
        onRowClick={r => { setEditId(r.id); setEditError(null); }}
      />

      <SidePanel open={creating} onClose={closeCreate} title="New user" width="520px">
        {creating && <CreateUserPanel onSave={handleCreate} onCancel={closeCreate} saving={savingCreate} error={createError} />}
      </SidePanel>

      <SidePanel open={!!editUser} onClose={() => setEditId(null)} title={editUser ? `Edit: ${editUser.displayName || editUser.subject}` : ''} width="560px">
        {editUser && (
          <EditUserPanel
            key={editUser.id}
            user={editUser}
            me={me}
            users={userList}
            onSave={handleEditSave}
            saving={savingEdit}
            error={editError}
            onError={setEditError}
            onRefresh={refetch}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete user"
        message={<DeleteUserMessage target={deleteTarget} warning={deleteWarn} />}
        variant="danger" confirmLabel="Delete" busy={deleting}
        onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

/* ── All Teams tab — the D5 System-Admin cleanup view (#2085) ─────────── */
//
// The rows are **Agent Teams**, not access scopes: since P1 (§3.3) a membership
// points at a `role: 'team'` agent id, so "every team on the platform" is that
// list. The tab is a cleanup view, not a management surface — growing a team,
// changing roles and naming a D4 successor all live in the Share dialog (#2082)
// where the team's own people already are. What is left here is the thing only a
// System Admin can do: see teams they are not a member of, and delete one.

// The delete confirmation's body, extracted for the same reason
// `DeleteUserMessage` is: it needs a hook, and a hook cannot live in a
// `message={…}` prop expression. ConfirmDialog is the shared Modal at 9999, so
// without the overlay subject the help would open behind the decision.
function DeleteTeamMessage({ impact }) {
  useHelpSubject({ overlay: OVERLAY_TEAM_DELETE, active: true });
  if (!impact) return null;
  return (
    <>
      <p style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--eb-space-1)' }}>
        <span>{impact.detail}</span>
        <PageHelpButton
          label="What deleting a team cascades to"
          size={13}
          style={{ padding: 0, flexShrink: 0 }}
          section={ADMINISTRATION_HELP_SECTIONS.teamDelete}
        />
      </p>
    </>
  );
}

function AllTeamsTab() {
  const { data: agents, loading: la, error: ea, refetch: refetchAgents } = useApi('/api/agents');
  const { data: memberships, refetch: refetchMemberships } = useApi('/api/admin/memberships');
  const { data: users } = useApi('/api/admin/users');

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState(null);

  const rows = useMemo(
    () => allTeamRows(agents ?? [], memberships ?? [], users ?? []),
    [agents, memberships, users],
  );

  const COLUMNS = [
    { key: 'id', label: 'ID', render: v => <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    { key: 'name', label: 'Team' },
    { key: 'owner', label: 'Owner', render: v => <span style={{ color: 'var(--eb-text-secondary)' }}>{v}</span> },
    { key: 'agents', label: 'Member agents' },
    {
      key: 'people', label: 'People',
      // A team with no Team Admin left is the one state this view exists to
      // surface (D5): nobody but a System Admin can change it any more.
      render: (v, row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {v}
          {isUnadministered(row) && (
            <span title="No Team Admin — only a System Admin can change this team" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--eb-status-warning)', fontSize: 'var(--eb-text-xs)' }}>
              <AlertTriangle size={12} /> no admin
            </span>
          )}
        </span>
      ),
    },
    { key: 'admins', label: 'Team Admins' },
    { key: 'enabled', label: 'State', render: v => <span style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)' }}>{v}</span> },
    {
      key: '_actions', label: '', sortable: false,
      render: (_, row) => (
        <div style={{ display: 'flex', gap: 'var(--eb-space-1)' }} onClick={e => e.stopPropagation()}>
          <IconButton icon={Trash2} label="Delete team" danger onClick={() => setDeleteTarget(row)} />
        </div>
      ),
    },
  ];

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      // The cascades are the server's and already exist: member agents go with
      // the parent (#1960) and the human memberships with the team (#2081), so
      // this tab needs no endpoint of its own.
      await apiCall('DELETE', `/api/agents/${encodeURIComponent(deleteTarget.id)}`);
      setDeleteTarget(null);
      refetchAgents(); refetchMemberships();
    } catch (e) { setActionError(e.message); setDeleteTarget(null); }
    finally { setDeleting(false); }
  }

  if (la) {
    return <div aria-busy="true" style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }
  if (ea) {
    return (
      <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>
        Failed to load teams: {ea}. The orchestrator must be reachable.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <TabLead
        label="What the All Teams tab shows, and why it lists Agent Teams"
        section={ADMINISTRATION_HELP_SECTIONS.allTeams}
      >
        Every team on the platform, including ones you are not a member of. Members and
        roles are managed by each team's own admins in <strong>Share…</strong> in the Agent Chat.
      </TabLead>

      <ErrorBar error={actionError} onDismiss={() => setActionError(null)} />

      <DataTable
        columns={COLUMNS}
        data={rows}
        emptyText="No teams yet. A team is created from + Create — it is self-service."
        getRowKey={r => r.id}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title={teamDeleteImpact(deleteTarget)?.title || 'Delete team'}
        message={<DeleteTeamMessage impact={teamDeleteImpact(deleteTarget)} />}
        variant="danger" confirmLabel="Delete" busy={deleting}
        onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

/* ── Resources tab — tiered ownership (#2085, D7/D12) ─────────────────── */

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

// One Working Environment's ownership.
//
// The old Access page rendered a flat team `<select>` here and sent
// `PUT { teamId }`. Since #2083 an environment carries the same
// `{scope, teamId, assignedTeamIds}` tier a credential does, and a bare
// `{ teamId }` normalizes to `scope: 'team'` server-side — so that one click
// would silently un-share a shared environment. The row therefore states the
// tier and edits it AS a tier, through the shared `EnvironmentOwnership` control
// (no second copy of the tier semantics).
function EnvironmentOwnershipRow({ env, teams, teamNames, onSaved, onError }) {
  const [editing, setEditing] = useState(false);
  const [ownership, setOwnership] = useState(() => ownershipFromRecord(env, { isSysAdmin: true }));
  const [saving, setSaving] = useState(false);

  const current = environmentTierSummary(env, teamNames);
  const pending = environmentTierSummary(
    ownership.scope === 'system'
      ? { scope: 'system', assignedTeamIds: ownership.assignedTeamIds }
      : { scope: 'team', teamId: ownership.teamId },
    teamNames,
  );
  const blocked = environmentOwnershipError(ownership);
  const unchanged = ownershipUnchanged(env, ownership);

  function open() {
    setOwnership(ownershipFromRecord(env, { isSysAdmin: true }));
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    try {
      await apiCall('PUT', `/api/environments/${encodeURIComponent(env.id)}`, environmentOwnershipPatch(ownership));
      setEditing(false);
      onSaved();
    } catch (e) { onError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ ...cardStyle, flexDirection: 'column', alignItems: 'stretch', gap: 'var(--eb-space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--eb-text-sm)' }}>{env.name || env.id}</div>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            <strong style={{ color: 'var(--eb-text-secondary)' }}>{current.label}</strong>
            {' · '}{current.detail}
          </div>
        </div>
        {!editing && (
          <button onClick={open} style={ghostBtn}>Change ownership</button>
        )}
      </div>

      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)', paddingTop: 'var(--eb-space-2)', borderTop: '1px solid var(--eb-border-default)' }}>
          <EnvironmentOwnership
            value={ownership}
            onChange={setOwnership}
            teams={teams}
            isSysAdmin
            disabled={saving}
          />
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            After saving: <strong style={{ color: 'var(--eb-text-secondary)' }}>{pending.label}</strong> · {pending.detail}
          </div>
          {blocked && <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)' }}>{blocked}</div>}
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <button
              onClick={save}
              disabled={saving || !!blocked || unchanged}
              title={blocked || (unchanged ? 'Nothing changed' : undefined)}
              style={{ ...primaryBtn, padding: 'var(--eb-space-1) var(--eb-space-3)', opacity: (saving || blocked || unchanged) ? 0.6 : 1 }}
            >
              {saving ? 'Saving…' : 'Save ownership'}
            </button>
            <button onClick={() => setEditing(false)} disabled={saving} style={ghostBtn}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// The delete-only governance view over PERSONAL resources (#2360, §6/§12.7).
// A System Admin sees every personal
// provider / SSH key / GitHub token MASKED — name, owner, created, and a
// non-secret discriminator only, NEVER the secret — and may DELETE one
// (canDeleteCredential's break-glass) but never see-secret or use it. Delete
// routes through the existing per-kind DELETE endpoints, which re-check the gate.
const PERSONAL_RESOURCE_DELETE_PATH = {
  provider: '/api/llm-endpoints',
  'ssh-key': '/api/ssh-keys',
  'github-token': '/api/github-tokens',
};
const PERSONAL_RESOURCE_KIND_LABEL = { provider: 'Model provider', 'ssh-key': 'SSH key', 'github-token': 'GitHub token' };

function PersonalResourcesSection({ onError }) {
  const { data, loading, refetch } = useApi('/api/admin/personal-resources');
  const [confirm, setConfirm] = useState(null); // the resource pending delete

  async function doDelete(r) {
    try {
      await apiCall('DELETE', `${PERSONAL_RESOURCE_DELETE_PATH[r.kind]}/${encodeURIComponent(r.id)}`);
    } catch (e) { onError(e.message); }
    finally { setConfirm(null); refetch(); }
  }

  const resources = (data && data.resources) || [];
  return (
    <Section title={`Personal resources (${resources.length})`}>
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-2)' }}>
        Every user's personal secret, masked. You may delete one for governance / offboarding hygiene,
        but never see its secret or use it — the owner alone can.
      </div>
      {loading && <div aria-busy="true" style={{ height: 80, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-md)' }} />}
      {!loading && resources.length === 0 && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>No personal resources.</div>
      )}
      {resources.map(r => (
        <div key={`${r.kind}:${r.id}`} style={cardStyle}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--eb-text-sm)' }}>{r.name}</div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>
              {PERSONAL_RESOURCE_KIND_LABEL[r.kind] || r.kind} · owner {r.ownerId || 'unknown'}
              {r.fingerprint ? ` · ${r.fingerprint}` : ''}{r.authType ? ` · ${r.authType}` : ''}
            </div>
          </div>
          <IconButton icon={Trash2} danger title="Delete (break-glass)" onClick={() => setConfirm(r)} />
        </div>
      ))}
      <ConfirmDialog
        open={!!confirm}
        title="Delete personal resource?"
        message={confirm
          ? `Delete ${PERSONAL_RESOURCE_KIND_LABEL[confirm.kind] || confirm.kind} "${confirm.name}" owned by ${confirm.ownerId || 'unknown'}? The secret is removed — revoke it at its provider too. This cannot be undone.`
          : ''}
        variant="danger" confirmLabel="Delete"
        onConfirm={() => confirm && doDelete(confirm)}
        onCancel={() => setConfirm(null)}
      />
    </Section>
  );
}

function ResourcesTab() {
  const { data: teams, loading: lt, error: et } = useApi('/api/admin/teams');
  const { data: agents, loading: laAgents, refetch: refetchAgents } = useApi('/api/agents');
  const { data: environments, refetch: refetchEnvs } = useApi('/api/environments');
  const [actionError, setActionError] = useState(null);

  const teamList = teams ?? [];
  const teamNames = useMemo(() => teamsById(teamList), [teamList]);
  const { agentTeams, standaloneAgents } = useMemo(
    () => groupAgentsForOwnership(agents ?? []),
    [agents],
  );

  // An Agent Team moves between tenants as one unit (#568): reassigning the
  // parent `team` agent cascades to all its members server-side, so the UI
  // fires a single call against the team agent and re-fetches. Agents carry no
  // tier of their own — only environments do — so this stays a plain select.
  async function reassignAgent(id, teamId) {
    try {
      await apiCall('PUT', `/api/agents/${encodeURIComponent(id)}`, { teamId });
    } catch (e) { setActionError(e.message); }
    finally { refetchAgents(); }
  }

  const TeamSelect = ({ value, onChange }) => (
    <select value={value || DEFAULT_TEAM_ID} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
      {teamList.map(t => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
    </select>
  );

  const standaloneRow = (item) => (
    <div key={`agent:${item.id}`} style={cardStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--eb-text-sm)' }}>{item.displayName || item.id}</div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)' }}>{item.id}</div>
      </div>
      <TeamSelect value={item.teamId} onChange={tid => reassignAgent(item.id, tid)} />
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
        <TeamSelect value={team.teamId} onChange={tid => reassignAgent(team.id, tid)} />
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

  if (lt || laAgents) {
    return <div aria-busy="true" style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />;
  }
  if (et) {
    return (
      <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>
        Failed to load access scopes: {et}. The orchestrator must be reachable.
      </div>
    );
  }

  const envList = environments ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <TabLead
        label="What ownership means for an agent and for an environment"
        section={ADMINISTRATION_HELP_SECTIONS.resources}
      >
        Which tenant owns each agent and environment. An environment can also be
        <strong> shared</strong> across several teams; an agent is always owned by exactly one.
      </TabLead>

      <ErrorBar error={actionError} onDismiss={() => setActionError(null)} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--eb-space-6)' }}>
        <Section title={`Agents (${agentTeams.length + standaloneAgents.length})`}>
          {agentTeams.length === 0 && standaloneAgents.length === 0 && (
            <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>No agents.</div>
          )}
          {agentTeams.map(teamGroup)}
          {standaloneAgents.map(standaloneRow)}
        </Section>
        <Section title={`Environments (${envList.length})`}>
          {envList.length === 0 && <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>No environments.</div>}
          {envList.map(e => (
            <EnvironmentOwnershipRow
              key={e.id}
              env={e}
              teams={teamList}
              teamNames={teamNames}
              onSaved={refetchEnvs}
              onError={setActionError}
            />
          ))}
        </Section>
        {/* The delete-only personal-resource governance view (#2360). */}
        <PersonalResourcesSection onError={setActionError} />
      </div>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────── */
//
// The single **Administration** surface (#2085, epic #2076 P6, D10). The route
// is still `/users` — renaming it would have broken every bookmark for no gain —
// and the whole page is behind `AdminRoute` in App.jsx, which is what makes all
// three tabs System-Admin-only without a second gate (AC2).
export default function Users() {
  const { user: me } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = resolveAdminTab(searchParams.get('tab'));

  // The primary button is the active tab's, not the page's: only the Users tab
  // has a create action (a team is created from + Create — self-service since
  // #2081 — and a resource's ownership is edited in place, never created here).
  const [creatingUser, setCreatingUser] = useState(false);

  function selectTab(id) {
    const next = new URLSearchParams(searchParams);
    if (id === 'users') next.delete('tab'); else next.set('tab', id);
    setSearchParams(next, { replace: true });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-5)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>Administration</h1>
        {tab === 'users' && (
          <button onClick={() => setCreatingUser(true)} style={primaryBtn}>
            <Plus size={15} /> New User
          </button>
        )}
      </div>

      {/* The page-level "?" and the one-liner. The Access page's intro box was
          folded into this topic when that page was dissolved (#2085), so the
          pointer that used to send readers there is gone — there is nowhere
          else left to go. */}
      <p style={{
        margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
        fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
      }}>
        {PAGE_DESCRIPTION}
        <PageHelpButton
          label="What this page manages"
          size={14}
          style={{ padding: 0, flexShrink: 0 }}
          section={ADMINISTRATION_HELP_SECTIONS.page}
        />
      </p>

      <div role="tablist" aria-label="Administration" style={{ display: 'flex', gap: 'var(--eb-space-2)', borderBottom: '1px solid var(--eb-border-default)' }}>
        {ADMIN_TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => selectTab(t.id)}
            style={{
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 'var(--eb-text-sm)',
              fontWeight: tab === t.id ? 'var(--eb-font-medium)' : 'normal',
              color: tab === t.id ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
              borderBottom: `2px solid ${tab === t.id ? 'var(--eb-accent-primary)' : 'transparent'}`,
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Each tab owns its own fetches and mounts only while selected, so
          opening Administration costs exactly what the Users page used to. */}
      {tab === 'users' && <UsersTab me={me} creating={creatingUser} onCreatingChange={setCreatingUser} />}
      {tab === 'teams' && <AllTeamsTab />}
      {tab === 'resources' && <ResourcesTab />}
    </div>
  );
}
