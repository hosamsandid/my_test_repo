'use strict';

// Unit tests for the pure autonomy predicate (#962).
// Run: node --test orchestrator/agent-autonomy.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAutonomousState, autonomyChanged } = require('./agent-autonomy');

// Removal guard (#1962): `orchestrator`/`bp-instance` used to be inherently
// autonomous by role alone. Both roles went with the BriefingPack model, so a
// leftover config carrying one is now judged purely on sessionPolicy+triggers —
// role must not resurrect as an autonomy signal.
test('no role is inherently autonomous any more — autonomy is policy + triggers', () => {
  assert.equal(isAutonomousState({ role: 'orchestrator', triggers: [] }), false);
  assert.equal(isAutonomousState({ role: 'bp-instance', triggers: [] }), false);
  // …and a leftover BP config that *does* carry a trigger is still autonomous,
  // for the ordinary reason.
  assert.equal(isAutonomousState({ role: 'bp-instance', triggers: [{ id: 't1' }] }), true);
});

test('a per-invocation session policy is autonomous even with no triggers', () => {
  assert.equal(isAutonomousState({ role: 'agent', sessionPolicy: 'per-invocation', triggers: [] }), true);
});

test('a persistent agent with at least one trigger is autonomous', () => {
  assert.equal(isAutonomousState({ role: 'agent', sessionPolicy: 'persistent', triggers: [{ id: 't1', type: 'cron' }] }), true);
});

test('a persistent agent with no triggers is NOT autonomous', () => {
  assert.equal(isAutonomousState({ role: 'agent', sessionPolicy: 'persistent', triggers: [] }), false);
});

test('missing / empty inputs default to not autonomous', () => {
  assert.equal(isAutonomousState(), false);
  assert.equal(isAutonomousState({}), false);
  assert.equal(isAutonomousState({ role: 'agent' }), false);
  // A non-array triggers value is ignored (defensive against corrupt files).
  assert.equal(isAutonomousState({ role: 'agent', triggers: 'nope' }), false);
});

test('autonomyChanged detects the flip on the first trigger add', () => {
  // persistent agent goes from 0 -> 1 triggers
  const before = isAutonomousState({ role: 'agent', sessionPolicy: 'persistent', triggers: [] });
  const after = isAutonomousState({ role: 'agent', sessionPolicy: 'persistent', triggers: [{ id: 't1' }] });
  assert.equal(before, false);
  assert.equal(after, true);
  assert.equal(autonomyChanged(before, after), true);
});

test('autonomyChanged detects the flip when the last trigger is removed', () => {
  const before = isAutonomousState({ role: 'agent', sessionPolicy: 'persistent', triggers: [{ id: 't1' }] });
  const after = isAutonomousState({ role: 'agent', sessionPolicy: 'persistent', triggers: [] });
  assert.equal(autonomyChanged(before, after), true);
});

test('autonomyChanged is false when a second trigger is added (already autonomous) — AC4', () => {
  const before = isAutonomousState({ role: 'agent', sessionPolicy: 'persistent', triggers: [{ id: 't1' }] });
  const after = isAutonomousState({ role: 'agent', sessionPolicy: 'persistent', triggers: [{ id: 't1' }, { id: 't2' }] });
  assert.equal(autonomyChanged(before, after), false);
});

test('autonomyChanged is false for a per-invocation agent whose trigger count changes — AC4', () => {
  // A reactive agent is always autonomous, so no trigger add/remove ever flips it.
  const before = isAutonomousState({ role: 'agent', sessionPolicy: 'per-invocation', triggers: [] });
  const after = isAutonomousState({ role: 'agent', sessionPolicy: 'per-invocation', triggers: [{ id: 't1' }] });
  assert.equal(autonomyChanged(before, after), false);
});

test('autonomyChanged coerces truthiness (never rebuilds on an identical state)', () => {
  assert.equal(autonomyChanged(false, false), false);
  assert.equal(autonomyChanged(true, true), false);
  assert.equal(autonomyChanged(false, true), true);
  assert.equal(autonomyChanged(true, false), true);
});
