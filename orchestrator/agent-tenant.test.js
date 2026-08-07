"use strict";

// Unit tests for agent → human tenant resolution + the startup realignment plan.
// Run: node --test orchestrator/agent-tenant.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveAgentTenant, planTenantBackfill } = require("./agent-tenant");

// Agent Team 'sdlc-2-0' is owned by the human team 'default'; Agent Team
// 'payments' happens to share its id with a human team (the coincidence that
// kept the pre-fix `parentTeamId || teamId` derivation looking correct).
const agents = {
  "sdlc-2-0": { id: "sdlc-2-0", role: "team", teamId: "default" },
  "sdlc-2-0-analyst": { id: "sdlc-2-0-analyst", role: "team-member", teamId: "default", parentTeamId: "sdlc-2-0" },
  "sdlc-2-0-dev": { id: "sdlc-2-0-dev", role: "team-member", teamId: "stale", parentTeamId: "sdlc-2-0" },
  payments: { id: "payments", role: "team", teamId: "payments" },
  "payments-dev": { id: "payments-dev", role: "team-member", teamId: "payments", parentTeamId: "payments" },
  standalone: { id: "standalone", role: "agent", teamId: "risk" },
};
const load = (id) => agents[id] || null;

test("a team-member resolves to its parent Agent Team's human team", () => {
  assert.equal(resolveAgentTenant(agents["sdlc-2-0-analyst"], load), "default");
  // The Agent-Team id is never the tenant.
  assert.notEqual(resolveAgentTenant(agents["sdlc-2-0-analyst"], load), "sdlc-2-0");
});

test("the parent wins over a drifted own stamp", () => {
  assert.equal(resolveAgentTenant(agents["sdlc-2-0-dev"], load), "default");
});

test("an Agent Team whose id coincides with a human team still resolves the same", () => {
  assert.equal(resolveAgentTenant(agents["payments-dev"], load), "payments");
});

test("agents without a parent use their own teamId", () => {
  assert.equal(resolveAgentTenant(agents.standalone, load), "risk");
  assert.equal(resolveAgentTenant(agents["sdlc-2-0"], load), "default");
});

test("falls back to the own stamp when the parent is missing, unstamped or unloadable", () => {
  assert.equal(resolveAgentTenant({ role: "team-member", teamId: "risk", parentTeamId: "gone" }, load), "risk");
  assert.equal(resolveAgentTenant({ role: "team-member", teamId: "risk", parentTeamId: "p" }, () => ({ role: "team" })), "risk");
  assert.equal(resolveAgentTenant({ role: "team-member", teamId: "risk", parentTeamId: "p" }, undefined), "risk");
});

test("defaults to the default team on missing input", () => {
  assert.equal(resolveAgentTenant(null, load), "default");
  assert.equal(resolveAgentTenant({ id: "x" }, load), "default");
});

test("backfill plan realigns only the drifted members", () => {
  const plan = planTenantBackfill(agents);
  assert.deepEqual(plan, [{ id: "sdlc-2-0-dev", from: "stale", to: "default" }]);
});

test("backfill plan is idempotent — a second pass over the applied state is empty", () => {
  const applied = { ...agents, "sdlc-2-0-dev": { ...agents["sdlc-2-0-dev"], teamId: "default" } };
  assert.deepEqual(planTenantBackfill(applied), []);
});

test("backfill plan skips non-members, parentless agents and unstamped parents", () => {
  const plan = planTenantBackfill({
    team: { id: "team", role: "team", teamId: "a" },
    solo: { id: "solo", role: "agent", teamId: "b" },
    orphan: { id: "orphan", role: "team-member", teamId: "b", parentTeamId: "gone" },
    unstamped: { id: "unstamped", role: "team-member", teamId: "b", parentTeamId: "bare" },
    bare: { id: "bare", role: "team" },
  });
  assert.deepEqual(plan, []);
});

test("backfill plan reports an unset stamp as null", () => {
  const plan = planTenantBackfill({
    t: { id: "t", role: "team", teamId: "a" },
    m: { id: "m", role: "team-member", parentTeamId: "t" },
  });
  assert.deepEqual(plan, [{ id: "m", from: null, to: "a" }]);
});

test("backfill plan tolerates missing / malformed input", () => {
  assert.deepEqual(planTenantBackfill(null), []);
  assert.deepEqual(planTenantBackfill({ a: null }), []);
});
