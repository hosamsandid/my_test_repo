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

// Is `row` the currently logged-in human's own record? A per-user session's
// `username` IS the user's subject (auth.js buildUser), so match on subject;
// `userId` (present when describeAuthz resolved a user record) is a more
// precise match when both are available. The env single-admin (no user record,
// no userId) matches nothing here — it manages users but is not one of them.
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
