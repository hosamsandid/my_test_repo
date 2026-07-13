"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { effectiveSkills, hasSkillGrant, migrateSkillGrant, planSkillSync } = require("./skill-grants");

// ---- effectiveSkills --------------------------------------------------------

test("standalone / orchestrator / team agents use their own skills[]", () => {
  assert.deepEqual(effectiveSkills({ role: "agent", skills: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(effectiveSkills({ role: "orchestrator", skills: [] }), []);
  assert.deepEqual(effectiveSkills({ role: "team", skills: ["x"] }), ["x"]);
});

test("missing skills field resolves to empty — env never contributes", () => {
  assert.deepEqual(effectiveSkills({ role: "agent" }), []);
  assert.deepEqual(effectiveSkills(null), []);
});

test("team-member inherits the parent team's skills[]", () => {
  const configs = {
    squad: { id: "squad", role: "team", skills: ["team-skill"] },
  };
  const load = (id) => configs[id] || null;
  const member = { role: "team-member", parentTeamId: "squad" };
  assert.deepEqual(effectiveSkills(member, load), ["team-skill"]);
});

test("team-member skillsOverride replaces the team list verbatim (incl. empty)", () => {
  const load = () => ({ role: "team", skills: ["team-skill"] });
  assert.deepEqual(
    effectiveSkills({ role: "team-member", parentTeamId: "t", skillsOverride: ["own"] }, load),
    ["own"],
  );
  // Empty override is a real override — NOT a fall-through to the team list.
  assert.deepEqual(
    effectiveSkills({ role: "team-member", parentTeamId: "t", skillsOverride: [] }, load),
    [],
  );
});

test("team-member with a missing parent resolves to empty, no throw", () => {
  assert.deepEqual(effectiveSkills({ role: "team-member", parentTeamId: "gone" }, () => null), []);
  assert.deepEqual(effectiveSkills({ role: "team-member", parentTeamId: "gone" }), []);
});

test("bp-instance inherits from its parent orchestrator", () => {
  const load = (id) => (id === "orch" ? { role: "orchestrator", skills: ["ace-engineering"] } : null);
  assert.deepEqual(
    effectiveSkills({ role: "bp-instance", parentOrchestratorId: "orch" }, load),
    ["ace-engineering"],
  );
  // Its own recorded grant wins over inheritance.
  assert.deepEqual(
    effectiveSkills({ role: "bp-instance", parentOrchestratorId: "orch", skills: ["own"] }, load),
    ["own"],
  );
});

// ---- hasSkillGrant ----------------------------------------------------------

test("hasSkillGrant", () => {
  assert.equal(hasSkillGrant(["a"]), true);
  assert.equal(hasSkillGrant([]), false);
  assert.equal(hasSkillGrant(undefined), false);
});

// ---- migrateSkillGrant ------------------------------------------------------

test("migration copies env.skills onto non-member configs without a skills field", () => {
  const migrated = migrateSkillGrant({ id: "t", role: "team" }, { skills: ["cobol", "jcl"] });
  assert.deepEqual(migrated.skills, ["cobol", "jcl"]);
  // Copy, not alias.
  const env = { skills: ["a"] };
  const m2 = migrateSkillGrant({ id: "x", role: "agent" }, env);
  env.skills.push("b");
  assert.deepEqual(m2.skills, ["a"]);
});

test("migration is idempotent — an existing skills field always wins", () => {
  assert.equal(migrateSkillGrant({ role: "agent", skills: [] }, { skills: ["x"] }), null);
  assert.equal(migrateSkillGrant({ role: "team", skills: ["kept"] }, { skills: ["x"] }), null);
});

test("migration skips team-members and bp-instances (they inherit)", () => {
  assert.equal(migrateSkillGrant({ role: "team-member" }, { skills: ["x"] }), null);
  assert.equal(migrateSkillGrant({ role: "bp-instance" }, { skills: ["x"] }), null);
});

test("migration with no env / no env.skills writes an empty grant", () => {
  assert.deepEqual(migrateSkillGrant({ role: "agent" }, null).skills, []);
  assert.deepEqual(migrateSkillGrant({ role: "agent" }, {}).skills, []);
});

// ---- planSkillSync ----------------------------------------------------------

test("planSkillSync: inheriting materialized members sync, stubs skip, overrides surface", () => {
  const members = [
    { id: "t-dev", token: "x" },                                   // inherit
    { id: "t-rev", token: "x", skillsOverride: ["own"] },          // override
    { id: "t-doc" },                                               // stub
  ];
  assert.deepEqual(planSkillSync({ members, skillName: "s" }), [
    { agentId: "t-dev", action: "sync" },
    { agentId: "t-rev", action: "skip-override" },
    { agentId: "t-doc", action: "stub" },
  ]);
});

test("planSkillSync: explicit opt-in turns an override member into sync-override", () => {
  const members = [{ id: "t-rev", token: "x", skillsOverride: ["own"] }];
  assert.deepEqual(planSkillSync({ members, skillName: "s", includeMembers: ["t-rev"] }), [
    { agentId: "t-rev", action: "sync-override" },
  ]);
});

test("planSkillSync: an override that already carries the name syncs like an inheritor", () => {
  const members = [{ id: "t-rev", token: "x", skillsOverride: ["s"] }];
  assert.deepEqual(planSkillSync({ members, skillName: "s" }), [
    { agentId: "t-rev", action: "sync" },
  ]);
});
