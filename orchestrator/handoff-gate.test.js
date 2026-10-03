'use strict';

// #2795: the pure hand-off gate — normalisation, hold decisions, comments.
// Run: node --test orchestrator/handoff-gate.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('./handoff-gate');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const NOW = Date.parse('2026-10-03T12:00:00Z');

const pr = (over = {}) => ({ number: 7, sha: SHA_A, baseRef: 'main', labels: ['ready-for-review'], ...over });
const entry = (over = {}) => ({ sha: SHA_A, ci: 'pending', merge: 'pending', failingChecks: [], ...over });
const hold = (gate = { ci: true, conflict: true }, over = {}) => ({
  agentId: 'rev', triggerId: 't', number: 7, key: 'pull_request.labeled', wakeLabel: 'ready-for-review',
  gate: g.normalizeGate(gate), heldAt: new Date(NOW).toISOString(), ...over,
});

test('normalizeGate: defaults, both-off = no gate, junk rejected', () => {
  assert.deepEqual(g.normalizeGate({ ci: true }), { ci: true, conflict: false, failureLabel: 'revisions-required', timeoutMinutes: 60 });
  assert.deepEqual(g.normalizeGate({ conflict: true, failureLabel: ' ci-red ', timeoutMinutes: 15 }),
    { ci: false, conflict: true, failureLabel: 'ci-red', timeoutMinutes: 15 });
  assert.equal(g.normalizeGate({ ci: false, conflict: false }), null);
  assert.equal(g.normalizeGate(null), null);
  assert.equal(g.normalizeGate([]), null);
  assert.equal(g.normalizeGate({ ci: 'yes' }), null);
  assert.equal(g.normalizeGate({ ci: true, timeoutMinutes: 0 }).timeoutMinutes, 60);
  assert.equal(g.normalizeGate({ ci: true, timeoutMinutes: 1.5 }).timeoutMinutes, 60);
  assert.equal(g.normalizeGate({ ci: true, failureLabel: '' }).failureLabel, 'revisions-required');
});

test('gateApplies: PR hand-off events only', () => {
  const gate = g.normalizeGate({ ci: true });
  for (const k of ['pull_request.labeled', 'pull_request.opened', 'pull_request.reopened']) assert.equal(g.gateApplies(gate, k), true);
  for (const k of ['issues.labeled', 'push', 'pull_request.checks_passed', 'pull_request.closed']) assert.equal(g.gateApplies(gate, k), false);
  assert.equal(g.gateApplies(null, 'pull_request.labeled'), false);
});

test('evaluateHold: release when every enabled gate is satisfied (passed / none, clean)', () => {
  assert.equal(g.evaluateHold(hold(), { pr: pr(), entry: entry({ ci: 'passed', merge: 'clean' }), now: NOW }).action, 'release');
  assert.equal(g.evaluateHold(hold(), { pr: pr(), entry: entry({ ci: 'none', merge: 'clean' }), now: NOW }).action, 'release');
  // Only CI gated: the merge verdict does not matter.
  assert.equal(g.evaluateHold(hold({ ci: true }), { pr: pr(), entry: entry({ ci: 'passed', merge: 'conflict' }), now: NOW }).action, 'release');
  // Only conflict gated: CI may still run.
  assert.equal(g.evaluateHold(hold({ conflict: true }), { pr: pr(), entry: entry({ ci: 'pending', merge: 'clean' }), now: NOW }).action, 'release');
});

test('evaluateHold: wait while a gate is pending, naming what it waits for', () => {
  const d = g.evaluateHold(hold(), { pr: pr(), entry: entry({ ci: 'pending', merge: 'clean' }), now: NOW });
  assert.deepEqual(d, { action: 'wait', pending: ['ci'], sha: SHA_A });
  assert.deepEqual(g.evaluateHold(hold(), { pr: pr(), entry: null, now: NOW }).pending, ['ci', 'conflict']);
});

test('evaluateHold: fail on CI failed (with the failing checks) or on a conflict', () => {
  const d = g.evaluateHold(hold(), { pr: pr(), entry: entry({ ci: 'failed', failingChecks: ['build'] }), now: NOW });
  assert.deepEqual(d, { action: 'fail', gate: 'ci', sha: SHA_A, failingChecks: ['build'] });
  const c = g.evaluateHold(hold(), { pr: pr(), entry: entry({ ci: 'passed', merge: 'conflict' }), now: NOW });
  assert.deepEqual(c, { action: 'fail', gate: 'conflict', sha: SHA_A, baseRef: 'main' });
  // A gate that is off never fails.
  assert.equal(g.evaluateHold(hold({ conflict: true }), { pr: pr(), entry: entry({ ci: 'failed', merge: 'pending' }), now: NOW }).action, 'wait');
});

