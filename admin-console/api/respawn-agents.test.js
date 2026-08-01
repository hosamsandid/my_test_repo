'use strict';

// Unit tests for the respawn-on-credential-rotation feature's pure logic
// (PR #1049). Run: node --test admin-console/api/respawn-agents.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverBoundAgents, respawnWithConcurrency } = require('./respawn-agents');

// ── discoverBoundAgents ──────────────────────────────────────────────

function deps({ envs = {}, teams = {} } = {}) {
  return {
    loadEnvironment: (envId) => envs[envId] || null,
    effectiveEndpointId: (cfg, env) => (cfg && cfg.llmEndpointOverride) || (env && env.llmEndpointId) || null,
    loadTeamConfig: (teamId) => teams[teamId] || null,
  };
}

test('discoverBoundAgents: includes an enabled, materialized, matching-endpoint agent', () => {
  const cfg = { id: 'a1', displayName: 'Agent One', role: 'team-member', token: 'tok', enabled: true, environmentId: 'env1' };
  const result = discoverBoundAgents([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep1' } } }));
  assert.deepEqual(result, [{ id: 'a1', displayName: 'Agent One', role: 'team-member', teamId: null, teamName: null }]);
});

test('discoverBoundAgents: excludes a disabled agent', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: false, environmentId: 'env1' };
  const result = discoverBoundAgents([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep1' } } }));
  assert.deepEqual(result, []);
});

test('discoverBoundAgents: excludes an agent with no token (stub, not materialized)', () => {
  const cfg = { id: 'a1', enabled: true, environmentId: 'env1' };
  const result = discoverBoundAgents([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep1' } } }));
  assert.deepEqual(result, []);
});

test('discoverBoundAgents: excludes an agent whose effective endpoint does not match', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1' };
  const result = discoverBoundAgents([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep2' } } }));
  assert.deepEqual(result, []);
});

test('discoverBoundAgents: skips null/malformed configs without throwing', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1' };
  const result = discoverBoundAgents([null, cfg, undefined], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep1' } } }));
  assert.deepEqual(result, [{ id: 'a1', displayName: 'a1', role: 'agent', teamId: null, teamName: null }]);
});

test('discoverBoundAgents: an agent-level llmEndpointOverride wins over the environment binding', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1', llmEndpointOverride: 'ep1' };
  const result = discoverBoundAgents([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep2' } } }));
  assert.equal(result.length, 1);
});

test('discoverBoundAgents: resolves teamName from parentTeamId', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1', parentTeamId: 'team1' };
  const result = discoverBoundAgents([cfg], 'ep1', deps({
    envs: { env1: { llmEndpointId: 'ep1' } },
    teams: { team1: { displayName: 'Team One' } },
  }));
  assert.deepEqual(result, [{ id: 'a1', displayName: 'a1', role: 'agent', teamId: 'team1', teamName: 'Team One' }]);
});

test('discoverBoundAgents: falls back to the raw teamId when the team config has no displayName', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1', parentTeamId: 'team1' };
  const result = discoverBoundAgents([cfg], 'ep1', deps({
    envs: { env1: { llmEndpointId: 'ep1' } },
    teams: { team1: {} },
  }));
  assert.equal(result[0].teamName, 'team1');
});

test('discoverBoundAgents: teamId/teamName are both null when there is no parentTeamId', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1' };
  const result = discoverBoundAgents([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep1' } } }));
  assert.equal(result[0].teamId, null);
  assert.equal(result[0].teamName, null);
});

test('discoverBoundAgents: teamName is null when parentTeamId points at a team config that no longer exists', () => {
  const cfg = { id: 'a1', token: 'tok', enabled: true, environmentId: 'env1', parentTeamId: 'ghost-team' };
  const result = discoverBoundAgents([cfg], 'ep1', deps({ envs: { env1: { llmEndpointId: 'ep1' } } }));
  assert.equal(result[0].teamId, 'ghost-team');
  assert.equal(result[0].teamName, null);
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
