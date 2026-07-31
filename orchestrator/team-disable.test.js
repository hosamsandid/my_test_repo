'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isTeamDisabled,
  planTeamDisable,
  planTeamEnable,
  isMemberLockedByTeam,
  deriveBusyState,
} = require('./team-disable');

test('isTeamDisabled: false/undefined enabled or missing config means enabled', () => {
  assert.equal(isTeamDisabled(null), false);
  assert.equal(isTeamDisabled(undefined), false);
  assert.equal(isTeamDisabled({}), false);
  assert.equal(isTeamDisabled({ enabled: true }), false);
});

test('isTeamDisabled: enabled === false means disabled', () => {
  assert.equal(isTeamDisabled({ enabled: false }), true);
});

test('planTeamDisable: enabled members go to toDisable, already-off members are skipped untouched', () => {
  const members = [
    { id: 'a', enabled: true },
    { id: 'b', enabled: false },          // independently disabled before team action
    { id: 'c' },                           // enabled defaults to true when absent
    { id: 'd', enabled: false, disabledByTeam: true }, // was already cascade-disabled
  ];
  const { toDisable, skip } = planTeamDisable(members);
  assert.deepEqual(toDisable.sort(), ['a', 'c']);
  assert.deepEqual(skip.sort(), ['b', 'd']);
});

test('planTeamDisable: ignores null/undefined entries defensively', () => {
  const { toDisable, skip } = planTeamDisable([null, { id: 'a', enabled: true }, undefined]);
  assert.deepEqual(toDisable, ['a']);
  assert.deepEqual(skip, []);
});

test('planTeamEnable: only disabledByTeam members come back, everyone else is skipped', () => {
  const members = [
    { id: 'a', enabled: false, disabledByTeam: true },  // cascade-disabled → re-enable
    { id: 'b', enabled: false },                          // independently disabled → stays off
    { id: 'c', enabled: true },                           // already on (shouldn't happen, but stays on)
    { id: 'd', enabled: false, disabledByTeam: false },  // explicit false is not true → stays off
  ];
  const { toEnable, skip } = planTeamEnable(members);
  assert.deepEqual(toEnable, ['a']);
  assert.deepEqual(skip.sort(), ['b', 'c', 'd']);
});

test('planTeamEnable: ignores null/undefined entries defensively', () => {
  const { toEnable, skip } = planTeamEnable([null, { id: 'a', enabled: false, disabledByTeam: true }]);
  assert.deepEqual(toEnable, ['a']);
  assert.deepEqual(skip, []);
});

test('isMemberLockedByTeam: non team-member is never locked', () => {
  assert.equal(isMemberLockedByTeam({ role: 'agent', parentTeamId: 't1' }, { enabled: false }), false);
  assert.equal(isMemberLockedByTeam({ role: 'team', parentTeamId: 't1' }, { enabled: false }), false);
});

test('isMemberLockedByTeam: team-member without a parentTeamId is never locked', () => {
  assert.equal(isMemberLockedByTeam({ role: 'team-member' }, { enabled: false }), false);
});

test('isMemberLockedByTeam: team-member whose parent team is enabled is not locked', () => {
  assert.equal(
    isMemberLockedByTeam({ role: 'team-member', parentTeamId: 't1' }, { enabled: true }),
    false,
  );
  assert.equal(
    isMemberLockedByTeam({ role: 'team-member', parentTeamId: 't1' }, {}),
    false,
  );
});

test('isMemberLockedByTeam: team-member whose parent team is disabled is locked', () => {
  assert.equal(
    isMemberLockedByTeam({ role: 'team-member', parentTeamId: 't1' }, { enabled: false }),
    true,
  );
});

test('isMemberLockedByTeam: null/undefined memberCfg is never locked', () => {
  assert.equal(isMemberLockedByTeam(null, { enabled: false }), false);
  assert.equal(isMemberLockedByTeam(undefined, { enabled: false }), false);
});

test('deriveBusyState: state busy maps to busy true', () => {
  const { busy } = deriveBusyState({ state: 'busy' }, []);
  assert.equal(busy, true);
});

test('deriveBusyState: any other state or missing status maps to busy false', () => {
  assert.equal(deriveBusyState({ state: 'idle' }, []).busy, false);
  assert.equal(deriveBusyState({}, []).busy, false);
  assert.equal(deriveBusyState(null, []).busy, false);
  assert.equal(deriveBusyState(undefined, []).busy, false);
});

test('deriveBusyState: triggers are filtered and mapped to id/type/description', () => {
  const triggers = [
    { id: 't1', type: 'cron', description: 'nightly build' },
    { id: 't2', type: 'once', enabled: false },              // dropped: disabled
    { type: 'http', description: 'no id' },                   // dropped: no id
    { id: 't3', type: 'github-event' },                        // no description -> null
  ];
  const { activeTriggers } = deriveBusyState({ state: 'idle' }, triggers);
  assert.deepEqual(activeTriggers, [
    { id: 't1', type: 'cron', description: 'nightly build' },
    { id: 't3', type: 'github-event', description: null },
  ]);
});

test('deriveBusyState: null status and null triggers (missing files) yield idle/no-triggers, no throw', () => {
  assert.deepEqual(deriveBusyState(null, null), { busy: false, activeTriggers: [] });
});
