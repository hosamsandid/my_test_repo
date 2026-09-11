import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADMIN_TABS, DEFAULT_ADMIN_TAB, resolveAdminTab,
  allTeamRows, isUnadministered, teamDeleteImpact,
  groupAgentsForOwnership,
  environmentTierSummary, mcpTierSummary, environmentOwnershipError, environmentOwnershipPatch,
  ownershipUnchanged,
} from './administration-view.js';

/* ── Tabs ──────────────────────────────────────────────────────────────── */

test('the three tabs are exactly the ones AC2 names, in reading order', () => {
  assert.deepEqual(ADMIN_TABS.map(t => t.id), ['users', 'teams', 'resources']);
  assert.deepEqual(ADMIN_TABS.map(t => t.label), ['Users', 'All Teams', 'Resources']);
});

test('an absent or unknown ?tab= lands on Users — a pre-#2085 /users bookmark is unchanged', () => {
  assert.equal(resolveAdminTab(undefined), 'users');
  assert.equal(resolveAdminTab(''), 'users');
  assert.equal(resolveAdminTab('nope'), 'users');
  assert.equal(resolveAdminTab(null), DEFAULT_ADMIN_TAB);
  assert.equal(resolveAdminTab('teams'), 'teams');
  assert.equal(resolveAdminTab('resources'), 'resources');
});

/* ── All Teams ─────────────────────────────────────────────────────────── */

const AGENTS = [
  { id: 'sdlc', role: 'team', displayName: 'SDLC Squad', ownerId: 'u1', enabled: true },
  { id: 'sdlc-dev', role: 'team-member', parentTeamId: 'sdlc' },
  { id: 'sdlc-rev', role: 'team-member', parentTeamId: 'sdlc' },
  { id: 'atlas', role: 'team', displayName: 'Atlas', enabled: false },
  { id: 'lonewolf', role: 'agent' },
];
const MEMBERSHIPS = [
  { userId: 'u1', teamId: 'sdlc', role: 'team-admin' },
  { userId: 'u2', teamId: 'sdlc', role: 'team-member' },
  { userId: 'u2', teamId: 'atlas', role: 'team-member' },
];
const USERS = [
  { id: 'u1', displayName: 'Jane Doe' },
  { id: 'u2', subject: 'sam@corp.com' },
];

test('one row per Agent Team — never per access scope, never per member agent', () => {
  const rows = allTeamRows(AGENTS, MEMBERSHIPS, USERS);
  assert.deepEqual(rows.map(r => r.id), ['atlas', 'sdlc']); // sorted by label
});

test('counts split member AGENTS from member PEOPLE, and name the owner', () => {
  const rows = allTeamRows(AGENTS, MEMBERSHIPS, USERS);
  const sdlc = rows.find(r => r.id === 'sdlc');
  assert.equal(sdlc.agents, 2);
  assert.equal(sdlc.people, 2);
  assert.equal(sdlc.admins, 1);
  assert.equal(sdlc.owner, 'Jane Doe');
  assert.equal(sdlc.enabled, 'Enabled');
});

test('an owner-less team reports "—" rather than a blank cell (D6 ends in "else unset")', () => {
  const rows = allTeamRows(AGENTS, MEMBERSHIPS, USERS);
  assert.equal(rows.find(r => r.id === 'atlas').owner, '—');
});

test('an ownerId with no user record falls back to the raw id, not to blank', () => {
  const rows = allTeamRows([{ id: 't', role: 'team', ownerId: 'ghost' }], [], USERS);
  assert.equal(rows[0].owner, 'ghost');
});

test('every displayed value is a top-level key, so DataTable can sort and filter it', () => {
  const [row] = allTeamRows(AGENTS, MEMBERSHIPS, USERS);
  for (const key of ['id', 'name', 'owner', 'agents', 'people', 'admins', 'enabled']) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, key), `${key} must be flat on the row`);
  }
});

test('a team with no team-admin left is flagged — that is what the cleanup view is for (D5)', () => {
  const rows = allTeamRows(AGENTS, MEMBERSHIPS, USERS);
  assert.equal(isUnadministered(rows.find(r => r.id === 'atlas')), true);
  assert.equal(isUnadministered(rows.find(r => r.id === 'sdlc')), false);
  assert.equal(isUnadministered(null), false);
});

test('the delete confirmation names BOTH cascades, singular and plural', () => {
  const rows = allTeamRows(AGENTS, MEMBERSHIPS, USERS);
  const many = teamDeleteImpact(rows.find(r => r.id === 'sdlc'));
  assert.match(many.title, /SDLC Squad/);
  assert.match(many.detail, /2 member agents are deleted/);
  assert.match(many.detail, /2 people lose their membership/);

  const one = teamDeleteImpact({ name: 'x', agents: 1, people: 1 });
  assert.match(one.detail, /1 member agent is deleted/);
  assert.match(one.detail, /1 person loses their membership/);
  assert.equal(teamDeleteImpact(null), null);
});

