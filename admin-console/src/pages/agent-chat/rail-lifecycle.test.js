import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHOW_DISABLED_KEY,
  loadShowDisabled,
  saveShowDisabled,
  clampMenuPosition,
  teamOptions,
  existingIds,
  deleteTargetFor,
  isTeamLocked,
} from './rail-lifecycle.js';

function fakeStorage(initial = {}) {
  const map = { ...initial };
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    _map: map,
  };
}

test('showDisabled defaults to off and round-trips through storage', () => {
  const s = fakeStorage();
  assert.equal(loadShowDisabled(s), false);

  saveShowDisabled(true, s);
  assert.equal(s._map[SHOW_DISABLED_KEY], 'true');
  assert.equal(loadShowDisabled(s), true);

  saveShowDisabled(false, s);
  assert.equal(loadShowDisabled(s), false);
});

test('showDisabled treats any non-"true" value as off', () => {
  assert.equal(loadShowDisabled(fakeStorage({ [SHOW_DISABLED_KEY]: 'yes' })), false);
  assert.equal(loadShowDisabled(fakeStorage({ [SHOW_DISABLED_KEY]: '' })), false);
});

test('showDisabled survives a throwing storage (privacy mode)', () => {
  const boom = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  assert.equal(loadShowDisabled(boom), false);
  assert.doesNotThrow(() => saveShowDisabled(true, boom));
});

test('clampMenuPosition prefers below-right of the pointer', () => {
  const pos = clampMenuPosition({
    x: 100, y: 100, width: 180, height: 200,
    viewportWidth: 1000, viewportHeight: 800,
  });
  assert.deepEqual(pos, { left: 100, top: 100 });
});

test('clampMenuPosition flips instead of overlapping the edge', () => {
  const pos = clampMenuPosition({
    x: 950, y: 780, width: 180, height: 200,
    viewportWidth: 1000, viewportHeight: 800,
  });
  assert.deepEqual(pos, { left: 770, top: 580 });
  // Fully inside the viewport after the flip.
  assert.ok(pos.left >= 8 && pos.left + 180 <= 1000);
  assert.ok(pos.top >= 8 && pos.top + 200 <= 800);
});

test('clampMenuPosition keeps a menu larger than the viewport on screen', () => {
  const pos = clampMenuPosition({
    x: 10, y: 10, width: 400, height: 900,
    viewportWidth: 300, viewportHeight: 500,
  });
  assert.equal(pos.left, 8);
  assert.equal(pos.top, 8);
});

const AGENTS = [
  { id: 'solo', role: 'agent', displayName: 'Solo' },
  { id: 'zeta', role: 'team', displayName: 'Zeta Team', enabled: true },
  { id: 'alpha', role: 'team', displayName: 'Alpha Team', enabled: false },
  { id: 'alpha-dev', role: 'team-member', parentTeamId: 'alpha', displayName: 'Dev' },
  { id: 'alpha-qa', role: 'team-member', parentTeamId: 'alpha', displayName: 'QA' },
  { id: 'zeta-dev', role: 'team-member', parentTeamId: 'zeta', displayName: 'Z Dev' },
  { id: 'orch', role: 'orchestrator', displayName: 'Orch' },
  { id: 'bp1', role: 'bp-instance', parentOrchestratorId: 'orch', displayName: 'BP 1' },
];

test('teamOptions lists only team constructs, sorted by display name', () => {
  assert.deepEqual(teamOptions(AGENTS), [
    { id: 'alpha', displayName: 'Alpha Team' },
    { id: 'zeta', displayName: 'Zeta Team' },
  ]);
  assert.deepEqual(teamOptions(null), []);
});

test('existingIds collects every id in the list', () => {
  const ids = existingIds(AGENTS);
  assert.ok(ids.has('solo'));
  assert.ok(ids.has('alpha-dev'));
  assert.equal(ids.size, AGENTS.length);
});

test('deleteTargetFor attaches a team\'s members and an orchestrator\'s missions', () => {
  const team = deleteTargetFor(AGENTS[2], AGENTS);
  assert.deepEqual(team.children.map(c => c.id), ['alpha-dev', 'alpha-qa']);

  const orch = deleteTargetFor(AGENTS[6], AGENTS);
  assert.deepEqual(orch.children.map(c => c.id), ['bp1']);

  // A leaf agent carries no children, so the confirm shows the plain message.
  assert.deepEqual(deleteTargetFor(AGENTS[0], AGENTS).children, []);
  assert.equal(deleteTargetFor(null, AGENTS), null);
});

test('isTeamLocked is true only for a member of a listed, disabled team', () => {
  const dev = AGENTS[3];
  assert.equal(isTeamLocked(dev, AGENTS), true);
  assert.equal(isTeamLocked(AGENTS[5], AGENTS), false);       // team enabled
  assert.equal(isTeamLocked(AGENTS[1], AGENTS), false);       // the team row itself
  assert.equal(isTeamLocked(AGENTS[0], AGENTS), false);       // standalone agent
  // Team absent from the payload (opt-in off): no lock is guessed from absence.
  assert.equal(isTeamLocked(dev, AGENTS.filter(a => a.id !== 'alpha')), false);
});
