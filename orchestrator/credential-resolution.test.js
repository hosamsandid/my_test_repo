"use strict";

// Unit tests for personal-credential runtime resolution (#1569, epic #1558
// Phase 3). These ARE the verification surface for the resolution algorithm:
// the live end-to-end path cannot be exercised until agents carry a real
// `config.ownerId` (the blocking prerequisite named in the issue), so every
// acceptance criterion is pinned here as a decision-level assertion.
// Run: node --test orchestrator/credential-resolution.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  operationPrefersPersonal,
  resolveAgentOwnerId,
  resolveEffectiveOwnerId,
  resolveBaselineOwnerId,
  isActingSenderTrusted,
  findPersonalCredential,
  findPersonalCredentialState,
  resolveCredential,
  selectAgentIdsForOwner,
  selectPersonalCredentialIds,
} = require("./credential-resolution");

// ── owner resolution (AC3, AC4) ─────────────────────────────────────────────

test("resolveAgentOwnerId: standalone agent uses its own ownerId", () => {
  assert.equal(resolveAgentOwnerId({ role: "agent", ownerId: "u-alice" }), "u-alice");
});

test("resolveAgentOwnerId: null when no owner is set anywhere (AC8 gate)", () => {
  assert.equal(resolveAgentOwnerId({ role: "agent" }), null);
  assert.equal(resolveAgentOwnerId({ role: "team-member", parentTeamId: "sq" }, () => ({})), null);
  assert.equal(resolveAgentOwnerId(null), null);
});

test("resolveAgentOwnerId: team-member resolves to parent Agent Team's owner (AC4)", () => {
  const agents = {
    squad: { role: "team", ownerId: "u-team-owner" },
    "squad-dev": { role: "team-member", parentTeamId: "squad" },
  };
  const load = (id) => agents[id] || null;
  // Deterministic: the member's owner is the team-agent's owner, not any
  // trigger initiator (AC3/AC4).
  assert.equal(resolveAgentOwnerId(agents["squad-dev"], load), "u-team-owner");
});

test("resolveAgentOwnerId: member's own ownerId wins when set; falls back to parent", () => {
  const load = () => ({ role: "team", ownerId: "u-parent" });
  assert.equal(
    resolveAgentOwnerId({ role: "team-member", parentTeamId: "squad", ownerId: "u-self" }, load),
    "u-parent", // parent hop takes precedence for a team-member (mirrors resolveAgentTenant)
  );
  // Parent missing/unstamped → fall back to the member's own stamp.
  assert.equal(
    resolveAgentOwnerId({ role: "team-member", parentTeamId: "squad", ownerId: "u-self" }, () => null),
    "u-self",
  );
});

// ── operation classification (AC7) ──────────────────────────────────────────

test("operationPrefersPersonal: attributed writes prefer personal, reads/poll do not", () => {
  // push-ssh joined the attributed set in #2175 (B3) once resolveAttributedSshKey
  // existed to prefer a personal SSH key for it — see the ATTRIBUTED_OPERATIONS
  // comment.
  for (const op of ["commit", "pr", "review", "push-https", "push-ssh"]) {
    assert.equal(operationPrefersPersonal(op), true, op);
  }
  for (const op of ["clone", "poll", "probe", "anything"]) {
    assert.equal(operationPrefersPersonal(op), false, op);
  }
});

// ── acting-sender re-keying (#2175, epic #2166 B3) ──────────────────────────

test("resolveEffectiveOwnerId: prefers the acting sender's userId when present", () => {
  const cfg = { role: "agent", ownerId: "u-team-creator" };
  assert.equal(resolveEffectiveOwnerId(cfg, () => null, "u-chatting-human"), "u-chatting-human");
});

test("resolveEffectiveOwnerId: falls back to the static owner with no acting sender (autonomous runs unaffected)", () => {
  const cfg = { role: "agent", ownerId: "u-team-creator" };
  assert.equal(resolveEffectiveOwnerId(cfg, () => null, null), "u-team-creator");
  assert.equal(resolveEffectiveOwnerId(cfg, () => null, undefined), "u-team-creator");
  assert.equal(resolveEffectiveOwnerId(cfg, () => null, ""), "u-team-creator");
});

