import React, { useState, useMemo } from 'react';
import { Plus, Pencil, Trash2, ShieldCheck, KeyRound } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import { useAuth } from '../auth/AuthContext';
import DataTable from '../components/DataTable';
import PageHelpButton from '../components/PageHelpButton';
import { USERS_HELP_SECTIONS } from './users-help-sections.js';
import { useHelpSubject } from '../context/HelperChatContext.jsx';
import { OVERLAY_USER_EDIT, OVERLAY_USER_DELETE } from '../context/page-help-view.js';
import SidePanel from '../components/SidePanel';
import ConfirmDialog from '../components/ConfirmDialog';
import FormInput from '../components/FormInput';
import PasswordField from '../components/PasswordField';
import IconButton from '../components/IconButton';
import {
  usersToRows, isSelf, selfActionWarning, validateUserForm, lastSystemAdminGuard,
} from './users-view';

// The page's one-liner under the title (epic #1870, E16 #1891). It keeps the
// Access hand-off, because a user record on its own grants nothing — everything
// else the old intro box said now lives in the `users` help topic.
const PAGE_DESCRIPTION = 'Human user records — who can sign in and who is a System Admin; access scopes are granted on the Access page.';

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
            section={USERS_HELP_SECTIONS.edit}
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
          section={USERS_HELP_SECTIONS.offboarding}
        />
      </p>
      {warning && <p style={{ color: 'var(--eb-status-warning)' }}>{warning}</p>}
    </>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────── */
export default function Users() {
  const { user: me } = useAuth();
  const { data: users, loading, error, refetch } = useApi('/api/admin/users');

  const [creating, setCreating] = useState(false);
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
      setCreating(false);
      refetch();
    } catch (e) { setCreateError(e.message); }
    finally { setSavingCreate(false); }
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-5)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>Users</h1>
        <button onClick={() => { setCreating(true); setCreateError(null); }} style={primaryBtn}>
          <Plus size={15} /> New User
        </button>
      </div>

      {/* The intro box moved into the `users` help topic (epic #1870, E16 #1891 —
          E7 deliberately left this route uncovered). What stays is the one thing a
          user must not miss on the way *out* of this page: a record alone grants
          nothing, so the pointer at Access remains on the page. */}
      <p style={{
        margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
        fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
      }}>
        {PAGE_DESCRIPTION}
        <PageHelpButton
          label="What a user record is"
          size={14}
          style={{ padding: 0, flexShrink: 0 }}
          section={USERS_HELP_SECTIONS.page}
        />
      </p>

      <ErrorBar error={actionError} onDismiss={() => setActionError(null)} />

      <DataTable
        columns={COLUMNS}
        data={rows}
        emptyText="No users yet. Click 'New User' to add one."
        getRowKey={r => r.id}
        onRowClick={r => { setEditId(r.id); setEditError(null); }}
      />

      <SidePanel open={creating} onClose={() => setCreating(false)} title="New user" width="520px">
        {creating && <CreateUserPanel onSave={handleCreate} onCancel={() => setCreating(false)} saving={savingCreate} error={createError} />}
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
