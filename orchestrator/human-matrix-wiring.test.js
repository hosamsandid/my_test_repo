"use strict";

// Wiring guard for the per-human Matrix identity (#1458).
//
// `orchestrator.js` is a monolith with no exports that starts a service on
// require, so the wiring it carries cannot be unit-tested by calling it (the
// #651 convention: pure logic moves to a sibling module — that is
// `human-matrix-identity.js` / `human-matrix-store.js`, both covered by their
// own suites — and what is left is asserted against the source text).
//
// These are drift guards, not behaviour tests: each one pins a property that a
// later refactor could silently drop. Every assertion below was proved by
// mutation (make the change, watch this file fail, revert).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8");

// Slice out one `async function <name>(…) { … }` body, so an assertion about
// "inside ensureMatrixUser" cannot be satisfied by an identical-looking line
// somewhere else in the 13k-line file.
function functionBody(name) {
  const start = SRC.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `expected an async function ${name} in orchestrator.js`);
  // Functions in this file are top-level, so the first line that is exactly a
  // closing brace in column 0 ends the body.
  const end = SRC.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return SRC.slice(start, end);
}

// ---- the reservation is enforced at the single choke point ------------------

test("ensureMatrixUser refuses a reserved human localpart before sending any admin command", () => {
  const body = functionBody("ensureMatrixUser");

  const guardAt = body.indexOf("isReservedHumanLocalpart");
  assert.notEqual(guardAt, -1, "ensureMatrixUser must consult isReservedHumanLocalpart");

  const sendAt = body.indexOf("buildEnsureUserCommands");
  assert.notEqual(sendAt, -1, "ensureMatrixUser must still fire the admin-room commands");

  // Order is the security property: a guard that ran after the commands were
  // sent would have already created the account it was meant to refuse.
  assert.ok(
    guardAt < sendAt,
    "the reservation guard must run BEFORE the create-user commands are sent",
  );
  assert.match(body, /throw new Error\(/, "a reserved localpart must throw, not warn");
});

test("ensureMatrixUser is the only place the reservation could be bypassed, and exactly one caller opts out", () => {
  // `allowHumanLocalpart: true` is the opt-out. If a second call site ever
  // acquires it, an agent-creation path could mint a human account again.
  const optOuts = SRC.match(/allowHumanLocalpart:\s*true/g) || [];
  assert.equal(
    optOuts.length,
    1,
    `exactly one caller may opt out of the reservation, found ${optOuts.length}`,
  );

  // …and that one caller is the human-provisioning function.
  const humanBody = functionBody("ensureHumanMatrixIdentity");
  assert.match(humanBody, /allowHumanLocalpart:\s*true/);
});

test("every agent-side ensureMatrixUser call site keeps the reservation on", () => {
  // Anti-vacuity: the agent/team/member call sites really do exist and really
  // do go through the guarded function, so the guard above is not protecting an
  // empty set.
  const calls = SRC.match(/ensureMatrixUser\([^)]*\)/g) || [];
  const callSites = calls.filter(c => !c.startsWith("ensureMatrixUser(adminClient, username"));
  assert.ok(callSites.length >= 7, `expected the known agent call sites, found ${callSites.length}`);
  const optedOut = callSites.filter(c => c.includes("allowHumanLocalpart"));
  assert.equal(optedOut.length, 1, "only the human path may opt out");
});

// ---- provisioning is wired to user creation --------------------------------

test("creating a user record provisions that human's Matrix identity", () => {
  // `orchestratorSingleton`, not `orchestrator` — see #2135. This assertion
  // pinned the buggy identifier, which is half of why the ReferenceError
  // survived review: the guard read the wrong name back and agreed with itself.
  assert.match(
    SRC,
    /const created = teamsStore\.createUser\(body\);[\s\S]{0,2000}?provisionHumanMatrixIdentityInBackground\(\s*orchestratorSingleton \? orchestratorSingleton\.adminClient : null, created\)/,
    "POST /internal/admin/users must provision the new human's Matrix identity",
  );
});

