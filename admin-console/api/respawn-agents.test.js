'use strict';

// Unit tests for the respawn-on-credential-rotation feature's pure logic
// (PR #1049, per-agent visibility added by #1501).
// Run: node --test admin-console/api/respawn-agents.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  discoverBoundAgents, hiddenBlastRadius, projectRespawnOutcome, respawnWithConcurrency,
} = require('./respawn-agents');

// ── discoverBoundAgents ──────────────────────────────────────────────

// `isVisible` defaults to "everything is visible" in the TEST helper only, so
// the pre-#1501 assertions below keep reading as statements about discovery.
// The module itself has no such default — see the required-dep test.
function deps({ envs = {}, teams = {}, isVisible = () => true } = {}) {
  return {
    loadEnvironment: (envId) => envs[envId] || null,
    effectiveEndpointId: (cfg, env) => (cfg && cfg.llmEndpointOverride) || (env && env.llmEndpointId) || null,
    loadTeamConfig: (teamId) => teams[teamId] || null,
    isVisible,
  };
}

// Most assertions predate the visible/hidden split and are about discovery, not
// visibility; this keeps them reading as they did while the shape changed.
function discoverVisible(configs, endpointId, d) {
  const { visible, hidden } = discoverBoundAgents(configs, endpointId, d);
  assert.deepEqual(hidden, [], 'helper is for all-visible fixtures only');
  return visible;
}

