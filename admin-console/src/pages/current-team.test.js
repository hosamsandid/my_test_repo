// #2850 — the current team shared by Agent Chat and Flow Control.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  currentTeamKey, teamIdOfAgent, readCurrentTeam, writeCurrentTeam, resolveFlowControlTeam,
} from './current-team.js';

function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

const TEAMS = [{ id: 'team-a', role: 'team' }, { id: 'team-b', role: 'team' }, { id: 'team-c', role: 'team' }];

test('teamIdOfAgent: a member and a pool instance resolve to their parent team', () => {
  assert.equal(teamIdOfAgent({ id: 'team-b-dev', role: 'team-member', parentTeamId: 'team-b' }), 'team-b');
  assert.equal(teamIdOfAgent({ id: 'team-b-dev-i7', poolInstance: true, parentTeamId: 'team-b' }), 'team-b');
});

test('teamIdOfAgent: a team entry is its own team (AC2)', () => {
  assert.equal(teamIdOfAgent({ id: 'team-b', role: 'team' }), 'team-b');
});

test('teamIdOfAgent: an agent outside any team, or no agent, has no team (AC3)', () => {
  assert.equal(teamIdOfAgent({ id: 'solo', role: 'agent' }), null);
  assert.equal(teamIdOfAgent({ id: 'solo', parentTeamId: null }), null);
  assert.equal(teamIdOfAgent(null), null);
  assert.equal(teamIdOfAgent(undefined), null);
});

test('writeCurrentTeam: no team id leaves the current team unchanged (AC3)', () => {
  const store = memStore();
  writeCurrentTeam('x', 'team-b', store);
  writeCurrentTeam('x', teamIdOfAgent({ id: 'solo' }), store);
  writeCurrentTeam('x', '', store);
  assert.equal(readCurrentTeam('x', store), 'team-b');
  assert.equal(resolveFlowControlTeam({ rememberedTeam: readCurrentTeam('x', store), teams: TEAMS }), 'team-b');
});

test('the most recent choice wins, on whichever page it was made (AC5)', () => {
  const store = memStore();
  writeCurrentTeam('x', teamIdOfAgent({ id: 'b-dev', parentTeamId: 'team-b' }), store); // Agent Chat
  writeCurrentTeam('x', 'team-c', store); // Flow Control picker
  assert.equal(resolveFlowControlTeam({ rememberedTeam: readCurrentTeam('x', store), teams: TEAMS }), 'team-c');
  writeCurrentTeam('x', teamIdOfAgent({ id: 'b-dev', parentTeamId: 'team-b' }), store); // Agent Chat again
  assert.equal(resolveFlowControlTeam({ rememberedTeam: readCurrentTeam('x', store), teams: TEAMS }), 'team-b');
});

test('an explicit ?team= takes precedence over the remembered team (AC6)', () => {
  assert.equal(resolveFlowControlTeam({ urlTeam: 'team-c', rememberedTeam: 'team-b', teams: TEAMS }), 'team-c');
});

test('an unknown ?team= falls through to the remembered team', () => {
  assert.equal(resolveFlowControlTeam({ urlTeam: 'gone', rememberedTeam: 'team-b', teams: TEAMS }), 'team-b');
});

test('a remembered team that no longer exists or is not visible falls back to the first team (AC7)', () => {
  assert.equal(resolveFlowControlTeam({ rememberedTeam: 'deleted-team', teams: TEAMS }), 'team-a');
  assert.equal(resolveFlowControlTeam({ rememberedTeam: '', teams: TEAMS }), 'team-a');
  assert.equal(resolveFlowControlTeam({ teams: TEAMS }), 'team-a');
});

test('no team is resolved while the list is loading or empty', () => {
  assert.equal(resolveFlowControlTeam({ rememberedTeam: 'team-b', teams: [] }), '');
  assert.equal(resolveFlowControlTeam({ rememberedTeam: 'team-b', teams: undefined }), '');
  assert.equal(resolveFlowControlTeam(), '');
});

test('the current team is remembered per user (AC8)', () => {
  const store = memStore();
  writeCurrentTeam('user-x', 'team-b', store);
  assert.equal(readCurrentTeam('user-y', store), '');
  assert.equal(resolveFlowControlTeam({ rememberedTeam: readCurrentTeam('user-y', store), teams: TEAMS }), 'team-a');
  assert.notEqual(currentTeamKey('user-x'), currentTeamKey('user-y'));
  assert.equal(currentTeamKey(undefined), 'aee.currentTeam.anon');
});

test('unavailable or throwing storage behaves like nothing remembered', () => {
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => writeCurrentTeam('x', 'team-b', throwing));
  assert.equal(readCurrentTeam('x', throwing), '');
  // No window under node:test, so the default store is unavailable.
  assert.equal(readCurrentTeam('x'), '');
  assert.doesNotThrow(() => writeCurrentTeam('x', 'team-b'));
});