test("resolveEffectiveOwnerId: a team-member without an acting sender still resolves through its parent (AC4 unchanged)", () => {
  const load = () => ({ role: "team", ownerId: "u-parent" });
  assert.equal(
    resolveEffectiveOwnerId({ role: "team-member", parentTeamId: "squad" }, load, null),
    "u-parent",
  );
});

// ── the team-admin BASELINE (#2176, epic #2166 B4) ──────────────────────────

test("resolveBaselineOwnerId: a team-bounded agent defers to the CURRENT team-admin, not the static creator ownerId", () => {
  const cfg = { role: "team", id: "squad", ownerId: "u-creator" };
  const users = [{ id: "u-creator" }, { id: "u-newadmin" }];
  // A D4 succession demoted the creator and promoted someone else — the
  // creator no longer holds a `team-admin` membership at all.
  const memberships = [
    { userId: "u-newadmin", teamId: "squad", role: "team-admin", createdAt: "2020-02-01" },
    { userId: "u-creator", teamId: "squad", role: "team-member", createdAt: "2020-01-01" },
  ];
  assert.equal(resolveBaselineOwnerId(cfg, { users, memberships }), "u-newadmin");
});

test("resolveBaselineOwnerId: a team-member resolves the admin of its PARENT team", () => {
  const cfg = { role: "team-member", parentTeamId: "squad" };
  const users = [{ id: "u-admin" }];
  const memberships = [{ userId: "u-admin", teamId: "squad", role: "team-admin", createdAt: "2020-01-01" }];
  assert.equal(resolveBaselineOwnerId(cfg, { users, memberships }), "u-admin");
});

test("resolveBaselineOwnerId: a standalone agent has no team boundary — falls back to its own static owner", () => {
  const cfg = { role: "agent", ownerId: "u-alice" };
  assert.equal(resolveBaselineOwnerId(cfg, {}), "u-alice");
  assert.equal(resolveBaselineOwnerId(cfg), "u-alice");
});

test("resolveBaselineOwnerId: no membership data available degrades to the static owner (fail-open)", () => {
  const cfg = { role: "team", id: "squad", ownerId: "u-creator" };
  // Same fail-open direction as `buildLiveUserGate`: an unreadable/absent
  // membership snapshot must not disable resolution, only widen it once real
  // data is supplied.
  assert.equal(resolveBaselineOwnerId(cfg, {}), "u-creator");
  assert.equal(resolveBaselineOwnerId(cfg), "u-creator");
  assert.equal(resolveBaselineOwnerId(cfg, { users: [], memberships: [] }), "u-creator");
});

test("resolveEffectiveOwnerId: with no acting sender, resolves the team-admin baseline once membership data is supplied", () => {
  const cfg = { role: "team", id: "squad", ownerId: "u-creator" };
  const users = [{ id: "u-newadmin" }];
  const memberships = [{ userId: "u-newadmin", teamId: "squad", role: "team-admin", createdAt: "2020-01-01" }];
  assert.equal(
    resolveEffectiveOwnerId(cfg, () => null, null, { users, memberships }),
    "u-newadmin",
  );
  // An acting sender still wins outright — B4 only changes the AUTONOMOUS
  // fallback, never overriding B3's interactive re-keying.
  assert.equal(
    resolveEffectiveOwnerId(cfg, () => null, "u-chatting-human", { users, memberships }),
    "u-chatting-human",
  );
});

test("resolveEffectiveOwnerId: omitting baselineDeps reproduces the pre-B4 static-owner answer exactly", () => {
  const cfg = { role: "team", id: "squad", ownerId: "u-creator" };
  assert.equal(resolveEffectiveOwnerId(cfg, () => null, null), "u-creator");
});

// ── acting-sender TRUST boundary (#2187 review finding) ─────────────────────
//
// `resolveEffectiveOwnerId` trusts `actingSenderUserId` unconditionally, so
// the caller (orchestrator.js's `resolveActingSenderUserId`) MUST filter a
// resolved user through `isActingSenderTrusted` first. These pin the actual
// security boundary — not just that a sender is threaded through, but that an
// UNRELATED platform user can never be selected.

test("isActingSenderTrusted: a member of the team-agent's own team is trusted", () => {
  const cfg = { role: "team", id: "squad" };
  const hasMembership = (teamId, userId) => teamId === "squad" && userId === "u-alice";
  assert.equal(isActingSenderTrusted(cfg, "u-alice", hasMembership), true);
});

