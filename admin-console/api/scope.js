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
  if (!username) return { all: false, teamIds: new Set(), userId: null };

  // The env single-admin credential is the operator: full visibility.
  if (adminUsername && username === adminUsername) {
    return { all: true, teamIds: new Set(), userId: null };
  }

  const user = users.find(u => (u.subject || '').toLowerCase() === String(username).toLowerCase());
  // A session subject that isn't a known user → fail closed (sees only what is
  // explicitly shared with no team, i.e. nothing). Per-user sessions only ever
  // issue for real users, so this is an edge case.
  if (!user) return { all: false, teamIds: new Set(), userId: null };

  // System Admins have global visibility regardless of team membership.
  if (user.systemAdmin) return { all: true, teamIds: new Set(), userId: user.id };

  const teamIds = new Set(
    memberships.filter(m => m.userId === user.id).map(m => m.teamId),
  );
  return { all: false, teamIds, userId: user.id };
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

module.exports = { computeScope, visibleTeam, visibleAgent };
