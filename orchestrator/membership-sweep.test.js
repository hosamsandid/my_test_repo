"use strict";

// Unit tests for the identity-lend binding sweep planner (#2358 E1, concept
// §10 E1 / §12.6). Pure decision-level assertions — the live applier
// (sweepMembershipBindings in orchestrator.js) is a fs-bound wrapper guarded by
// a source-drift wiring test.
// Run: node --test orchestrator/membership-sweep.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  planMembershipRemovalSweep,
  buildPersonalOwnerLookup,
  indexPersonalOwners,
} = require("./membership-sweep");

// A fixture where u-alice OWNS a personal provider, PAT and SSH key, and has
// just left team "squad" (so isMemberOfTeam returns false for her).
const OWNERS = {
  "prov-alice": "u-alice",   // personal provider
  "tok-alice": "u-alice",    // personal github token
  "key-alice": "u-alice",    // personal ssh key
  "prov-bob": "u-bob",       // personal provider of a STILL-member
};
const KIND = { "prov-alice": "provider", "prov-bob": "provider", "tok-alice": "github-token", "key-alice": "ssh-key" };
const personalOwnerOf = (kind, id) => (KIND[id] === kind ? OWNERS[id] || null : null);
// Alice left; Bob is still a member of squad.
const isMemberOfTeam = (userId, teamId) => teamId === "squad" && userId === "u-bob";

test("plans nothing when no binding references a departed member's personal resource", () => {
  const plan = planMembershipRemovalSweep({
    teamId: "squad",
    environments: [{ envId: "e1", env: { llmEndpointId: "shared-team-provider", githubTokenId: "team-bot" } }],
    agents: [{ id: "a1", cfg: {} }],
    personalOwnerOf,
    isMemberOfTeam,
  });
  assert.deepEqual(plan.envResets, []);
  assert.deepEqual(plan.agentResets, []);
});

test("resets an env provider / github token / per-repo ssh key lent by the departed member", () => {
  const plan = planMembershipRemovalSweep({
    teamId: "squad",
    environments: [{
      envId: "e1",
      env: {
        llmEndpointId: "prov-alice",
        githubTokenId: "tok-alice",
        repositories: [
          { url: "git@x/a.git", sshKeyId: "key-alice" },
          { url: "git@x/b.git", sshKeyId: "team-deploy-key" },
        ],
      },
    }],
    agents: [],
    personalOwnerOf,
    isMemberOfTeam,
  });
  assert.deepEqual(plan.envResets, [
    { envId: "e1", field: "llmEndpointId", from: "prov-alice" },
    { envId: "e1", field: "githubTokenId", from: "tok-alice" },
    { envId: "e1", field: "repositories.sshKeyId", repoIndex: 0, repoUrl: "git@x/a.git", from: "key-alice" },
  ]);
  assert.deepEqual(plan.affectedEnvIds, ["e1"]);
});

test("resets a per-agent llmEndpointOverride lent by the departed member", () => {
  const plan = planMembershipRemovalSweep({
    teamId: "squad",
    environments: [],
    agents: [
      { id: "a1", cfg: { llmEndpointOverride: "prov-alice" } },
      { id: "a2", cfg: { llmEndpointOverride: "prov-bob" } },  // Bob still a member → kept
    ],
    personalOwnerOf,
    isMemberOfTeam,
  });
  assert.deepEqual(plan.agentResets, [{ agentId: "a1", field: "llmEndpointOverride", from: "prov-alice" }]);
  assert.deepEqual(plan.affectedAgentIds, ["a1"]);
});

test("the lend LIVES while the owner is still a member — a still-member's personal resource is never swept", () => {
  const plan = planMembershipRemovalSweep({
    teamId: "squad",
    environments: [{ envId: "e1", env: { llmEndpointId: "prov-bob" } }],
    agents: [{ id: "a1", cfg: { llmEndpointOverride: "prov-bob" } }],
    personalOwnerOf,
    isMemberOfTeam,
  });
  assert.deepEqual(plan.envResets, []);
  assert.deepEqual(plan.agentResets, []);
});

test("a team / system / global (non-personal) binding is never a lend — never swept", () => {
  // personalOwnerOf returns null for anything not personal, so these are inert.
  const plan = planMembershipRemovalSweep({
    teamId: "squad",
    environments: [{ envId: "e1", env: { llmEndpointId: "shared", githubTokenId: "bot", repositories: [{ url: "u", sshKeyId: "deploy" }] } }],
    agents: [{ id: "a1", cfg: { llmEndpointOverride: "global-service" } }],
    personalOwnerOf: () => null,
    isMemberOfTeam,
  });
  assert.deepEqual(plan.envResets, []);
  assert.deepEqual(plan.agentResets, []);
});

test("fails closed on missing teamId or gates", () => {
  const base = { environments: [{ envId: "e1", env: { llmEndpointId: "prov-alice" } }], agents: [], personalOwnerOf, isMemberOfTeam };
  assert.deepEqual(planMembershipRemovalSweep({ ...base, teamId: null }).envResets, []);
  assert.deepEqual(planMembershipRemovalSweep({ ...base, personalOwnerOf: null }).envResets, []);
  assert.deepEqual(planMembershipRemovalSweep({ ...base, isMemberOfTeam: null }).envResets, []);
});

// ── buildPersonalOwnerLookup / indexPersonalOwners ──────────────────────────

test("indexPersonalOwners maps only personal entries with an owner", () => {
  const map = indexPersonalOwners([
    { id: "p1", scope: "personal", userId: "u-a" },
    { id: "t1", scope: "team", teamId: "squad", userId: "u-a" }, // team → not a lend
    { id: "p2", scope: "personal" },                              // no owner → skipped
    { id: "g1", scope: "system", global: true, userId: "u-a" },   // global → not a lend
  ]);
  assert.equal(map.get("p1"), "u-a");
  assert.equal(map.has("t1"), false);
  assert.equal(map.has("p2"), false);
  assert.equal(map.has("g1"), false);
});

test("buildPersonalOwnerLookup routes each kind to its own store", () => {
  const ownerOf = buildPersonalOwnerLookup({
    providerIndex: [{ id: "prov", scope: "personal", userId: "u-prov" }],
    githubTokenIndex: [{ id: "tok", scope: "personal", userId: "u-tok" }],
    sshKeyIndex: [{ id: "key", scope: "personal", userId: "u-key" }],
  });
  assert.equal(ownerOf("provider", "prov"), "u-prov");
  assert.equal(ownerOf("github-token", "tok"), "u-tok");
  assert.equal(ownerOf("ssh-key", "key"), "u-key");
  assert.equal(ownerOf("provider", "tok"), null, "a token id is not a provider");
  assert.equal(ownerOf("provider", null), null);
  assert.equal(ownerOf("bogus-kind", "prov"), null);
});
