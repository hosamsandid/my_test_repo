'use strict';

// Unit tests for the knowledge-sync pure helpers (Knowledge Flow, Phase 1).
// Run: node --test orchestrator/knowledge-sync.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KNOWLEDGE_BRANCH,
  MAX_PUSH_RETRIES,
  isRetryablePushError,
  knowledgeBranchAllowed,
} = require('./knowledge-sync');

test('KNOWLEDGE_BRANCH is a non-protected dedicated branch', () => {
  assert.equal(KNOWLEDGE_BRANCH, 'agent-knowledge');
  // must not collide with agent-git-ops PROTECTED_BRANCHES
  const { PROTECTED_BRANCHES } = require('./agent-git-ops');
  assert.equal(PROTECTED_BRANCHES.has(KNOWLEDGE_BRANCH), false);
});

test('knowledgeBranchAllowed only permits the shared KB branch', () => {
  assert.equal(knowledgeBranchAllowed('agent-knowledge'), true);
  assert.equal(knowledgeBranchAllowed('main'), false);
  assert.equal(knowledgeBranchAllowed('feature/x'), false);
  assert.equal(knowledgeBranchAllowed(''), false);
  assert.equal(knowledgeBranchAllowed(undefined), false);
});

test('isRetryablePushError detects lost fast-forward races', () => {
  assert.equal(isRetryablePushError('! [rejected] agent-knowledge -> agent-knowledge (non-fast-forward)'), true);
  assert.equal(isRetryablePushError('Updates were rejected because the remote contains work... fetch first'), true);
  assert.equal(isRetryablePushError('the tip of your current branch is behind its remote counterpart'), true);
});

test('isRetryablePushError is false for non-recoverable failures', () => {
  assert.equal(isRetryablePushError('Permission denied (publickey)'), false);
  assert.equal(isRetryablePushError('repository not found'), false);
  assert.equal(isRetryablePushError(''), false);
  assert.equal(isRetryablePushError(null), false);
});

test('MAX_PUSH_RETRIES is a small positive bound', () => {
  assert.ok(Number.isInteger(MAX_PUSH_RETRIES) && MAX_PUSH_RETRIES >= 1 && MAX_PUSH_RETRIES <= 5);
});