test("isActingSenderTrusted: a team-member resolves the boundary to its PARENT team, not its own id", () => {
  const cfg = { role: "team-member", id: "squad-dev", parentTeamId: "squad" };
  let queriedTeamId = null;
  const hasMembership = (teamId, userId) => { queriedTeamId = teamId; return userId === "u-alice"; };
  assert.equal(isActingSenderTrusted(cfg, "u-alice", hasMembership), true);
  assert.equal(queriedTeamId, "squad", "must check membership of the PARENT team, never the member's own id");
});

test("isActingSenderTrusted: THE ACTUAL FINDING — a real platform user with no relationship to this team is refused", () => {
  const cfg = { role: "team", id: "squad" };
  // u-mallory resolves to a real user (that is exactly the vulnerable case —
  // an installation-wide lookup with no boundary), but is not a member of
  // this agent's team.
  const hasMembership = (teamId, userId) => teamId === "squad" && userId === "u-alice";
  assert.equal(isActingSenderTrusted(cfg, "u-mallory", hasMembership), false);
});

test("isActingSenderTrusted: no membership lookup injected → fails closed, never trusts by default", () => {
  const cfg = { role: "team", id: "squad" };
  assert.equal(isActingSenderTrusted(cfg, "u-alice", undefined), false);
  assert.equal(isActingSenderTrusted(cfg, "u-alice", null), false);
});

test("isActingSenderTrusted: a standalone agent (no team boundary, D8) trusts ONLY its own owner", () => {
  const cfg = { role: "agent", ownerId: "u-alice" };
  // No hasMembership call should even matter here — the standalone branch
  // never reaches it. Passing a lookup that would say "yes to anyone" proves
  // the owner check is what actually gates this, not an unreachable no-op.
  const wouldTrustAnyone = () => true;
  assert.equal(isActingSenderTrusted(cfg, "u-alice", wouldTrustAnyone), true);
  assert.equal(isActingSenderTrusted(cfg, "u-bob", wouldTrustAnyone), false, "wrong owner must be refused even if a membership lookup would have said yes");
});

test("isActingSenderTrusted: a standalone agent with no ownerId trusts nobody (fail closed)", () => {
  assert.equal(isActingSenderTrusted({ role: "agent" }, "u-alice", () => true), false);
});

test("isActingSenderTrusted: no userId is always refused, regardless of shape", () => {
  assert.equal(isActingSenderTrusted({ role: "team", id: "squad" }, null, () => true), false);
  assert.equal(isActingSenderTrusted({ role: "team", id: "squad" }, "", () => true), false);
  assert.equal(isActingSenderTrusted(null, "u-alice", () => true), false);
});

test("isActingSenderTrusted: a broken/unresolvable config (no team, no owner) trusts nobody", () => {
  assert.equal(isActingSenderTrusted({ role: "team-member" }, "u-alice", () => true), false);
  assert.equal(isActingSenderTrusted({}, "u-alice", () => true), false);
});

// ── personal credential lookup ───────────────────────────────────────────────

const index = [
  { id: "sys-1", scope: "system", assignedTeamIds: ["default"] },
  { id: "team-1", scope: "team", teamId: "default" },
  { id: "pers-alice", scope: "personal", userId: "u-alice" },
  { id: "pers-bob", scope: "personal", userId: "u-bob" },
];

test("findPersonalCredential: returns only the owner's personal entry", () => {
  assert.equal(findPersonalCredential(index, "u-alice").id, "pers-alice");
  assert.equal(findPersonalCredential(index, "u-bob").id, "pers-bob");
  assert.equal(findPersonalCredential(index, "u-carol"), null); // no personal entry
  assert.equal(findPersonalCredential(index, null), null);
  assert.equal(findPersonalCredential([], "u-alice"), null);
});

test("findPersonalCredential: isUsable hook rejects an underscoped credential (D5)", () => {
  const scoped = [{ id: "pers-alice", scope: "personal", userId: "u-alice", scopes: ["read"] }];
  const needsRepo = (e) => Array.isArray(e.scopes) && e.scopes.includes("repo");
  assert.equal(findPersonalCredential(scoped, "u-alice", needsRepo), null);
  assert.equal(
    findPersonalCredential(
      [{ id: "ok", scope: "personal", userId: "u-alice", scopes: ["repo"] }],
      "u-alice",
      needsRepo,
    ).id,
    "ok",
  );
});

