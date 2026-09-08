// Pure, framework-free helpers for the Users management page (#1844).
//
// Kept React-free per the #651 convention so the row-flattening, self-lockout
// guard and form validation can be unit-tested in the `admin-console-src` CI
// job while `Users.jsx` stays a thin renderer over them.

// The System-Admin display label for a user row.
export function systemAdminLabel(u) {
  return u && u.systemAdmin ? 'System Admin' : 'Member';
}

// The login-password display label for a user row. The sanitized user record
// carries a boolean `hasPassword` (teams-store.js) so the page can reflect the
// set/clear affordance's current state without ever seeing the secret.
export function passwordLabel(u) {
  return u && u.hasPassword ? 'Set' : 'None';
}

// Flatten sanitized user records into DataTable rows. DataTable sorts + filters
// by `row[col.key]` only, so every sortable/filterable value must live as a
// top-level primitive key on the row; the original record is preserved under
// `_user` for the action renderers (edit/password/delete).
export function usersToRows(users = []) {
  return (Array.isArray(users) ? users : []).map(u => ({
    ...u,
    displayName: u.displayName || u.subject || '',
    subject: u.subject || '',
    email: u.email || '',
    systemAdminLabel: systemAdminLabel(u),
    passwordLabel: passwordLabel(u),
    _user: u,
  }));
}

// Is `row` the currently logged-in human's own record? A session's `username`
// IS the user's subject (auth.js buildUser), so match on subject; `userId`
// (present when describeAuthz resolved a user record) is a more precise match
// when both are available. Since #2059 every authenticated human has a record,
// so the `userId` branch is the normal path and the seeded administrator
// correctly matches its own row — it manages users AND is one of them.
export function isSelf(me, row) {
  if (!me || !row) return false;
  if (me.userId && row.id) return me.userId === row.id;
  return !!me.username && me.username === row.subject;
}

// Guard against a self-lockout (edge case). Returns a human warning string —
// never blocks — when the logged-in admin removes their own System-Admin
// status or deletes their own record, so the action is confirmed intentionally
// instead of silently costing them their access. Returns null otherwise.
export function selfActionWarning({ me, target, action, nextSystemAdmin } = {}) {
  if (!isSelf(me, target)) return null;
  if (action === 'delete') {
    return 'This is your own account. Deleting it removes your access and you may be signed out.';
  }
  if (action === 'edit' && target && target.systemAdmin && nextSystemAdmin === false) {
    return 'You are removing System-Admin from your own account — you will lose administrative access.';
  }
  return null;
}

// Client-side mirror of the STORE's refusal to remove the last System Admin
// (#2059 AC7 / #2041 AC18). The rule lives in `orchestrator/teams-store.js`,
// which throws a 409 whose message the page already renders verbatim; this is
// what turns that into a disabled control with the reason on it, so the refusal
// is visible before the click rather than after it.
//
// The sentences are duplicated rather than imported — the store runs in another
// container — which is the same shape `Teams.jsx` uses for "the default team
// cannot be deleted". `users-view.test.js` reads the store's own constants to
// prove the two sides still agree.
//
// Returns `{ ok, reason }`: a `{ ok, reason }` pair rather than a boolean
// because two different controls (Delete, and the System-Admin checkbox) render
// the same rule with different wording, and a bare `false` would leave each
// call site inventing its own explanation.
const LAST_SYSTEM_ADMIN_DELETE_REASON =
  'The last System Admin cannot be deleted — promote another user to System Admin first';
const LAST_SYSTEM_ADMIN_DEMOTE_REASON =
  'The last System Admin cannot be demoted — promote another user to System Admin first';

// Is `target` the only System Admin in `users`? Mirrors isLastSystemAdmin in
// teams-store.js, including the `=== true` strictness (nothing else in the
// store treats a truthy-but-not-true flag as System Admin) and the "zero
// System Admins means nothing to protect" branch, which keeps a legacy stack's
// lone ordinary user deletable.
export function isLastSystemAdmin(users, target) {
  const id = target && target.id;
  if (!id) return false;
  const admins = (Array.isArray(users) ? users : []).filter(u => u && u.systemAdmin === true);
  return admins.length === 1 && admins[0].id === id;
}

// May this action proceed? `action` is 'delete' | 'demote'.
export function lastSystemAdminGuard({ users, target, action } = {}) {
  if (!isLastSystemAdmin(users, target)) return { ok: true, reason: null };
  if (action === 'delete') return { ok: false, reason: LAST_SYSTEM_ADMIN_DELETE_REASON };
  if (action === 'demote') return { ok: false, reason: LAST_SYSTEM_ADMIN_DEMOTE_REASON };
  return { ok: true, reason: null };
}

// Client-side mirror of the backend create/update validation (AC11), returning
// an error string or null. On create the backend requires a subject (an empty
// display name defaults to the subject); on edit the backend rejects an empty
// display name and the subject is immutable. `mode` is 'create' | 'edit'.
export function validateUserForm({ subject, displayName } = {}, mode = 'create') {
  const s = String(subject == null ? '' : subject).trim();
  const dn = String(displayName == null ? '' : displayName).trim();
  if (mode === 'create' && !s) return 'Subject is required.';
  if (mode === 'edit' && !dn) return 'Display name cannot be empty.';
  return null;
}
