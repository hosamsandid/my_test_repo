'use strict';

// Unit tests for the team-clone decision core (#2171, epic #2166 A5).
// Run: node --test admin-console/api/team-clone.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCloneSource, describeClonedCredentialNeeds } = require('./team-clone');
const { copyEnvironmentStructure } = require('./environment-template');

test('validateCloneSource refuses a missing config', () => {
  assert.deepEqual(validateCloneSource(null), { error: 'not-found' });
  assert.deepEqual(validateCloneSource(undefined), { error: 'not-found' });
});

test('validateCloneSource refuses a non-team role', () => {
  assert.deepEqual(validateCloneSource({ role: 'agent' }), { error: 'not-a-team' });
  assert.deepEqual(validateCloneSource({ role: 'team-member' }), { error: 'not-a-team' });
});

test('validateCloneSource accepts a team', () => {
  assert.deepEqual(validateCloneSource({ role: 'team' }), { ok: true });
});

test('describeClonedCredentialNeeds names every repo and mcp server, and needs a token whenever a repo exists', () => {
  const structure = copyEnvironmentStructure({
    repositories: [{ url: 'git@github.com:acme/repo.git', branch: 'main', sshKeyId: 'key-1' }],
    mcpServers: [{ serverId: 'wiki', credentialId: 'cred-1' }],
  });
  assert.deepEqual(describeClonedCredentialNeeds(structure), {
    needsGithubToken: true,
    repositories: [{ url: 'git@github.com:acme/repo.git', branch: 'main' }],
    mcpServers: [{ serverId: 'wiki' }],
  });
});

test('describeClonedCredentialNeeds needs no token for a repo-less team', () => {
  const structure = copyEnvironmentStructure({});
  assert.deepEqual(describeClonedCredentialNeeds(structure), {
    needsGithubToken: false,
    repositories: [],
    mcpServers: [],
  });
});

test('describeClonedCredentialNeeds never carries a credential id, regardless of what the source had', () => {
  const structure = copyEnvironmentStructure({
    repositories: [
      { url: 'git@github.com:acme/one.git', branch: 'main', sshKeyId: 'key-1' },
      { url: 'https://github.com/acme/two.git', branch: 'dev', sshKeyId: 'key-2' },
    ],
    mcpServers: [{ serverId: 'wiki', credentialId: 'cred-1' }, { serverId: 'kb', credentialId: 'cred-2' }],
  });
  const needs = describeClonedCredentialNeeds(structure);
  assert.equal(JSON.stringify(needs).includes('key-'), false);
  assert.equal(JSON.stringify(needs).includes('cred-'), false);
});
