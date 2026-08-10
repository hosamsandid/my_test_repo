// Pure view helpers for team-scoped credentials (SSH keys + GitHub tokens, #798).
//
// The backend now tags every credential with a `scope` (`system` | `team`) and,
// for system-scoped ones, an `assignedTeamIds` set. These helpers turn that raw
// shape into the labels, form options and client-side capability checks the two
// credential pages need — kept pure (no React, no fetch) so they are unit-tested
// in credential-scope-view.test.js and shared by SshKeys.jsx / GithubTokens.jsx.
//
// The client checks mirror scope.js on the server. They are UX only — the API is
// the security boundary (every mutating route re-checks). The point is to avoid
// showing a Team Admin actions that would just 403.

const DEFAULT_TEAM_ID = 'default';

// Normalize a credential entry to an explicit scope shape (backward-compatible
// with pre-#798 entries that only carry `teamId`). Mirrors scope.js.
//
// Personal tier (#1568/epic #1558): a `personal` credential is owned by exactly
// one human (`userId`) and carries neither a team nor system assignments. It
// round-trips its owner reference; every other (team/system/legacy) entry
// normalizes exactly as before — personal is strictly additive.
export function normalizeCredential(cred) {
  const c = cred || {};
  if (c.scope === 'personal') {
    return { ...c, scope: 'personal', userId: c.userId || null, teamId: null, assignedTeamIds: [] };
  }
  const scope = c.scope === 'system' ? 'system' : 'team';
  if (scope === 'system') {
    const assignedTeamIds = Array.isArray(c.assignedTeamIds)
      ? [...new Set(c.assignedTeamIds.map(String))]
      : [];
    return { ...c, scope, teamId: null, assignedTeamIds };
  }
  return { ...c, scope: 'team', teamId: c.teamId || DEFAULT_TEAM_ID, assignedTeamIds: [] };
}

// Is this a personal-tier credential? (helper so pages can split the personal
// self-service surface from the admin team/system tables without re-deriving.)
export function isPersonalCredential(cred) {
  return normalizeCredential(cred).scope === 'personal';
}

// Map a teams array (`[{id, name}]`) to an id→name lookup.
export function teamsById(teams) {
  const map = {};
  for (const t of Array.isArray(teams) ? teams : []) {
    if (t && t.id) map[t.id] = t.name || t.id;
  }
  return map;
}

// Human-readable scope/ownership descriptor for the table.
//   system, assigned    → { scope:'system', label:'System', teams:[names], detail:'a, b' }
//   system, unassigned  → { scope:'system', label:'System', teams:[], detail:'Unassigned' }
//   team                → { scope:'team',   label:'Team',   teams:[name], detail:'name' }
export function credentialScopeLabel(cred, names = {}) {
  const c = normalizeCredential(cred);
  if (c.scope === 'personal') {
    return { scope: 'personal', label: 'Personal', teams: [], detail: 'Private to you' };
  }
  if (c.scope === 'system') {
    const teamNames = c.assignedTeamIds.map(id => names[id] || id);
    return {
      scope: 'system',
      label: 'System',
      teams: teamNames,
      detail: teamNames.length ? teamNames.join(', ') : 'Unassigned',
    };
  }
  const name = names[c.teamId] || c.teamId;
  return { scope: 'team', label: 'Team', teams: [name], detail: name };
}

// Which scopes may the caller create? System Admins may create both; a Team
// Admin may only create team-scoped credentials.
export function creatableScopes({ isSysAdmin }) {
  return isSysAdmin ? ['system', 'team'] : ['team'];
}

// The initial ownership state for the create form, given the caller's role and
// the teams they administer.
export function defaultOwnership({ isSysAdmin, adminTeamIds = [] }) {
  if (isSysAdmin) return { scope: 'team', teamId: DEFAULT_TEAM_ID, assignedTeamIds: [] };
  return { scope: 'team', teamId: adminTeamIds[0] || '', assignedTeamIds: [] };
}

// Reduce an ownership state to the minimal API payload for a create/patch body.
export function ownershipPayload(own) {
  const o = own || {};
  if (o.scope === 'system') {
    return { scope: 'system', assignedTeamIds: [...new Set((o.assignedTeamIds || []).map(String))] };
  }
  return { scope: 'team', teamId: o.teamId || undefined };
}

// May the caller edit/delete THIS existing credential? Mirrors
// scope.canManageCredential: System Admins → all; a Team Admin → only
// team-scoped credentials of a team they administer.
export function canManageCredentialClient(cred, { isSysAdmin, adminTeamIds = [], userId = null }) {
  const c = normalizeCredential(cred);
  // Personal tier first, ahead of the sys-admin shortcut (mirrors scope.js /
  // D2): only the owner may manage their own personal credential — not even a
  // System Admin. Fail-closed when either side lacks an identity.
  if (c.scope === 'personal') return !!(userId && c.userId && c.userId === userId);
  if (isSysAdmin) return true;
  if (c.scope === 'system') return false;
  return adminTeamIds.includes(c.teamId);
}

// May the caller reassign / change a credential's scope or team set? System
// Admin only (mirrors scope.canReassignCredential).
export function canReassignCredentialClient({ isSysAdmin }) {
  return !!isSysAdmin;
}

// Team ids the caller administers, from the session `user.teams` descriptor.
export function adminTeamIdsOf(user) {
  return (user && Array.isArray(user.teams) ? user.teams : [])
    .filter(t => t && t.role === 'team-admin')
    .map(t => t.teamId);
}

// Is this user allowed onto the credential pages at all? System Admins and any
// Team Admin (of ≥1 team). Drives the route guard + nav visibility.
export function canAccessCredentialPages(user) {
  if (!user) return false;
  if (user.admin) return true;
  return adminTeamIdsOf(user).length > 0;
}
