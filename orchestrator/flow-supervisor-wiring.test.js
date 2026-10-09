"use strict";

// Source-reading drift guard for the Flow Supervisor's orchestrator wiring
// (#2247, epic #2251 Phase 2). The pure core (flow-supervisor.js) is fully
// unit-tested, but the properties the issue's own acceptance criteria name —
// maintenance-gating, "piggybacks on wipLimit", epic-serialization actually
// being wired end to end, and every dispatch going through an EXISTING audited
// hand rather than a new one — live only in orchestrator.js's impure half.
//
// orchestrator.js cannot be `require`d in a unit test (it boots the container
// runtime, the webhook server and reaches for Matrix), so this reads its
// source — the `agent-pool-wiring.test.js` / `admission-control-wiring.test.js`
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

// `runFlowSupervisorTick` is an arrow function assigned inside `main()`, not a
// `function` declaration, so it needs its own slice rather than `fn()`.
function arrowConst(name) {
  const start = SRC.indexOf(`const ${name} = async () => {`);
  assert.ok(start > 0, `const ${name} not found — this guard needs re-pointing`);
  const rest = SRC.slice(start);
  const end = rest.indexOf("\n  const ", 1); // next sibling `const X = ` at the same indent
  return end === -1 ? rest : rest.slice(0, end);
}

test("the guard is not vacuous: every slice survives the comment strip with its body intact", () => {
  for (const name of ["flowSupervisorSweepTeam", "wakeGithubLabelListeners"]) {
    assert.ok(fn(name).length > 100, `${name} came back empty — the comment strip or slice ran away`);
  }
  assert.ok(arrowConst("runFlowSupervisorTick").length > 100, "runFlowSupervisorTick came back empty");
});

test("the reconcile tick is maintenance-gated (AC: 'maintenance-gated timer')", () => {
  const src = arrowConst("runFlowSupervisorTick");
  assert.match(src, /readMaintenanceState\(\)/);
  assert.match(src, /if \(maint && maint\.active\) return;/);
});

test("mutation-proved: a tick with the maintenance check removed would fail the guard above", () => {
  const buggy = arrowConst("runFlowSupervisorTick").replace(
    /const maint = readMaintenanceState\(\);\s*\n\s*if \(maint && maint\.active\) return;[^\n]*\n/,
    "",
  );
  assert.doesNotMatch(buggy, /if \(maint && maint\.active\) return;/);
});

test("the sweep piggybacks on the flow's own wipLimit — no wipLimit, no dispatch, matching pool's own rule", () => {
  const src = fn("flowSupervisorSweepTeam");
  assert.match(src, /admissionControl\.limitInForce\(teamCfg\.wipLimit\)/);
  assert.match(src, /if \(wipLimit === null\) return null;/);
});

test("the sweep requires an opt-in AND at least one pooled role — never fires on a flow that never configured either", () => {
  const src = fn("flowSupervisorSweepTeam");
  assert.match(src, /autoDispatch\.enabled !== true/);
  assert.match(src, /_freshTeamPooledRoles\(teamId, fleet\)/); // #569: re-read per role, never the snapshot
  assert.match(src, /pooledRoleIds\.size === 0\) return null;/);
});

