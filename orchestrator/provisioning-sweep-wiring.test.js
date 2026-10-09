'use strict';

// Source-reading drift guard for the stuck-`_provisioning` reaper's orchestrator
// wiring (#2493). The pure core (provisioning-sweep.js) is unit-tested; the
// properties the ticket's acceptance criteria name — a periodic tick following
// the established pattern, both creation paths stamped + covered, the reap going
// through the real delete route, the operator-visible log row, the not-touched
// young config, and the overlap guard — live only in orchestrator.js's impure
// half. orchestrator.js can't be required in a unit test (it boots the container
// runtime, the webhook server and reaches for Matrix), so this reads its source —
// the agent-pool-wiring.test.js / flow-supervisor-wiring.test.js technique.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FULL_SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

// Strip comments first (anchored to line start on both forms, the
// flow-supervisor-wiring.test.js discipline) so a property named in a comment
// can't satisfy an assertion about the code.
function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
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

// `runProvisioningReapTick` is an arrow assigned inside `main()`, not a
// `function` declaration.
function arrowConst(name) {
  const start = SRC.indexOf(`const ${name} = async () => {`);
  assert.ok(start > 0, `const ${name} not found — this guard needs re-pointing`);
  const rest = SRC.slice(start);
  const end = rest.indexOf('\n  const ', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

test('the guard is not vacuous: every slice survives the comment strip intact', () => {
  assert.ok(fn('provisioningReapSweep').length > 200, 'provisioningReapSweep came back empty');
  assert.ok(arrowConst('runProvisioningReapTick').length > 100, 'runProvisioningReapTick came back empty');
});

test('the module is required and the sweep uses its pure decisions', () => {
  assert.match(SRC, /require\(["']\.\/provisioning-sweep["']\)/);
  const src = fn('provisioningReapSweep');
  assert.match(src, /provisioningSweep\.provisioningAgeMs\(/);
  assert.match(src, /provisioningSweep\.isStuckProvisioning\(/);
  assert.match(src, /provisioningSweep\.provisioningOrigin\(/);
});

test('AC1/AC5: the sweep is age-gated and only acts on _provisioning:true', () => {
  const src = fn('provisioningReapSweep');
  // Only stuck records proceed — the isStuck check must `continue` past the rest.
  assert.match(src, /if \(!cfg \|\| cfg\._provisioning !== true\) continue;/);
  assert.match(src, /if \(!provisioningSweep\.isStuckProvisioning\([\s\S]*?\) continue;/);
});

test('AC2/edge-case: the reap goes through the real delete route, not a hand-rolled path', () => {
  const src = fn('provisioningReapSweep');
  assert.match(src, /_internalSelfDelete\(id\)/);
});

test('AC3: every action records an operator-visible github-event-log row', () => {
  const src = fn('provisioningReapSweep');
  assert.match(src, /githubEventLog\.record\(/);
  assert.match(src, /provisioningSweep\.PROVISIONING_SWEEP_KEY/);
  assert.match(src, /provisioningSweep\.buildProvisioningSweepLogEvent\(/);
  assert.match(src, /provisioningSweep\.buildProvisioningSweepLogFields\(/);
  // Both success and failure are logged (the row is not gated on `reaped`).
  assert.match(src, /reaped \? "reaped" : "reap-failed"/);
});

test('AC4: both creation paths stamp _provisioningAt so the sweep can age them', () => {
  // Standalone placeholder (resolveAndReserveAgentId) and team-member/pool path.
  const stamps = SRC.match(/_provisioningAt: new Date\(\)\.toISOString\(\)/g) || [];
  assert.ok(stamps.length >= 2, `expected both provisioning write sites to stamp _provisioningAt, found ${stamps.length}`);
  // The success/import path clears the stamp alongside the flag.
  assert.match(SRC, /delete newConfig\._provisioning;/);
  assert.match(SRC, /delete newConfig\._provisioningAt;/);
});

test('the tick follows the established pattern: overlap guard + unref + interval', () => {
  const src = arrowConst('runProvisioningReapTick');
  assert.match(src, /if \(provisioningReapBusy\) return;/); // edge case 2: no double-act across ticks
  assert.match(src, /provisioningReapBusy = true;/);
  assert.match(src, /provisioningReapBusy = false;/);
  assert.match(src, /fleet = buildTickFleet\("provisioning-reap"\);/); // #569
  assert.match(src, /await provisioningReapSweep\(Date\.now\(\), \{ fleet \}\)/);
  // The timer is registered and unref'd like every sibling tick.
  assert.match(SRC, /const provisioningReapTimer = setInterval\(runProvisioningReapTick, PROVISIONING_REAP_TICK_INTERVAL_MS\);/);
  assert.match(SRC, /if \(typeof provisioningReapTimer\.unref === "function"\) provisioningReapTimer\.unref\(\);/);
});

test('the tick is NOT maintenance-gated (cleanup, like the pool-reap tick)', () => {
  const src = arrowConst('runProvisioningReapTick');
  assert.doesNotMatch(src, /readMaintenanceState\(\)/);
});
