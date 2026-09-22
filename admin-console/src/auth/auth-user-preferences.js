// Pure helper for optimistically reflecting a just-saved user preference in the
// in-session AuthContext.user (#2402).
//
// AuthContext.user is only ever (re)set on mount / login / logout / 401, so a
// successful PUT /api/me/preferences would otherwise leave the session's
// preference value frozen at its load-time value. A component that re-reads that
// session value on remount — most notably the Settings dialog, which fully
// unmounts on close and re-runs its useState initializers on reopen — then sees
// the stale value and discards the freshly-written one. Patching user.<pref>
// immediately after a save keeps the session value fresh so the reopened dialog
// (and any later reader) reflects the real setting.
//
// Kept dependency-free and unit-tested (admin-console-src CI job) per the #651
// convention; AuthContext is the sole caller.
export function applyUserPreferencePatch(user, patch) {
  // No user in session (logged out / pre-load) — nothing to reflect; never
  // synthesise a user record from a preference write.
  if (!user || typeof user !== 'object') return user;
  if (!patch || typeof patch !== 'object') return user;
  return { ...user, ...patch };
}
