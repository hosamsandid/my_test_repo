"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  buildEnsureUserCommands,
  CREATE_USER_SETTLE_MS,
  FOLLOWUP_SETTLE_MS,
} = require("./matrix-admin-commands");

// ---- buildEnsureUserCommands ------------------------------------------------

test("emits create → reset-password → enable-login in order", () => {
  const cmds = buildEnsureUserCommands("cobol-dev", "s3cret");
  assert.equal(cmds.length, 3);
  assert.match(cmds[0].body, /^!admin users create-user cobol-dev s3cret$/);
  assert.match(cmds[1].body, /^!admin users reset-password @cobol-dev:local s3cret /);
  assert.match(cmds[2].body, /^!admin users enable-login @cobol-dev:local$/);
});

test("reset-password carries --convert-to-local-account so a re-created, previously deactivated account is reactivated (issue #715)", () => {
  const cmds = buildEnsureUserCommands("team-role", "pw");
  const resetPassword = cmds.find((c) => c.body.includes("reset-password"));
  assert.ok(resetPassword, "expected a reset-password command");
  assert.match(resetPassword.body, /--convert-to-local-account\b/);
  // The flag must apply to the reset-password command, not create-user.
  assert.ok(!cmds[0].body.includes("--convert-to-local-account"));
});

test("addresses the full @user:local id on reset-password and enable-login", () => {
  const cmds = buildEnsureUserCommands("agent-x", "pw");
  assert.ok(cmds[1].body.includes("@agent-x:local"));
  assert.ok(cmds[2].body.includes("@agent-x:local"));
});

test("carries the documented per-command settle delays", () => {
  const cmds = buildEnsureUserCommands("u", "p");
  assert.equal(cmds[0].delayMs, CREATE_USER_SETTLE_MS);
  assert.equal(cmds[1].delayMs, FOLLOWUP_SETTLE_MS);
  assert.equal(cmds[2].delayMs, FOLLOWUP_SETTLE_MS);
  for (const c of cmds) assert.equal(typeof c.delayMs, "number");
});

test("password and username are interpolated verbatim (no escaping surprises)", () => {
  const cmds = buildEnsureUserCommands("my-agent", "agent-my-agent-1699999999999");
  assert.ok(cmds[0].body.endsWith("create-user my-agent agent-my-agent-1699999999999"));
  assert.ok(cmds[1].body.includes("agent-my-agent-1699999999999 --convert-to-local-account"));
});
