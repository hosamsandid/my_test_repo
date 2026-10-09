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

// Code-review finding on #2281: a pause/drain refusal used to be
// indistinguishable from "not pooled at all" (both returned `null`), so
// `enqueuePending` fell through and dispatched the ticket to the role
// TEMPLATE's own pending queue under the shared, unpooled identity while the
// operator believed the role was stopped.

test("routePooledDispatch holds a paused/draining refusal durably instead of returning null (the fallthrough bug)", () => {
  const src = fn("routePooledDispatch");
  assert.match(
    src,
    /if \(agentPool\.POOL_CONTROL_STATES\.includes\(decision\.reason\)\) \{/,
    "a pause/drain refusal must be told apart from an ordinary (e.g. max-instances) refusal",
  );
  assert.match(src, /savePausedHold\(teamId, held\)/, "the refused entry must be persisted, not just logged");
  assert.match(
    src,
    /if \(agentPool\.POOL_CONTROL_STATES\.includes\(decision\.reason\)\) \{[\s\S]{0,400}?return \{ held: true \};/,
    "the paused/draining branch must return a distinguishable {held:true}, never null",
  );
});

test("mutation-proved: reverting the held branch to `return null` would fail the check above", () => {
  const src = fn("routePooledDispatch");
  const buggy = src.replace(
    /if \(agentPool\.POOL_CONTROL_STATES\.includes\(decision\.reason\)\) \{[\s\S]*?return \{ held: true \};\n\s*\}\n/,
    "",
  );
  assert.doesNotMatch(buggy, /return \{ held: true \};/);
});

test("enqueuePending never falls through to the template's own pending queue for a held (paused/draining) entry", () => {
  const src = fn("enqueuePending");
  assert.match(
    src,
    /if \(pooled\.held\) return true;/,
    "a {held:true} result from routePooledDispatch must short-circuit before agentId is reassigned/used below",
  );
  const heldIdx = src.indexOf("if (pooled.held) return true;");
  const spawningIdx = src.indexOf("if (pooled.spawning) return true;");
  const pendingPathIdx = src.indexOf("pendingPath(agentId)");
  assert.ok(heldIdx > 0 && spawningIdx > heldIdx && pendingPathIdx > spawningIdx, "held must be checked before spawning and before the template fallthrough");
});

test("mutation-proved: dropping the held check from enqueuePending would fail the check above", () => {
  const buggy = fn("enqueuePending").replace("if (pooled.held) return true;\n    ", "");
  assert.doesNotMatch(buggy, /if \(pooled\.held\) return true;/);
});

test("resuming a role (POST pool-control with state:running/null) redelivers everything held while it was paused/draining", () => {
  const start = SRC.indexOf("const poolControlSetMatch =");
  assert.ok(start > 0, "poolControlSetMatch route not found");
  const body = SRC.slice(start, SRC.indexOf("const forceDispatchMatch ="));
  assert.match(body, /let resumed = false;/);
  assert.match(body, /resumed = true;/);
  assert.match(
    body,
    /if \(resumed\) \{[\s\S]*?enqueuePending\(h\.agentId, h\.entry, \{ admissionChecked: true \}\)/,
    "resuming must redeliver every held entry for this role through enqueuePending",
  );
  // The redelivery must happen AFTER savePoolControl persists the resumed
  // state — otherwise a redelivered dispatch could race the still-paused
  // control file and be held right back into the queue it was just drained
  // from.
  const saveAt = body.indexOf("savePoolControl(teamId, control)");
  const redeliverAt = body.indexOf("enqueuePending(h.agentId, h.entry");
  assert.ok(saveAt > 0 && redeliverAt > saveAt, "resume must persist the cleared control state before redelivering held entries");
});

test("mutation-proved: dropping the resume redelivery would fail the check above", () => {
  const start = SRC.indexOf("const poolControlSetMatch =");
  const body = SRC.slice(start, SRC.indexOf("const forceDispatchMatch ="));
  const buggy = body.replace(/if \(resumed\) \{[\s\S]*?\n {10}\}\n/, "");
  assert.doesNotMatch(buggy, /enqueuePending\(h\.agentId, h\.entry, \{ admissionChecked: true \}\)/);
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
  const reapIdx = src.indexOf("_internalSelfDelete(instanceId, \"done\")");
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
  const reapIdx = buggy.indexOf("_internalSelfDelete(instanceId, \"done\")");
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

test("#2814: GET pool-control lists each role's live instances with the lane view's own read and status rule", () => {
  const start = SRC.indexOf("const poolControlGetMatch =");
  const body = SRC.slice(start, SRC.indexOf("const poolControlSetMatch ="));
  assert.match(body, /instances: poolInstanceLanes\.liveInstanceRows\(\{/);
  assert.match(body, /_liveInstancesForWithWaiting\(role\.id, poolWaiting\)/);
  assert.match(body, /maxRuntimeMs: role\.pool\.teardown\.maxRuntimeMs/);
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