test('allTeamRows survives empty / malformed input', () => {
  assert.deepEqual(allTeamRows(null, null, null), []);
  assert.deepEqual(allTeamRows([null, undefined], [null], [null]), []);
  // A membership with no teamId must not create a phantom bucket.
  assert.deepEqual(allTeamRows([{ id: 't', role: 'team' }], [{ userId: 'u' }], []).map(r => r.people), [0]);
});

/* ── groupAgentsForOwnership (moved from teams-ownership.js, #568) ─────── */

const OWNERSHIP_AGENTS = [
  { id: 'sdlc', role: 'team', displayName: 'SDLC Squad', teamId: 'alpha' },
  { id: 'sdlc-dev', role: 'team-member', parentTeamId: 'sdlc', teamId: 'alpha' },
  { id: 'sdlc-rev', role: 'team-member', parentTeamId: 'sdlc', teamId: 'alpha' },
  { id: 'lonewolf', role: 'agent', teamId: 'default' },
  { id: 'orch', role: 'orchestrator', teamId: 'default' },
  { id: 'orphan', role: 'team-member', parentTeamId: 'gone', teamId: 'default' },
];

test('groups team-members under their parent Agent Team', () => {
  const { agentTeams } = groupAgentsForOwnership(OWNERSHIP_AGENTS);
  assert.equal(agentTeams.length, 1);
  assert.equal(agentTeams[0].team.id, 'sdlc');
  assert.deepEqual(agentTeams[0].members.map(m => m.id), ['sdlc-dev', 'sdlc-rev']);
});

test('standalone agents exclude team agents and grouped members', () => {
  const { standaloneAgents } = groupAgentsForOwnership(OWNERSHIP_AGENTS);
  const ids = standaloneAgents.map(a => a.id);
  assert.ok(ids.includes('lonewolf'));
  assert.ok(ids.includes('orch'));
  assert.ok(!ids.includes('sdlc'));
  assert.ok(!ids.includes('sdlc-dev'));
});

test('orphan member (parent gone) falls back to standalone, not crashing (E2)', () => {
  const { agentTeams, standaloneAgents } = groupAgentsForOwnership(OWNERSHIP_AGENTS);
  assert.ok(standaloneAgents.map(a => a.id).includes('orphan'));
  assert.ok(!agentTeams.some(g => g.members.some(m => m.id === 'orphan')));
});

test('a team with zero members still appears as an assignable group (E1)', () => {
  const solo = [{ id: 'solo', role: 'team', displayName: 'Solo', teamId: 'default' }];
  const { agentTeams } = groupAgentsForOwnership(solo);
  assert.equal(agentTeams.length, 1);
  assert.deepEqual(agentTeams[0].members, []);
});

test('handles empty / bad input without throwing', () => {
  assert.deepEqual(groupAgentsForOwnership(null), { agentTeams: [], standaloneAgents: [] });
  assert.deepEqual(groupAgentsForOwnership([]), { agentTeams: [], standaloneAgents: [] });
  assert.deepEqual(groupAgentsForOwnership([null, undefined]), { agentTeams: [], standaloneAgents: [] });
});

test('groups + standalone are sorted by label for stable rendering', () => {
  const many = [
    { id: 'b-team', role: 'team', displayName: 'Bravo' },
    { id: 'a-team', role: 'team', displayName: 'Alpha' },
    { id: 'z-agent', role: 'agent', displayName: 'Zeta' },
    { id: 'm-agent', role: 'agent', displayName: 'Mike' },
  ];
  const { agentTeams, standaloneAgents } = groupAgentsForOwnership(many);
  assert.deepEqual(agentTeams.map(g => g.team.id), ['a-team', 'b-team']);
  assert.deepEqual(standaloneAgents.map(a => a.id), ['m-agent', 'z-agent']);
});

/* ── Environment tiers (D7/D12) ────────────────────────────────────────── */

const NAMES = { alpha: 'Alpha', beta: 'Beta' };

test('the shared tier reads "Shared" and lists the teams it reaches', () => {
  const s = environmentTierSummary({ scope: 'system', assignedTeamIds: ['alpha', 'beta'] }, NAMES);
  assert.equal(s.scope, 'system');
  assert.equal(s.label, 'Shared');
  assert.equal(s.detail, 'Alpha, Beta');
});

test('a shared environment assigned to nobody says so — it is reachable by no team', () => {
  const s = environmentTierSummary({ scope: 'system', assignedTeamIds: [] }, NAMES);
  assert.match(s.detail, /Not assigned to any team/);
  assert.match(s.detail, /System Admins only/);
});

// #2158 AC7 — a global record and a shared-with-nobody record carry the
// IDENTICAL underlying shape (`scope: 'system'`, `assignedTeamIds: []`) and
// mean the OPPOSITE thing (everyone vs. nobody). This is the actual logic the
// #2158 review flagged as untested — the shape overlap is exactly what makes
// getting the branch order wrong silently swap the two meanings.
test('#2158: a global record reads "Global" — not the shared-with-nobody wording — despite the identical empty-assignment shape', () => {
  const s = environmentTierSummary({ scope: 'system', assignedTeamIds: [], global: true }, NAMES);
  assert.equal(s.scope, 'system');
  assert.equal(s.global, true);
  assert.equal(s.label, 'Global');
  assert.match(s.detail, /every team/i);
  assert.match(s.detail, /created later/i);
  // The "System Admins only" shared-with-nobody sentence must NEVER appear on
  // a global record — that sentence claims the opposite of what global means.
  assert.doesNotMatch(s.detail, /Not assigned to any team/);
  assert.doesNotMatch(s.detail, /System Admins only/);
});

