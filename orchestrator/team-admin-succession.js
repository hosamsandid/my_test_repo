'use strict';

// The last-admin successor rule (#2081, epic #2076 P3 — #2041 D4, concept
// `docs/decentralised-access-concept.md` §2.3).
//
// Self-service creation (P3) makes it possible to end up with a team nobody can
// administer: the creator is its only Team Admin, and removing or demoting them
// leaves a team with members, agents and a workspace that no member may change.
// D4's answer is not orphan-recovery machinery but a refusal:
//
//   Removing or demoting the LAST `team-admin` of a team is refused unless a
//   successor is named in the same operation; and a user cannot be deleted
//   while they are the last `team-admin` of any team.
//
// ── Why this is a pure module, and why it lives beside the store ───────────
//
// The rule is a question about the membership SET, not about a request. Keeping
// it here means the three call sites in `teams-store.js` (`setMembership`,
// `removeMembership`, `deleteUser`) share one answer, and — the reason it is a
// module rather than three inline checks — the promotion and the
// removal/demotion it authorises can be computed BEFORE anything is written, so
// the store lands both in a single `writeArray`. A two-step "promote, then
// remove" would leave a team with two admins (or none) if the process died
// between the writes.
//
// ── Why the store and not the console routes ───────────────────────────────
//
// §2.3 names the three `api.js` routes as the enforcement points. The store is
// strictly stronger and is the same three operations: the orchestrator's own
// `/internal/admin/*` API writes memberships too, and it is reachable without
// going through the console. A rule whose whole purpose is "this team can never
// become un-administrable" has to hold for every writer, so it belongs to the
// single writer rather than to one of its callers.
//
// ── What a successor must be ───────────────────────────────────────────────
//
// An EXISTING member of the same team. Naming somebody who is not a member
// would make this route a second, unaudited invitation path — sharing is
// `POST /api/admin/memberships` (P4's Share dialog), and it is already gated on
// `canManageTeam`. Requiring an existing membership also keeps the rule
// answerable from the membership array alone: no user lookup, no team lookup,
// nothing that could fail open when a file is unreadable.

const ROLE_ADMIN = 'team-admin';

// Refusal codes. Exported so the HTTP layer and the tests name the same thing
// rather than matching on message text.
const SUCCESSOR_REQUIRED = 'successor-required';
const SUCCESSOR_IS_SELF = 'successor-is-self';
const SUCCESSOR_NOT_A_MEMBER = 'successor-not-a-member';
const LAST_TEAM_ADMIN = 'last-team-admin';

function isMembership(m) {
  return !!m && typeof m === 'object'
    && typeof m.userId === 'string'
    && typeof m.teamId === 'string';
}

// The user ids holding `team-admin` in `teamId`.
function adminIdsOf(memberships, teamId) {
  if (!Array.isArray(memberships) || !teamId) return [];
  const ids = [];
  for (const m of memberships) {
    if (!isMembership(m) || m.teamId !== teamId || m.role !== ROLE_ADMIN) continue;
    if (!ids.includes(m.userId)) ids.push(m.userId);
  }
  return ids;
}

// True when `userId` is the ONLY `team-admin` of `teamId`. A user who is not an
// admin of the team at all is never "the last" one — demoting or removing a
// plain member is unconstrained.
function isSoleAdmin(memberships, userId, teamId) {
  const admins = adminIdsOf(memberships, teamId);
  return admins.length === 1 && admins[0] === userId;
}

// Every team in which `userId` is the sole `team-admin`. This is the whole of
// AC5: a user is deletable exactly when this list is empty.
function soleAdminTeamIds(memberships, userId) {
  if (!Array.isArray(memberships) || !userId) return [];
  const teamIds = [];
  for (const m of memberships) {
    if (!isMembership(m) || m.userId !== userId || m.role !== ROLE_ADMIN) continue;
    if (teamIds.includes(m.teamId)) continue;
    if (isSoleAdmin(memberships, userId, m.teamId)) teamIds.push(m.teamId);
  }
  return teamIds;
}

// True when `userId` currently holds a membership in `teamId` (any role).
function isMemberOf(memberships, userId, teamId) {
  if (!Array.isArray(memberships)) return false;
  return memberships.some(m => isMembership(m) && m.userId === userId && m.teamId === teamId);
}

// The decision for a removal or a `team-admin → team-member` demotion.
//
// Returns `{ ok: true, promote }` — `promote` is `null` when the operation
// needs no successor, or `{ userId, teamId }` when one was named and must be
// raised to `team-admin` in the SAME write. Returns `{ ok: false, code,
// message }` otherwise.
function planAdminHandover({ memberships, userId, teamId, successorUserId } = {}) {
  if (!isSoleAdmin(memberships, userId, teamId)) return { ok: true, promote: null };

  const successor = typeof successorUserId === 'string' ? successorUserId.trim() : '';
  if (!successor) {
    return {
      ok: false,
      code: SUCCESSOR_REQUIRED,
      message: `User '${userId}' is the last Team Admin of team '${teamId}'. `
        + 'Name a successor (successorUserId) who is already a member of the team, '
        + 'or delete the team instead.',
    };
  }
  if (successor === userId) {
    return {
      ok: false,
      code: SUCCESSOR_IS_SELF,
      message: `The successor for team '${teamId}' must be somebody other than '${userId}'.`,
    };
  }
  if (!isMemberOf(memberships, successor, teamId)) {
    return {
      ok: false,
      code: SUCCESSOR_NOT_A_MEMBER,
      message: `Successor '${successor}' is not a member of team '${teamId}' — `
        + 'add them to the team first, then hand over.',
    };
  }
  return { ok: true, promote: { userId: successor, teamId } };
}

// The decision for deleting a user (AC5). No successor parameter: offboarding
// deletes a person, and silently handing their teams to somebody the operator
// did not choose is exactly the guess D4 exists to prevent. The remedy is named
// in the message because the caller cannot infer it from a 409.
function planUserDeletion({ memberships, userId } = {}) {
  const teamIds = soleAdminTeamIds(memberships, userId);
  if (teamIds.length === 0) return { ok: true, teamIds: [] };
  return {
    ok: false,
    code: LAST_TEAM_ADMIN,
    teamIds,
    message: `User '${userId}' is the last Team Admin of ${teamIds.length === 1 ? 'team' : 'teams'} `
      + `${teamIds.map(t => `'${t}'`).join(', ')}. Promote another member to Team Admin, `
      + 'or delete the team, before deleting this user.',
  };
}

module.exports = {
  ROLE_ADMIN,
  SUCCESSOR_REQUIRED,
  SUCCESSOR_IS_SELF,
  SUCCESSOR_NOT_A_MEMBER,
  LAST_TEAM_ADMIN,
  adminIdsOf,
  isSoleAdmin,
  soleAdminTeamIds,
  isMemberOf,
  planAdminHandover,
  planUserDeletion,
};
