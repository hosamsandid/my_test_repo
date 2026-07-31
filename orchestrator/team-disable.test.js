'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isTeamDisabled, planTeamDisable, planTeamEnable } = require('./team-disable');

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
