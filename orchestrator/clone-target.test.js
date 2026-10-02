"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveCloneTarget, teamOfOneIdConflict } = require("./clone-target");

test("no target team → standalone agent, keeps the source's environment", () => {
  const sourceCfg = { environmentId: "env-1" };
  const result = resolveCloneTarget(sourceCfg, {}, null);
  assert.deepEqual(result, { role: "agent", parentTeamId: null, environmentId: "env-1" });
});

test("target team supplied → team-member, inherits the team's environment", () => {
  const sourceCfg = { environmentId: "env-1" };
  const teamCfg = { role: "team", environmentId: "env-2" };
  const result = resolveCloneTarget(sourceCfg, { parentTeamId: "team-a" }, teamCfg);
  assert.deepEqual(result, { role: "team-member", parentTeamId: "team-a", environmentId: "env-2" });
});

test("target team id does not resolve to any agent → throws not-found", () => {
  const sourceCfg = { environmentId: "env-1" };
  assert.throws(
    () => resolveCloneTarget(sourceCfg, { parentTeamId: "ghost-team" }, null),
    /Team 'ghost-team' not found/,
  );
});

test("target id resolves but isn't a team → throws", () => {
  const sourceCfg = { environmentId: "env-1" };
  const notATeam = { role: "agent", environmentId: "env-2" };
  assert.throws(
    () => resolveCloneTarget(sourceCfg, { parentTeamId: "some-agent" }, notATeam),
    /Agent 'some-agent' is not a team \(role=agent\)/,
  );
});

test("teamOfOneIdConflict names the derived team id only when it is taken (#2684)", () => {
  assert.equal(teamOfOneIdConflict("solo", () => false), null);
  assert.equal(teamOfOneIdConflict("solo", (id) => id === "solo-team"), "solo-team");
  // The agent id itself being taken is a different refusal, not this one.
  assert.equal(teamOfOneIdConflict("solo", (id) => id === "solo"), null);
});
