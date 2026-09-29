'use strict';

// Source-reading drift guard for the admission-control wiring (#2114, #651).
//
// Every judgement admission control makes is unit-tested in the pure
// `admission-control.test.js`. What CANNOT be tested there is that the
// orchestrator actually calls it in the right place and in the right order —
// `orchestrator.js` boots two HTTP listeners on require, so it cannot be
// imported here. These are therefore assertions over its source, written as a
// dict of NAMED predicates so each one can be proven non-vacuous by a mutation
// that makes exactly it fire.
//
// The properties guarded are the ones whose loss would be SILENT: a gate moved
// below the queue write still passes every unit test, and a lane saved before
// the promoted entries are enqueued loses work only on a crash.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

// A bounded slice between two anchors. `maxSpan` is not decoration: an end
// anchor that matches far past the intended block silently swallows unrelated
// code and turns an "X is not in here" assertion into a vacuous pass.
function slice(src, startAnchor, endAnchor, maxSpan) {
  const a = src.indexOf(startAnchor);
  assert.notEqual(a, -1, `start anchor not found: ${startAnchor}`);
  const b = src.indexOf(endAnchor, a + startAnchor.length);
  assert.notEqual(b, -1, `end anchor not found after start: ${endAnchor}`);
  const span = b - a;
  assert.ok(span <= maxSpan, `slice ${startAnchor} → ${endAnchor} is ${span} chars, expected ≤ ${maxSpan}`);
  return src.slice(a, b);
}

// ── the named checks ────────────────────────────────────────────────────────