test("epic-serialization: busyEpicIds is computed from every ACTIVE (non-backlog, non-done) ticket and threaded into the selector", () => {
  const src = fn("flowSupervisorSweepTeam");
  assert.match(src, /FLOW_SUPERVISOR_ACTIVE_STATES\.has\(t\.state\)/);
  assert.match(src, /selectAutoDispatch\(\{[\s\S]*?busyEpicIds,/);
});

test("mutation-proved: dropping busyEpicIds from the selector call would fail the check above", () => {
  const src = fn("flowSupervisorSweepTeam");
  const buggy = src.replace(
    /const toDispatch = flowSupervisor\.selectAutoDispatch\(\{\s*\n\s*candidates: pooledCandidates, busyEpicIds, budget, now, windowMs, limit: wipLimit,\s*\n\s*contentionPolicy: autoDispatch\.contentionPolicy, busyPathSets,\s*\n\s*\}\);/,
    "const toDispatch = flowSupervisor.selectAutoDispatch({ candidates: pooledCandidates, budget, now, windowMs, limit: wipLimit, contentionPolicy: autoDispatch.contentionPolicy, busyPathSets });",
  );
  assert.doesNotMatch(buggy, /selectAutoDispatch\(\{[\s\S]*?busyEpicIds,/);
});

// Phase 4 (#2249, D6): predicted-paths contention is layered on TOP of
// epic-serialization, opt-in, and must never fire a prediction unless the
// team's own `autoDispatch.contentionPolicy` names it — see
// `predicted-paths-wiring.test.js` for the full drift guard on this half.
test("predicted-paths contention is threaded into the SAME selector call, gated on autoDispatch.contentionPolicy", () => {
  const src = fn("flowSupervisorSweepTeam");
  assert.match(src, /usePathContention = autoDispatch\.contentionPolicy === flowSupervisor\.CONTENTION_PREDICTED_PATHS/);
  assert.match(src, /selectAutoDispatch\(\{[\s\S]*?contentionPolicy: autoDispatch\.contentionPolicy, busyPathSets,/);
});

test("auto-dispatch and the 'unclaimed' remediation row are ONE code path: both run through wakeGithubLabelListeners, no bespoke GitHub write", () => {
  const src = fn("flowSupervisorSweepTeam");
  assert.match(src, /await wakeGithubLabelListeners\(\{/);
  assert.match(src, /actor: 'flow-supervisor', source: 'supervisor'/);
});

test("every auto-dispatch is recorded so 'who dispatched' stays clear (AC): wakeGithubLabelListeners always writes the transparency log", () => {
  const src = fn("wakeGithubLabelListeners");
  assert.match(src, /githubEventLog\.record\(/);
  // `source` rides through to the log entry, not hardcoded to the label-fastpath
  // value — this is what lets a 'supervisor' dispatch read differently from a
  // human's in the GitHub Event Log.
  assert.match(src, /\.\.\.githubEventLog\.buildEventEntry\(\{[\s\S]*?\}\),\s*\n\s*source,/);
});

test("the HTTP handler (a human applying a label) and the supervisor share the SAME wake implementation, not two copies", () => {
  const handlerStart = SRC.indexOf("'/internal/github-label-applied'");
  assert.ok(handlerStart > 0, "the github-label-applied route not found");
  const handlerBody = SRC.slice(handlerStart, handlerStart + 2000);
  assert.match(handlerBody, /await wakeGithubLabelListeners\(\{/);
});

test("the stale-base remediation nudges the ticket's OWNER through wake-agent's own builders, not a bespoke queue entry", () => {
  const src = fn("flowSupervisorSweepTeam");
  assert.match(src, /wakeAgent\.buildWakeEntry\(\{ from: 'flow-supervisor', note, teamId \}\)/);
  assert.match(src, /wakeAgent\.buildWakeLogEvent\(\{/);
  assert.match(src, /wakeAgent\.buildWakeLogFields\(\{/);
});

test("the ≤1-action-per-(item,blocker)-per-window budget is loaded, folded and persisted every sweep", () => {
  const src = fn("flowSupervisorSweepTeam");
  assert.match(src, /loadFlowSupervisorBudget\(teamId\)/);
  assert.match(src, /flowSupervisor\.recordFired\(budget, firedKeys, now\)/);
  assert.match(src, /flowSupervisor\.pruneBudget\(budget, now, windowMs\)/);
  assert.match(src, /saveFlowSupervisorBudget\(teamId, budget\)/);
});

test("mutation-proved: a sweep that never persists the budget would fail the check above", () => {
  const buggy = fn("flowSupervisorSweepTeam").replace(
    /saveFlowSupervisorBudget\(teamId, budget\);/,
    "// budget intentionally dropped",
  );
  assert.doesNotMatch(buggy, /saveFlowSupervisorBudget\(teamId, budget\);/);
});

test("a per-team failure in the tick loop is caught and logged, never escapes to stop the other teams", () => {
  const src = arrowConst("runFlowSupervisorTick");
  assert.match(src, /await flowSupervisorSweepTeam\(teamId, \{ fleet \}\);/);
  assert.match(src, /console\.warn\(`\[FlowSupervisor\] \$\{teamId\}: sweep failed/);
});
