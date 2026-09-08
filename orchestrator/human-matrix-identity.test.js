"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  HUMAN_LOCALPART_PREFIX,
  HUMAN_LOCALPART_RE,
  humanMatrixLocalpart,
  humanMatrixUserId,
  isHumanMatrixLocalpart,
  isHumanMatrixUserId,
  isServiceMatrixUserId,
  isReservedHumanLocalpart,
  normalizeSubject,
} = require("./human-matrix-identity");

// ---- determinism & stability ------------------------------------------------

test("the same subject always maps to the same localpart", () => {
  const a = humanMatrixLocalpart("alice@corp.example");
  const b = humanMatrixLocalpart("alice@corp.example");
  assert.equal(a, b);
});

test("localpart is derived from the subject, so a re-created user record keeps their Matrix account and rooms", () => {
  // The record id is a fresh randomUUID on every re-creation; the subject is
  // not. Deriving from the subject is what makes off-board → re-onboard keep
  // the same @u-…:local account (and therefore its rooms and history).
  const first = humanMatrixLocalpart("alice@corp.example");
  const afterRecreate = humanMatrixLocalpart("alice@corp.example");
  assert.equal(first, afterRecreate);
});

test("subject normalisation matches the user store's case-insensitive, trimmed lookup", () => {
  // teams-store.js getUserBySubject compares `subject.trim().toLowerCase()`,
  // so two spellings the store considers ONE user must not get TWO accounts.
  const canonical = humanMatrixLocalpart("alice@corp.example");
  assert.equal(humanMatrixLocalpart("  Alice@Corp.Example  "), canonical);
  assert.equal(humanMatrixLocalpart("ALICE@CORP.EXAMPLE"), canonical);
});

test("different subjects map to different localparts", () => {
  assert.notEqual(
    humanMatrixLocalpart("alice@corp.example"),
    humanMatrixLocalpart("bob@corp.example"),
  );
});

test("normalizeSubject is exported and trims + lowercases", () => {
  assert.equal(normalizeSubject("  Bob@X.COM "), "bob@x.com");
  assert.equal(normalizeSubject(undefined), "");
  assert.equal(normalizeSubject(42), "");
});

// ---- shape ------------------------------------------------------------------

test("localpart has the reserved prefix and a fixed 16 hex-char digest", () => {
  const lp = humanMatrixLocalpart("alice@corp.example");
  assert.ok(lp.startsWith(HUMAN_LOCALPART_PREFIX), `${lp} should start with the prefix`);
  assert.match(lp, /^u-[0-9a-f]{16}$/);
  assert.equal(lp.length, 18);
  assert.ok(HUMAN_LOCALPART_RE.test(lp));
});

test("localpart carries no personal data — the subject does not appear in it", () => {
  // The localpart is world-readable to every member of every room the human
  // joins, so an email must not survive into it.
  const lp = humanMatrixLocalpart("alice.example@corp.example");
  assert.ok(!lp.includes("alice"));
  assert.ok(!lp.includes("@"));
  assert.ok(!lp.includes("."));
});

test("humanMatrixUserId builds a full @localpart:server id, defaulting to this stack's server name", () => {
  const lp = humanMatrixLocalpart("alice@corp.example");
  assert.equal(humanMatrixUserId("alice@corp.example"), `@${lp}:local`);
  assert.equal(humanMatrixUserId("alice@corp.example", "example.org"), `@${lp}:example.org`);
});

// ---- fail-closed on a missing subject ---------------------------------------

test("a blank subject throws instead of minting a shared account", () => {
  // Silently deriving one localpart for every subject-less caller would put
  // several humans into the same Matrix account — the exact failure this
  // ticket exists to remove.
  for (const bad of ["", "   ", null, undefined, 0, {}]) {
    assert.throws(() => humanMatrixLocalpart(bad), /non-empty subject/);
  }
});

// ---- human vs service -------------------------------------------------------

test("isHumanMatrixLocalpart accepts only the minted shape", () => {
  assert.ok(isHumanMatrixLocalpart(humanMatrixLocalpart("alice@corp.example")));
  assert.ok(!isHumanMatrixLocalpart("admin"));
  assert.ok(!isHumanMatrixLocalpart("agent-studio-2-0-developer-6"));
  assert.ok(!isHumanMatrixLocalpart("u-payments"), "a plausible agent id must stay usable");
  assert.ok(!isHumanMatrixLocalpart("u-2"));
  assert.ok(!isHumanMatrixLocalpart("u-0123456789ABCDEF"), "uppercase is not the minted shape");
  assert.ok(!isHumanMatrixLocalpart("u-0123456789abcde"), "15 hex chars is too short");
  assert.ok(!isHumanMatrixLocalpart("u-0123456789abcdef0"), "17 hex chars is too long");
  assert.ok(!isHumanMatrixLocalpart("xu-0123456789abcdef"), "must be anchored at the start");
  assert.ok(!isHumanMatrixLocalpart("u-0123456789abcdef:local"), "must be anchored at the end");
  assert.ok(!isHumanMatrixLocalpart(undefined));
});

test("isHumanMatrixUserId reads the localpart out of a full id", () => {
  assert.ok(isHumanMatrixUserId(humanMatrixUserId("alice@corp.example")));
  assert.ok(isHumanMatrixUserId(humanMatrixUserId("alice@corp.example", "example.org")));
  assert.ok(!isHumanMatrixUserId("@admin:local"));
  assert.ok(!isHumanMatrixUserId("@agent-studio-2-0-developer-6:local"));
});

test("a malformed id is not a human id (fail closed)", () => {
  for (const bad of ["", "u-0123456789abcdef", "@u-0123456789abcdef", "@:local", null, 7]) {
    assert.ok(!isHumanMatrixUserId(bad), `${String(bad)} must not read as a human id`);
  }
});

test("the admin bot and every per-agent account are service identities", () => {
  // docs/multi-user-concept.md §2: the human/service split is what lets the
  // audit trail answer "human or machine?" for every action.
  assert.ok(isServiceMatrixUserId("@admin:local"));
  assert.ok(isServiceMatrixUserId("@agent-studio-2-0-developer-6:local"));
  assert.ok(isServiceMatrixUserId("@team-alpha.member-1:local"));
  assert.ok(!isServiceMatrixUserId(humanMatrixUserId("alice@corp.example")));
});

test("service/human is a strict partition — never both, never neither", () => {
  const ids = [
    "@admin:local",
    "@agent-x:local",
    humanMatrixUserId("alice@corp.example"),
    "garbage",
  ];
  for (const id of ids) {
    assert.notEqual(
      isHumanMatrixUserId(id),
      isServiceMatrixUserId(id),
      `${id} must be exactly one of human/service`,
    );
  }
});

// ---- the reservation --------------------------------------------------------

test("isReservedHumanLocalpart refuses exactly the minted shape and nothing wider", () => {
  // This is the predicate ensureMatrixUser uses to stop an agent id from taking
  // over a human's Matrix account. It must be narrow enough that no plausible
  // existing agent id is suddenly rejected.
  assert.ok(isReservedHumanLocalpart(humanMatrixLocalpart("alice@corp.example")));
  for (const agentId of [
    "u-payments",
    "u-team-2",
    "user-service",
    "admin",
    "team-alpha.member-1",
    "agent-studio-2-0-developer-6",
  ]) {
    assert.ok(!isReservedHumanLocalpart(agentId), `${agentId} must remain a legal agent id`);
  }
});
