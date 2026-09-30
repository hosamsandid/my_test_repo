'use strict';

// Wiring for #2596: the GitHub Event Log names the pool INSTANCE a pooled
// role's dispatch ran on. The pure halves are covered elsewhere
// (github-event-log.test.js applyPoolDecision, github-poller.test.js fan-out);
// these source-text assertions pin the producer links in orchestrator.js, which
// starts a server on require. Each names the mutation that makes it fire.
// Run: node --test orchestrator/event-log-pool-instance-wiring.test.js

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ORCH = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function slice(src, startNeedle, endNeedle, max = 4000) {
  const start = src.indexOf(startNeedle);
  if (start === -1) return '';
  const end = src.indexOf(endNeedle, start);
  return src.slice(start, end === -1 ? Math.min(src.length, start + max) : end);
}

test('enqueuePending hands its decision to the pool router', () => {
  // Dropping the third argument leaves every pooled row naming the role again.
  assert.match(ORCH, /const pooled = routePooledDispatch\(agentId, entry, decision\);/);
});

test('routePooledDispatch reports the instance for BOTH reuse and spawn (AC1, AC2)', () => {
  const route = slice(ORCH, 'function routePooledDispatch(agentId, entry, out = null) {', '\n}\n', 7000);
  const stamp = route.indexOf('if (out) out.instanceId = decision.instanceId;');
  assert.notEqual(stamp, -1, 'the routed instance must be written to the out-parameter');
  // Below the reuse branch, the first event of every ticket — the one that
  // spawns the instance — would lose it.
  assert.ok(stamp < route.indexOf("if (decision.action === 'reuse') {"), 'stamped before the reuse/spawn split');
  // Above the refuse branch, a max-instances refusal (which falls through to
  // the role) would claim an instance that never ran it.
  assert.ok(stamp > route.indexOf("if (decision.action === 'refuse') {"), 'never stamped for a refusal');
});

test('a pool pause/drain hold is reported as held with a pool-<state> reason (AC6)', () => {
  const route = slice(ORCH, 'function routePooledDispatch(agentId, entry, out = null) {', '\n}\n', 7000);
  assert.match(
    route,
    /if \(out && agentPool\.POOL_CONTROL_STATES\.includes\(decision\.reason\)\) \{\n\s+Object\.assign\(out, \{ held: true, reason: `pool-\$\{decision\.reason\}` \}\);/,
    'the hold must be reported with the control state that caused it',
  );
});

test('the label fast path and the manual re-fire fold the verdict into their logged outcome', () => {
  const fast = slice(ORCH, 'async function wakeGithubLabelListeners(', '\n}\n', 6000);
  assert.match(fast, /enqueuePending\(l\.agentId, \{[\s\S]*?\}, \{ decision \}\);/, 'the fast path must pass a decision');
  assert.match(fast, /githubEventLog\.applyPoolDecision\(\{[\s\S]*?\}, decisions\.get\(l\)\)/);
  const refire = slice(ORCH, 'const ok = enqueuePending(agentId, githubRefire.buildRefirePendingEntry({', 'githubEventLog.record(logEntry);', 3000);
  assert.match(refire, /\}\), \{ decision \}\);/, 'the re-fire must pass a decision');
  assert.match(refire, /githubEventLog\.applyPoolDecision\(\s*\{[^}]*\}, decision\)/);
});
