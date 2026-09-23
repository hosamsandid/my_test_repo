"use strict";

// Ownership data model + the D6 migration (#2077, epic #2076; design of record
// `docs/decentralised-access-concept.md` D1/D6/D8, concept §3.4/§3.5/§8).
//
// This is the PURE decision core — no fs, no network, no orchestrator state.
// The impure half (reading the agent configs, writing them back, appending the
// membership records, logging) wraps it in `orchestrator.js`, exactly like
// `agent-tenant.js` / `credential-resolution.js` do. It answers three
// questions, all from data the caller has already loaded:
//
//   1. Who should own the resources of one access scope? (`resolveScopeOwner`)
//   2. Which agent configs still need an `ownerId`, and which? (`planOwnerBackfill`)
//   3. Which (user → Agent Team) memberships does the collapse imply?
//      (`planMembershipRepoint`)
//
// ── Why the membership fan-out is ADDITIVE ──────────────────────────────────
// Concept §8.1 turns each `(user ↔ access-scope)` membership into one
// `(user ↔ Agent Team)` membership per Agent Team in that scope. Doing that as
// a *replacement* would break every existing read: enforcement still compares a
// resource's `teamId` stamp (an access-scope id until P2 re-points it) against
// `scope.teamIds`, so dropping the scope memberships in P1 would empty every
// list for every non-admin. P1 is specified as "no behaviour change", so the
// new records are added ALONGSIDE the legacy ones and the scope memberships are
// retired by P2 together with the stamps they gate.
//
// That is exactly why §8.3 states the no-lockout property as `⊇` and not `=`:
// reach may legitimately grow (a scope `team-admin` becomes `team-admin` of each
// of its Agent Teams, which is what D6 asks for), and losing any is the failure
// the fixture test exists to catch.
//
// ── Why an owner carries its provenance ────────────────────────────────────
// Concept §8.2: no `createdBy` and no `ownerId` exists anywhere today, so
// nothing reconstructs who created a pre-existing team. The owner this
// migration assigns is "a defensible placeholder, not a recovered fact" and
// must be correctable. So every write records HOW the owner was decided
// (`ownerSource`), which keeps a migrated guess distinguishable from a real
// creator instead of silently laundering one into the other.

// Only these two roles carry an `ownerId` of their own (D8). A `team-member`
// deliberately gets none — `resolveAgentOwnerId` (credential-resolution.js)
// resolves it from the parent Agent Team, which is the D8 rule "a team member
// always follows its team". An `ephemeral`/`bp-instance` agent is transient and
// is left alone.
const OWNABLE_ROLES = Object.freeze(["team", "agent"]);

// How an `ownerId` was decided. Recorded on the config next to the owner.
const OWNER_SOURCE_CREATOR = "creator"; // the human who made the request
const OWNER_SOURCE_MIGRATION = "migration"; // the D6 placeholder (§8.2)
const OWNER_SOURCE_CONVERSION = "conversion"; // carried from the converted agent

const OWNER_SOURCES = Object.freeze([
  OWNER_SOURCE_CREATOR,
  OWNER_SOURCE_MIGRATION,
  OWNER_SOURCE_CONVERSION,
]);

const DEFAULT_TEAM_ID = "default";

