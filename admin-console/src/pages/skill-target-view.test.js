import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canWriteGlobalSkills,
  writableTeamOptions,
  writableSkillTargets,
  defaultSkillTarget,
} from './skill-target-view.js';

const teams = [
  { id: 'payments', name: 'Payments' },
  { id: 'risk', name: 'Risk' },
];

/* ─── canWriteGlobalSkills ────────────────────────────────────────────────── */

test('canWriteGlobalSkills: a System Admin may always write global (AC15)', () => {
  assert.equal(canWriteGlobalSkills({ isSysAdmin: true, adminTeamIds: [] }), true);
});

test('canWriteGlobalSkills: a Team Admin of at least one team may write global (#2307 AC1)', () => {
  assert.equal(canWriteGlobalSkills({ isSysAdmin: false, adminTeamIds: ['payments'] }), true);
});

test('canWriteGlobalSkills: a Team Admin of no team may not (#2307 AC2)', () => {
  assert.equal(canWriteGlobalSkills({ isSysAdmin: false, adminTeamIds: [] }), false);
  assert.equal(canWriteGlobalSkills(), false);
});

/* ─── writableTeamOptions ─────────────────────────────────────────────────── */

test('writableTeamOptions: System Admin sees every team, not just ones administered', () => {
  assert.deepEqual(writableTeamOptions({ isSysAdmin: true, adminTeamIds: [] }, teams), teams);
});

test('writableTeamOptions: a Team Admin sees only teams they administer (AC13 — not every membership)', () => {
  assert.deepEqual(writableTeamOptions({ isSysAdmin: false, adminTeamIds: ['risk'] }, teams), [{ id: 'risk', name: 'Risk' }]);
});

test('writableTeamOptions: a caller who is Team Admin of no team sees no team option', () => {
  assert.deepEqual(writableTeamOptions({ isSysAdmin: false, adminTeamIds: [] }, teams), []);
});

/* ─── writableSkillTargets / defaultSkillTarget ──────────────────────────── */

test('writableSkillTargets: System Admin gets global plus every team', () => {
  const out = writableSkillTargets({ isSysAdmin: true, adminTeamIds: [] }, teams);
  assert.deepEqual(out.map(o => o.value), ['global', 'team:payments', 'team:risk']);
});

test('writableSkillTargets: a Team Admin of one team gets global plus only that team (#2307 AC1/AC13)', () => {
  const out = writableSkillTargets({ isSysAdmin: false, adminTeamIds: ['risk'] }, teams);
  assert.deepEqual(out.map(o => o.value), ['global', 'team:risk']);
});

test('writableSkillTargets: a caller who is Team Admin of no team gets nothing to write to (#2307 AC14)', () => {
  assert.deepEqual(writableSkillTargets({ isSysAdmin: false, adminTeamIds: [] }, teams), []);
});

test('defaultSkillTarget: pre-selects global when the caller may write it (#2307 AC11)', () => {
  assert.equal(defaultSkillTarget({ isSysAdmin: true, adminTeamIds: [] }, teams), 'global');
});

test('defaultSkillTarget: a Team Admin of one team also defaults to global — under #2307 the two can never split (any admin team opens global too)', () => {
  assert.equal(defaultSkillTarget({ isSysAdmin: false, adminTeamIds: ['risk'] }, teams), 'global');
});

test('defaultSkillTarget: empty string when the caller may write nowhere — never a target certain to 403 (#2307 AC11/AC14)', () => {
  assert.equal(defaultSkillTarget({ isSysAdmin: false, adminTeamIds: [] }, teams), '');
});
