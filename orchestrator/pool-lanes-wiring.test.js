'use strict';

// Source-reading drift guard for the pool-lanes orchestrator wiring (#2273,
// epic #2251 — the read-only "Live surface" from concept Amendment 2 A2.2).
// The pure core (`pool-instance-lanes.js`'s `buildTeamPoolLanes`) is fully
// unit-tested; this file guards the properties that live ONLY in
// orchestrator.js's impure half (same technique as `pool-control-wiring.test.js`
// — orchestrator.js cannot be `require`d in a unit test, it boots the
// container runtime, the webhook server and reaches for Matrix):
//
//   1. the route is maintenance-gated exactly like `tickets`/`flow-anomalies`
//      (a GitHub sweep must stay quiet during the window);
//   2. it feeds the pure core each pooled role's LIVE instances plus the
//      shared ticket ledger, not a re-derived subset;
//   3. `_liveInstancesForRole` carries the same identity fields the
//      hard-timeout reaper trusts (`poolRepo`/`poolItem`/`poolSpawnedAt`),
//      so the lane view can never show a runtime tag the reaper disagrees
//      with.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FULL_SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
}
const SRC = stripComments(FULL_SRC);

function fn(name, { async: isAsync = false } = {}) {
  const marker = `${isAsync ? 'async ' : ''}function ${name}(`;
  const start = SRC.indexOf(marker);
  assert.ok(start > 0, `function ${name} not found — this guard needs re-pointing`);
  const rest = SRC.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function /);
  const end = nextFn === -1 ? SRC.length : start + 1 + nextFn;
  return SRC.slice(start, end);
}

test('the guard is not vacuous: _liveInstancesForRole survives the comment strip with its body intact', () => {
  assert.ok(fn('_liveInstancesForRole').length > 200);
});

test('_liveInstancesForRole reads the same identity fields the hard-timeout reaper trusts', () => {
  const src = fn('_liveInstancesForRole');
  assert.match(src, /repo: cfg\.poolRepo \|\| null/);
  assert.match(src, /itemKey: cfg\.poolItem != null \? Number\(cfg\.poolItem\) : null/);
  assert.match(src, /spawnedAt: cfg\.poolSpawnedAt \|\| null/);
  // Same "is this actually a live instance of THIS role" test as
  // `_liveInstanceIdsForRole` — a drift here would silently show/hide
  // instances the reaper's own count disagrees with.
  assert.match(src, /if \(!cfg \|\| !cfg\.poolInstance \|\| cfg\.poolOf !== roleFullId\) continue;/);
});

test('GET /internal/teams/:teamId/pool-lanes is maintenance-gated like tickets/flow-anomalies', () => {
  const start = SRC.indexOf('const poolLanesMatch =');
  assert.ok(start > 0, 'poolLanesMatch route not found');
  const body = SRC.slice(start, SRC.indexOf("const poolControlSetMatch ="));
  assert.match(body, /readMaintenanceState\(\)/);
  assert.match(
    body,
    /if \(maint && maint\.active\) \{\s*\n\s*return sendJson\(res, 200, \{\s*\n\s*teamId, maintenance: true, roles: \[\]/,
    'an active maintenance window must short-circuit before the ledger sweep, returning an empty (not stale) roles list',
  );
});

test('mutation-proved: dropping the maintenance short-circuit would fail the check above', () => {
  const start = SRC.indexOf('const poolLanesMatch =');
  const body = SRC.slice(start, SRC.indexOf("const poolControlSetMatch ="));
  const buggy = body.replace(
    /if \(maint && maint\.active\) \{[\s\S]*?\n {10}\}\n/,
    '',
  );
  assert.doesNotMatch(buggy, /maintenance: true, roles: \[\]/);
});

test('GET /internal/teams/:teamId/pool-lanes feeds the pure core each role\'s live instances plus the shared ticket ledger', () => {
  const start = SRC.indexOf('const poolLanesMatch =');
  assert.ok(start > 0, 'poolLanesMatch route not found');
  const body = SRC.slice(start, SRC.indexOf("const poolControlSetMatch ="));
  assert.match(body, /const ledger = await computeTeamTicketLedger\(teamId\)/);
  assert.match(body, /instances: _liveInstancesForWithWaiting\(role\.id, poolWaiting\)/);
  assert.match(SRC, /function _liveInstancesForWithWaiting[\s\S]*?_liveInstancesForRole\(roleFullId\)/, '#2789: still built on the live instances');
  assert.match(body, /poolInstanceLanes\.buildTeamPoolLanes\(roleInputs, ledger\.tickets \|\| \[\]\)/);
  assert.match(body, /maxRuntimeMs: role\.pool\.teardown\.maxRuntimeMs/, 'the hard-timeout budget must be threaded through, or the pure core can never emit timed-out');
});

test('mutation-proved: dropping maxRuntimeMs from the role input would fail the check above', () => {
  const start = SRC.indexOf('const poolLanesMatch =');
  const body = SRC.slice(start, SRC.indexOf("const poolControlSetMatch ="));
  const buggy = body.replace(/\s*maxRuntimeMs: role\.pool\.teardown\.maxRuntimeMs,\n/, '\n');
  assert.doesNotMatch(buggy, /maxRuntimeMs: role\.pool\.teardown\.maxRuntimeMs/);
});