test('evaluateHold: a verdict of a superseded commit neither releases nor fails (AC8)', () => {
  const newHead = pr({ sha: SHA_B });
  assert.equal(g.evaluateHold(hold(), { pr: newHead, entry: entry({ ci: 'passed', merge: 'clean' }), now: NOW }).action, 'wait');
  assert.equal(g.evaluateHold(hold(), { pr: newHead, entry: entry({ ci: 'failed', merge: 'conflict' }), now: NOW }).action, 'wait');
});

test('evaluateHold: timeout after timeoutMinutes from the hold, default 60 (AC7)', () => {
  const h = hold();
  const e = entry({ ci: 'pending', merge: 'clean' });
  assert.equal(g.evaluateHold(h, { pr: pr(), entry: e, now: NOW + 59 * 60_000 }).action, 'wait');
  assert.deepEqual(g.evaluateHold(h, { pr: pr(), entry: e, now: NOW + 60 * 60_000 }), { action: 'timeout', pending: ['ci'], sha: SHA_A });
  const short = hold({ ci: true, timeoutMinutes: 5 });
  assert.equal(g.evaluateHold(short, { pr: pr(), entry: e, now: NOW + 5 * 60_000 }).action, 'timeout');
  // A final verdict wins over an elapsed timeout.
  assert.equal(g.evaluateHold(h, { pr: pr(), entry: entry({ ci: 'passed', merge: 'clean' }), now: NOW + 2 * 3600_000 }).action, 'release');
});

test('evaluateHold: cancel when the PR is gone from a complete list, or the wake label is removed', () => {
  assert.deepEqual(g.evaluateHold(hold(), { pr: null, listComplete: true, now: NOW }), { action: 'cancel', reason: 'closed' });
  assert.equal(g.evaluateHold(hold(), { pr: null, listComplete: false, now: NOW }).action, 'wait');
  assert.deepEqual(g.evaluateHold(hold(), { pr: pr({ labels: ['other'] }), entry: entry(), now: NOW }), { action: 'cancel', reason: 'label-removed' });
  // Unknown labels (an older query) never cancel.
  assert.equal(g.evaluateHold(hold(), { pr: pr({ labels: undefined }), entry: entry(), now: NOW }).action, 'wait');
  // An opened/reopened hold has no wake label to lose.
  assert.equal(g.evaluateHold(hold(undefined, { wakeLabel: null }), { pr: pr({ labels: [] }), entry: entry(), now: NOW }).action, 'wait');
});

test('newHold: stores the gate, the head and a compact event', () => {
  const ev = {
    id: 'e1', type: 'PullRequestEvent', actor: { login: 'dev', id: 1 }, repo: { name: 'o/r', id: 2 }, created_at: 'x',
    payload: { action: 'labeled', pull_request: { head: { sha: SHA_A } } },
  };
  const h = g.newHold({ sub: { agentId: 'a', triggerId: 't', readinessGate: { ci: true } }, key: 'pull_request.labeled', ghEvent: ev, number: 3, wakeLabel: 'w', now: NOW });
  assert.equal(h.headSha, SHA_A);
  assert.equal(h.heldAt, new Date(NOW).toISOString());
  assert.deepEqual(h.gate, { ci: true, conflict: false, failureLabel: 'revisions-required', timeoutMinutes: 60 });
  assert.deepEqual(h.event.actor, { login: 'dev' });
  assert.deepEqual(h.event.repo, { name: 'o/r' });
  assert.equal(h.resolution, null);
});

test('comments: failing checks, merge conflict, timeout — each with the marker and the label swap', () => {
  const h = hold();
  const ci = g.failureComment({ decision: { action: 'fail', gate: 'ci', sha: SHA_A, failingChecks: ['build', 'e2e'] }, hold: h, consumer: 'rev' });
  assert.ok(ci.startsWith(g.COMMENT_MARKER));
  assert.match(ci, /CI failed\*\* on `aaaaaaa`/);
  assert.match(ci, /- `build`\n- `e2e`/);
  assert.match(ci, /`ready-for-review` was removed and `revisions-required` set — `rev` was not woken/);
  const cf = g.failureComment({ decision: { action: 'fail', gate: 'conflict', sha: SHA_A, baseRef: 'main' }, hold: h });
  assert.match(cf, /merge conflict with `main`/);
  const to = g.timeoutComment({ decision: { action: 'timeout', pending: ['ci', 'conflict'] }, hold: h, consumer: 'rev' });
  assert.match(to, /timed out after 60 min — still waiting for CI \/ conflict-free/);
  assert.match(to, /`needs-human` set/);
});
