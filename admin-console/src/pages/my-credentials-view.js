// Pure view helpers for the self-service "My Credentials" surface (#1568,
// epic #1558 Phase 2). A human manages their OWN personal SSH keys and GitHub
// tokens here; the page never touches team/system credentials (those stay on
// the admin SSH Keys / GitHub Tokens pages).
//
// Kept pure (no React, no fetch) so they are unit-tested in
// my-credentials-view.test.js and the JSX page stays a thin renderer over them.
// The server (scope.js / api.js, Phase 1 #1567) is the security boundary — every
// mutating route re-checks ownership; these helpers are UX only.

import { normalizeCredential } from './credential-scope-view.js';

// Can this caller own personal credentials at all? A personal credential is
// keyed on a real user id (`user.userId`), so this mirrors
// ownsPersonalCredential in scope.js, which fails closed for a null userId.
// Since #2059 every authenticated human HAS a user record — the recordless
// env single-admin that used to land here with `userId: null` no longer
// authenticates — so in practice this is now only the signed-out/partial case.
// Kept as a guard rather than deleted: it is the client mirror of a server
// rule, and a UI that assumes an id is present would render an owner-less
// create form instead of an explanation. Fail-closed on missing input.
export function canOwnPersonalCredentials(user) {
  return !!(user && user.userId);
}

// The caller's own user id, or null (signed-out / no record).
export function personalOwnerId(user) {
  return (user && user.userId) || null;
}

// Filter a raw credential list (as returned by GET /api/ssh-keys or
// /api/github-tokens, which is already caller-scoped by visibleCredential) down
// to the caller's OWN personal credentials. Defensive: even though the API only
// returns a caller their own personal entries, we re-assert `userId === me` so a
// future change to the list contract can never leak someone else's personal
// credential onto this surface (AC3/AC5).
export function personalCredentials(list, userId) {
  if (!Array.isArray(list) || !userId) return [];
  return list
    .map(normalizeCredential)
    .filter(c => c.scope === 'personal' && c.userId && c.userId === userId);
}

// Everything that is NOT the caller's personal credential — i.e. the team/system
// tier that belongs on the admin SSH Keys / GitHub Tokens pages. Used there to
// keep those pages showing only admin-managed credentials (AC6: the two tiers
// stay visually and navigationally distinct; the admin pages are unchanged for
// team/system).
export function adminManagedCredentials(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(c => normalizeCredential(c).scope !== 'personal');
}

// Minimal create payload for a personal credential. The server forces the owner
// to the caller (resolveCredentialOwnership), so the client only declares the
// tier plus the label/id — never a userId (a spoofed foreign owner is rejected
// 403 server-side, so we deliberately don't send one).
export function personalCreateBody({ name, id } = {}) {
  const body = { scope: 'personal', name: (name || '').trim() };
  const trimmedId = (id || '').trim();
  if (trimmedId) body.id = trimmedId;
  return body;
}