// ── the core decision ────────────────────────────────────────────────────────

// AC8: no owner → shared credential, exactly as today, never a refusal. This is
// the branch every existing agent takes until ownerId population lands.
test("resolveCredential: no owner → shared, no refusal, for writes AND reads (AC8)", () => {
  for (const operation of ["pr", "push-https", "clone", "poll"]) {
    assert.deepEqual(
      resolveCredential({ operation, ownerId: null, sharedCredentialId: "team-1" }),
      { tier: "shared", credentialId: "team-1" },
      operation,
    );
  }
});

// AC1: owner with a usable personal credential → personal, for attributed writes.
test("resolveCredential: owner + usable personal → personal (AC1)", () => {
  const r = resolveCredential({
    operation: "pr",
    ownerId: "u-alice",
    personalCredential: { id: "pers-alice" },
    sharedCredentialId: "team-1",
  });
  assert.deepEqual(r, { tier: "personal", credentialId: "pers-alice" });
});

// AC2 + AC5 + D5: owner, attributed write, personal credential PRESENT but
// unusable → refuse, no fallback.
//
// #2077 narrowed this: presence is now what arms the refusal, not the owner. An
// owner who has a personal credential must never have an attributed write
// re-attributed to a shared identity — but an owner who never opted into the
// personal tier is not protected by taking their agents offline. See the
// sibling test below and the header comment in credential-resolution.js.
test("resolveCredential: owner + attributed write + unusable personal → refuse (AC2/AC5)", () => {
  const r = resolveCredential({
    operation: "pr",
    ownerId: "u-alice",
    personalCredential: null,
    personalCredentialPresent: true,
    sharedCredentialId: "team-1",
  });
  assert.ok(r.refuse, "must refuse");
  assert.equal(r.refuse.code, "personal-credential-required");
  assert.match(r.refuse.message, /u-alice/); // names the owner (AC5)
  assert.match(r.refuse.message, /NOT fall back/i); // states no team/system fallback
  assert.equal(r.tier, undefined);
  assert.equal(r.credentialId, undefined);
});

// #2077 AC7: an owner who has NO personal credential of this kind at all takes
// the shared credential for an attributed write, exactly as the platform does
// today. This is the branch every existing agent lands in once the D6 backfill
// stamps its `ownerId`; refusing here would stop every agent opening a PR.
test("resolveCredential: owner + attributed write + owner has no personal credential → shared (#2077 AC7)", () => {
  for (const operation of ["commit", "pr", "review", "push-https", "push-ssh"]) {
    assert.deepEqual(
      resolveCredential({
        operation,
        ownerId: "u-alice",
        personalCredential: null,
        personalCredentialPresent: false,
        sharedCredentialId: "team-1",
      }),
      { tier: "shared", credentialId: "team-1" },
      operation,
    );
  }
});

// The refusal must not be reachable by omission — a caller that forgets to
// report presence gets the safe branch, not an outage.
test("resolveCredential: an omitted personalCredentialPresent never refuses (#2077)", () => {
  assert.deepEqual(
    resolveCredential({ operation: "pr", ownerId: "u-alice", sharedCredentialId: "team-1" }),
    { tier: "shared", credentialId: "team-1" },
  );
});

// ── #2176 (epic #2166 B4): just-in-time refusal for INTERACTIVE writes ──────

test("resolveCredential: INTERACTIVE attributed write + owner has NO personal credential at all → refuse (B4 widening)", () => {
  for (const operation of ["commit", "pr", "review", "push-https", "push-ssh"]) {
    const r = resolveCredential({
      operation,
      ownerId: "u-alice",
      personalCredential: null,
      personalCredentialPresent: false,
      sharedCredentialId: "team-1",
      interactive: true,
    });
    assert.ok(r.refuse, operation);
    assert.equal(r.refuse.code, "personal-credential-required", operation);
    assert.match(r.refuse.message, /u-alice/, operation);
  }
});

