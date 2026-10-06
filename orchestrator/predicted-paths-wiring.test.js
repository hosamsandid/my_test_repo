"use strict";

// Source-reading drift guard for the Phase 4 (#2249, epic #2251) LLM
// conflict-prediction wiring. The pure shape (sanitize/overlap/prompt/parse)
// is fully unit-tested in `predicted-paths.test.js`; the properties the
// issue's own acceptance criteria name — gated behind config off by default,
// LLM-over-(issue+repo-tree) reusing the EXISTING assist-billing/synthesis
// hands rather than a new one, and a heuristic fallback that never blocks a
// dispatch — live only in orchestrator.js's impure half.
//
// orchestrator.js cannot be `require`d in a unit test (it boots the container
// runtime, the webhook server and reaches for Matrix), so this reads its
// source — the `flow-supervisor-wiring.test.js` / `agent-pool-wiring.test.js`
// technique.

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

function fn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > 0, `function ${name} not found — this guard needs re-pointing`);
  const rest = SRC.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?(?:const \w+ = )?function /);
  const end = nextFn === -1 ? SRC.length : start + 1 + nextFn;
  return SRC.slice(start, end);
}

test("the guard is not vacuous: every slice survives the comment strip with its body intact", () => {
  for (const name of ["flowSupervisorSweepTeam", "_predictTicketPaths", "_ensurePredictedPaths", "_fetchRepoTreeSample"]) {
    assert.ok(fn(name).length > 80, `${name} came back empty — the comment strip or slice ran away`);
  }
});

test("prediction is fully gated on autoDispatch.contentionPolicy === CONTENTION_PREDICTED_PATHS — off by default (AC)", () => {
  const src = fn("flowSupervisorSweepTeam");
  assert.match(src, /usePathContention = autoDispatch\.contentionPolicy === flowSupervisor\.CONTENTION_PREDICTED_PATHS/);
  assert.match(src, /if \(usePathContention\) \{/);
});

test("mutation-proved: a sweep with the gate removed would fire prediction unconditionally", () => {
  const src = fn("flowSupervisorSweepTeam");
  const buggy = src.replace(
    /const usePathContention = autoDispatch\.contentionPolicy === flowSupervisor\.CONTENTION_PREDICTED_PATHS;/,
    "const usePathContention = true;",
  );
  assert.doesNotMatch(buggy, /usePathContention = autoDispatch\.contentionPolicy ===/);
});

test("only UNCLAIMED (about-to-dispatch) candidates trigger a new prediction — not every ticket in the ledger", () => {
  const src = fn("flowSupervisorSweepTeam");
  assert.match(src, /unclaimedCandidates = pooledCandidates\.filter\(\(t\) => t\.blocker === flowSupervisor\.AUTO_DISPATCH_BLOCKER\)/);
  assert.match(src, /_ensurePredictedPaths\(teamId, unclaimedCandidates, pathsCache, fleet\)/);
});

test("busy path sets are read from the CACHE for active tickets, never trigger a fresh prediction for them", () => {
  const src = fn("flowSupervisorSweepTeam");
  assert.match(src, /busyPathSets = tickets\s*\n\s*\.filter\(\(t\) => FLOW_SUPERVISOR_ACTIVE_STATES\.has\(t\.state\) && pathsCache\[t\.ticketId\]\)/);
});

test("the predicted-paths cache is persisted every sweep it was used in, mirroring the budget's own persistence", () => {
  const src = fn("flowSupervisorSweepTeam");
  assert.match(src, /if \(usePathContention\) savePredictedPathsCache\(teamId, pathsCache\);/);
});

test("mutation-proved: dropping the cache save would fail the persistence check above", () => {
  const src = fn("flowSupervisorSweepTeam");
  const buggy = src.replace(/if \(usePathContention\) savePredictedPathsCache\(teamId, pathsCache\);/, "// cache save dropped");
  assert.doesNotMatch(buggy, /savePredictedPathsCache\(teamId, pathsCache\);/);
});

test("prediction is once-per-ticket, never re-predicted: _ensurePredictedPaths only fills MISSING cache entries", () => {
  const src = fn("_ensurePredictedPaths");
  assert.match(src, /candidates\s*\n\s*\.filter\(\(t\) => !cache\[t\.ticketId\]\)/);
});

test("the LLM half reuses the EXISTING assist-billing resolver and generic synthesis call — no bespoke fetch/billing path", () => {
  const src = fn("_predictTicketPaths");
  assert.match(src, /resolveAssistBindingForTeam\(teamId\)/);
  assert.match(src, /await _synthesizeSkillMd\(/);
});

test("a heuristic fallback always runs when the LLM path yields nothing usable — AC: 'LLM ... or a heuristic'", () => {
  const src = fn("_predictTicketPaths");
  assert.match(src, /predictedPaths\.extractHeuristicPaths\(/);
  // The heuristic line must be reachable even when `binding` is falsy (no
  // `return` inside the `if (binding)` block for the no-binding case) —
  // asserted by checking the heuristic call sits OUTSIDE the `if (binding)` body.
  const ifStart = src.indexOf("if (binding) {");
  const ifBodyEnd = src.indexOf("\n  }", ifStart);
  const heuristicIdx = src.indexOf("predictedPaths.extractHeuristicPaths(");
  assert.ok(ifStart > 0 && ifBodyEnd > 0 && heuristicIdx > ifBodyEnd, "heuristic fallback must be reachable without a binding");
});

test("the repo-tree sample reuses _flowGithubGetJson (the ticket ledger's own GET-JSON hand), not a new fetch primitive", () => {
  const src = fn("_fetchRepoTreeSample");
  assert.match(src, /await _flowGithubGetJson\(/);
});
