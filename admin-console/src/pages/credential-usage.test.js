import test from 'node:test';
import assert from 'node:assert/strict';

import {
  environmentsUsingSshKey,
  environmentsUsingGithubToken,
  usageCountLabel,
  usageTooltip,
} from './credential-usage.js';

const environments = [
  {
    id: 'prod',
    name: 'Production',
    githubTokenId: 'tok-a',
    repositories: [
      { url: 'git@github.com:acme/api.git', sshKeyId: 'key-1' },
      { url: 'git@github.com:acme/web.git', sshKeyId: 'key-2' },
    ],
  },
  {
    id: 'staging',
    name: 'Staging',
    githubTokenId: 'tok-b',
    repositories: [{ url: 'git@github.com:acme/api.git', sshKeyId: 'key-1' }],
  },
  {
    id: 'sandbox',
    name: 'Sandbox',
    githubTokenId: 'tok-a',
    repositories: [],
  },
];

test('environmentsUsingSshKey: finds every environment referencing the key', () => {
  assert.deepEqual(environmentsUsingSshKey(environments, 'key-1'), [
    { id: 'prod', name: 'Production' },
    { id: 'staging', name: 'Staging' },
  ]);
});

test('environmentsUsingSshKey: single match', () => {
  assert.deepEqual(environmentsUsingSshKey(environments, 'key-2'), [
    { id: 'prod', name: 'Production' },
  ]);
});

test('environmentsUsingSshKey: no match → empty', () => {
  assert.deepEqual(environmentsUsingSshKey(environments, 'key-unused'), []);
});

test('environmentsUsingSshKey: falsy keyId / non-array env → empty', () => {
  assert.deepEqual(environmentsUsingSshKey(environments, ''), []);
  assert.deepEqual(environmentsUsingSshKey(environments, null), []);
  assert.deepEqual(environmentsUsingSshKey(null, 'key-1'), []);
});

test('environmentsUsingSshKey: results sorted by display name', () => {
  const envs = [
    { id: 'z', name: 'Zeta', repositories: [{ sshKeyId: 'k' }] },
    { id: 'a', name: 'Alpha', repositories: [{ sshKeyId: 'k' }] },
  ];
  assert.deepEqual(environmentsUsingSshKey(envs, 'k').map(e => e.name), ['Alpha', 'Zeta']);
});

test('environmentsUsingSshKey: falls back to id when name is missing', () => {
  const envs = [{ id: 'no-name', repositories: [{ sshKeyId: 'k' }] }];
  assert.deepEqual(environmentsUsingSshKey(envs, 'k'), [{ id: 'no-name', name: 'no-name' }]);
});

test('environmentsUsingGithubToken: matches on top-level githubTokenId', () => {
  assert.deepEqual(environmentsUsingGithubToken(environments, 'tok-a'), [
    { id: 'prod', name: 'Production' },
    { id: 'sandbox', name: 'Sandbox' },
  ]);
});

test('environmentsUsingGithubToken: single match / no match', () => {
  assert.deepEqual(environmentsUsingGithubToken(environments, 'tok-b'), [
    { id: 'staging', name: 'Staging' },
  ]);
  assert.deepEqual(environmentsUsingGithubToken(environments, 'tok-none'), []);
});

test('environmentsUsingGithubToken: falsy tokenId / non-array env → empty', () => {
  assert.deepEqual(environmentsUsingGithubToken(environments, ''), []);
  assert.deepEqual(environmentsUsingGithubToken(null, 'tok-a'), []);
});

test('usageCountLabel: pluralization', () => {
  assert.equal(usageCountLabel([]), 'None');
  assert.equal(usageCountLabel(null), 'None');
  assert.equal(usageCountLabel([{ id: 'a' }]), '1 environment');
  assert.equal(usageCountLabel([{ id: 'a' }, { id: 'b' }]), '2 environments');
});

test('usageTooltip: lists names one per line, friendly empty note', () => {
  assert.equal(usageTooltip([]), 'Not used by any environment');
  assert.equal(
    usageTooltip([{ id: 'prod', name: 'Production' }, { id: 'staging', name: 'Staging' }]),
    'Production\nStaging',
  );
  assert.equal(usageTooltip([{ id: 'no-name' }]), 'no-name');
});
