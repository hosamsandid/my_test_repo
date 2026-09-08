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
  for (const op of ["commit", "pr", "review", "push-https"]) {
    assert.equal(operationPrefersPersonal(op), true, op);
  }
  for (const op of ["clone", "poll", "probe", "push-ssh", "anything"]) {
    assert.equal(operationPrefersPersonal(op), false, op);
  }
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
  for (const operation of ["commit", "pr", "review", "push-https"]) {
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

// AC2 second half / AC7: owner, no personal, but a SHARED-eligible op → shared, no refusal.
test("resolveCredential: owner + read/poll + no personal → shared, no refusal (AC2/AC7)", () => {
  for (const operation of ["clone", "poll", "probe", "push-ssh"]) {
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
  assert.deepEqual(findPersonalCredentialState(index, "u-alice"), { entry: null, present: false });
  // No owner and a non-array index are both "not present".
  assert.deepEqual(findPersonalCredentialState(index, null), { entry: null, present: false });
  assert.deepEqual(findPersonalCredentialState(null, "u-alice"), { entry: null, present: false });
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
    { entry: null, present: true },
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