function ownableRole(role) {
  return OWNABLE_ROLES.includes(role);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// A missing/blank `createdAt` must not sort ahead of a real one — it would make
// the "earliest" tie-break depend on record order in the file, which is not a
// stable fact about anything. Sort such records last, then by id, so the result
// is deterministic either way (AC6 idempotence depends on this being a function
// of the data alone).
function byCreatedAtThenId(a, b) {
  const at = isNonEmptyString(a.createdAt) ? a.createdAt : "￿";
  const bt = isNonEmptyString(b.createdAt) ? b.createdAt : "￿";
  if (at !== bt) return at < bt ? -1 : 1;
  return String(a.id || "") < String(b.id || "") ? -1 : 1;
}

// The D6 owner-resolution rule for one access scope (§8.1):
//
//   the first `team-admin` of the scope (earliest `createdAt`),
//   else the first member of the scope,
//   else unset.
//
// A membership naming a user that no longer exists in `users` is skipped — it
// cannot be an owner, and `resolveAgentOwnerId`'s consumers compare the id
// against the credential index's `userId`, where a dangling id resolves to
// nothing anyway.
function resolveScopeOwner({ scopeId, users = [], memberships = [] } = {}) {
  if (!isNonEmptyString(scopeId)) return null;
  const known = new Set((users || []).map((u) => u && u.id).filter(Boolean));
  const inScope = (memberships || []).filter(
    (m) => m && m.teamId === scopeId && m.userId && known.has(m.userId)
  );
  if (inScope.length === 0) return null;

  const admins = inScope.filter((m) => m.role === "team-admin").sort(byCreatedAtThenId);
  if (admins.length > 0) return String(admins[0].userId);

  const members = [...inScope].sort(byCreatedAtThenId);
  return String(members[0].userId);
}

// Which agent configs still need an `ownerId`, and what it should be (AC5).
//
// `configs` is a `{ [agentId]: config }` map — the shape the orchestrator's
// startup pass already builds. Only `role: 'team'` and `role: 'agent'` are
// considered (D8); a config that already carries an `ownerId` is skipped, which
// is what makes a second run a no-op (AC6).
//
// Returns two lists rather than one, because they need different handling:
//   `stamp`      — `[{ id, ownerId, ownerSource, scopeId }]`, ready to write.
//   `unresolved` — `[{ id, scopeId }]`, an ownable config whose scope has no
//                  member to inherit from. D6's own rule ends in "else unset",
//                  so these are REPORTED rather than given a fabricated owner;
//                  see the AC5 note in the PR body.
function planOwnerBackfill({ configs = {}, users = [], memberships = [] } = {}) {
  const stamp = [];
  const unresolved = [];
  const ownerByScope = new Map();

  for (const id of Object.keys(configs).sort()) {
    const cfg = configs[id];
    if (!cfg || typeof cfg !== "object") continue;
    if (!ownableRole(cfg.role)) continue;
    if (isNonEmptyString(cfg.ownerId)) continue;

    const scopeId = isNonEmptyString(cfg.teamId) ? cfg.teamId : DEFAULT_TEAM_ID;
    if (!ownerByScope.has(scopeId)) {
      ownerByScope.set(scopeId, resolveScopeOwner({ scopeId, users, memberships }));
    }
    const ownerId = ownerByScope.get(scopeId);
    if (ownerId) {
      stamp.push({ id, ownerId, ownerSource: OWNER_SOURCE_MIGRATION, scopeId });
    } else {
      unresolved.push({ id, scopeId });
    }
  }

  return { stamp, unresolved };
}

// The (user ↔ Agent Team) memberships the collapse implies (§3.3, §8.1).
//
// For each access scope `S` and each Agent Team `T` stamped `teamId: S`, every
// membership `{U, S, R}` implies `{U, T, R}`. A pair that already exists is
// skipped — including the coincidental case where an Agent Team's id equals a
// scope id, in which case the legacy record IS the new one.
//
// Returns `[{ userId, teamId, role, fromScopeId }]`, deduplicated on
// `(userId, teamId)`. When one user reaches the same Agent Team through two
// scopes with different roles, `team-admin` wins — dropping to `team-member`
// would be the reach loss §8.3 forbids.
// Two guards keep this a ONE-TIME LEGACY migration, not a recurring boot
// reconcile: it runs on every boot, so without them it re-derives from the
// still-present scope memberships and re-adds, on each restart, members a human
// curated away. The property we need: a restart never adds members to a team
// created under the new model.
function planMembershipRepoint({ configs = {}, memberships = [], users = [] } = {}) {
  // (C) A System Admin is a global flag with scope.all, never a membership
  // (decentralised-access-concept.md 2.1/2.2): their reach comes from the
  // bypass, so they are never materialised as a team member. `users` marks who
  // is a System Admin; omitting it disables this guard (kept optional so
  // existing callers stay valid).
  const systemAdminIds = new Set(
    (users || [])
      .filter((u) => u && u.systemAdmin === true && u.id)
      .map((u) => String(u.id))
  );
  // scope id → the Agent Team ids stamped into it
  const teamsByScope = new Map();
  for (const id of Object.keys(configs).sort()) {
    const cfg = configs[id];
    if (!cfg || typeof cfg !== "object" || cfg.role !== "team") continue;
    // (B) A team created under the new model (ownerSource: 'creator', #2081)
    // already holds its correct membership (planCreatorMembership) and is never
    // a fan-out target — otherwise a new team stamped `teamId: 'default'` (its
    // owning tenant) re-inherits the whole default scope on every restart. Only
    // genuinely legacy teams (no ownerSource, or the 'migration' placeholder
    // this pass itself stamps) inherit their scope's members.
    if (cfg.ownerSource === OWNER_SOURCE_CREATOR) continue;
    const scopeId = isNonEmptyString(cfg.teamId) ? cfg.teamId : DEFAULT_TEAM_ID;
    if (!teamsByScope.has(scopeId)) teamsByScope.set(scopeId, []);
    teamsByScope.get(scopeId).push(id);
  }

  const existing = new Set(
    (memberships || [])
      .filter((m) => m && m.userId && m.teamId)
      .map((m) => `${m.userId} ${m.teamId}`)
  );

  const planned = new Map();
  for (const m of memberships || []) {
    if (!m || !m.userId || !m.teamId) continue;
    if (m.role !== "team-admin" && m.role !== "team-member") continue;
    if (systemAdminIds.has(String(m.userId))) continue; // (C)
    for (const teamId of teamsByScope.get(m.teamId) || []) {
      const key = `${m.userId} ${teamId}`;
      if (existing.has(key)) continue;
      const prior = planned.get(key);
      if (prior && (prior.role === "team-admin" || m.role !== "team-admin")) continue;
      planned.set(key, {
        userId: String(m.userId),
        teamId,
        role: m.role,
        fromScopeId: String(m.teamId),
      });
    }
  }

  return [...planned.values()];
}

module.exports = {
  OWNABLE_ROLES,
  OWNER_SOURCES,
  OWNER_SOURCE_CREATOR,
  OWNER_SOURCE_MIGRATION,
  OWNER_SOURCE_CONVERSION,
  ownableRole,
  resolveScopeOwner,
  planOwnerBackfill,
  planMembershipRepoint,
};
