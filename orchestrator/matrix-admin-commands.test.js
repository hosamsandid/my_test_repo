"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  buildEnsureUserCommands,
  buildReactivateCommands,
  CREATE_USER_SETTLE_MS,
  FOLLOWUP_SETTLE_MS,
} = require("./matrix-admin-commands");

// ---- buildEnsureUserCommands ------------------------------------------------

test("emits create → reset-password → enable-login in order", () => {
  const cmds = buildEnsureUserCommands("cobol-dev", "s3cret");
  assert.equal(cmds.length, 3);
  assert.match(cmds[0].body, /^!admin users create-user cobol-dev s3cret$/);
  assert.match(cmds[1].body, /^!admin users reset-password @cobol-dev:local s3cret$/);
  assert.match(cmds[2].body, /^!admin users enable-login @cobol-dev:local$/);
});

test("reset-password is a plain reset (no flags) so it works on the current Continuwuity, which rejects --convert-to-local-account and reactivates a deactivated account via plain reset-password (issue #715)", () => {
  const cmds = buildEnsureUserCommands("team-role", "pw");
  const resetPassword = cmds.find((c) => c.body.includes("reset-password"));
  assert.ok(resetPassword, "expected a reset-password command");
  // The current Continuwuity build rejects the flag ("unexpected argument"),
  // which silently defeated the reset — so it must NOT be present.
  assert.ok(!resetPassword.body.includes("--convert-to-local-account"));
  assert.match(resetPassword.body, /^!admin users reset-password @team-role:local pw$/);
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
  assert.ok(cmds[1].body.endsWith("reset-password @my-agent:local agent-my-agent-1699999999999"));
});

// ---- buildReactivateCommands (issue #1386) ----------------------------------

test("reactivate omits create-user and re-issues only the flag-clearing commands", () => {
  const cmds = buildReactivateCommands("cobol-dev", "s3cret");
  assert.ok(
    !cmds.some((c) => c.body.includes("create-user")),
    "reactivation must NOT re-create the (already-existing) account"
  );
  // Plain reset-password (works on the current build) → flag variant (for a
  // build that requires it) → enable-login.
  assert.equal(cmds.length, 3);
  assert.match(cmds[0].body, /^!admin users reset-password @cobol-dev:local s3cret$/);
  assert.match(
    cmds[1].body,
    /^!admin users reset-password @cobol-dev:local s3cret --convert-to-local-account$/
  );
  assert.match(cmds[2].body, /^!admin users enable-login @cobol-dev:local$/);
});

test("reactivate sends the PLAIN reset-password before the --convert-to-local-account variant", () => {
  // Order matters: the plain reset already reactivates + sets the password on
  // the build we run, so even if the flag variant is rejected as an "unexpected
  // argument", the account is already correct.
  const cmds = buildReactivateCommands("agent-x", "pw");
  const plainIdx = cmds.findIndex(
    (c) => c.body === "!admin users reset-password @agent-x:local pw"
  );
  const flagIdx = cmds.findIndex((c) => c.body.includes("--convert-to-local-account"));
  assert.ok(plainIdx >= 0 && flagIdx >= 0);
  assert.ok(plainIdx < flagIdx, "plain reset-password must precede the flag variant");
});

test("reactivate carries the follow-up settle delay on every command", () => {
  const cmds = buildReactivateCommands("u", "p");
  for (const c of cmds) {
    assert.equal(c.delayMs, FOLLOWUP_SETTLE_MS);
    assert.equal(typeof c.delayMs, "number");
  }
});

test("deactivate → re-create same id → login: the re-creation reactivates the deactivated account", () => {
  // Reproduces the issue #1386 scenario as a command-sequence assertion. The
  // account was deactivated on delete (`!admin users deactivate @agent:local`);
  // re-creating with the same id runs the ensure sequence, and on a lingering
  // deactivated flag the recovery path re-issues the reactivation commands.
  const id = "team-role";
  const password = `agent-${id}-1700000000000`;

  const ensure = buildEnsureUserCommands(id, password);
  // The ensure sequence's plain reset-password is the primary reactivation.
  assert.ok(
    ensure.some((c) => c.body === `!admin users reset-password @${id}:local ${password}`),
    "ensure must attempt to reactivate via plain reset-password"
  );

  const reactivate = buildReactivateCommands(id, password);
  // The recovery path re-issues reactivation without re-creating the user.
  assert.ok(reactivate.every((c) => !c.body.includes("create-user")));
  assert.ok(
    reactivate.some((c) => c.body === `!admin users reset-password @${id}:local ${password}`),
    "recovery must re-issue plain reset-password to clear a late-landed deactivate"
  );
});
