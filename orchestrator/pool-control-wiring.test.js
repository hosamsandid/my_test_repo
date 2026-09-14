"use strict";

// Source-reading drift guard for the pool-control orchestrator wiring
// (#2250 Phase 5, epic #2251 — board pause/drain/force-dispatch). The pure
// cores (`agent-pool.js`'s `normalizePoolControl`/`poolControlState`,
// `admission-control.js`'s `forcePromoteHeld`) are fully unit-tested; this
// file guards the three properties that live ONLY in orchestrator.js's
// impure half, the same `agent-pool-wiring.test.js` technique (orchestrator.js
// cannot be `require`d in a unit test — it boots the container runtime, the
// webhook server and reaches for Matrix):
//
//   1. `routePooledDispatch` must read the role's live pause/drain state and
//      pass it into `planPoolDispatch` — omitting it silently defaults to
//      "running" (a caller-side bug the pure core cannot itself detect).
//   2. `flowSupervisorSweepTeam` must exclude a paused/draining role from
//      auto-dispatch candidates — otherwise the supervisor keeps timing
//      dispatch for a role an operator just told the board to stop.
//   3. `recurringPoolSweepTeam` must gate only the DISPATCH half on control
//      state, never the reap half — a drained role's finishing instances must
//      still be torn down.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FULL_SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8");

function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "");
}
const SRC = stripComments(FULL_SRC);

function fn(name, { async: isAsync = false } = {}) {
  const marker = `${isAsync ? "async " : ""}function ${name}(`;
  const start = SRC.indexOf(marker);
  assert.ok(start > 0, `function ${name} not found — this guard needs re-pointing`);
  const rest = SRC.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function /);
  const end = nextFn === -1 ? SRC.length : start + 1 + nextFn;
  return SRC.slice(start, end);
}

test("the guard is not vacuous: every function under test survives the comment strip with its body intact", () => {
  assert.ok(fn("routePooledDispatch").length > 200);
  assert.ok(fn("flowSupervisorSweepTeam", { async: true }).length > 500);
  assert.ok(fn("recurringPoolSweepTeam", { async: true }).length > 500);
});

