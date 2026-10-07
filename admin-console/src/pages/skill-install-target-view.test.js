import test from 'node:test';
import assert from 'node:assert/strict';

import { groupInstallTargets, NO_TEAM_LABEL } from './skill-install-target-view.js';

const labels = groups => groups.map(g => g.label);
const ids = group => group.agents.map(a => a.id);

test('groupInstallTargets: groups agents under their team, labelled with the team name (#2836 AC1/AC2)', () => {
  const groups = groupInstallTargets(
    [
      { id: 'a1', displayName: 'My Assistant', parentTeamId: 'pay' },
      { id: 'a2', displayName: 'My Assistant', parentTeamId: 'risk' },
      { id: 'a3', displayName: 'Developer', parentTeamId: 'pay' },
    ],
    { pay: 'Payments', risk: 'Risk' },
  );
  assert.deepEqual(labels(groups), ['Payments', 'Risk']);
  assert.deepEqual(ids(groups[0]), ['a3', 'a1']);
  assert.deepEqual(ids(groups[1]), ['a2']);
  const all = groups.flatMap(ids);
  assert.equal(all.length, 3);
  assert.equal(new Set(all).size, 3);
});

test('groupInstallTargets: falls back to the team id when no name is known (#2836 AC1)', () => {
  const groups = groupInstallTargets([{ id: 'a1', displayName: 'X', parentTeamId: 'team-42' }], {});
  assert.deepEqual(labels(groups), ['team-42']);
  assert.equal(groups[0].teamId, 'team-42');
});

test('groupInstallTargets: groups sorted by team name, agents by display name, case-insensitive (#2836 AC3)', () => {
  const groups = groupInstallTargets(
    [
      { id: 'z', displayName: 'zeta', parentTeamId: 't2' },
      { id: 'b', displayName: 'Beta', parentTeamId: 't2' },
      { id: 'A', displayName: 'alpha', parentTeamId: 't2' },
      { id: 'q', displayName: 'Q', parentTeamId: 't1' },
      { id: 'm', displayName: 'M', parentTeamId: 't3' },
    ],
    { t1: 'charlie', t2: 'Alpha team', t3: 'bravo' },
  );
  assert.deepEqual(labels(groups), ['Alpha team', 'bravo', 'charlie']);
  assert.deepEqual(groups[0].agents.map(a => a.displayName), ['alpha', 'Beta', 'zeta']);
});

test('groupInstallTargets: agents without a team land in a final "No team" group (#2836 AC4)', () => {
  const groups = groupInstallTargets(
    [
      { id: 'o2', displayName: 'Orphan B' },
      { id: 'a1', displayName: 'Zed', parentTeamId: 'zz' },
      { id: 'o1', displayName: 'Orphan A', parentTeamId: '' },
    ],
    { zz: 'Zulu' },
  );
  assert.deepEqual(labels(groups), ['Zulu', NO_TEAM_LABEL]);
  assert.equal(NO_TEAM_LABEL, 'No team');
  assert.equal(groups[1].teamId, null);
  assert.deepEqual(ids(groups[1]), ['o1', 'o2']);
});

test('groupInstallTargets: no "No team" group when every agent has a team (#2836 AC4)', () => {
  const groups = groupInstallTargets([{ id: 'a', displayName: 'A', parentTeamId: 't' }], { t: 'T' });
  assert.deepEqual(labels(groups), ['T']);
});

test('groupInstallTargets: two teams sharing a name get their id appended (#2836 AC7)', () => {
  const groups = groupInstallTargets(
    [
      { id: 'a1', displayName: 'A', parentTeamId: 'team-b' },
      { id: 'a2', displayName: 'B', parentTeamId: 'team-a' },
      { id: 'a3', displayName: 'C', parentTeamId: 'solo' },
    ],
    { 'team-a': 'My Team', 'team-b': 'my team', solo: 'Solo' },
  );
  assert.deepEqual(labels(groups), ['My Team (team-a)', 'my team (team-b)', 'Solo']);
  assert.equal(new Set(groups.map(g => g.key)).size, 3);
});

test('groupInstallTargets: a single team still renders as one group (edge case)', () => {
  const groups = groupInstallTargets(
    [{ id: 'a', displayName: 'A', parentTeamId: 't' }, { id: 'b', displayName: 'B', parentTeamId: 't' }],
    { t: 'Only' },
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(ids(groups[0]), ['a', 'b']);
});

test('groupInstallTargets: re-grouping after names load keeps every agent id (edge case)', () => {
  const agents = [{ id: 'a', displayName: 'A', parentTeamId: 't1' }, { id: 'b', displayName: 'B', parentTeamId: 't2' }];
  const before = groupInstallTargets(agents, {});
  const after = groupInstallTargets(agents, { t1: 'Zulu', t2: 'Alpha' });
  assert.deepEqual(labels(before), ['t1', 't2']);
  assert.deepEqual(labels(after), ['Alpha', 'Zulu']);
  assert.deepEqual(before.flatMap(ids).sort(), after.flatMap(ids).sort());
});

test('groupInstallTargets: tolerates empty / malformed input', () => {
  assert.deepEqual(groupInstallTargets(), []);
  assert.deepEqual(groupInstallTargets(null, null), []);
  assert.deepEqual(groupInstallTargets([null, {}, { displayName: 'no id' }], {}), []);
  const [g] = groupInstallTargets([{ id: 'x' }], {});
  assert.equal(g.agents[0].displayName, 'x');
});
