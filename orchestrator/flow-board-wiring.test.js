"use strict";

// Source-reading drift guard for the Flow Control board's orchestrator wiring
// (#2573). The pure core (`flow-board.js`, `agent-pool.js` `settleDrain`) is
// unit-tested; orchestrator.js cannot be `require`d in a unit test, so the
// properties that live only in its impure half are pinned here:
//   1. the periodic pool sweep settles a finished drain to `off`;
//   2. the board sweep is ONE parallel list pass per repo (no per-PR fan-out)
//      behind a single-flight cache, and serves the last good snapshot stale;
//   3. the board route is maintenance-gated and the ledger route untouched.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "orchestrator.js"), "utf8");

function body(marker) {
  const start = SRC.indexOf(marker);
  assert.ok(start > 0, `${marker} not found — this guard needs re-pointing`);
  const next = SRC.indexOf("\nfunction ", start + 1);
  const nextAsync = SRC.indexOf("\nasync function ", start + 1);
  const end = Math.min(...[next, nextAsync].filter((i) => i > 0));
  return SRC.slice(start, end);
}

test("poolReapSweepTeam settles finished drains", () => {
  assert.match(body("async function poolReapSweepTeam("), /settlePoolDrains\(teamId\)/);
  assert.match(body("function settlePoolDrains("), /agentPool\.settleDrain\(/);
});

test("the board sweep is a parallel list pass, never a per-PR fan-out", () => {
  const repo = body("async function _flowBoardSweepRepo(");
  assert.match(repo, /Promise\.all\(/);
  assert.doesNotMatch(repo, /\/pulls\/\$\{/);
  assert.doesNotMatch(repo, /check-runs|\/reviews|\/timeline/);
  assert.match(body("async function computeTeamFlowBoard("), /Promise\.all\(/);
});

test("getTeamFlowBoard is single-flight and falls back to the last good snapshot", () => {
  const b = body("async function getTeamFlowBoard(");
  assert.match(b, /if \(entry\.inflight\) return entry\.inflight;/);
  assert.match(b, /stale: true/);
});

test("the flow-board route is maintenance-gated and leaves /tickets in place", () => {
  const i = SRC.indexOf("const flowBoardMatch");
  assert.ok(i > 0);
  assert.match(SRC.slice(i, i + 1500), /readMaintenanceState\(\)/);
  assert.match(SRC, /\/internal\\\/teams\\\/\(\[\^\/\]\+\)\\\/tickets/);
});

test("board removals (#2637) are stored per team and pruned only for repos the sweep reached", () => {
  assert.match(body("function flowBoardRemovedPath("), /controlOrPoolPath\(teamId, "flow-board-removed\.json"\)/);
  const compute = body("async function computeTeamFlowBoard(");
  assert.match(compute, /removed, now,/);
  assert.match(compute, /removalsToPrune\.filter\(\(id\) => reachedRepos\.has\(/);
  assert.match(compute, /saveFlowBoardRemoved\(teamId, current\)/);
});

test("the flow-board-removed route checks removability on the board and never writes to GitHub", () => {
  const i = SRC.indexOf("const flowBoardRemovedMatch");
  assert.ok(i > 0);
  const route = SRC.slice(i, SRC.indexOf("// POST /internal/teams/:teamId/flow-board-release", i));
  assert.match(route, /if \(!row\.removable\) return sendJson\(res, 409/);
  // The store is read after the board, whose computation may have pruned it.
  const remove = route.slice(route.indexOf("parsed.action === 'remove'"));
  assert.ok(remove.indexOf("await getTeamFlowBoard(teamId)") >= 0);
  assert.ok(remove.indexOf("await getTeamFlowBoard(teamId)") < remove.indexOf("removed = loadFlowBoardRemoved(teamId)"));
  assert.match(route, /_flowBoardCache\.delete\(teamId\)/);
  assert.doesNotMatch(route, /api\.github\.com|_flowGithub|gh-as-agent/);
});

test("the flow-board-release route (#2754) re-reads a fresh board, swaps via the pure helper and logs every swap", () => {
  const i = SRC.indexOf("const flowBoardReleaseMatch");
  assert.ok(i > 0);
  const route = SRC.slice(i, SRC.indexOf("// GET /internal/teams/:teamId/pool-control", i));
  // Only on a FRESH board — never the cached snapshot the page was showing.
  assert.match(route, /flowClaimRelease\.planClaimRelease\(await getTeamFlowBoard\(teamId, \{ refresh: true \}\), rowId\)/);
  assert.match(route, /if \(!plan\.ok\) return sendJson\(res, plan\.status/);
  assert.match(route, /flowClaimRelease\.swapClaimLabel\(/);
  assert.match(route, /githubEventLog\.record\(flowClaimRelease\.buildClaimReleaseLogEntry\(\{ teamId, rowId, actor, claim, result \}\)\)/);
  assert.match(route, /_flowBoardCache\.delete\(teamId\)/);
  // The swap goes through the repo's environment token, never a hard-coded host.
  assert.match(route, /resolveRepoGithubTokenId\(claim\.repo\)/);
  assert.match(route, /githubApiBase\(\)/);
  assert.doesNotMatch(route, /api\.github\.com|gh-as-agent|wakeGithubLabelListeners/);
});

test("_flowTeamMembers carries each member's enabled flag for the board (#2754)", () => {
  assert.match(body("function _flowTeamMembers("), /enabled: cfg\.enabled !== false,/);
});
