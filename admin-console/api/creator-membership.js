'use strict';

// Self-service Agent Team creation: the creator becomes its Team Admin in the
// same operation (#2081, epic #2076 P3 — #2041 D1/AC5, concept §10's P3 row).
//
// ── The gap this closes ────────────────────────────────────────────────────
//
// `POST /api/teams` already stamps the creating human as `ownerId`
// (`ownerFor(req)`, #2077 D8). That is enough for a STANDALONE agent, whose
// access boundary is `null` so `visibleAgent` falls through to ownership — but
// a `role: 'team'` agent IS its own boundary (`resolveAgentTeam` returns
// `cfg.id`), so `visibleAgent`/`canManageAgent` take the team branch and ask for
// a MEMBERSHIP. Measured against the real predicates, a creator with no prior
// membership therefore could not see the team they had just created — which is
// precisely what `api.js`'s own comment above `POST /api/admin/teams` predicted
// ("a fresh team has no members, so a non-admin creator could not even see it
// afterwards") and what P1's owner model makes fixable.
//
// ── Why a module for one object ────────────────────────────────────────────
//
// Because the decision is "when", not "what", and the two team-create handlers
// (`POST /api/teams` and its streaming twin) duplicate their variable shape
// inline — concept §10's P3 row asks specifically for "an idempotence test that
// the creator's membership is written exactly once by both the streaming and
// non-streaming handler". `api.js` cannot be required in a unit test (#651), so
// the condition has to live somewhere a test can reach it, and both handlers
// have to call the same one.

const ROLE_TEAM_ADMIN = 'team-admin';

// The membership to write for a team-create request, or `null` when there is
// none to write. Two cases return `null`, for different reasons:
//
//   • `teamCreated === false` — this request did not mint the team. It is an
//     `extend` (or an orphan adoption on a team that already existed), so the
//     creator's grant is somebody's existing decision and re-asserting it would
//     be a silent role change: `setMembership` is an UPSERT, so a `team-member`
//     who extends a team they were shared into would promote themselves to
//     `team-admin`. That is also what makes the write idempotent — a second run
//     over an existing team writes nothing at all.
//
//   • no `userId` — the env single-admin (`scope.userId === null`, #276) and
//     any caller in single-user compatibility mode (`AUTH_ENABLED=false`,
//     #1457) have no user record to grant a membership to. They already hold
//     `scope.all`, so the team is fully visible to them; a membership would
//     have nobody to name. Same rule as `ownerFor`, deliberately — the owner
//     stamp and this grant must be present or absent together, or a team could
//     end up with an admin who is not its owner.
function planCreatorMembership({ userId, teamAgentId, teamCreated } = {}) {
  if (teamCreated !== true) return null;
  if (typeof userId !== 'string' || !userId.trim()) return null;
  if (typeof teamAgentId !== 'string' || !teamAgentId.trim()) return null;
  return { userId: userId.trim(), teamId: teamAgentId.trim(), role: ROLE_TEAM_ADMIN };
}

// The ownership triple stamped onto the Working Environment a team-create
// auto-provisions, so the team can see its own infrastructure.
//
// Before #2081 that record was written with NO tier fields at all, which
// `normalizeTier` reads as the team tier with `teamId: null` — and since #2078
// removed the `|| 'default'` fallback, `visibleEnvironment(scope, env)` is
// FALSE for every non-admin. Invisible was survivable while every caller was
// `scope.all`; under private-by-default it would hand each new team an
// environment only a System Admin can see, on the page where its own repository
// and credentials are configured. Stamping the Agent Team id is also exactly
// AC2's "private by default": `visibleEnvironment` is membership-based, so the
// record is reachable by this team and by nobody else.
//
// Only for the AUTO-CREATED env. A REUSED one (`environmentId`) keeps whatever
// tier it already carries — re-stamping it would silently move a shared
// environment into the new team, which is a re-tier and System-Admin-only
// (`canRetierEnvironment`).
function creatorEnvironmentOwnership(teamAgentId) {
  return { scope: 'team', teamId: String(teamAgentId), assignedTeamIds: [] };
}

module.exports = {
  ROLE_TEAM_ADMIN,
  planCreatorMembership,
  creatorEnvironmentOwnership,
};
