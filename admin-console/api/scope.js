'use strict';

// Resource scoping by human Team (#302).
//
// Computes what the logged-in caller may see, then filters list endpoints by
// resource `teamId` (and, for agents, `visibility`/`ownerId`).
//
// SAFETY — the operator never loses visibility:
//   - The env single-admin (#276) and any System-Admin user see EVERYTHING
//     (`all: true`). In the current single-operator setup the caller is always
//     the env admin, so filtering is a no-op and nothing can disappear.
//   - Filtering only narrows the view for non-admin users who are members of
//     specific teams — exactly the multi-user isolation the ticket asks for.
//
// Pure (no IO) so it is unit-testable; the api wires it with the on-disk
// users/memberships indexes.

function computeScope({ username, adminUsername, users = [], memberships = [] } = {}) {
  // No identity → see nothing (the auth gate normally guarantees a username;
  // this is a defensive fail-closed default, never reached for the env admin).
  if (!username) return { all: false, teamIds: new Set(), roles: new Map(), userId: null };

  // The env single-admin credential is the operator: full visibility.
  if (adminUsername && username === adminUsername) {
    return { all: true, teamIds: new Set(), roles: new Map(), userId: null };
  }

  const user = users.find(u => (u.subject || '').toLowerCase() === String(username).toLowerCase());
  // A session subject that isn't a known user → fail closed (sees only what is
  // explicitly shared with no team, i.e. nothing). Per-user sessions only ever
  // issue for real users, so this is an edge case.
  if (!user) return { all: false, teamIds: new Set(), roles: new Map(), userId: null };

  // System Admins have global visibility regardless of team membership.
  if (user.systemAdmin) return { all: true, teamIds: new Set(), roles: new Map(), userId: user.id };

  // Otherwise: visible teams are the caller's memberships, and `roles` records
  // the per-team role (team-admin / team-member) — the basis for the admin
  // surface's per-team management gate (#584).
  const teamIds = new Set();
  const roles = new Map();
  for (const m of memberships) {
    if (m.userId !== user.id) continue;
    teamIds.add(m.teamId);
    roles.set(m.teamId, m.role);
  }
  return { all: false, teamIds, roles, userId: user.id };
}

// Is a resource owned by `teamId` visible to this scope? Resources without an
// explicit owner are treated as belonging to the default team.
function visibleTeam(scope, teamId) {
  if (!scope) return false;
  if (scope.all) return true;
  return scope.teamIds.has(teamId || 'default');
}

// Agent visibility: must be in-team, and a `private` agent is visible only to
// its owner (admins always see all). Inert until visibility/ownerId are set
// (#304) — a missing visibility defaults to team-wide.
function visibleAgent(scope, agent) {
  if (!scope) return false;
  if (scope.all) return true;
  if (!visibleTeam(scope, agent && agent.teamId)) return false;
  if (agent && agent.visibility === 'private' && agent.ownerId) {
    return agent.ownerId === scope.userId;
  }
  return true;
}

// ── Admin surface (Teams / Users / Memberships) scoping & gating (#584) ──────
//
// The #302 list-endpoints above are read-only filters. The Teams admin surface
// additionally needs a *management* gate: per the role model
// (docs/multi-user-concept.md §3), a Team Admin may manage their own team and
// its memberships, a Team Member gets read-only visibility of their own team,
// and creating teams / managing global user records is a System-Admin action.
// All admins (env admin + System Admin) keep `all: true` — full access.

// May the caller create/edit/delete this team and manage its memberships?
// Admins always may; a non-admin must be the `team-admin` of that exact team.
// (A missing teamId collapses to the default team, mirroring visibleTeam.)
function canManageTeam(scope, teamId) {
  if (!scope) return false;
  if (scope.all) return true;
  return scope.roles instanceof Map && scope.roles.get(teamId || 'default') === 'team-admin';
}

// Is this user visible to the caller? A non-admin sees only users who share at
// least one of their teams (which includes the caller themselves). A caller who
// is a member of no team therefore sees no user at all — fail-closed (AC5).
function visibleUser(scope, userId, memberships = []) {
  if (!scope) return false;
  if (scope.all) return true;
  return memberships.some(m => m.userId === userId && scope.teamIds.has(m.teamId));
}

