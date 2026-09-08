'use strict';

// Layered resource ownership — the shared three-tier shape (#2083, epic #2076
// P5; design of record docs/decentralised-access-concept.md D7/D12 + §5).
//
// D12's principle is "what is only configuration or content becomes
// self-service and tiered; what runs as infrastructure stays with the
// administrator". Credentials and model providers were already tiered (#798,
// #800); working environments and MCP servers carried a single `teamId` with no
// shared tier at all. This module is the ONE definition of that shape, so the
// three resource kinds cannot drift in what `personal` / `team` / `system`
// means:
//
//   • personal — owned by exactly one human (`userId`), no team, no
//                assignments. Strictly private to the owner: every predicate
//                built on this checks it BEFORE any `scope.all` shortcut, so
//                not even a System Admin sees it (concept §2.2 / #1567 D2).
//   • team     — owned by exactly one team (`teamId`), no assignments.
//   • system   — the SHARED tier. No owning team; assigned to 0..n teams
//                (`assignedTeamIds`). Assigned to zero teams → reachable by
//                System Admins only, never orphaned and never globally
//                visible.
//
// A record with no `scope` field is a pre-#2083 (or pre-#798) one and reads as
// `team`, so every environment, MCP server and credential on disk today keeps
// working untouched.
//
// WHY THIS IS A SHARED FILE AND NOT THREE COPIES. The tier is written by the
// console (route handlers, `scope.js` predicates) and read by the orchestrator
// (the boot adoption pass must not adopt a deliberately team-less shared
// record, and the D6 re-point migration writes these very fields). Those run in
// two images, so the module is duplicated byte-identically and guarded
// two-sided — the `agent-team.js` / `toolchain-registry.js` arrangement.
//
// Pure: no IO, no `require` of anything. The `scope` argument is a
// `computeScope` result and is only ever read.

const TIER_PERSONAL = 'personal';
const TIER_TEAM = 'team';
const TIER_SYSTEM = 'system';

// Every tier a record may legally carry, in widening order of reach.
const TIERS = [TIER_PERSONAL, TIER_TEAM, TIER_SYSTEM];

// Backward-compatible view of a stored record. Returns a normalized COPY with an
// explicit `scope`, `teamId` and `assignedTeamIds`, so a predicate never has to
// ask "which of the three shapes is this".
//
// The three tiers are mutually exclusive by construction: exactly one of
// `userId` / `teamId` / `assignedTeamIds` carries the reach, and the other two
// are nulled. That is what makes "promote this record to the shared tier" a
// total function rather than a merge.
function normalizeTier(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (entry.scope === TIER_PERSONAL) {
    return { ...entry, scope: TIER_PERSONAL, userId: entry.userId || null, teamId: null, assignedTeamIds: [] };
  }
  const scope = entry.scope === TIER_SYSTEM ? TIER_SYSTEM : TIER_TEAM;
  if (scope === TIER_SYSTEM) {
    const assignedTeamIds = Array.isArray(entry.assignedTeamIds)
      ? [...new Set(entry.assignedTeamIds.map(String))]
      : [];
    return { ...entry, scope, teamId: null, assignedTeamIds };
  }
  // No `|| 'default'` (concept §8.4). Safe to drop because the boot-time
  // adoption pass stamps an explicit `teamId` on every record; one that still
  // lacks a team is a record nobody owns and must fail closed rather than land
  // in the default team's lap.
  return { ...entry, scope: TIER_TEAM, teamId: entry.teamId || null, assignedTeamIds: [] };
}

// Does this human own this personal-tier record? Requires an identified owner
// AND an identified caller, so an ownerless record and the env single-admin
// (`userId: null`) both match nobody.
//
// Deliberately carries NO `scope.all` bypass — the personal tier is stronger
// than D5, and a census guard in `scope.test.js` pins that omission.
function ownsPersonalTier(scope, entry) {
  const r = normalizeTier(entry);
  return !!(r && r.userId && scope && scope.userId && r.userId === scope.userId);
}

// Is this record on the shared tier? Read by the boot adoption pass, which must
// leave a shared record's deliberate `teamId: null` alone instead of adopting it
// into the default team.
function isSharedTier(entry) {
  return !!(entry && entry.scope === TIER_SYSTEM);
}

// Which teams reach this record, as a flat list — the team tier's single owner,
// or the shared tier's assignments, or nothing for a personal one. The one place
// that knows a shared record's reach lives on a different field.
function tierTeamIds(entry) {
  const r = normalizeTier(entry);
  if (!r || r.scope === TIER_PERSONAL) return [];
  if (r.scope === TIER_SYSTEM) return [...r.assignedTeamIds];
  return r.teamId ? [r.teamId] : [];
}

// Would `teamId` reach this record? The runtime question ("may this agent's team
// use that environment / MCP server / credential"), asked without a caller
// scope. No `|| 'default'` fallback: an unstamped record is reachable by no
// team, mirroring `normalizeTier`.
function tierUsableByTeam(entry, teamId) {
  if (!teamId) return false;
  return tierTeamIds(entry).includes(String(teamId));
}

// The minimal persisted ownership triple for a create/update body. Written
// explicitly rather than spread from the request, so a client cannot smuggle a
// fourth field into the shape the predicates read.
function tierOwnershipFields(desired) {
  const r = normalizeTier(desired) || {};
  if (r.scope === TIER_PERSONAL) {
    return { scope: TIER_PERSONAL, teamId: null, assignedTeamIds: [], userId: r.userId || null };
  }
  if (r.scope === TIER_SYSTEM) {
    return { scope: TIER_SYSTEM, teamId: null, assignedTeamIds: [...r.assignedTeamIds] };
  }
  return { scope: TIER_TEAM, teamId: r.teamId || null, assignedTeamIds: [] };
}

// Does a change of ownership re-TIER the record — change which tier it is on, or
// which teams a shared one is assigned to?
//
// This is the boundary §5.2 puts behind a System Admin (`canReassignCredential`),
// and it is deliberately narrower than "may I edit this record": editing a shared
// environment's repository list is self-service for every assigned team's admin
// (D12), whereas deciding WHICH teams share it, or moving a record between
// tiers, is an operator act. See the note on `canManageEnvironment` in scope.js.
function isRetier(current, desired) {
  const a = normalizeTier(current) || {};
  const b = normalizeTier(desired) || {};
  if (a.scope !== b.scope) return true;
  if (b.scope === TIER_TEAM) return (a.teamId || null) !== (b.teamId || null);
  if (b.scope === TIER_SYSTEM) {
    const before = [...a.assignedTeamIds].sort().join(',');
    const after = [...b.assignedTeamIds].sort().join(',');
    return before !== after;
  }
  return (a.userId || null) !== (b.userId || null);
}

module.exports = {
  TIER_PERSONAL,
  TIER_TEAM,
  TIER_SYSTEM,
  TIERS,
  normalizeTier,
  ownsPersonalTier,
  isSharedTier,
  tierTeamIds,
  tierUsableByTeam,
  tierOwnershipFields,
  isRetier,
};