test('#2158: global wins even when assignedTeamIds is non-empty (the broadest reach wins, mirrors #2136)', () => {
  const s = environmentTierSummary({ scope: 'system', assignedTeamIds: ['alpha'], global: true }, NAMES);
  assert.equal(s.label, 'Global');
});

test('#2158: a stale/hand-edited global flag on a non-system-scoped record is not honoured', () => {
  // isGlobalRecord requires scope === 'system'; a team-tier record carrying a
  // stray `global: true` must read as an ordinary team record, not Global.
  const s = environmentTierSummary({ scope: 'team', teamId: 'alpha', global: true }, NAMES);
  assert.equal(s.label, 'Team');
  assert.equal(s.global, false);
});

test('#2158 AC7: mcpTierSummary is the SAME helper as environmentTierSummary, not a second copy', () => {
  // The whole point of the alias (AC7 — "one shared tier-summary helper
  // serving both kinds") is that a global MCP server and a global environment
  // can never be labelled differently by drifting implementations.
  assert.equal(mcpTierSummary, environmentTierSummary);
  const mcpGlobal = mcpTierSummary({ scope: 'system', assignedTeamIds: [], global: true }, NAMES);
  assert.equal(mcpGlobal.label, 'Global');
  const mcpShared = mcpTierSummary({ scope: 'system', assignedTeamIds: [] }, NAMES);
  assert.equal(mcpShared.label, 'Shared');
});

test('a team-tier and a LEGACY (scope-less) environment read identically', () => {
  const explicit = environmentTierSummary({ scope: 'team', teamId: 'alpha' }, NAMES);
  const legacy = environmentTierSummary({ teamId: 'alpha' }, NAMES);
  assert.deepEqual(explicit, legacy);
  assert.equal(explicit.label, 'Team');
  assert.equal(explicit.detail, 'Alpha');
});

test('a personal-tier environment is reported as unsupported, not rendered as a team (A3.2)', () => {
  const s = environmentTierSummary({ scope: 'personal', userId: 'u1' }, NAMES);
  assert.equal(s.label, 'Personal');
  assert.match(s.detail, /Unsupported tier/);
});

test('Save is refused with a reason before the server 400s', () => {
  assert.match(environmentOwnershipError({ scope: 'team', teamId: '' }), /Pick the team/);
  assert.match(environmentOwnershipError({ scope: 'personal' }), /cannot be personal/);
  assert.equal(environmentOwnershipError({ scope: 'team', teamId: 'alpha' }), null);
  // Shared needs no team — assigning to none is a legal, stated state.
  assert.equal(environmentOwnershipError({ scope: 'system', assignedTeamIds: [] }), null);
});

test('the PUT body is the SHARED ownership payload — never a bare teamId', () => {
  // The whole point of the rework: a bare `{ teamId }` against a shared record
  // normalizes to scope:'team' server-side, i.e. it silently un-shares it.
  assert.deepEqual(environmentOwnershipPatch({ scope: 'team', teamId: 'alpha' }), { scope: 'team', teamId: 'alpha' });
  assert.deepEqual(
    environmentOwnershipPatch({ scope: 'system', assignedTeamIds: ['alpha', 'alpha', 'beta'] }),
    { scope: 'system', assignedTeamIds: ['alpha', 'beta'] },
  );
  for (const own of [{ scope: 'team', teamId: 'alpha' }, { scope: 'system', assignedTeamIds: [] }]) {
    assert.ok('scope' in environmentOwnershipPatch(own), 'scope must always be sent explicitly');
  }
});

test('an unchanged tier is recognised as a no-op, in both directions and for a legacy record', () => {
  assert.equal(ownershipUnchanged({ scope: 'team', teamId: 'alpha' }, { scope: 'team', teamId: 'alpha' }), true);
  assert.equal(ownershipUnchanged({ teamId: 'alpha' }, { scope: 'team', teamId: 'alpha' }), true);
  assert.equal(ownershipUnchanged({ scope: 'team', teamId: 'alpha' }, { scope: 'team', teamId: 'beta' }), false);
  assert.equal(ownershipUnchanged({ scope: 'team', teamId: 'alpha' }, { scope: 'system', assignedTeamIds: [] }), false);
  assert.equal(
    ownershipUnchanged({ scope: 'system', assignedTeamIds: ['beta', 'alpha'] }, { scope: 'system', assignedTeamIds: ['alpha', 'beta'] }),
    true, 'assignment order is not a change',
  );
  assert.equal(
    ownershipUnchanged({ scope: 'system', assignedTeamIds: ['alpha'] }, { scope: 'system', assignedTeamIds: ['alpha', 'beta'] }),
    false,
  );
});
