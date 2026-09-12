'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nextAvailableAgentId, MAX_ID_SUFFIX } = require('./agent-id-resolution');

function isTakenOf(taken) {
  const set = new Set(taken);
  return (id) => set.has(id);
}

test('nextAvailableAgentId: base id is returned when free', () => {
  assert.equal(nextAvailableAgentId('repo-agent', isTakenOf([])), 'repo-agent');
});

test('nextAvailableAgentId: walks the -2, -3, … suffix sequence, first free wins (AC3)', () => {
  const isTaken = isTakenOf(['repo-agent', 'repo-agent-2', 'repo-agent-3']);
  assert.equal(nextAvailableAgentId('repo-agent', isTaken), 'repo-agent-4');
});

test('nextAvailableAgentId: a hole in the middle of the sequence is reused (AC3 — deleted-then-recreated)', () => {
  // repo-agent-2 was deleted (and its teardown has completed) while
  // repo-agent and repo-agent-3 are still live — the first FREE id wins,
  // not the highest suffix seen.
  const isTaken = isTakenOf(['repo-agent', 'repo-agent-3']);
  assert.equal(nextAvailableAgentId('repo-agent', isTaken), 'repo-agent-2');
});

test('nextAvailableAgentId: empty base falls back to "agent"', () => {
  assert.equal(nextAvailableAgentId('', isTakenOf([])), 'agent');
  assert.equal(nextAvailableAgentId(null, isTakenOf([])), 'agent');
});

test('nextAvailableAgentId: refuses with a distinct, actionable code past the cap', () => {
  const taken = ['repo-agent'];
  for (let n = 2; n <= MAX_ID_SUFFIX; n++) taken.push(`repo-agent-${n}`);
  assert.throws(
    () => nextAvailableAgentId('repo-agent', isTakenOf(taken)),
    (err) => err.code === 'id-sequence-exhausted' && /repo-agent/.test(err.message)
  );
});

test('nextAvailableAgentId: isTaken is consulted, not merely called once (deleted-teardown-in-flight edge case)', () => {
  // The base directory was already removed but its teardown is still in
  // flight — the caller's `isTaken` folds that in (agentTeardownRegistry),
  // so the base still reads as taken even though a directory check alone
  // would say free.
  let calls = 0;
  const isTaken = (id) => {
    calls += 1;
    return id === 'repo-agent';
  };
  assert.equal(nextAvailableAgentId('repo-agent', isTaken), 'repo-agent-2');
  assert.equal(calls, 2);
});
