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
  visibleUser,
  describeAuthz,
};