test("routePooledDispatch resolves the role's live control state and threads it into planPoolDispatch", () => {
  const src = fn("routePooledDispatch");
  assert.match(
    src,
    /const controlState = agentPool\.poolControlState\(loadPoolControl\(teamId\), roleId\)/,
    "must read the pool-control file for THIS team before deciding",
  );
  assert.match(
    src,
    /agentPool\.planPoolDispatch\(\{\s*\n\s*teamId, roleId, pool, itemKey, controlState,/,
    "controlState must actually be passed into planPoolDispatch, not just computed and dropped",
  );
});

test("mutation-proved: dropping controlState from the planPoolDispatch call would fail the check above", () => {
  const buggy = fn("routePooledDispatch").replace(", controlState,", ",");
  assert.doesNotMatch(buggy, /teamId, roleId, pool, itemKey, controlState,/);
});

test("flowSupervisorSweepTeam excludes a paused/draining role from the auto-dispatch candidate set", () => {
  const src = fn("flowSupervisorSweepTeam", { async: true });
  assert.match(src, /const poolControl = loadPoolControl\(teamId\)/);
  assert.match(
    src,
    /\.filter\(\(r\) => agentPool\.poolControlState\(poolControl, agentPool\.roleIdFromMemberId\(r\.id, teamId\)\) === ['"]running['"]\)/,
    "pooledRoleIds must be filtered to roles whose control state is running before candidates are selected",
  );
});

test("mutation-proved: dropping the running-filter would fail the check above", () => {
  const src = fn("flowSupervisorSweepTeam", { async: true });
  const buggy = src.replace(
    /\n\s*\.filter\(\(r\) => agentPool\.poolControlState\(poolControl, agentPool\.roleIdFromMemberId\(r\.id, teamId\)\) === ['"]running['"]\)/,
    "",
  );
  assert.doesNotMatch(buggy, /poolControlState\(poolControl,/);
});

test("recurringPoolSweepTeam gates only the dispatch half on control state — the reap pass runs unconditionally", () => {
  const src = fn("recurringPoolSweepTeam", { async: true });
  const reapIdx = src.indexOf("_internalSelfDelete(instanceId)");
  const gateIdx = src.search(/if \(agentPool\.poolControlState\(poolControl, roleId\) !== ['"]running['"]\) continue;/);
  const dispatchIdx = src.indexOf("selectRecurringDispatch(");
  assert.ok(reapIdx > 0 && gateIdx > 0 && dispatchIdx > 0, "one of the three anchors is missing — this guard needs re-pointing");
  assert.ok(reapIdx < gateIdx, "the reap loop must run BEFORE the control-state gate, not be skipped by it");
  assert.ok(gateIdx < dispatchIdx, "the control-state gate must sit before dispatch selection");
});

test("mutation-proved: a gate placed BEFORE the reap loop (blocking teardown too) would fail the ordering check above", () => {
  const src = fn("recurringPoolSweepTeam", { async: true });
  const gate = "if (agentPool.poolControlState(poolControl, roleId) !== 'running') continue;\n\n    ";
  const buggy = src.replace(gate, "").replace(
    "const roleId = agentPool.roleIdFromMemberId(role.id, teamId);",
    `const roleId = agentPool.roleIdFromMemberId(role.id, teamId);\n    ${gate.trim()}`,
  );
  const reapIdx = buggy.indexOf("_internalSelfDelete(instanceId)");
  const gateIdx = buggy.search(/if \(agentPool\.poolControlState\(poolControl, roleId\) !== ['"]running['"]\) continue;/);
  assert.ok(gateIdx < reapIdx, "sanity: the mutated fixture really does move the gate before the reap loop");
});

// ─── the three internal routes ──────────────────────────────────────────────

test("GET /internal/teams/:teamId/pool-control returns roles (with live control state) and held entries with a client-usable id", () => {
  const start = SRC.indexOf("const poolControlGetMatch =");
  assert.ok(start > 0, "poolControlGetMatch route not found");
  const body = SRC.slice(start, SRC.indexOf("const poolControlSetMatch ="));
  assert.match(body, /agentPool\.poolControlState\(control, roleId\)/);
  assert.match(body, /admissionControl\.heldIdentity\(h\.agentId, h\.entry\)/);
});

test("POST /internal/teams/:teamId/pool-control/:roleId validates the role is actually a pooled role of THIS team before writing", () => {
  const start = SRC.indexOf("const poolControlSetMatch =");
  assert.ok(start > 0, "poolControlSetMatch route not found");
  const body = SRC.slice(start, SRC.indexOf("const forceDispatchMatch ="));
  assert.match(body, /agentPool\.isPooledRole\(roleCfg\)/);
  assert.match(body, /\(roleCfg\.parentTeamId \|\| null\) !== teamId/);
  assert.match(body, /agentPool\.POOL_CONTROL_STATES\.includes\(state\)/);
});

test("POST /internal/teams/:teamId/force-dispatch calls forcePromoteHeld and only enqueues when an entry was actually found", () => {
  const start = SRC.indexOf("const forceDispatchMatch =");
  assert.ok(start > 0, "forceDispatchMatch route not found");
  const body = SRC.slice(start, SRC.indexOf("// GET /internal/teams/:teamId/hill-climb/metrics"));
  assert.match(body, /admissionControl\.forcePromoteHeld\(\{ lane, id \}\)/);
  assert.match(body, /if \(!result\.found\) return sendJson\(res, 200, \{ teamId, found: false \}\);/);
  assert.match(body, /enqueuePending\(result\.agentId, result\.entry, \{ admissionChecked: true \}\)/);
});
