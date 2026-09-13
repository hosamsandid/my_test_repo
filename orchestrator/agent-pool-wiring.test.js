"use strict";

// Source-reading drift guard for the agent-pool orchestrator wiring (#2246).
//
// The pure core (agent-pool.js) is fully unit-tested, but two properties live
// ONLY in orchestrator.js's impure half, and both broke silently in the
// original PR — the happy path (one item, no cap configured) never exercises
// either bug:
//
//   maxInstances (D5) — `routePooledDispatch` must pass `planPoolDispatch`
//   every LIVE instance of the ROLE (any work item), not just this one item's
//   own instance filtered down to 0-or-1 elements. The latter can never reach
//   the `refuse` branch (a length-1 array always contains the item's own
//   instance id, so `reuse` fires first) — a role configured with
//   `maxInstances: N` silently never gets capped. Caught in code review only
//   by tracing the caller by hand; the pure `planPoolDispatch` tests hand-
//   construct a correct multi-element array and could never have caught it.
//
//   Hard-timeout needs-human (D8) — `_reapTimedOutPoolInstances` must actually
//   stamp the GitHub label, not merely log that it "is marking" the item.
//
// orchestrator.js cannot be `require`d in a unit test (it boots the container
// runtime, the webhook server and reaches for Matrix), so this reads its
// source — the `bound-agents-visibility.test.js` / `agent-repositories-
// wiring.test.js` technique.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FULL_SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8");

// Comments name the very properties under test, so strip them first. Anchored
// to the start of a line on both forms (the agent-repositories-wiring.test.js
// discipline) — an unanchored `/* … */` strip is unsafe on a file this size
// full of regex literals.
function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "");
}
const SRC = stripComments(FULL_SRC);

function fn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > 0, `function ${name} not found — this guard needs re-pointing`);
  // Slice to the next top-level `\nfunction ` (or `\nasync function `) after
  // the opening — every function in this file is separated by at least one
  // blank line, so this is a stable enough boundary for a drift guard.
  const rest = SRC.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function /);
  const end = nextFn === -1 ? SRC.length : start + 1 + nextFn;
  return SRC.slice(start, end);
}

test("the guard is not vacuous: both functions survive the comment strip with their bodies intact", () => {
  for (const name of ["routePooledDispatch", "_reapTimedOutPoolInstances", "_liveInstanceIdsForRole"]) {
    assert.ok(fn(name).length > 100, `${name} came back empty — the comment strip or slice ran away`);
  }
});

test("routePooledDispatch enumerates every live instance of the ROLE, not just this one item's own instance", () => {
  const src = fn("routePooledDispatch");
  assert.match(
    src,
    /existingInstanceIds:\s*itemKey == null \? \[\] : _liveInstanceIdsForRole\(agentId\)/,
    "existingInstanceIds must come from _liveInstanceIdsForRole(agentId) — a single-item array can never reach the refuse (maxInstances) branch",
  );
});

test("mutation-proved: the pre-fix single-item shape would fail the check above", () => {
  const buggy = fn("routePooledDispatch").replace(
    "existingInstanceIds: itemKey == null ? [] : _liveInstanceIdsForRole(agentId),",
    "existingInstanceIds: itemKey == null ? [] : [agentPool.poolInstanceId(teamId, roleId, itemKey)]\n"
      + "      .filter((id) => loadAgentConfig(id) || agentTeardownRegistry.has(id)),",
  );
  assert.doesNotMatch(buggy, /_liveInstanceIdsForRole\(agentId\)/);
});

test("_liveInstanceIdsForRole scans by role prefix and poolOf, not by a single item key", () => {
  const src = fn("_liveInstanceIdsForRole");
  assert.match(src, /const prefix = `\$\{roleFullId\}-i`/);
  assert.match(src, /cfg\.poolOf !== roleFullId/);
  // It must NOT take an itemKey/instanceId param — the whole point is that it
  // answers "every instance of this role", independent of any one item.
  assert.doesNotMatch(fn("_liveInstanceIdsForRole").split("\n")[0], /itemKey|instanceId/);
});

test("the hard-timeout reaper actually stamps needs-human, not just a console.warn claiming to", () => {
  const src = fn("_reapTimedOutPoolInstances");
  assert.match(
    src,
    /stampMirrorLabel\(cfg\.poolRepo, cfg\.poolItem, "needs-human", labelWarnings\)/,
    "the reaper must call stampMirrorLabel — logging that it 'is marking needs-human' without doing it leaves a timed-out ticket invisible to everyone but the server log",
  );
});

test("mutation-proved: a reaper that only logs (the pre-fix shape) would fail the check above", () => {
  const buggy = fn("_reapTimedOutPoolInstances").replace(
    /if \(cfg\.poolRepo[\s\S]*?await _internalSelfDelete\(id\);/,
    'console.warn(`marking item ${cfg.poolItem} needs-human`);\n      await _internalSelfDelete(id);',
  );
  assert.doesNotMatch(buggy, /stampMirrorLabel\(/);
});

test("spawnPoolInstance stamps poolRepo on the instance at spawn time, so the reaper never has to re-derive it", () => {
  const start = SRC.indexOf("async function spawnPoolInstance(");
  assert.ok(start > 0, "spawnPoolInstance not found");
  const body = SRC.slice(start, SRC.indexOf("\nfunction routePooledDispatch("));
  assert.match(body, /poolRepo:\s*repoFullName \|\| null/);
});

test("D3: a fresh clone and a cache-copy both apply the resolved rework branch before returning", () => {
  const start = SRC.indexOf("function cloneRepository(");
  assert.ok(start > 0, "cloneRepository not found");
  const body = SRC.slice(start, SRC.indexOf("\nfunction listWorkspaceClones("));
  const hits = body.match(/_checkoutReworkBranch\(repoDir, repository, envGithubTokenId, reworkBranch\)/g) || [];
  assert.equal(hits.length, 2, "expected the rework checkout on both the cache-copy path and the fresh-clone path");
});

test("CodeQL js/second-order-command-line-injection: both git-argument sites validate via isSafeGitRef before executing", () => {
  const checkoutStart = SRC.indexOf("function _checkoutReworkBranch(");
  assert.ok(checkoutStart > 0, "_checkoutReworkBranch not found");
  const checkoutBody = SRC.slice(checkoutStart, SRC.indexOf("\nfunction cloneRepository("));
  assert.match(checkoutBody, /agentPool\.isSafeGitRef\(branch\)/);

  const refreshStart = SRC.indexOf("function refreshRepoCacheIfStale(");
  assert.ok(refreshStart > 0, "refreshRepoCacheIfStale not found");
  const refreshBody = SRC.slice(refreshStart, SRC.indexOf("\nfunction repoGitCredentials("));
  assert.match(refreshBody, /agentPool\.isSafeGitRef\(branch\)/);
});

test("mutation-proved: an unvalidated branch/rawBranch would fail the check above", () => {
  const checkoutStart = SRC.indexOf("function _checkoutReworkBranch(");
  const checkoutBody = SRC.slice(checkoutStart, SRC.indexOf("\nfunction cloneRepository("));
  const buggyCheckout = checkoutBody.replace(/if \(!agentPool\.isSafeGitRef\(branch\)\) \{[\s\S]*?\}\n/, "");
  assert.doesNotMatch(buggyCheckout, /agentPool\.isSafeGitRef\(branch\)/);
});
