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

export const DEFAULT_TEAM_ID = 'default';

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
// the teams they administer. Under AEE_RESOURCE_ACCESS_V2 (`v2`) the state also
// carries the `identity` stamp — a create form defaults to a team `service`
// credential, matching the default `team` scope (a `human` secret is
// Personal-only). Off the flag the shape is byte-identical to before.
export function defaultOwnership({ isSysAdmin, adminTeamIds = [], v2 = false } = {}) {
  // Under v2 the SSH/GitHub-token pages are open to EVERY authenticated user
  // (#2360 consolidation): a caller who administers no team and is not a System
  // Admin can only ever create a PERSONAL credential, so default them straight to
  // a personal/human one — the form opens ready instead of on a team picker they
  // can't fill. Off the flag this branch is unreachable (the pages stay
  // admin-gated) and the returned shape is byte-identical to before.
  if (v2 && !isSysAdmin && adminTeamIds.length === 0) {
    return { scope: 'personal', teamId: null, assignedTeamIds: [], identity: IDENTITY_HUMAN };
  }
  const base = isSysAdmin
    ? { scope: 'team', teamId: DEFAULT_TEAM_ID, assignedTeamIds: [] }
    : { scope: 'team', teamId: adminTeamIds[0] || '', assignedTeamIds: [] };
  return v2 ? { ...base, identity: IDENTITY_SERVICE } : base;
}

// The initial ownership state for an EDIT form: the record's own tier, made
// explicit. #2083 needs this because working environments and MCP servers are
// edited in the same panel they are created in, so the control has to open
// showing what the record already is — a create-shaped default would silently
// re-tier a shared record on the next save. A legacy record (no `scope`) reads
// as team-tier, exactly as the server's normalizer does.
//
// Falls back to `defaultOwnership` when there is no record (the create case), so
// one call site serves both modes.
export function ownershipFromRecord(record, { isSysAdmin, adminTeamIds = [], v2 = false, kind } = {}) {
  if (!record || typeof record !== 'object') return defaultOwnership({ isSysAdmin, adminTeamIds, v2 });
  const c = normalizeCredential(record);
  // Under v2 the edit form opens on the record's stamped identity (falling back
  // to the per-kind inference for a legacy record) — immutable, so the control
  // shows it read-only, but the state still needs to carry it for the payload.
  const withIdentity = (own) => (v2 ? { ...own, identity: defaultIdentity(kind, record) } : own);
  if (c.scope === 'system') return withIdentity({ scope: 'system', teamId: '', assignedTeamIds: [...c.assignedTeamIds] });
  if (c.scope === 'personal') return withIdentity({ scope: 'personal', teamId: '', assignedTeamIds: [], userId: c.userId });
  return withIdentity({ scope: 'team', teamId: c.teamId || '', assignedTeamIds: [] });
}