test('discoverBoundAgents: includes an enabled, materialized, matching-endpoint agent', () => {
  const cfg = { id: 'a1', displayName: 'Agent One', role: 'team-member', token: 'tok', enabled: true, environmentId: 'env1' };
  const result = discoverVisible([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep1' } } }));
  assert.deepEqual(result, [{ id: 'a1', displayName: 'Agent One', role: 'team-member', teamId: null, teamName: null }]);
});

test('discoverBoundAgents: excludes a disabled agent', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: false, environmentId: 'env1' };
  const result = discoverVisible([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep1' } } }));
  assert.deepEqual(result, []);
});

test('discoverBoundAgents: excludes an agent with no token (stub, not materialized)', () => {
  const cfg = { id: 'a1', enabled: true, environmentId: 'env1' };
  const result = discoverVisible([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep1' } } }));
  assert.deepEqual(result, []);
});

test('discoverBoundAgents: excludes an agent whose effective endpoint does not match', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1' };
  const result = discoverVisible([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep2' } } }));
  assert.deepEqual(result, []);
});

test('discoverBoundAgents: skips null/malformed configs without throwing', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1' };
  const result = discoverVisible([null, cfg, undefined], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep1' } } }));
  assert.deepEqual(result, [{ id: 'a1', displayName: 'a1', role: 'agent', teamId: null, teamName: null }]);
});

test('discoverBoundAgents: an agent-level llmEndpointOverride wins over the environment binding', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1', llmEndpointOverride: 'ep1' };
  const result = discoverVisible([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep2' } } }));
  assert.equal(result.length, 1);
});

test('discoverBoundAgents: resolves teamName from parentTeamId', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1', parentTeamId: 'team1' };
  const result = discoverVisible([cfg], 'ep1', deps({
    envs: { env1: { llmEndpointId: 'ep1' } },
    teams: { team1: { displayName: 'Team One' } },
  }));
  assert.deepEqual(result, [{ id: 'a1', displayName: 'a1', role: 'agent', teamId: 'team1', teamName: 'Team One' }]);
});

test('discoverBoundAgents: falls back to the raw teamId when the team config has no displayName', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1', parentTeamId: 'team1' };
  const result = discoverVisible([cfg], 'ep1', deps({
    envs: { env1: { llmEndpointId: 'ep1' } },
    teams: { team1: {} },
  }));
  assert.equal(result[0].teamName, 'team1');
});

test('discoverBoundAgents: teamId/teamName are both null when there is no parentTeamId', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1' };
  const result = discoverVisible([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep1' } } }));
  assert.equal(result[0].teamId, null);
  assert.equal(result[0].teamName, null);
});

test('discoverBoundAgents: teamName is null when parentTeamId points at a team config that no longer exists', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1', parentTeamId: 'ghost-team' };
  const result = discoverVisible([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep1' } } }));
  assert.equal(result[0].teamId, 'ghost-team');
  assert.equal(result[0].teamName, null);
});

// ── discoverBoundAgents: per-agent visibility (#1501) ─────────────────

// The leak this closes: seeing the PROVIDER said nothing about seeing an AGENT.
const boundTo = (id, extra = {}) => ({ id, token: 'tok', enabled: true, environmentId: 'env1', ...extra });
const ep1 = { envs: { env1: { llmEndpointId: 'ep1' } } };

test('#1501 partitions bound agents by caller visibility — hidden ones never reach `visible`', () => {
  const mine = boundTo('mine', { parentTeamId: 'my-team', displayName: 'Mine' });
  const theirs = boundTo('theirs', { parentTeamId: 'other-team', displayName: 'Theirs' });
  const { visible, hidden } = discoverBoundAgents([mine, theirs], 'ep1', deps({
    ...ep1,
    isVisible: (cfg) => cfg.parentTeamId === 'my-team',
  }));
  assert.deepEqual(visible.map(a => a.id), ['mine']);
  assert.deepEqual(hidden.map(a => a.id), ['theirs']);
});

test('#1501 a hidden agent is still DISCOVERED — the respawn set is the union, not the visible set', () => {
  const { visible, hidden } = discoverBoundAgents([boundTo('a'), boundTo('b')], 'ep1', deps({
    ...ep1, isVisible: () => false,
  }));
  assert.deepEqual(visible, []);
  assert.deepEqual(hidden.map(a => a.id), ['a', 'b'],
    'hiding an agent from the respawn would leave it on the rotated-away credential');
});

test('#1501 visibility is asked per agent, never inferred from the credential', () => {
  const asked = [];
  discoverBoundAgents([boundTo('a'), boundTo('b')], 'ep1', deps({
    ...ep1, isVisible: (cfg) => { asked.push(cfg.id); return true; },
  }));
  assert.deepEqual(asked, ['a', 'b']);
});

test('#1501 an agent excluded by discovery is never asked about, and lands in neither list', () => {
  const asked = [];
  const { visible, hidden } = discoverBoundAgents(
    [boundTo('disabled', { enabled: false }), boundTo('stub', { token: undefined }), null],
    'ep1',
    deps({ ...ep1, isVisible: (cfg) => { asked.push(cfg.id); return true; } }),
  );
  assert.deepEqual(asked, []);
  assert.deepEqual(visible, []);
  assert.deepEqual(hidden, []);
});

test('#1501 isVisible is REQUIRED — a call site cannot inherit a fail-open default', () => {
  const { isVisible, ...withoutIt } = deps(ep1); // eslint-disable-line no-unused-vars
  assert.throws(
    () => discoverBoundAgents([boundTo('a')], 'ep1', withoutIt),
    /isVisible/,
  );
});

// ── The leak itself, over the REAL predicates ─────────────────────────
//
// Everything above stubs `isVisible`, which proves the partition but not that
// the route's answer to it is the right one. This drives the exact scenario
// #1501 describes — a system-scoped provider shared across two teams, rotated by
// a Team Admin of one of them — through `computeScope` → `visibleAgent` →
// `resolveAgentTeam`, i.e. the same chain `boundAgentDeps` builds in api.js.

test('#1501 a Team Admin who can merely VIEW a shared provider no longer sees the other team\'s agents', () => {
  const { computeScope, visibleAgent } = require('./scope');
  const { resolveAgentTeam } = require('./agent-team');
  const agentMetaForScope = (cfg) => ({ teamId: resolveAgentTeam(cfg), ownerId: cfg && cfg.ownerId });

  const users = [
    { id: 'u-alice', subject: 'alice@example.com' },
    { id: 'u-bob', subject: 'bob@example.com' },
  ];
  const memberships = [
    { userId: 'u-alice', teamId: 'team-a', role: 'team-admin' },
    { userId: 'u-bob', teamId: 'team-b', role: 'team-admin' },
  ];
  // authEnabled: true — the multi-user mode this boundary only exists in.
  const alice = computeScope({ username: 'alice@example.com', adminUsername: 'root', users, memberships, authEnabled: true });

  const configs = [
    { id: 'team-a-dev', role: 'team-member', parentTeamId: 'team-a', displayName: 'A Dev', ...boundTo('team-a-dev') },
    { id: 'team-b-dev', role: 'team-member', parentTeamId: 'team-b', displayName: 'B Dev', ...boundTo('team-b-dev') },
    { id: 'bobs-own', role: 'agent', ownerId: 'u-bob', displayName: "Bob's assistant", ...boundTo('bobs-own') },
  ];
  const { visible, hidden } = discoverBoundAgents(configs, 'ep1', deps({
    ...ep1,
    teams: { 'team-a': { displayName: 'Team A' }, 'team-b': { displayName: 'Team B' } },
    isVisible: (cfg) => visibleAgent(alice, agentMetaForScope(cfg)),
  }));

  assert.deepEqual(visible.map(a => a.id), ['team-a-dev']);
  // The other team's member AND another human's standalone agent (D8) are both hidden.
  assert.deepEqual(hidden.map(a => a.id).sort(), ['bobs-own', 'team-b-dev']);

  // What Alice is told: two more consumers, one other team plus one agent that
  // belongs to no team — and not a single id, name or team name of theirs.
  const signal = hiddenBlastRadius(hidden);
  assert.deepEqual(signal, { count: 2, teamCount: 1, standalone: 1 });
  const serialized = JSON.stringify(signal);
  for (const secret of ['team-b', 'Team B', 'bobs-own', 'B Dev', "Bob's assistant"]) {
    assert.equal(serialized.includes(secret), false, `the signal leaked ${secret}`);
  }

  // …and the restart still reaches them: the respawn set is the union.
  const respawnSet = [...visible, ...hidden].map(a => a.id).sort();
  assert.deepEqual(respawnSet, ['bobs-own', 'team-a-dev', 'team-b-dev']);
});

test('#1501 a System Admin still sees every bound agent (D5 — nothing is hidden from the operator)', () => {
  const { computeScope, visibleAgent } = require('./scope');
  const { resolveAgentTeam } = require('./agent-team');
  const agentMetaForScope = (cfg) => ({ teamId: resolveAgentTeam(cfg), ownerId: cfg && cfg.ownerId });

  const root = computeScope({ username: 'root', adminUsername: 'root', users: [], memberships: [], authEnabled: true });
  assert.equal(root.all, true, 'fixture precondition: the env admin is the full-visibility scope');

  const configs = [
    { id: 'team-a-dev', role: 'team-member', parentTeamId: 'team-a', ...boundTo('team-a-dev') },
    { id: 'team-b-dev', role: 'team-member', parentTeamId: 'team-b', ...boundTo('team-b-dev') },
  ];
  const { visible, hidden } = discoverBoundAgents(configs, 'ep1', deps({
    ...ep1, isVisible: (cfg) => visibleAgent(root, agentMetaForScope(cfg)),
  }));
  assert.deepEqual(visible.map(a => a.id), ['team-a-dev', 'team-b-dev']);
  assert.deepEqual(hidden, [], 'the fix must not narrow what an operator sees');
});

// ── hiddenBlastRadius ─────────────────────────────────────────────────

test('hiddenBlastRadius: counts agents and distinct teams, never names either', () => {
  const r = hiddenBlastRadius([
    { id: 'x', teamId: 't1' }, { id: 'y', teamId: 't1' }, { id: 'z', teamId: 't2' },
  ]);
  assert.deepEqual(r, { count: 3, teamCount: 2, standalone: 0 });
  assert.equal(JSON.stringify(r).includes('t1'), false, 'no team id may survive into the signal');
});

test('hiddenBlastRadius: a teamless hidden agent is counted, but does not claim a team', () => {
  const r = hiddenBlastRadius([{ id: 'x', teamId: null }, { id: 'y', teamId: 't1' }]);
  assert.deepEqual(r, { count: 2, teamCount: 1, standalone: 1 });
});

test('hiddenBlastRadius: nothing hidden is an all-zero signal, not a missing one', () => {
  assert.deepEqual(hiddenBlastRadius([]), { count: 0, teamCount: 0, standalone: 0 });
});

// ── projectRespawnOutcome ─────────────────────────────────────────────

test('projectRespawnOutcome: discloses ids only for visible agents, the rest as counts', () => {
  const out = projectRespawnOutcome(
    { respawned: ['mine', 'theirs'], skipped: ['mine2', 'theirs2'] },
    new Set(['mine', 'mine2']),
  );
  assert.deepEqual(out, {
    respawned: ['mine'], skipped: ['mine2'], hiddenRespawned: 1, hiddenSkipped: 1,
  });
});

test('projectRespawnOutcome: a hidden FAILURE is counted, never dropped', () => {
  const out = projectRespawnOutcome({ respawned: [], skipped: ['theirs'] }, new Set());
  assert.deepEqual(out.skipped, []);
  assert.equal(out.hiddenSkipped, 1,
    'an agent left on a stale credential must reach the operator even unnamed');
});

test('projectRespawnOutcome: with everything visible the projection is the identity', () => {
  const outcome = { respawned: ['a'], skipped: ['b'] };
  const out = projectRespawnOutcome(outcome, new Set(['a', 'b']));
  assert.deepEqual(out.respawned, ['a']);
  assert.deepEqual(out.skipped, ['b']);
  assert.equal(out.hiddenRespawned + out.hiddenSkipped, 0);
});

// ── respawnWithConcurrency ────────────────────────────────────────────

test('respawnWithConcurrency: processes every id exactly once and partitions by result', async () => {
  const calls = [];
  const respawnFn = async (id) => { calls.push(id); return id !== 'b'; };
  const result = await respawnWithConcurrency(['a', 'b', 'c'], 5, respawnFn);
  assert.deepEqual(calls.sort(), ['a', 'b', 'c']);
  assert.deepEqual(result.respawned.sort(), ['a', 'c']);
  assert.deepEqual(result.skipped, ['b']);
});

test('respawnWithConcurrency: concurrency of 1 never runs more than one call at a time', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const respawnFn = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return true;
  };
  await respawnWithConcurrency(['a', 'b', 'c', 'd'], 1, respawnFn);
  assert.equal(maxInFlight, 1);
});

test('respawnWithConcurrency: a concurrency below the id count caps simultaneous calls at that number', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const respawnFn = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return true;
  };
  const ids = Array.from({ length: 18 }, (_, i) => `agent-${i}`);
  await respawnWithConcurrency(ids, 5, respawnFn);
  assert.equal(maxInFlight, 5);
});

test('respawnWithConcurrency: a concurrency at or above the id count runs everything at once (never more workers than ids)', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const respawnFn = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return true;
  };
  const ids = ['a', 'b', 'c'];
  await respawnWithConcurrency(ids, 50, respawnFn);
  assert.equal(maxInFlight, 3);
});

test('respawnWithConcurrency: a concurrency of 0, negative, or NaN still processes every id (floored to 1, never hangs)', async () => {
  for (const bad of [0, -5, NaN]) {
    const calls = [];
    const respawnFn = async (id) => { calls.push(id); return true; };
    const result = await respawnWithConcurrency(['a', 'b'], bad, respawnFn);
    assert.deepEqual(calls.sort(), ['a', 'b']);
    assert.deepEqual(result.respawned.sort(), ['a', 'b']);
  }
});

test('respawnWithConcurrency: an empty id list returns empty results with zero calls', async () => {
  let callCount = 0;
  const respawnFn = async () => { callCount++; return true; };
  const result = await respawnWithConcurrency([], 5, respawnFn);
  assert.deepEqual(result, { respawned: [], skipped: [] });
  assert.equal(callCount, 0);
});
