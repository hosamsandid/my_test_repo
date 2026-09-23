"use strict";

// Unit tests for the ownership data model + the D6 migration plan (#2077).
// Run: node --test orchestrator/ownership-migration.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ownableRole,
  resolveScopeOwner,
  planOwnerBackfill,
  planMembershipRepoint,
  OWNER_SOURCE_MIGRATION,
} = require("./ownership-migration");

// ── Fixture ────────────────────────────────────────────────────────────────
// Access scope 'default' holds two Agent Teams (the N×M case) plus a
// standalone agent; scope 'risk' holds one Agent Team and has a member but no
// admin; scope 'empty' holds an Agent Team and NO members at all.
const users = [
  { id: "u-ada", subject: "ada@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "u-bob", subject: "bob@example.com", createdAt: "2026-01-02T00:00:00.000Z" },
  { id: "u-cyd", subject: "cyd@example.com", createdAt: "2026-01-03T00:00:00.000Z" },
];

const memberships = [
  // Bob's admin record is OLDER than Ada's, so "first team-admin by createdAt"
  // must pick Bob and not the first record in the array.
  { id: "m-1", userId: "u-ada", teamId: "default", role: "team-admin", createdAt: "2026-02-02T00:00:00.000Z" },
  { id: "m-2", userId: "u-bob", teamId: "default", role: "team-admin", createdAt: "2026-02-01T00:00:00.000Z" },
  { id: "m-3", userId: "u-cyd", teamId: "default", role: "team-member", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "m-4", userId: "u-cyd", teamId: "risk", role: "team-member", createdAt: "2026-03-01T00:00:00.000Z" },
];

const configs = {
  "sdlc-2-0": { id: "sdlc-2-0", role: "team", teamId: "default" },
  "sdlc-2-0-dev": { id: "sdlc-2-0-dev", role: "team-member", teamId: "default", parentTeamId: "sdlc-2-0" },
  payments: { id: "payments", role: "team", teamId: "default" },
  scratch: { id: "scratch", role: "agent", teamId: "default" },
  "risk-squad": { id: "risk-squad", role: "team", teamId: "risk" },
  "ghost-squad": { id: "ghost-squad", role: "team", teamId: "empty" },
};

// ── ownableRole (D8) ───────────────────────────────────────────────────────

test("only a team and a standalone agent carry an ownerId of their own (D8)", () => {
  assert.equal(ownableRole("team"), true);
  assert.equal(ownableRole("agent"), true);
  // A member follows its team via resolveAgentOwnerId's parent hop.
  assert.equal(ownableRole("team-member"), false);
  assert.equal(ownableRole("ephemeral"), false);
  assert.equal(ownableRole("bp-instance"), false);
  assert.equal(ownableRole(undefined), false);
});

// ── resolveScopeOwner (§8.1) ───────────────────────────────────────────────

test("the first team-admin by createdAt owns the scope, not the first record", () => {
  assert.equal(resolveScopeOwner({ scopeId: "default", users, memberships }), "u-bob");
});

test("a scope with members but no admin falls back to its first member", () => {
  assert.equal(resolveScopeOwner({ scopeId: "risk", users, memberships }), "u-cyd");
});

test("a scope with no members resolves to no owner (D6 ends in 'else unset')", () => {
  assert.equal(resolveScopeOwner({ scopeId: "empty", users, memberships }), null);
  assert.equal(resolveScopeOwner({ scopeId: "", users, memberships }), null);
  assert.equal(resolveScopeOwner({ scopeId: "default", users: [], memberships }), null);
});

test("a membership naming a deleted user is never an owner", () => {
  const dangling = [{ id: "m-x", userId: "u-gone", teamId: "orphan", role: "team-admin", createdAt: "2026-01-01T00:00:00.000Z" }];
  assert.equal(resolveScopeOwner({ scopeId: "orphan", users, memberships: dangling }), null);
});

test("a blank createdAt sorts last rather than winning by array order", () => {
  const ms = [
    { id: "m-a", userId: "u-ada", teamId: "t", role: "team-admin" },
    { id: "m-b", userId: "u-bob", teamId: "t", role: "team-admin", createdAt: "2026-05-05T00:00:00.000Z" },
  ];
  assert.equal(resolveScopeOwner({ scopeId: "t", users, memberships: ms }), "u-bob");
});

// ── planOwnerBackfill (AC5, AC6) ───────────────────────────────────────────

test("every ownable config in a resolvable scope is stamped, members are not", () => {
  const { stamp, unresolved } = planOwnerBackfill({ configs, users, memberships });
  assert.deepEqual(
    stamp.map((s) => [s.id, s.ownerId]),
    [["payments", "u-bob"], ["risk-squad", "u-cyd"], ["scratch", "u-bob"], ["sdlc-2-0", "u-bob"]]
  );
  // The team-member is absent from BOTH lists — it is not ownable at all.
  assert.equal(stamp.some((s) => s.id === "sdlc-2-0-dev"), false);
  assert.equal(unresolved.some((u) => u.id === "sdlc-2-0-dev"), false);
  for (const s of stamp) assert.equal(s.ownerSource, OWNER_SOURCE_MIGRATION);
});

test("an ownable config whose scope has no member is reported, never fabricated", () => {
  const { stamp, unresolved } = planOwnerBackfill({ configs, users, memberships });
  assert.deepEqual(unresolved, [{ id: "ghost-squad", scopeId: "empty" }]);
  assert.equal(stamp.some((s) => s.id === "ghost-squad"), false);
});

test("an unstamped config is resolved against the default scope", () => {
  const { stamp } = planOwnerBackfill({
    configs: { legacy: { id: "legacy", role: "agent" } },
    users,
    memberships,
  });
  assert.deepEqual(stamp, [
    { id: "legacy", ownerId: "u-bob", ownerSource: OWNER_SOURCE_MIGRATION, scopeId: "default" },
  ]);
});

test("running the backfill twice is a no-op (AC6)", () => {
  const applied = {};
  for (const [id, cfg] of Object.entries(configs)) applied[id] = { ...cfg };
  const first = planOwnerBackfill({ configs: applied, users, memberships });
  for (const s of first.stamp) {
    applied[s.id].ownerId = s.ownerId;
    applied[s.id].ownerSource = s.ownerSource;
  }
  const second = planOwnerBackfill({ configs: applied, users, memberships });
  assert.deepEqual(second.stamp, []);
  // The unresolved one stays reported — it has no owner to become idempotent on.
  assert.deepEqual(second.unresolved, first.unresolved);
});

test("a config that already has an owner is never re-stamped", () => {
  const { stamp } = planOwnerBackfill({
    configs: { kept: { id: "kept", role: "team", teamId: "default", ownerId: "u-cyd" } },
    users,
    memberships,
  });
  assert.deepEqual(stamp, []);
});

// ── planMembershipRepoint (§3.3, §8.1, AC2/AC3) ────────────────────────────

test("each scope membership fans out to every Agent Team in that scope", () => {
  const plan = planMembershipRepoint({ configs, memberships });
  const pairs = plan.map((p) => [p.userId, p.teamId, p.role]).sort();
  assert.deepEqual(pairs, [
    // scope 'default' → its two Agent Teams, for all three members (N×M).
    ["u-ada", "payments", "team-admin"],
    ["u-ada", "sdlc-2-0", "team-admin"],
    ["u-bob", "payments", "team-admin"],
    ["u-bob", "sdlc-2-0", "team-admin"],
    ["u-cyd", "payments", "team-member"],
    ["u-cyd", "risk-squad", "team-member"],
    ["u-cyd", "sdlc-2-0", "team-member"],
  ]);
  // Nothing is planned for the member-less scope, and no membership is ever
  // planned against a role that is not an Agent Team.
  assert.equal(plan.some((p) => p.teamId === "ghost-squad"), false);
  assert.equal(plan.some((p) => p.teamId === "sdlc-2-0-dev"), false);
});

test("the plan records which scope each new membership came from", () => {
  const plan = planMembershipRepoint({ configs, memberships });
  const risk = plan.find((p) => p.teamId === "risk-squad");
  assert.equal(risk.fromScopeId, "risk");
});

test("an Agent Team whose id coincides with its scope id yields no duplicate", () => {
  // 'payments' is both an Agent Team id and an access-scope id, and the user
  // already holds the scope membership — the legacy record IS the new one.
  const coincident = { payments: { id: "payments", role: "team", teamId: "payments" } };
  const ms = [{ id: "m", userId: "u-ada", teamId: "payments", role: "team-admin", createdAt: "2026-01-01T00:00:00.000Z" }];
  assert.deepEqual(planMembershipRepoint({ configs: coincident, memberships: ms }), []);
});

test("running the fan-out twice is a no-op (AC6)", () => {
  const first = planMembershipRepoint({ configs, memberships });
  const after = [
    ...memberships,
    ...first.map((p, i) => ({ id: `new-${i}`, userId: p.userId, teamId: p.teamId, role: p.role, createdAt: "2026-09-08T00:00:00.000Z" })),
  ];
  assert.deepEqual(planMembershipRepoint({ configs, memberships: after }), []);
});

test("team-admin wins when one user reaches a team through two scopes", () => {
  // 'shared-squad' is stamped into scope 'a'; the same user is a member of 'a'
  // and an admin of 'b' — but only 'a' holds the team, so only 'a' fans out.
  // The tie-break matters when TWO scopes hold the same Agent Team id, which is
  // possible because nothing enforces one stamp per team.
  const cfgs = {
    "shared-squad": { id: "shared-squad", role: "team", teamId: "a" },
    "shared-squad-2": { id: "shared-squad-2", role: "team", teamId: "b" },
  };
  const ms = [
    { id: "m1", userId: "u-ada", teamId: "a", role: "team-member", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "m2", userId: "u-ada", teamId: "b", role: "team-admin", createdAt: "2026-01-02T00:00:00.000Z" },
  ];
  const plan = planMembershipRepoint({ configs: cfgs, memberships: ms });
  assert.deepEqual(
    plan.map((p) => [p.teamId, p.role]).sort(),
    [["shared-squad", "team-member"], ["shared-squad-2", "team-admin"]]
  );
});

test("a malformed membership role is never fanned out", () => {
  const ms = [{ id: "m", userId: "u-ada", teamId: "default", role: "owner", createdAt: "2026-01-01T00:00:00.000Z" }];
  assert.deepEqual(planMembershipRepoint({ configs, memberships: ms }), []);
});

// ── B: the fan-out is terminal for teams born under the new model ────────────
// A team created via self-service (#2081) carries ownerSource: 'creator' and
// already holds its correct membership. The legacy scope fan-out must never add
// members to it, or every restart re-inherits its whole owning scope — the bug.
test("a team created under the new model (ownerSource: creator) is never a fan-out target", () => {
  const cfgs = {
    ...configs,
    "fresh-team": { id: "fresh-team", role: "team", teamId: "default", ownerId: "u-ada", ownerSource: "creator" },
  };
  const plan = planMembershipRepoint({ configs: cfgs, memberships, users });
  assert.equal(plan.some((p) => p.teamId === "fresh-team"), false,
    "the default scope's members were fanned into a creator-owned team");
  // The genuinely legacy teams in the same scope still fan out as before.
  assert.equal(plan.some((p) => p.teamId === "sdlc-2-0"), true);
  // A 'migration'-stamped team (this pass's own placeholder) is still a target.
  const migrated = {
    ...configs,
    "legacy-team": { id: "legacy-team", role: "team", teamId: "default", ownerId: "u-bob", ownerSource: "migration" },
  };
  assert.equal(
    planMembershipRepoint({ configs: migrated, memberships, users }).some((p) => p.teamId === "legacy-team"),
    true,
  );
});

// ── C: a System Admin is a flag with scope.all, never a membership ───────────
// (decentralised-access-concept.md 2.1/2.2). Even a stray Default-Team admin
// membership must never be materialised onto an Agent Team.
test("a System Admin's membership is never fanned out", () => {
  const withSys = [
    ...users,
    { id: "u-sys", subject: "sys@example.com", systemAdmin: true, createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  const ms = [
    ...memberships,
    { id: "m-sys", userId: "u-sys", teamId: "default", role: "team-admin", createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  const plan = planMembershipRepoint({ configs, memberships: ms, users: withSys });
  assert.equal(plan.some((p) => p.userId === "u-sys"), false, "a System Admin was materialised as a team member");
  // Non-admin members still fan out exactly as before.
  assert.equal(plan.some((p) => p.userId === "u-cyd"), true);
});

test("without a users list the System-Admin guard is inert (backward-compatible)", () => {
  const ms = [
    ...memberships,
    { id: "m-sys", userId: "u-sys", teamId: "default", role: "team-admin", createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.equal(
    planMembershipRepoint({ configs, memberships: ms }).some((p) => p.userId === "u-sys"),
    true,
  );
});

test("the planners tolerate empty and malformed input", () => {
  assert.deepEqual(planOwnerBackfill({}), { stamp: [], unresolved: [] });
  assert.deepEqual(planMembershipRepoint({}), []);
  assert.deepEqual(
    planOwnerBackfill({ configs: { a: null, b: "nope" }, users, memberships }),
    { stamp: [], unresolved: [] }
  );
});