const CHECKS = {
  // The gate must run BEFORE the queue write, or a dispatch is already in
  // `pending-triggers.json` by the time it is "held".
  'gate-precedes-queue-write'(src) {
    const body = slice(src, 'function enqueuePending(agentId, entry', 'function resolveRepoGithubTokenId', 5000);
    const gate = body.indexOf('admissionControl.admit(');
    const write = body.indexOf('pending.push(');
    return gate !== -1 && write !== -1 && gate < write;
  },

  // The promotion path must be able to re-enter without being re-gated, or a
  // promoted dispatch would be held again forever.
  'promotion-bypass-exists'(src) {
    return /function enqueuePending\(agentId, entry, \{ admissionChecked = false(?:, decision = null)? \} = \{\}\)/.test(src)
      && /if \(!admissionChecked\) \{/.test(src)
      && /enqueuePending\(r\.agentId, r\.entry, \{ admissionChecked: true \}\)/.test(src);
  },

  // A held dispatch is queued, not failed. Returning false here would make an
  // `aee-wake` producer (#2030) report a delivery failure for work that will
  // fire as soon as capacity frees.
  'hold-reports-enqueued'(src) {
    const body = slice(src, 'if (!d.admit) {', 'const p = pendingPath(agentId);', 1200);
    return /return true;/.test(body) && !/return false;/.test(body);
  },

  // The limit is read through the shared predicate, so "positive integer or no
  // limit at all" cannot be re-decided differently on the dispatch path.
  'limit-read-through-shared-predicate'(src) {
    const body = slice(src, 'function resolveAdmissionFlow(agentId)', 'function enqueuePending', 1600);
    return /admissionControl\.limitInForce\(/.test(body) && /return wipLimit === null \? null :/.test(body);
  },

  // Fail closed: a repo is reported as swept only after BOTH fetches returned.
  // Pushing it before the try, or in a finally, would let a GitHub outage
  // release every ticket and open the lane.
  'sweep-fails-closed-on-fetch-error'(src) {
    const body = slice(src, 'async function admissionSweepTeam(teamId)', 'const reconciled = admissionControl.reconcileInFlight', 4000);
    const cont = body.indexOf('errors.push(`${repo}: ${err.message}`);');
    const push = body.indexOf('repos.push(repo);');
    return cont !== -1 && push !== -1 && cont < push && /continue;\n    \}\n    repos\.push\(repo\);/.test(body);
  },

  // Enqueue first, persist second (concept §4.2 step 3). The reverse order
  // drops a held entry from the lane without putting it anywhere.
  'promote-enqueues-before-saving-lane'(src) {
    const body = slice(src, 'const promoted = admissionControl.promoteHeld(', 'return {\n    teamId,\n    repos,', 1600);
    const enq = body.indexOf('enqueuePending(r.agentId, r.entry, { admissionChecked: true });');
    const save = body.indexOf('saveAdmissionLane(teamId, promoted.lane);');
    return enq !== -1 && save !== -1 && enq < save;
  },

  // An idle flow costs zero GitHub requests, which is what makes a 60s tick
  // affordable for every team on the installation.
  'idle-lane-short-circuits-before-any-request'(src) {
    // The slice ends at the first line that does real work, so BOTH early
    // returns must be inside it — that is the whole claim.
    const body = slice(src, 'async function admissionSweepTeam(teamId)', 'const { members, envIds } = _flowTeamMembers(teamId);', 1300);
    return /limitInForce\(teamCfg && teamCfg\.wipLimit\)/.test(body)
      && /if \(wipLimit === null\) return null;/.test(body)
      && /if \(!admissionControl\.laneNeedsRefresh\(lane\)\) return null;/.test(body);
  },

  // The tick is deliberately NOT maintenance-gated: it starts no work, it only
  // reconciles a ledger and moves entries between two durable queues (and the
  // agent-side drain is already gated). Asserted on the mechanism, not on the
  // word "maintenance", so the reasoning can stay in a comment.
  'tick-does-not-gate-on-maintenance'(src) {
    const body = slice(src, 'const runAdmissionTick = async () => {', 'const admissionTimer = setInterval', 1600);
    return !/readMaintenanceState\(/.test(body);
  },

  // One team's failure must not stop the others, and must not escape the timer.
  'tick-isolates-per-team-failures'(src) {
    const body = slice(src, 'const runAdmissionTick = async () => {', 'const admissionTimer = setInterval', 1600);
    return /await admissionSweepTeam\(teamId\);/.test(body)
      && /\} catch \(err\) \{/.test(body)
      && /admissionBusy = false;/.test(body);
  },

  // Registered and unref'd like every other orchestrator sweep, so it cannot
  // hold the process open in a test or a short-lived run.
  'tick-timer-registered-and-unrefd'(src) {
    return /const admissionTimer = setInterval\(runAdmissionTick, ADMISSION_TICK_INTERVAL_MS\);/.test(src)
      && /if \(typeof admissionTimer\.unref === "function"\) admissionTimer\.unref\(\);/.test(src);
  },

  // The lane lives beside the team agent's other control files, so an isolated
  // per-agent volume puts it in the same place the pending queue goes.
  'lane-path-uses-control-or-pool'(src) {
    return /function admissionLanePath\(teamId\) \{\n  return controlOrPoolPath\(teamId, "admission-lane\.json"\);/.test(src);
  },

  // An unreadable lane degrades to empty rather than throwing on the dispatch
  // path — a corrupt JSON file must not stop every wake in the installation.
  'unreadable-lane-degrades-to-empty'(src) {
    const body = slice(src, 'function loadAdmissionLane(teamId)', 'function saveAdmissionLane', 700);
    return /return admissionControl\.emptyLane\(\);/.test(body) && /\} catch \{/.test(body);
  },

  // The team config is the only place the orchestrator reads a limit from, and
  // it re-validates rather than trusting the console's normalizer.
  'team-config-write-revalidates-the-limit'(src) {
    return /\.\.\.\(Number\.isInteger\(extra\.wipLimit\) && extra\.wipLimit >= 1\n          \? \{ wipLimit: extra\.wipLimit \} : \{\}\)/.test(src);
  },
};

function runCheck(src) {
  for (const [name, fn] of Object.entries(CHECKS)) {
    let ok = false;
    try {
      ok = fn(src);
    } catch {
      return name; // a slice that no longer resolves IS the drift
    }
    if (!ok) return name;
  }
  return null;
}

// ── the guard ───────────────────────────────────────────────────────────────

test('#2114: the admission-control wiring in orchestrator.js is intact', () => {
  assert.equal(runCheck(SRC), null);
});

// ── each check is proven non-vacuous by a mutation that makes exactly it fire ─

// Each entry is `[check, find, replace]`. `find` is asserted to occur EXACTLY
// ONCE in the source before the substitution runs: an anchor that also matches
// inside a neighbouring function silently mutates the wrong code, and the
// "wrong check fired" failure that produces is far less obvious than it sounds.
const MUTATIONS = [
  // The literal pre-#2114 bug: no gate at all.
  ['gate-precedes-queue-write',
    'const d = admissionControl.admit({ lane, wipLimit: flow.wipLimit, agentId, entry });',
    'const d = { admit: true, lane };'],
  // The queue write moved ABOVE the gate — every unit test still passes, and
  // the dispatch is already in `pending-triggers.json` when it is "held".
  ['gate-precedes-queue-write',
    '  if (!admissionChecked) {\n    const flow = resolveAdmissionFlow(agentId);',
    '  pending.push(entry);\n  if (!admissionChecked) {\n    const flow = resolveAdmissionFlow(agentId);'],
  ['promotion-bypass-exists',
    'enqueuePending(r.agentId, r.entry, { admissionChecked: true });',
    'enqueuePending(r.agentId, r.entry);'],
  ['hold-reports-enqueued',
    '// merely queued behind a full lane.\n        return true;',
    '// merely queued behind a full lane.\n        return false;'],
  ['limit-read-through-shared-predicate',
    'const wipLimit = admissionControl.limitInForce(teamCfg && teamCfg.wipLimit);\n  return wipLimit === null ? null :',
    'const wipLimit = (teamCfg && teamCfg.wipLimit) || null;\n  return wipLimit === null ? null :'],
  // Fail OPEN: swallow the fetch error and report the repo as swept anyway,
  // which lets a GitHub outage release every ticket and open the lane.
  // The anchor carries the `errors.push` line above the `continue` on purpose:
  // #2115's ticket-ledger sweep grew the same continue/}/repos.push shape a few
  // hundred lines up, and the bare three lines stopped being unique. The check
  // itself was already scoped to `admissionSweepTeam`'s body — it is the anchor
  // that has to name which sweep it is sabotaging.
  ['sweep-fails-closed-on-fetch-error',
    'errors.push(`${repo}: ${err.message}`);\n      continue;\n    }\n    repos.push(repo);',
    'errors.push(`${repo}: ${err.message}`);\n      /* swallowed */\n    }\n    repos.push(repo);'],
  ['promote-enqueues-before-saving-lane',
    '  for (const r of promoted.release) {\n    enqueuePending(r.agentId, r.entry, { admissionChecked: true });',
    '  saveAdmissionLane(teamId, promoted.lane);\n  for (const r of promoted.release) {\n    enqueuePending(r.agentId, r.entry, { admissionChecked: true });'],
  ['idle-lane-short-circuits-before-any-request',
    '  if (!admissionControl.laneNeedsRefresh(lane)) return null;\n', ''],
  ['tick-does-not-gate-on-maintenance',
    '    if (admissionBusy) return; // overlap guard — a slow sweep must not stack\n    admissionBusy = true;',
    '    if (admissionBusy) return;\n    const maint = readMaintenanceState();\n    admissionBusy = true;'],
  ['tick-isolates-per-team-failures',
    '          await admissionSweepTeam(teamId);', '          void teamId;'],
  ['tick-timer-registered-and-unrefd',
    'if (typeof admissionTimer.unref === "function") admissionTimer.unref();', ''],
  ['lane-path-uses-control-or-pool',
    'return controlOrPoolPath(teamId, "admission-lane.json");',
    'return path.join("/tmp", `${teamId}-admission-lane.json`);'],
  ['unreadable-lane-degrades-to-empty',
    '    return admissionControl.emptyLane();', '    throw new Error("unreadable lane");'],
  ['team-config-write-revalidates-the-limit',
    '...(Number.isInteger(extra.wipLimit) && extra.wipLimit >= 1\n          ? { wipLimit: extra.wipLimit } : {}),',
    '...(extra.wipLimit ? { wipLimit: extra.wipLimit } : {}),'],
];

test('#2114: every wiring check is proven by a mutation that makes exactly it fire', () => {
  const fired = new Set();
  for (const [expected, find, replace] of MUTATIONS) {
    const hits = SRC.split(find).length - 1;
    assert.equal(hits, 1, `mutation anchor for ${expected} matches ${hits}x (must be exactly 1): ${find.slice(0, 60)}`);
    const mutated = SRC.replace(find, replace);
    assert.notEqual(mutated, SRC, `mutation for ${expected} did not change the source`);
    assert.equal(runCheck(mutated), expected, `mutation for ${expected} fired the wrong check`);
    fired.add(expected);
  }
  // No check may be untested — a guard nothing can falsify guards nothing.
  assert.deepEqual([...Object.keys(CHECKS)].filter((k) => !fired.has(k)), []);
});