// Reduce an ownership state to the minimal API payload for a create/patch body.
// Under AEE_RESOURCE_ACCESS_V2 (`v2`) the payload also carries `identity` (the
// server honours it only where legal — a personal credential marked `service`),
// and a `personal` scope round-trips as its own tier (the owner is filled from
// the session server-side). Off the flag the payload is byte-identical to before.
export function ownershipPayload(own, { v2 = false } = {}) {
  const o = own || {};
  const identity = (v2 && (o.identity === IDENTITY_HUMAN || o.identity === IDENTITY_SERVICE))
    ? { identity: o.identity } : {};
  if (o.scope === 'personal') {
    // Only meaningful under v2 (the create forms offer personal only then); off
    // the flag this branch is unreachable from the legacy scope-tabs.
    return { scope: 'personal', ...identity };
  }
  if (o.scope === 'system') {
    return { scope: 'system', assignedTeamIds: [...new Set((o.assignedTeamIds || []).map(String))], ...identity };
  }
  return { scope: 'team', teamId: o.teamId || undefined, ...identity };
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

// Is `record` a GLOBAL Working Environment or MCP server (#2158) — reachable
// by every user and agent with no team assignment at all? Mirrors the
// server's `isGlobalEnvironment` (admin-console/api/global-resource.js):
// re-reads BOTH preconditions from the record on every call rather than
// trusting a stale flag alone, so a hand-edited `{scope:'team', global:true}`
// record reads as not global here too. UX only — the API is the boundary.
export function isGlobalRecord(record) {
  return !!(record && record.global === true && record.scope === 'system');
}

// ── Identity vs scope (unified resource access model §2/§4/§7/§12.10, #2360) ──
//
// The redesign classifies every secret by the IDENTITY it acts as, orthogonal to
// its tier, and surfaces that as a two-control pair replacing the old
// "System / Assigned to teams / Team owns" tabs. These pure helpers give the
// forms the option lists + the allowed-combo guard; they byte-mirror the server
// (resource-tier.js `isAllowedTierCombo`, llm-endpoint-global.js, and the
// api.js `oauth-not-team` refusal), which stays the real boundary.

export const IDENTITY_HUMAN = 'human';
export const IDENTITY_SERVICE = 'service';

// The two identity options, with the concept's exact UI naming (§12.10).
export const IDENTITY_OPTIONS = [
  { value: IDENTITY_HUMAN, label: 'Personal identity — acts as you',
    hint: 'A personal token / key / subscription seat. Every action is attributed to you; it stays yours and can only be lent to a team while you are a member.' },
  { value: IDENTITY_SERVICE, label: 'Service credential — a shared machine / deploy identity',
    hint: 'A machine-user token, a deploy key, or an api-key gateway. Belongs to no one person, so it can be shared with a team or made global and survives personnel changes.' },
];

// Which scopes are legal for a given identity (§4). A `human` secret is
// Personal-only — the one exception being a subscription (oauth) provider, which
// MAY be Global via the single-user escape hatch (§9). A `service` secret may sit
// at any tier.
export function allowedScopesForIdentity(identity, { kind, isOauth } = {}) {
  if (identity === IDENTITY_HUMAN) {
    return (kind === 'provider' && isOauth) ? ['personal', 'global'] : ['personal'];
  }
  return ['personal', 'team', 'global'];
}

// The allowed-combo guard the form submit uses, byte-mirroring the server. UX
// only — every route re-checks.
export function isAllowedIdentityScope(identity, scope, ctx = {}) {
  return allowedScopesForIdentity(identity, ctx).includes(scope);
}

// The default identity to preselect for a record/kind, matching the server's
// create-time stamp (PR2/PR3) and the migration inference: a subscription
// provider is human, an api-key gateway service; a credential inherits its
// record's stamp, else a personal record is human and any other is service.
export function defaultIdentity(kind, record = {}) {
  if (record.identity === IDENTITY_HUMAN || record.identity === IDENTITY_SERVICE) return record.identity;
  if (kind === 'provider') return record.authType === 'oauth-token' ? IDENTITY_HUMAN : IDENTITY_SERVICE;
  return record.scope === 'personal' ? IDENTITY_HUMAN : IDENTITY_SERVICE;
}

// Which scopes may the caller actually CREATE at, for a chosen identity —
// intersect the identity's legal scopes with the caller's authority (personal:
// anyone; team: a team-admin of some team / sysadmin; global: sysadmin only).
// Mirrors the server create gates.
export function creatableScopesForIdentity(identity, { kind, isOauth, isSysAdmin, adminTeamIds = [] } = {}) {
  return allowedScopesForIdentity(identity, { kind, isOauth }).filter((scope) => {
    if (scope === 'personal') return true;
    if (scope === 'team') return isSysAdmin || adminTeamIds.length > 0;
    return !!isSysAdmin; // global
  });
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

// Can this user add a provider (or manage credentials) FOR A SPECIFIC team?
// System Admins can (they add system-scoped providers that cover any team);
// otherwise the user must be a Team Admin of *that* team. This is stricter than
// `canAccessCredentialPages` (admin of ≥1 team) and closes the #2084 edge case:
// a Team Admin of team A must NOT be offered a working /models link when the
// agent will belong to team B, where they can navigate but cannot actually add a
// provider. Note it subsumes `canAccessCredentialPages` — anyone who administers
// a given team necessarily passes the credential-pages route guard too.
export function isAdminForTeam(user, teamId) {
  if (!user) return false;
  if (user.admin) return true;
  return !!teamId && adminTeamIdsOf(user).includes(teamId);
}