test("provisioning never blocks or fails the user creation it hangs off", () => {
  // The admin-room command sequence sleeps ~5s; a homeserver hiccup must not
  // turn a successful user creation into an error the operator sees.
  const src = SRC.slice(SRC.indexOf("function provisionHumanMatrixIdentityInBackground"));
  assert.match(src.slice(0, 600), /\.catch\(/, "the background provisioning must swallow its errors");
  assert.ok(
    !/await\s+provisionHumanMatrixIdentityInBackground/.test(SRC),
    "the create path must not await provisioning",
  );
});

// ---- de-provisioning is wired to user deletion ------------------------------

test("deleting a user retires their Matrix account before the record goes away", () => {
  // The anchor is an `indexOf` LITERAL: after a rename it returns -1, `slice(-1)`
  // yields the file's last character, and every assertion below passes
  // vacuously against a one-character string. So assert the anchor was FOUND
  // and the slice is long enough to contain what we are about to look for
  // (#2135 AC6) — the rename from `orchestrator.` to `orchestratorSingleton.`
  // is exactly the event this guard has to survive rather than sleep through.
  //
  // #2138 narrowed the anchor to the CALL alone: the assignment around it now
  // wraps the summary (`{ ok: true, ...(await …) }`) so the delete route can
  // report a degraded offboarding instead of a bare `null`. The call itself is
  // the thing this guard is anchored on, and it is still unique in the file.
  const anchorAt = SRC.indexOf("orchestratorSingleton.offboardOwner(resourceId)");
  assert.notEqual(anchorAt, -1, "expected the delete branch's offboarding call as the slice anchor");

  // 3000, widened from 2000 by #2138: the AC5 degradation reporting sits
  // between the offboarding call and `deleteUser`, which pushed the latter to
  // ~1998 chars — i.e. straddling the old window, where `indexOf` answers -1
  // and this guard reports "the delete branch must still delete the user" for
  // a route that plainly does. Keep it comfortably ahead of the real distance.
  const deleteBranch = SRC.slice(anchorAt).slice(0, 3000);
  assert.ok(deleteBranch.length > 500, "the delete-branch slice must not be empty or truncated");

  const deprovisionAt = deleteBranch.indexOf("deprovisionHumanMatrixIdentity");
  const deleteAt = deleteBranch.indexOf("teamsStore.deleteUser(resourceId)");
  assert.notEqual(deprovisionAt, -1, "the delete branch must de-provision the Matrix identity");
  assert.notEqual(deleteAt, -1, "the delete branch must still delete the user");
  assert.ok(
    deprovisionAt < deleteAt,
    "de-provision BEFORE deleteUser, so a failure leaves the user recoverable",
  );
});

test("de-provisioning deactivates the account and drops the stored token", () => {
  const body = functionBody("deprovisionHumanMatrixIdentity");
  assert.match(body, /deactivateMatrixUserId\(/, "the Matrix account must be deactivated");
  assert.match(body, /humanMatrixStore\.deleteIdentity\(/, "the stored token must be deleted");
});

// ---- the token stays out of the user record --------------------------------

test("the user record is stamped with the Matrix id only — never with the access token", () => {
  // The credential lives in human-matrix-store.js precisely because
  // users/index.json has readers that bypass sanitizeUser(). This pins that
  // split at the one place both stores are written.
  const body = functionBody("ensureHumanMatrixIdentity");
  assert.match(body, /teamsStore\.setUserMatrixIdentity\(user\.id, matrixUserId\)/);
  assert.match(body, /humanMatrixStore\.writeIdentity\(user\.id, \{ matrixUserId, accessToken \}\)/);

  // No call anywhere hands an access token to the user store.
  const stamps = SRC.match(/setUserMatrixIdentity\([^)]*\)/g) || [];
  assert.ok(stamps.length > 0, "expected at least one stamp call site");
  for (const stamp of stamps) {
    assert.ok(
      !/accessToken|token/i.test(stamp),
      `setUserMatrixIdentity must never receive a token: ${stamp}`,
    );
  }
});

test("the human's Matrix password is full-entropy, not the derivable agent pattern", () => {
  // Agent accounts use `agent-<id>-<Date.now()>`, which is guessable by anyone
  // who knows the id and roughly when it was created. That is tolerable for a
  // service account whose token the stack holds anyway; for a human account it
  // would be a login as that person.
  const body = functionBody("ensureHumanMatrixIdentity");
  assert.match(body, /const password = randomHex\(/);
  assert.ok(!/`agent-\$\{/.test(body), "must not reuse the agent password pattern");
});

// ---- login is still the success signal --------------------------------------

test("provisioning treats the login, not the fire-and-forget admin command, as the success signal", () => {
  // The admin-room commands' replies are never parsed, so only the subsequent
  // login proves the account exists — and it must go through the retrying
  // wrapper that absorbs the cold-stack race (#719/#1386).
  const body = functionBody("ensureHumanMatrixIdentity");
  assert.match(body, /await loginMatrixUser\(localpart, password, adminClient\)/);
  assert.ok(
    !/attemptLoginMatrixUser/.test(body),
    "must use the retrying loginMatrixUser, not the single-shot attempt",
  );
});

test("provisioning is idempotent — an existing credential short-circuits it", () => {
  const body = functionBody("ensureHumanMatrixIdentity");
  const readAt = body.indexOf("humanMatrixStore.readIdentity(user.id)");
  const createAt = body.indexOf("ensureMatrixUser(");
  assert.notEqual(readAt, -1, "must check for an existing credential first");
  assert.ok(readAt < createAt, "the existing-credential check must precede account creation");
  assert.match(body, /if \(existing && existing\.accessToken\) return existing;/);
});
