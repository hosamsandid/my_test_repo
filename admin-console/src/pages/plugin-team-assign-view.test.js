import test from 'node:test';
import assert from 'node:assert/strict';

import {
  grantableTeams,
  teamHasPlugin,
  pluginAssignmentState,
  assignmentGranularity,
  assignmentGate,
} from './plugin-team-assign-view.js';

const AGENTS = [
  { id: 'alpha', role: 'team', name: 'Alpha Squad', plugins: [{ id: 'podman-sandbox', scopeGranularity: 'agent' }] },
  { id: 'zeta', role: 'team', name: 'Zeta', plugins: ['github-issues'] }, // bare-string shorthand
  { id: 'beta', role: 'team' }, // no name, no plugins
  { id: 'alpha-dev', role: 'team-member', name: 'Dev', parentTeamId: 'alpha' },
  { id: 'solo', role: 'agent', name: 'Standalone' },
];

test('grantableTeams keeps only team constructs, sorted by name, with normalised grants', () => {
  const teams = grantableTeams(AGENTS);
  assert.deepEqual(teams.map((t) => t.id), ['alpha', 'beta', 'zeta']); // sorted by display name
  const zeta = teams.find((t) => t.id === 'zeta');
  assert.deepEqual(zeta.plugins, [{ id: 'github-issues', scopeGranularity: 'team' }]); // string → team default
  const beta = teams.find((t) => t.id === 'beta');
  assert.equal(beta.name, 'beta'); // falls back to id
  assert.deepEqual(beta.plugins, []);
});

test('grantableTeams tolerates the {agents:[]} envelope and non-arrays', () => {
  assert.deepEqual(grantableTeams({ agents: AGENTS }).map((t) => t.id), ['alpha', 'beta', 'zeta']);
  assert.deepEqual(grantableTeams(null), []);
  assert.deepEqual(grantableTeams(undefined), []);
});

test('teamHasPlugin reads the persisted team-level grant only', () => {
  const teams = grantableTeams(AGENTS);
  const alpha = teams.find((t) => t.id === 'alpha');
  assert.equal(teamHasPlugin(alpha, 'podman-sandbox'), true);
  assert.equal(teamHasPlugin(alpha, 'github-issues'), false);
  assert.equal(teamHasPlugin({}, 'x'), false);
});

test('pluginAssignmentState summarises granted teams and rows', () => {
  const teams = grantableTeams(AGENTS);
  const s = pluginAssignmentState('podman-sandbox', teams);
  assert.equal(s.rows.length, 3);
  assert.deepEqual(s.grantedNames, ['Alpha Squad']);
  assert.equal(s.grantedCount, 1);
  assert.equal(s.noTeams, false);
  assert.match(s.summary, /Assigned to 1 team: Alpha Squad/);
  // pluralisation
  const two = pluginAssignmentState('github-issues', [
    { id: 'a', name: 'A', plugins: [{ id: 'github-issues', scopeGranularity: 'team' }] },
    { id: 'b', name: 'B', plugins: [{ id: 'github-issues', scopeGranularity: 'team' }] },
  ]);
  assert.match(two.summary, /Assigned to 2 teams: A, B/);
});

test('pluginAssignmentState empty state (AC6) and no-grantable-team (AC8)', () => {
  const teams = grantableTeams(AGENTS);
  const fresh = pluginAssignmentState('never-granted', teams);
  assert.equal(fresh.grantedCount, 0);
  assert.equal(fresh.noTeams, false);
  assert.equal(fresh.summary, 'Not assigned to any team yet');

  const none = pluginAssignmentState('x', []);
  assert.equal(none.noTeams, true);
  assert.deepEqual(none.rows, []);
});

test('assignmentGranularity reuses the manifest default, clamped to scopes (open Q1)', () => {
  assert.equal(assignmentGranularity({ scopes: ['team', 'agent'], defaultScopeGranularity: 'agent' }), 'agent');
  assert.equal(assignmentGranularity({ scopes: ['team', 'agent'], defaultScopeGranularity: null }), 'team');
  assert.equal(assignmentGranularity({ scopes: ['team'] }), 'team');
  // a default that is not in scopes falls back safely
  assert.equal(assignmentGranularity({ scopes: ['team'], defaultScopeGranularity: 'agent' }), 'team');
  // no team scope at all → first offered
  assert.equal(assignmentGranularity({ scopes: ['agent'] }), 'agent');
  assert.equal(assignmentGranularity({}), 'team');
});

test('assignmentGate blocks invalid manifests and platform mismatches', () => {
  assert.deepEqual(assignmentGate({ ok: true, platforms: ['any'] }, 'podman'), { ok: true, reason: null });
  assert.deepEqual(assignmentGate({ ok: true, platforms: ['podman'] }, 'podman'), { ok: true, reason: null });

  const badManifest = assignmentGate({ ok: false, platforms: ['any'] }, 'podman');
  assert.equal(badManifest.ok, false);
  assert.match(badManifest.reason, /manifest is invalid/);

  const mismatch = assignmentGate({ ok: true, platforms: ['podman'] }, 'kubernetes');
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /Requires podman/);
});
