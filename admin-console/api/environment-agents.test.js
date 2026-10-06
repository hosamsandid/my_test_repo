'use strict';

// Unit tests for the environments list's one-pass agent index (#570), with a
// parity check against the c824d48b7 per-environment scan it replaces.
const test = require('node:test');
const assert = require('node:assert/strict');
const { indexAgentsByEnvironment, environmentAgentRows, firstAgentIdUsingEnvironment } = require('./environment-agents');

// Verbatim shape of the old `agentsUsingEnvironment` loop over pre-read configs.
function legacyAgentsUsingEnvironment(entries, envId, isVisible) {
  const agents = [];
  for (const { id, cfg } of entries) {
    if (cfg.environmentId === envId && isVisible(cfg)) {
      agents.push({ id, displayName: cfg.displayName || id });
    }
  }
  return agents;
}

const ENTRIES = [
  { id: 'a', cfg: { environmentId: 'env-1', displayName: 'Alpha', teamId: 't1' } },
  { id: 'b', cfg: { environmentId: 'env-2', teamId: 't2' } },
  { id: 'c', cfg: {} }, // corrupt config read as {}
  { id: 'd', cfg: { environmentId: 'env-1', teamId: 't2' } },
  { id: 'e', cfg: { environmentId: null } },
  { id: 'f', cfg: { environmentId: 'env-1', displayName: '', teamId: 't1' } },
];

test('parity with the per-environment scan, for every env and visibility', () => {
  const byEnv = indexAgentsByEnvironment(ENTRIES);
  const visibilities = [() => true, (cfg) => cfg.teamId === 't1', () => false];
  for (const envId of ['env-1', 'env-2', 'env-missing', '']) {
    for (const isVisible of visibilities) {
      assert.deepEqual(
        environmentAgentRows(byEnv, envId, isVisible),
        legacyAgentsUsingEnvironment(ENTRIES, envId, isVisible),
        `env ${envId}`,
      );
    }
  }
});

test('rows keep disk order and fall back to the id for a blank displayName', () => {
  const byEnv = indexAgentsByEnvironment(ENTRIES);
  assert.deepEqual(environmentAgentRows(byEnv, 'env-1', () => true), [
    { id: 'a', displayName: 'Alpha' }, { id: 'd', displayName: 'd' }, { id: 'f', displayName: 'f' },
  ]);
});

test('unbound and corrupt configs land in no bucket', () => {
  const byEnv = indexAgentsByEnvironment(ENTRIES);
  assert.deepEqual([...byEnv.keys()].sort(), ['env-1', 'env-2']);
  assert.equal(indexAgentsByEnvironment(null).size, 0);
  assert.equal(indexAgentsByEnvironment([null, { id: 'x' }]).size, 0);
});

// Verbatim shape of the old `environmentInUse` loop over pre-read configs.
function legacyEnvironmentInUse(entries, envId) {
  for (const { id, cfg } of entries) {
    if (cfg.environmentId === envId) return id;
  }
  return null;
}

test('the delete guard matches the old first-match scan', () => {
  const byEnv = indexAgentsByEnvironment(ENTRIES);
  for (const envId of ['env-1', 'env-2', 'env-missing']) {
    assert.equal(firstAgentIdUsingEnvironment(byEnv, envId), legacyEnvironmentInUse(ENTRIES, envId), `env ${envId}`);
  }
  assert.equal(firstAgentIdUsingEnvironment(byEnv, 'env-1'), 'a', 'first in disk order');
  assert.equal(firstAgentIdUsingEnvironment(new Map(), 'env-1'), null);
});
