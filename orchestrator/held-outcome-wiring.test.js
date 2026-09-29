'use strict';

// Wiring for the held-outcome label (PR4): the GitHub Event Log must record
// `held` instead of a false `delivered` for a dispatch the flow's WIP lane holds.
// The chain has three links and the ported test set covers only the middle one:
//
//   orchestrator.enqueuePending  --writes-->  decision  --read by-->  _fanOutBatch
//        (producer, here)         (the plumb, here)        (github-poller.test.js)
//
// Both outer links were verified silent: disabling the held assignment in
// orchestrator.js, or dropping the `{ decision }` argument in _enqueuePending,
// left all 2643 orchestrator tests green — the feature would be dead in
// production with a green CI. Source-text assertions because orchestrator.js
// starts a server on require; each is paired below with the mutation that makes
// exactly it fire.
// Run: node --test orchestrator/held-outcome-wiring.test.js

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ORCH = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');
const POLLER = fs.readFileSync(path.join(__dirname, 'github-poller.js'), 'utf8');

function slice(src, startNeedle, endNeedle, max = 4000) {
  const start = src.indexOf(startNeedle);
  if (start === -1) return '';
  const end = src.indexOf(endNeedle, start);
  return src.slice(start, end === -1 ? Math.min(src.length, start + max) : end);
}

test('enqueuePending takes a `decision` out-parameter and defaults it to not-held', () => {
  assert.match(
    ORCH,
    /function enqueuePending\(agentId, entry, \{ admissionChecked = false, decision = null \} = \{\}\)/,
    'the out-parameter must be an accepted option, not an undeclared global',
  );
  const body = slice(ORCH, 'function enqueuePending(agentId, entry', 'function resolveRepoGithubTokenId', 5000);
  // Default FIRST, so a caller reusing an object cannot read a stale `held:true`
  // from an earlier dispatch as this one's outcome.
  const init = body.indexOf('if (decision) decision.held = false;');
  const gate = body.indexOf('if (!admissionChecked) {');
  assert.notEqual(init, -1, 'must initialise decision.held = false');
  assert.ok(init < gate, 'the default must be set before the admission gate can set it true');
});

test('the held branch reports held plus the context the label needs', () => {
  // Scoped to the hold branch: an assignment anywhere else in the function would
  // not make a held dispatch report itself.
  const body = slice(ORCH, 'if (!d.admit) {', 'const p = pendingPath(agentId);', 1200);
  // The CONDITION is part of the assertion, not just the assignment: neutering
  // the guard to `if (false)` leaves every assignment line textually intact, and
  // that mutation survives the whole 2643-test suite otherwise.
  assert.match(
    body,
    /if \(decision\) \{\s*\n\s+decision\.held = true;/,
    'the hold must be reported to the caller, guarded only on decision being present',
  );
  assert.match(body, /decision\.reason = 'wip';/, 'the reason distinguishes it from other non-deliveries');
  assert.match(body, /decision\.wipLimit = flow\.wipLimit;/, 'the label names the limit that is holding it');
  assert.match(body, /decision\.ticketKey = d\.ticketKey;/, 'the log line names the held ticket');
});

test('_enqueuePending forwards the decision to the injected enqueuePending', () => {
  const body = slice(POLLER, '_enqueuePending(agentId, entry, decision) {', 'const pendingPath = path.join');
  // The orchestrator injects enqueuePending BARE (not wrapped), so this call is
  // the only thing that connects producer to consumer. Passing two arguments
  // here silently disables the whole feature.
  assert.match(
    body,
    /this\.enqueuePending\(agentId, entry, decision \? \{ decision \} : undefined\)/,
    'the decision must reach the real enqueuePending as its options argument',
  );
});

test('_enqueue creates the decision, passes it down and returns it to the fan-out', () => {
  const body = slice(POLLER, '_enqueue(agentId, triggerId, key, ghEvent', '\n  }\n', 2500);
  assert.match(body, /const decision = \{\};/, 'must create the out-parameter');
  assert.match(body, /this\._enqueuePending\(agentId, entry, decision\);/, 'must pass it down');
  assert.match(body, /return decision;/, 'must hand it back — the fan-out has no other way to learn the outcome');
  // The two log lines are how an operator sees a hold in the orchestrator log at
  // all; without the split, a hold is indistinguishable from a queue.
  assert.match(body, /\[GH-Poller\] Held \$\{key\}/, 'a hold must log as held');
});

test('the fan-out records the true status and never overwrites the digest path', () => {
  const body = slice(POLLER, 'if (decision && decision.held) {', '\n    }\n', 600);
  assert.match(body, /it\.outcome\.status = 'held';/);
  assert.match(body, /it\.outcome\.reason = 'wip';/);
  assert.match(body, /if \(decision\.wipLimit != null\) it\.outcome\.wipLimit = decision\.wipLimit;/);
  assert.match(body, /\} else \{\n\s+it\.outcome\.status = 'delivered';/, 'not-held must still record delivered');
  // The digest path stamps its own 'delivered' a few dozen lines up and must not
  // be reached by this branch — a digest is bundled, never held.
  const digest = slice(POLLER, 'digest', 'if (decision && decision.held) {', 20000);
  assert.ok(digest.length > 0);
  assert.equal(
    (POLLER.match(/it\.outcome\.status = 'held';/g) || []).length, 1,
    'exactly one place may stamp held',
  );
});

test('a held outcome carries wipLimit through the recorded-outcome mapping', () => {
  // The record written to the event log is built from a destructure; a field it
  // does not list is dropped silently, so the label would degrade to `held (WIP)`
  // on every row.
  assert.match(POLLER, /if \(wipLimit !== undefined\) o\.wipLimit = wipLimit;/);
});