// ── Credentials (SSH keys + GitHub tokens) scope & management gate (#798) ────
//
// Credentials extend the #302/#584 model with a two-value scope, so a Team
// Admin can self-serve their team's credentials and a System Admin can provision
// shared, system-wide credentials assigned to specific teams:
//
//   • team   — owned by exactly one team (`teamId`). Visible to that team's
//              Team Admins and to System Admins.
//   • system — created by a System Admin, assigned to 0..n teams
//              (`assignedTeamIds`). Visible to System Admins always and to the
//              Team Admins of every assigned team. Assigned to zero teams → only
//              System Admins see it (never orphaned or globally visible).
//
// Visibility and management are gated on the *team-admin* role (canManageTeam),
// NOT mere membership: Team Member credential access is deferred. All admins
// keep `all: true` (no regression to the single-operator setup).

// Backward-compatible view of a stored credential entry. Pre-#798 entries have
// no `scope` field and carry only `teamId` (all currently 'default'); treat each
// as team-scoped owned by its team so existing credentials keep working. Returns
// a normalized copy with an explicit `scope`, `teamId` and `assignedTeamIds`.
function normalizeCredential(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const scope = entry.scope === 'system' ? 'system' : 'team';
  if (scope === 'system') {
    const assignedTeamIds = Array.isArray(entry.assignedTeamIds)
      ? [...new Set(entry.assignedTeamIds.map(String))]
      : [];
    return { ...entry, scope, teamId: null, assignedTeamIds };
  }
  return { ...entry, scope: 'team', teamId: entry.teamId || 'default', assignedTeamIds: [] };
}

// Is this credential visible to the caller? (list-endpoint filter — AC1/AC2/AC3)
function visibleCredential(scope, cred) {
  if (!scope) return false;
  if (scope.all) return true;
  const c = normalizeCredential(cred);
  if (c.scope === 'system') return c.assignedTeamIds.some(t => canManageTeam(scope, t));
  return canManageTeam(scope, c.teamId);
}

// ── Assist model selection — selection (usage) visibility (#1210) ────────────
//
// The global assist model selector (Flow Copilot, Generate agent prompt, port
// suggestions, Knowledge drafting, skill merge, orchestrator syntheses) must
// bill against a provider the acting user's teams are entitled to *use*. This is
// deliberately DISTINCT from visibleCredential (the management rule, Team-Admin-
// oriented): a plain Team Member may run the Flow Copilot billed against their
// team's provider — exactly as their agents already do via
// usableEndpointsForTeam (api.js). So selection is membership-based (any role),
// not gated on canManageTeam.
//
//   A user may select provider P iff `scope.all`, OR P is usable by at least one
//   team the user is a member of: P is team-scoped with P.teamId ∈ teamIds, or
//   system-scoped with assignedTeamIds ∩ teamIds ≠ ∅.
//
// Additional filter: `oauth-token` providers are never selectable — subscription
// CLI-seat tokens must not be spent on server-side /v1/messages calls (mirrors
// resolveAssistTarget's env fallback), and they carry no baseUrl.
function assistSelectableEndpoint(scope, ep) {
  if (!scope || !ep) return false;
  if (ep.authType === 'oauth-token') return false;
  if (scope.all) return true;
  const c = normalizeCredential(ep);
  if (c.scope === 'team') return scope.teamIds.has(c.teamId);
  return c.assignedTeamIds.some(t => scope.teamIds.has(t));
}

// May the caller edit/delete THIS existing credential? A Team Admin may manage
// team-scoped credentials of a team they administer, never system-scoped ones
// (AC5); System Admins may manage all.
function canManageCredential(scope, cred) {
  if (!scope) return false;
  if (scope.all) return true;
  const c = normalizeCredential(cred);
  if (c.scope === 'system') return false;
  return canManageTeam(scope, c.teamId);
}

// May the caller create a credential with the requested ownership? System-scoped
// creation is System-Admin-only; a Team Admin may create team-scoped credentials
// only for a team they administer (AC3/AC4/AC6).
function canCreateCredential(scope, desired) {
  if (!scope) return false;
  if (scope.all) return true;
  const reqScope = desired && desired.scope === 'system' ? 'system' : 'team';
  if (reqScope === 'system') return false;
  return canManageTeam(scope, (desired && desired.teamId) || 'default');
}

