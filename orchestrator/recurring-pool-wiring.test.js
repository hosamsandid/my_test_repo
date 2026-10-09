"use strict";

// Source-reading drift guard for the recurring-analysis binding's orchestrator
// wiring (#2248, epic #2251 Phase 3). The pure core
// (`recurring-pool-source.js`) is fully unit-tested, but the properties the
// design doc names — maintenance-gating, no GitHub/ticket-ledger anywhere in
// this path, "reap on completion before dispatch" (D4), idempotency (D11) and
// the input-copy workspace seeding — live only in orchestrator.js's impure
// half.
//
// orchestrator.js cannot be `require`d in a unit test (it boots the container
// runtime, the webhook server and reaches for Matrix), so this reads its
// source — the `agent-pool-wiring.test.js` / `flow-supervisor-wiring.test.js`
// technique.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FULL_SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8");

// Comments name the very properties under test, so strip them first (the
// agent-pool-wiring.test.js discipline — anchored to line start on both forms,
// unsafe to do unanchored on a file this size full of regex literals).
function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "");
}
const SRC = stripComments(FULL_SRC);

function fn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > 0, `function ${name} not found — this guard needs re-pointing`);
  const rest = SRC.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?(?:const \w+ = )?function /);
  const end = nextFn === -1 ? SRC.length : start + 1 + nextFn;
  return SRC.slice(start, end);
}

// `runRecurringPoolTick` is an arrow function assigned inside `main()`, not a
// `function` declaration, so it needs its own slice rather than `fn()`.
function arrowConst(name) {
  const start = SRC.indexOf(`const ${name} = async () => {`);
  assert.ok(start > 0, `const ${name} not found — this guard needs re-pointing`);
  const rest = SRC.slice(start);
  const end = rest.indexOf("\n  const ", 1); // next sibling `const X = ` at the same indent
  return end === -1 ? rest : rest.slice(0, end);
}

test("the guard is not vacuous: every slice survives the comment strip with its body intact", () => {
  for (const name of ["recurringPoolSweepTeam", "_seedRecurringInput", "_recurringItemComplete", "seedAgentWorkspace"]) {
    assert.ok(fn(name).length > 80, `${name} came back empty — the comment strip or slice ran away`);
  }
  assert.ok(arrowConst("runRecurringPoolTick").length > 80, "runRecurringPoolTick came back empty");
});

test("the tick is maintenance-gated (AC: 'maintenance-gated timer'), same as the Flow Supervisor's", () => {
  const src = arrowConst("runRecurringPoolTick");
  assert.match(src, /readMaintenanceState\(\)/);
  assert.match(src, /if \(maint && maint\.active\) return;/);
});

test("mutation-proved: a tick with the maintenance check removed would fail the guard above", () => {
  const buggy = arrowConst("runRecurringPoolTick").replace(
    /const maint = readMaintenanceState\(\);\s*\n\s*if \(maint && maint\.active\) return;[^\n]*\n/,
    "",
  );
  assert.doesNotMatch(buggy, /if \(maint && maint\.active\) return;/);
});

test("a per-team failure in the tick loop is caught and logged, never escapes to stop the other teams", () => {
  const src = arrowConst("runRecurringPoolTick");
  assert.match(src, /await recurringPoolSweepTeam\(teamId, \{ fleet \}\);/);
  assert.match(src, /console\.warn\(`\[AgentPool\] \$\{teamId\}: recurring-pool sweep failed/);
});

test("the sweep skips any pooled role with no workSource — the SDLC binding is never touched here", () => {
  const src = fn("recurringPoolSweepTeam");
  assert.match(src, /const workSource = role\.pool\.workSource;/);
  assert.match(src, /if \(!workSource\) continue;/);
});

test("no GitHub call anywhere in the sweep — proves the binding is domain-neutral (concept §6)", () => {
  const src = fn("recurringPoolSweepTeam");
  assert.doesNotMatch(src, /_flowGithubGetJson|github\.com|resolveRepoGithubTokenId|computeTeamTicketLedger/);
});

test("release (D4) happens BEFORE dispatch, so a just-completed slot is free the same tick", () => {
  const src = fn("recurringPoolSweepTeam");
  const reapAt = src.indexOf("_internalSelfDelete(instanceId)");
  const dispatchAt = src.indexOf("selectRecurringDispatch(");
  assert.ok(reapAt > 0 && dispatchAt > 0, "expected both a reap call and a dispatch selection in the sweep");
  assert.ok(reapAt < dispatchAt, "reap must run before the dispatch selection, not after");
});

test("completion is the output-artifact signal, not a ticket/PR state", () => {
  const src = fn("recurringPoolSweepTeam");
  assert.match(src, /_recurringItemComplete\(workSource\.outputDir, itemId\)/);
});

test("D11 idempotency: an item already running (existingItemIds) is threaded into the selector, never re-spawned", () => {
  const src = fn("recurringPoolSweepTeam");
  assert.match(src, /existingItemIds: stillLiveItemIds/);
});

test("mutation-proved: dropping existingItemIds from the selector call would fail the check above", () => {
  const src = fn("recurringPoolSweepTeam");
  const buggy = src.replace(
    /items: workSource\.items, completedItemIds, existingItemIds: stillLiveItemIds, limit,/,
    "items: workSource.items, completedItemIds, limit,",
  );
  assert.doesNotMatch(buggy, /existingItemIds: stillLiveItemIds/);
});

test("concurrency: no wipLimit/maxInstances configured refuses to dispatch rather than spawning unbounded", () => {
  const src = fn("recurringPoolSweepTeam");
  assert.match(src, /if \(limit == null\) \{/);
  assert.match(src, /console\.warn\(`\[AgentPool\] \$\{teamId\}: \$\{role\.id\} has no wipLimit\/maxInstances configured/);
});

test("dispatch reuses the SAME spawn hand as the SDLC binding (startPoolSpawn → spawnPoolInstance), not a new one, with no repo/rework", () => {
  const src = fn("recurringPoolSweepTeam");
  // #2760: through the slot-claiming wrapper, so an in-flight spawn counts against the cap.
  assert.match(src, /await startPoolSpawn\(teamId, role\.cfg, instanceId, itemId, \{ repoFullName: null, directReworkRef: null \}\);/);
  assert.match(fn("routePooledDispatch"), /startPoolSpawn\(teamId, cfg, decision\.instanceId, itemKey,/);
});

test("#2760: items still provisioning count as taken for the recurring limit", () => {
  const src = fn("recurringPoolSweepTeam");
  assert.match(src, /poolSpawns\.provisioningIds\(role\.id\)/);
  assert.match(src, /\.\.\.provisioningItemIds,/);
});

test("instance ids are the SAME item-keyed identity function as the SDLC binding (D11)", () => {
  const src = fn("recurringPoolSweepTeam");
  assert.match(src, /agentPool\.poolInstanceId\(teamId, roleId, itemId\)/);
});

test("the input-copy workspace binding is wired into seedAgentWorkspace, gated on workspace/workSource/poolItem", () => {
  const src = fn("seedAgentWorkspace");
  assert.match(src, /opts\.pool\.workspace === "input-copy" && opts\.pool\.workSource && opts\.poolItem != null/);
  assert.match(src, /_seedRecurringInput\(dest, opts\.pool\.workSource\.inputDir, String\(opts\.poolItem\), warnings\);/);
});

test("_seedRecurringInput never throws on a missing source — best-effort like every other seed step", () => {
  const src = fn("_seedRecurringInput");
  assert.match(src, /try \{/);
  assert.match(src, /warnings\.push\(/);
});