test("resolveCredential: AUTONOMOUS (non-interactive) attributed write with no personal credential is UNAFFECTED — still shared, no refusal (B4 AC)", () => {
  for (const operation of ["commit", "pr", "review", "push-https", "push-ssh"]) {
    assert.deepEqual(
      resolveCredential({
        operation,
        ownerId: "u-alice",
        personalCredential: null,
        personalCredentialPresent: false,
        sharedCredentialId: "team-1",
        interactive: false, // the default — an explicit autonomous run
      }),
      { tier: "shared", credentialId: "team-1" },
      operation,
    );
  }
});

test("resolveCredential: interactive does not widen an already-usable personal credential (AC1 unaffected)", () => {
  const r = resolveCredential({
    operation: "pr",
    ownerId: "u-alice",
    personalCredential: { id: "pers-alice" },
    sharedCredentialId: "team-1",
    interactive: true,
  });
  assert.deepEqual(r, { tier: "personal", credentialId: "pers-alice" });
});

test("resolveCredential: interactive read/poll still falls back to shared even with no personal credential (B4 AC — reads via baseline)", () => {
  for (const operation of ["clone", "poll", "probe"]) {
    assert.deepEqual(
      resolveCredential({
        operation,
        ownerId: "u-alice",
        personalCredential: null,
        personalCredentialPresent: false,
        sharedCredentialId: "team-1",
        interactive: true,
      }),
      { tier: "shared", credentialId: "team-1" },
      operation,
    );
  }
});

test("resolveCredential: interactive + present-but-unusable still refuses with the ordinary (non-orphan) message", () => {
  const r = resolveCredential({
    operation: "pr",
    ownerId: "u-alice",
    personalCredential: null,
    personalCredentialPresent: true,
    sharedCredentialId: "team-1",
    interactive: true,
  });
  assert.ok(r.refuse);
  assert.equal(r.refuse.code, "personal-credential-required");
});

// AC2 second half / AC7: owner, no personal, but a SHARED-eligible op → shared, no refusal.
test("resolveCredential: owner + read/poll + no personal → shared, no refusal (AC2/AC7)", () => {
  for (const operation of ["clone", "poll", "probe"]) {
    assert.deepEqual(
      resolveCredential({
        operation,
        ownerId: "u-alice",
        personalCredential: null,
        sharedCredentialId: "team-1",
      }),
      { tier: "shared", credentialId: "team-1" },
      operation,
    );
  }
});

// The personal credential is preferred even when a shared one exists (AC1 does
// not fall through to shared just because a shared credential is available).
test("resolveCredential: personal beats an available shared credential (AC1)", () => {
  const r = resolveCredential({
    operation: "push-https",
    ownerId: "u-bob",
    personalCredential: { id: "pers-bob" },
    sharedCredentialId: "sys-1",
  });
  assert.deepEqual(r, { tier: "personal", credentialId: "pers-bob" });
});

// SSH kind surfaces in the refusal message (used for the SSH-transport path).
test("resolveCredential: refusal message names the credential kind", () => {
  const r = resolveCredential({
    operation: "push-https",
    ownerId: "u-alice",
    personalCredential: null,
    personalCredentialPresent: true,
    kind: "SSH key",
  });
  assert.match(r.refuse.message, /personal SSH key/);
});

// ── findPersonalCredentialState (#2077) ──────────────────────────────────────
// The lookup that keeps "the owner has none" apart from "the owner's is
// unusable" — the distinction the refusal switch now turns on.

test("findPersonalCredentialState: absent → not present, no entry", () => {
  const index = [{ id: "team-1", scope: "team", teamId: "t" }];
  // `orphaned` (#2138 AC6) is a third, independent axis: "the credential is
  // there but its owner is not a live user". It is false in every state below.
  assert.deepEqual(findPersonalCredentialState(index, "u-alice"), { entry: null, present: false, orphaned: false });
  // No owner and a non-array index are both "not present".
  assert.deepEqual(findPersonalCredentialState(index, null), { entry: null, present: false, orphaned: false });
  assert.deepEqual(findPersonalCredentialState(null, "u-alice"), { entry: null, present: false, orphaned: false });
});

test("findPersonalCredentialState: usable → present with the entry", () => {
  const index = [{ id: "pers-alice", scope: "personal", userId: "u-alice" }];
  const s = findPersonalCredentialState(index, "u-alice");
  assert.equal(s.present, true);
  assert.equal(s.entry.id, "pers-alice");
});

