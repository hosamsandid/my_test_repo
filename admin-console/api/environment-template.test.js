'use strict';

// Unit tests for the Environment Template decision core (#2170, epic #2166 A4).
// Run: node --test admin-console/api/environment-template.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { isTemplateEnvironment, resolveTemplateFlag, copyEnvironmentStructure } = require('./environment-template');

test('isTemplateEnvironment reads the explicit flag', () => {
  assert.equal(isTemplateEnvironment({ isTemplate: true }), true);
  assert.equal(isTemplateEnvironment({ isTemplate: false }), false);
  assert.equal(isTemplateEnvironment({}), false);
  assert.equal(isTemplateEnvironment(null), false);
});

test('isTemplateEnvironment treats a legacy global:true system-tier record as a template (migration)', () => {
  assert.equal(isTemplateEnvironment({ global: true, scope: 'system' }), true);
  // A hand-edited or stale shape (global but not system-tier) is NOT a
  // template, mirroring isGlobalEnvironment's own re-check discipline.
  assert.equal(isTemplateEnvironment({ global: true, scope: 'team', teamId: 't1' }), false);
});

test('body without an isTemplate field keeps the current value', () => {
  assert.deepEqual(resolveTemplateFlag({ currentTemplate: false, scopeAll: false }), { isTemplate: false });
  assert.deepEqual(resolveTemplateFlag({ currentTemplate: true, scopeAll: false }), { isTemplate: true });
  assert.deepEqual(resolveTemplateFlag({ wantTemplate: null, currentTemplate: true, scopeAll: false }), { isTemplate: true });
});

test('a System Admin may mark an environment as a template', () => {
  assert.deepEqual(
    resolveTemplateFlag({ wantTemplate: true, currentTemplate: false, scopeAll: true }),
    { isTemplate: true },
  );
});

test('a System Admin may retire a template back to an ordinary environment', () => {
  assert.deepEqual(
    resolveTemplateFlag({ wantTemplate: false, currentTemplate: true, scopeAll: true }),
    { isTemplate: false },
  );
});

test('a non-admin cannot change the flag either direction', () => {
  const publish = resolveTemplateFlag({ wantTemplate: true, currentTemplate: false, scopeAll: false });
  assert.equal(publish.status, 403);
  assert.equal(publish.code, 'template-system-admin-only');

  const retract = resolveTemplateFlag({ wantTemplate: false, currentTemplate: true, scopeAll: false });
  assert.equal(retract.status, 403);
  assert.equal(retract.code, 'template-system-admin-only');
});

test('a non-admin re-asserting the current value is not gated (no-op)', () => {
  assert.deepEqual(resolveTemplateFlag({ wantTemplate: true, currentTemplate: true, scopeAll: false }), { isTemplate: true });
  assert.deepEqual(resolveTemplateFlag({ wantTemplate: false, currentTemplate: false, scopeAll: false }), { isTemplate: false });
});

test('a stray non-boolean value never publishes', () => {
  assert.deepEqual(resolveTemplateFlag({ wantTemplate: 'yes', currentTemplate: false, scopeAll: true }), { isTemplate: false });
});

test('copyEnvironmentStructure strips credentials from repositories and MCP pairings', () => {
  const template = {
    repositories: [
      { url: 'git@github.com:acme/repo.git', branch: 'main', sshKeyId: 'key-1', readOnly: false },
      { url: '  ', branch: 'main', sshKeyId: 'key-2' }, // blank url dropped
    ],
    mcpServers: [
      { serverId: 'wiki', credentialId: 'cred-1' },
      { serverId: '  ' }, // blank serverId dropped
    ],
    llmEndpointId: 'ep-1',
    defaultModelId: 'model-1',
    toolchainId: 'jvm-21',
    additionalContext: '## Notes\nBe careful.',
  };
  assert.deepEqual(copyEnvironmentStructure(template), {
    repositories: [{ url: 'git@github.com:acme/repo.git', branch: 'main', sshKeyId: null, readOnly: false }],
    mcpServers: [{ serverId: 'wiki', credentialId: null }],
    llmEndpointId: 'ep-1',
    defaultModelId: 'model-1',
    toolchainId: 'jvm-21',
    additionalContext: '## Notes\nBe careful.',
  });
});

test('copyEnvironmentStructure degrades to an empty structure for a bare/repo-less template', () => {
  assert.deepEqual(copyEnvironmentStructure({}), {
    repositories: [],
    mcpServers: [],
    llmEndpointId: null,
    defaultModelId: null,
    toolchainId: null,
    additionalContext: '',
  });
  assert.deepEqual(copyEnvironmentStructure(null), {
    repositories: [],
    mcpServers: [],
    llmEndpointId: null,
    defaultModelId: null,
    toolchainId: null,
    additionalContext: '',
  });
});