// Only a System Admin may change a credential's scope or team assignment,
// including a cross-team move of a team-scoped credential (AC6/AC7).
function canReassignCredential(scope) {
  return !!(scope && scope.all);
}

// Would `teamId` still see this credential under the given (normalized) state?
// Used to reject a reassignment that would orphan an environment still
// referencing the credential (edge case: no silent break).
function credentialVisibleToTeam(cred, teamId) {
  const c = normalizeCredential(cred);
  const t = teamId || 'default';
  if (c.scope === 'system') return c.assignedTeamIds.includes(t);
  return c.teamId === t;
}

// ── Config-write authorization for agents / environments (#989) ─────────────
//
// The #302/#584 model gives list/read endpoints a *visibility* filter
// (visibleAgent / visibleTeam) and the Teams admin surface a *management* gate
// (canManageTeam). The core config-write endpoints — agent config, triggers,
// prompt/model/provider, environment CRUD — were previously either unguarded or
// gated only on visibility, so a Team Member (or a member of an unrelated team)
// could mutate them. These predicates apply the same management gate as
// canManageCredential, keyed on the *resource's* owning team: write authorization
// requires the team-admin role of the owning team (or full-visibility admin),
// never mere visibility. All admins keep `all: true` (no single-operator
// regression).

// May the caller create / edit / delete / re-parent this agent? Team Admin of
// the agent's owning team, or a full-visibility admin. Callers pass the resolved
// owning team on `agent.teamId` (agentTeamId = parentTeamId||teamId, single-
// sourced in the api layer via agentMetaForScope), mirroring canManageCredential.
function canManageAgent(scope, agent) {
  if (!scope) return false;
  if (scope.all) return true;
  return canManageTeam(scope, (agent && agent.teamId) || 'default');
}

// May the caller create / edit / delete this environment (or its MCP
// credentials)? Team Admin of the resource's owning team, or a full-visibility
// admin. A missing teamId collapses to the default team, mirroring visibleTeam.
function canManageEnvironment(scope, env) {
  if (!scope) return false;
  if (scope.all) return true;
  return canManageTeam(scope, (env && env.teamId) || 'default');
}

// ── Token-usage statistics visibility (#801) ────────────────────────────────
//
// The Token Usage statistics view (token/cost figures) is, for now, a
// System-Admin-only surface: the operator keeps consumption numbers until it is
// decided how much of them teams should see. The boundary is simply full
// visibility (`scope.all` — the env admin or a System-Admin user); a Team Admin
// or Team Member gets none. This is the real security boundary enforced on every
// usage endpoint; the SPA route/nav gate is UX only. The System Admin narrows to
// a single team via the `?team=` query parameter (see the usage routes), which is
// orthogonal to this gate.
function canViewUsageStatistics(scope) {
  return !!(scope && scope.all);
}

// A serializable authorization descriptor for the session (AC6/AC7). Carries an
// admin/System-Admin indicator and the caller's per-team memberships+roles, so
// the frontend can make rendering decisions without re-deriving them. The env
// admin and System Admins are reported as `admin: true` (full visibility).
function describeAuthz({ username, adminUsername, users = [], memberships = [] } = {}) {
  const scope = computeScope({ username, adminUsername, users, memberships });
  const envAdmin = !!(username && adminUsername && String(username) === String(adminUsername));
  const teams = [...scope.roles.entries()].map(([teamId, role]) => ({ teamId, role }));
  return {
    admin: scope.all,                    // full visibility: env admin OR System Admin
    envAdmin,                            // env single-admin credential
    systemAdmin: scope.all && !envAdmin, // a non-env-admin with full visibility is a System-Admin user
    userId: scope.userId,
    teams,
  };
}

module.exports = {
  computeScope,
  visibleTeam,
  visibleAgent,
  canManageTeam,
  canManageAgent,
  canManageEnvironment,
  visibleUser,
  describeAuthz,
  normalizeCredential,
  visibleCredential,
  assistSelectableEndpoint,
  canManageCredential,
  canCreateCredential,
  canReassignCredential,
  credentialVisibleToTeam,
  canViewUsageStatistics,
};