test("findPersonalCredentialState: present but rejected by isUsable → present, no entry", () => {
  const index = [{ id: "pers-alice", scope: "personal", userId: "u-alice", underscoped: true }];
  assert.deepEqual(
    findPersonalCredentialState(index, "u-alice", (e) => !e.underscoped),
    // Underscoped, not orphaned — the two refusals have different remedies.
    { entry: null, present: true, orphaned: false },
  );
});

test("findPersonalCredentialState: a usable entry later in the index still wins", () => {
  const index = [
    { id: "bad", scope: "personal", userId: "u-alice", underscoped: true },
    { id: "good", scope: "personal", userId: "u-alice" },
  ];
  const s = findPersonalCredentialState(index, "u-alice", (e) => !e.underscoped);
  assert.equal(s.present, true);
  assert.equal(s.entry.id, "good");
});

test("findPersonalCredential stays the usable-entry-or-null shape it always was", () => {
  const index = [{ id: "pers-alice", scope: "personal", userId: "u-alice", underscoped: true }];
  assert.equal(findPersonalCredential(index, "u-alice", (e) => !e.underscoped), null);
  assert.equal(findPersonalCredential(index, "u-alice").id, "pers-alice");
});

// ── owner-scoped respawn selection (#1570 Phase 4, AC1/AC2/AC4) ──────────────

test("selectAgentIdsForOwner: returns only the owner's agents (AC1)", () => {
  const agents = [
    { id: "a1", cfg: { role: "agent", ownerId: "u-alice" } },
    { id: "a2", cfg: { role: "agent", ownerId: "u-bob" } },   // other human — untouched
    { id: "a3", cfg: { role: "agent" } },                      // no owner — untouched (AC8 gate)
    { id: "a4", cfg: { role: "agent", ownerId: "u-alice" } },
  ];
  assert.deepEqual(selectAgentIdsForOwner(agents, "u-alice"), ["a1", "a4"]);
});

test("selectAgentIdsForOwner: a team-member is selected via its parent team's owner (AC4)", () => {
  const parents = { squad: { role: "team", ownerId: "u-alice" } };
  const load = (id) => parents[id] || null;
  const agents = [
    { id: "squad-dev", cfg: { role: "team-member", parentTeamId: "squad" } },
    { id: "squad-rev", cfg: { role: "team-member", parentTeamId: "squad" } },
    { id: "other-dev", cfg: { role: "team-member", parentTeamId: "other" } }, // parent unknown → no owner
  ];
  assert.deepEqual(selectAgentIdsForOwner(agents, "u-alice", load), ["squad-dev", "squad-rev"]);
});

test("selectAgentIdsForOwner: null/empty owner or a corrupt config selects nothing", () => {
  const agents = [
    { id: "a1", cfg: { role: "agent", ownerId: "u-alice" } },
    { id: "a2", cfg: null }, // corrupt/unreadable — skipped, never throws
  ];
  assert.deepEqual(selectAgentIdsForOwner(agents, null), []);
  assert.deepEqual(selectAgentIdsForOwner(agents, ""), []);
  assert.deepEqual(selectAgentIdsForOwner(agents, "u-alice"), ["a1"]);
});

// ── offboarding credential selection (#1571 Phase 5, AC1/AC3) ────────────────

test("selectPersonalCredentialIds: only the owner's PERSONAL entries (AC1)", () => {
  assert.deepEqual(selectPersonalCredentialIds(index, "u-alice"), ["pers-alice"]);
  assert.deepEqual(selectPersonalCredentialIds(index, "u-bob"), ["pers-bob"]);
  assert.deepEqual(selectPersonalCredentialIds(index, "u-carol"), []); // owns nothing
});

test("selectPersonalCredentialIds: a team/system entry is never selected even if userId coincides (AC3)", () => {
  const mixed = [
    { id: "sys-1", scope: "system", userId: "u-alice" },     // shared — never deleted
    { id: "team-1", scope: "team", userId: "u-alice" },      // shared — never deleted
    { id: "pers-a", scope: "personal", userId: "u-alice" },  // the only one offboarding deletes
  ];
  assert.deepEqual(selectPersonalCredentialIds(mixed, "u-alice"), ["pers-a"]);
});

