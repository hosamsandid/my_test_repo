"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { computeTeamRoster, createVerdictStore } = require("./loop-verify");

// ── computeTeamRoster ────────────────────────────────────────────────────

test("roster = other team-members under the same parentTeamId, sorted", () => {
  const configs = [
    { id: "t1-dev", role: "team-member", parentTeamId: "t1", displayName: "Dev" },
    { id: "t1-rev", role: "team-member", parentTeamId: "t1", displayName: "Reviewer" },
    { id: "t1-qa", role: "team-member", parentTeamId: "t1" },
  ];
  const r = computeTeamRoster("t1-dev", configs);
  assert.equal(r.found, true);
  assert.equal(r.teamId, "t1");
  assert.deepEqual(
    r.siblings.map((s) => s.agentId),
    ["t1-qa", "t1-rev"], // self excluded, sorted by id
  );
  // displayName falls back to id when absent
  assert.equal(r.siblings.find((s) => s.agentId === "t1-qa").displayName, "t1-qa");
  assert.equal(r.siblings.find((s) => s.agentId === "t1-rev").displayName, "Reviewer");
});

test("siblings match parentTeamId (the squad), not the broader human teamId", () => {
  const configs = [
    { id: "a", role: "team-member", parentTeamId: "squad-1", teamId: "default" },
    { id: "b", role: "team-member", parentTeamId: "squad-2", teamId: "default" },
  ];
  const r = computeTeamRoster("a", configs);
  assert.deepEqual(r.siblings.map((s) => s.agentId), []); // different squad
});

test("the team agent itself and standalone agents are not siblings", () => {
  const configs = [
    { id: "team", role: "team", parentTeamId: "team" },
    { id: "team-dev", role: "team-member", parentTeamId: "team" },
    { id: "team-rev", role: "team-member", parentTeamId: "team" },
    { id: "loner", role: "agent" },
  ];
  const r = computeTeamRoster("team-dev", configs);
  assert.deepEqual(r.siblings.map((s) => s.agentId), ["team-rev"]);
});

test("standalone agent (no parentTeamId) has no siblings", () => {
  const configs = [
    { id: "solo", role: "agent" },
    { id: "other", role: "team-member", parentTeamId: "t1" },
  ];
  const r = computeTeamRoster("solo", configs);
  assert.equal(r.found, true);
  assert.equal(r.teamId, null);
  assert.deepEqual(r.siblings, []);
});

test("unknown agent → found:false, empty roster", () => {
  const r = computeTeamRoster("ghost", [{ id: "x", role: "team-member", parentTeamId: "t" }]);
  assert.equal(r.found, false);
  assert.deepEqual(r.siblings, []);
});

test("non-array configs are tolerated", () => {
  assert.deepEqual(computeTeamRoster("a", null), { found: false, teamId: null, siblings: [] });
});

// ── createVerdictStore ───────────────────────────────────────────────────

test("verdict round-trip: set then get", () => {
  const store = createVerdictStore();
  assert.deepEqual(store.get("tok"), { found: false });
  store.set("tok", true, "all green");
  assert.deepEqual(store.get("tok"), { found: true, passed: true, output: "all green" });
});

test("verdict coerces types (passed→bool, missing output→'')", () => {
  const store = createVerdictStore();
  store.set("t", 0, undefined);
  assert.deepEqual(store.get("t"), { found: true, passed: false, output: "" });
});

test("set requires a token", () => {
  const store = createVerdictStore();
  assert.throws(() => store.set("", true, "x"), /token required/);
});

test("verdicts older than the TTL are pruned", () => {
  let clock = 1000;
  const store = createVerdictStore({ ttlMs: 100, now: () => clock });
  store.set("old", true, "x");
  assert.equal(store.get("old").found, true);
  clock = 1201; // > 100ms past the write
  assert.deepEqual(store.get("old"), { found: false });
  assert.equal(store.size(), 0);
});
