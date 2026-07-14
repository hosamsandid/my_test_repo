const test = require('node:test');
const assert = require('node:assert/strict');

const { membersOfTeam } = require('./agent-team-cascade');

const configs = [
  { id: 'sdlc', role: 'team', teamId: 'default' },
  { id: 'sdlc-dev', role: 'team-member', parentTeamId: 'sdlc', teamId: 'default' },
  { id: 'sdlc-rev', role: 'team-member', parentTeamId: 'sdlc', teamId: 'default' },
  { id: 'other', role: 'team', teamId: 'alpha' },
  { id: 'other-dev', role: 'team-member', parentTeamId: 'other', teamId: 'alpha' },
  { id: 'lonewolf', role: 'agent', teamId: 'default' },
  { id: 'orphan', role: 'team-member', parentTeamId: 'gone', teamId: 'default' },
];

test('returns only the members of the named team agent', () => {
  const ids = membersOfTeam(configs, 'sdlc').map(m => m.id);
  assert.deepEqual(ids, ['sdlc-dev', 'sdlc-rev']);
});

test('does not leak members of a sibling team', () => {
  const ids = membersOfTeam(configs, 'other').map(m => m.id);
  assert.deepEqual(ids, ['other-dev']);
});

test('a team agent with zero members yields an empty list (E1)', () => {
  const solo = [{ id: 'solo', role: 'team', teamId: 'default' }];
  assert.deepEqual(membersOfTeam(solo, 'solo'), []);
});

test('matches purely by parentTeamId, never by tenant teamId', () => {
  // `sdlc-dev`/`sdlc-rev` share teamId 'default' with plenty of others, yet
  // only the two whose parentTeamId is 'sdlc' come back — the cascade follows
  // squad membership, not the current tenant.
  const ids = membersOfTeam(configs, 'sdlc').map(m => m.id);
  assert.deepEqual(ids, ['sdlc-dev', 'sdlc-rev']);
  // An orphan (E2) is only ever returned for its literal missing parent id,
  // which is never a live team agent, so the cascade (guarded on role:"team"
  // at the call site) never touches it.
  assert.deepEqual(membersOfTeam(configs, 'gone').map(m => m.id), ['orphan']);
});

test('a standalone agent id has no members', () => {
  assert.deepEqual(membersOfTeam(configs, 'lonewolf'), []);
});

test('guards against bad input', () => {
  assert.deepEqual(membersOfTeam(null, 'sdlc'), []);
  assert.deepEqual(membersOfTeam(configs, ''), []);
  assert.deepEqual(membersOfTeam(configs, undefined), []);
});