test("selectPersonalCredentialIds: multiple personal creds of one owner all selected", () => {
  const many = [
    { id: "p1", scope: "personal", userId: "u-alice" },
    { id: "p2", scope: "personal", userId: "u-alice" },
    { id: "p3", scope: "personal", userId: "u-bob" },
  ];
  assert.deepEqual(selectPersonalCredentialIds(many, "u-alice"), ["p1", "p2"]);
});

test("selectPersonalCredentialIds: null/empty owner, non-array, or entry without id → []", () => {
  assert.deepEqual(selectPersonalCredentialIds(index, null), []);
  assert.deepEqual(selectPersonalCredentialIds(index, ""), []);
  assert.deepEqual(selectPersonalCredentialIds(null, "u-alice"), []);
  assert.deepEqual(selectPersonalCredentialIds([{ scope: "personal", userId: "u-alice" }], "u-alice"), []);
});

// ── #2138 AC6: a credential whose owner no longer exists must not resolve ────
//
// The bug this closes: from 2026-08-11 to the #2135 fix, deleting a user never
// ran `offboardOwner`, so their personal PAT stayed on disk. `scope` + `userId`
// still matched here, the entry was usable, and the departed person's agents
// kept pushing under it — with NO refusal, because the refusal branch needs a
// credential that is present but UNUSABLE and this one worked fine.
//
// The gate is the containment layer: it does not need the offboarding path to
// have succeeded, which is exactly why it is worth having.

const {
  buildLiveUserGate,
  selectOrphanedOwnerIds,
  buildOrphanRefusal,
} = require("./credential-resolution");

const LIVE = buildLiveUserGate([{ id: "u-alice" }, { id: "u-bob" }]);

test("buildLiveUserGate: an empty or unreadable user list is UNKNOWN, never 'nobody is live'", () => {
  // teams-store's readArray answers [] for a malformed file exactly as it does
  // for an empty one, and a booted stack always has the seeded System Admin —
  // so treating [] as authoritative would refuse every attributed write at once.
  for (const input of [[], null, undefined, "not-an-array", [{ id: "" }, { noId: 1 }]]) {
    const gate = buildLiveUserGate(input);
    assert.equal(gate.known, false, JSON.stringify(input));
    assert.equal(gate.isLive("u-anyone"), true, "an unknown gate must answer 'live' for everyone");
  }
  assert.equal(LIVE.known, true);
  assert.equal(LIVE.isLive("u-alice"), true);
  assert.equal(LIVE.isLive("u-ghost"), false);
});

test("findPersonalCredentialState: an orphaned credential is present-but-unusable", () => {
  const orphaned = [{ id: "pers-ghost", scope: "personal", userId: "u-ghost" }];

  const state = findPersonalCredentialState(orphaned, "u-ghost", undefined, LIVE);
  assert.equal(state.entry, null, "an orphan must never be handed back as usable");
  assert.equal(state.present, true, "…but it IS present — that is what makes the write refuse");
  assert.equal(state.orphaned, true);

  // A live owner is untouched.
  const alive = findPersonalCredentialState(index, "u-alice", undefined, LIVE);
  assert.equal(alive.entry.id, "pers-alice");
  assert.equal(alive.orphaned, false);
});

test("findPersonalCredentialState: the owner's absence outranks isUsable", () => {
  // The disqualifier is that nobody is behind the credential, not its scopes —
  // so an `isUsable` that says yes must not resurrect it.
  const orphaned = [{ id: "pers-ghost", scope: "personal", userId: "u-ghost", scopes: ["repo"] }];
  const alwaysUsable = () => true;
  const state = findPersonalCredentialState(orphaned, "u-ghost", alwaysUsable, LIVE);
  assert.equal(state.entry, null);
  assert.equal(state.orphaned, true);
});

test("findPersonalCredentialState: NO gate is pre-#2138 behaviour, byte for byte", () => {
  // The fail-open direction, stated as a test: an unreadable user index must
  // not turn every personal credential on the installation into a refusal.
  const orphaned = [{ id: "pers-ghost", scope: "personal", userId: "u-ghost" }];
  for (const gate of [undefined, null, buildLiveUserGate([]), { known: false }]) {
    const state = findPersonalCredentialState(orphaned, "u-ghost", undefined, gate);
    assert.equal(state.entry?.id, "pers-ghost", `gate=${JSON.stringify(gate)}`);
    assert.equal(state.present, true);
    assert.equal(state.orphaned, false);
  }
});

