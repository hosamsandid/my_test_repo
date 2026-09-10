'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  armedKey, parseArmedKey, isArmed, arm, disarmLabel, disarmObject, gcArmed,
  ARMED_TTL_MS,
} = require('./wake-armory');

const ISSUE = { triggerId: 't-dev', kind: 'issue', number: 2152, label: 'ready' };

test('armedKey round-trips through parseArmedKey', () => {
  const k = armedKey(ISSUE);
  assert.deepEqual(parseArmedKey(k), ISSUE);
});

test('armedKey is stable and label-safe (a `|` in the label never collides)', () => {
  const weird = { triggerId: 't|1', kind: 'issue', number: 5, label: 'ready|now' };
  assert.deepEqual(parseArmedKey(armedKey(weird)), weird);
});

test('parseArmedKey returns null on garbage', () => {
  assert.equal(parseArmedKey('not-json'), null);
});

test('isArmed reads a fresh/malformed map as not-armed (fail-open)', () => {
  assert.equal(isArmed(undefined, armedKey(ISSUE)), false);
  assert.equal(isArmed({}, armedKey(ISSUE)), false);
});

test('rising edge: arm, then a second identical add is armed (would be dropped)', () => {
  const armed = {};
  const k = armedKey(ISSUE);
  assert.equal(isArmed(armed, k), false); // first add fires
  arm(armed, k, 1000);
  assert.equal(isArmed(armed, k), true); // second add suppressed
});

test('disarmLabel clears across triggers but leaves other labels/objects', () => {
  const armed = {};
  arm(armed, armedKey({ triggerId: 't-a', kind: 'issue', number: 1, label: 'ready' }), 1);
  arm(armed, armedKey({ triggerId: 't-b', kind: 'issue', number: 1, label: 'ready' }), 1);
  arm(armed, armedKey({ triggerId: 't-a', kind: 'issue', number: 1, label: 'other' }), 1);
  arm(armed, armedKey({ triggerId: 't-a', kind: 'issue', number: 2, label: 'ready' }), 1);

  disarmLabel(armed, { kind: 'issue', number: 1, label: 'ready' });

  // both triggers' `ready` on #1 gone
  assert.equal(isArmed(armed, armedKey({ triggerId: 't-a', kind: 'issue', number: 1, label: 'ready' })), false);
  assert.equal(isArmed(armed, armedKey({ triggerId: 't-b', kind: 'issue', number: 1, label: 'ready' })), false);
  // a different label on #1 and `ready` on #2 survive
  assert.equal(isArmed(armed, armedKey({ triggerId: 't-a', kind: 'issue', number: 1, label: 'other' })), true);
  assert.equal(isArmed(armed, armedKey({ triggerId: 't-a', kind: 'issue', number: 2, label: 'ready' })), true);
});

test('remove -> re-add re-fires (disarm reopens the rising edge)', () => {
  const armed = {};
  const k = armedKey(ISSUE);
  arm(armed, k, 1);                                   // delivered once
  assert.equal(isArmed(armed, k), true);              // churn suppressed
  disarmLabel(armed, ISSUE);                          // label removed
  assert.equal(isArmed(armed, k), false);             // genuine re-add fires again
});

test('disarmObject clears every label of a closed object', () => {
  const armed = {};
  arm(armed, armedKey({ triggerId: 't-a', kind: 'pr', number: 9, label: 'ready-for-review' }), 1);
  arm(armed, armedKey({ triggerId: 't-b', kind: 'pr', number: 9, label: 'revisions-required' }), 1);
  arm(armed, armedKey({ triggerId: 't-a', kind: 'pr', number: 8, label: 'ready-for-review' }), 1);

  disarmObject(armed, { kind: 'pr', number: 9 });

  assert.equal(Object.keys(armed).length, 1);
  assert.equal(isArmed(armed, armedKey({ triggerId: 't-a', kind: 'pr', number: 8, label: 'ready-for-review' })), true);
});

test('gcArmed drops entries past the TTL', () => {
  const now = 1_000_000_000_000;
  const armed = {};
  arm(armed, armedKey({ triggerId: 't', kind: 'issue', number: 1, label: 'ready' }), now - ARMED_TTL_MS - 1); // stale
  arm(armed, armedKey({ triggerId: 't', kind: 'issue', number: 2, label: 'ready' }), now - 1000);             // fresh
  gcArmed(armed, { now });
  assert.equal(isArmed(armed, armedKey({ triggerId: 't', kind: 'issue', number: 1, label: 'ready' })), false);
  assert.equal(isArmed(armed, armedKey({ triggerId: 't', kind: 'issue', number: 2, label: 'ready' })), true);
});

test('gcArmed enforces the cap by evicting the oldest', () => {
  const armed = {};
  for (let i = 0; i < 10; i++) arm(armed, armedKey({ triggerId: 't', kind: 'issue', number: i, label: 'ready' }), i + 1);
  gcArmed(armed, { now: 100, ttlMs: ARMED_TTL_MS, maxEntries: 3 });
  assert.equal(Object.keys(armed).length, 3);
  // the three newest (i=7,8,9) survive
  assert.equal(isArmed(armed, armedKey({ triggerId: 't', kind: 'issue', number: 9, label: 'ready' })), true);
  assert.equal(isArmed(armed, armedKey({ triggerId: 't', kind: 'issue', number: 0, label: 'ready' })), false);
});