test("resolveCredential: an orphaned credential REFUSES an attributed write", () => {
  const decision = resolveCredential({
    operation: "pr",
    ownerId: "u-ghost",
    personalCredential: null,
    personalCredentialPresent: true,
    personalCredentialOrphaned: true,
    sharedCredentialId: "team-1",
  });
  assert.ok(decision.refuse, "the departed human's PAT must not silently keep working");
  assert.equal(decision.refuse.code, "owner-not-a-live-user");
  assert.notEqual(decision.credentialId, "team-1");
  // The remedy differs from the ordinary refusal, so the message must too:
  // nobody can "add a personal token" for a user record that is gone.
  assert.doesNotMatch(decision.refuse.message, /My Credentials page/);
  assert.match(decision.refuse.message, /revoke it at GitHub/i);
  assert.notEqual(buildOrphanRefusal("u-ghost", "GitHub token").code, "personal-credential-required");
});

test("resolveCredential: an orphan still lets a READ take the shared credential", () => {
  // Refuse-on-missing is per operation class. A clone/poll is shared-eligible,
  // and refusing it would take a whole flow offline over a stale index entry.
  for (const op of ["clone", "poll", "probe"]) {
    const decision = resolveCredential({
      operation: op,
      ownerId: "u-ghost",
      personalCredentialPresent: true,
      personalCredentialOrphaned: true,
      sharedCredentialId: "team-1",
    });
    assert.equal(decision.refuse, undefined, op);
    assert.equal(decision.tier, "shared", op);
    assert.equal(decision.credentialId, "team-1", op);
  }
});

// ── #2138 AC1/AC2: which owners still need their offboarding replayed ────────

test("selectOrphanedOwnerIds: finds deleted owners holding credentials or agents", () => {
  const keys = [
    { id: "k-alice", scope: "personal", userId: "u-alice" },   // live → not selected
    { id: "k-ghost", scope: "personal", userId: "u-ghost" },   // orphan
    { id: "k-team", scope: "team", teamId: "default", userId: "u-ghost" }, // not personal
  ];
  const tokens = [{ id: "t-ghost2", scope: "personal", userId: "u-ghost2" }];
  const configs = { squad: { role: "team", ownerId: "u-ghost3" } };
  const agents = [
    { id: "squad", cfg: configs.squad },
    { id: "squad-dev", cfg: { role: "team-member", parentTeamId: "squad" } },
    { id: "solo", cfg: { role: "agent", ownerId: "u-alice" } },
  ];

  const ids = selectOrphanedOwnerIds({
    credentialIndexes: [keys, tokens],
    agents,
    loadAgentConfig: (id) => configs[id] || null,
    liveUsers: LIVE,
  });

  assert.deepEqual(ids, ["u-ghost", "u-ghost2", "u-ghost3"], "credential owners first, then agent owners, deduped");
});

test("selectOrphanedOwnerIds: a team/system credential is never a reason to sweep", () => {
  const ids = selectOrphanedOwnerIds({
    credentialIndexes: [[{ id: "sys-1", scope: "system", userId: "u-ghost" }]],
    liveUsers: LIVE,
  });
  assert.deepEqual(ids, [], "shared infrastructure is not offboarded with a person (#1571 AC3)");
});

test("selectOrphanedOwnerIds: an UNKNOWN live-user gate sweeps nothing", () => {
  // The dangerous direction. With nobody known to be live, "not a live user" is
  // true of everyone and a sweep on that belief drains the whole installation.
  const keys = [{ id: "k-alice", scope: "personal", userId: "u-alice" }];
  const agents = [{ id: "solo", cfg: { role: "agent", ownerId: "u-alice" } }];
  for (const gate of [undefined, null, buildLiveUserGate([]), { known: false, isLive: () => false }]) {
    assert.deepEqual(
      selectOrphanedOwnerIds({ credentialIndexes: [keys], agents, liveUsers: gate }),
      [],
      `gate=${JSON.stringify(gate)}`,
    );
  }
});
