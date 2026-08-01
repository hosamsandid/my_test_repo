'use strict';

// Unit tests for the knowledge-sync pure helpers (Knowledge Flow, Phase 1).
// Run: node --test orchestrator/knowledge-sync.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KNOWLEDGE_BRANCH,
  PROTECTED_BRANCHES,
  MAX_PUSH_RETRIES,
  isRetryablePushError,
  knowledgeBranchAllowed,
  resolveKnowledgeBranch,
  isProtectedBranch,
} = require('./knowledge-sync');

test('KNOWLEDGE_BRANCH is a non-protected dedicated branch', () => {
  assert.equal(KNOWLEDGE_BRANCH, 'agent-knowledge');
  // must not collide with agent-git-ops PROTECTED_BRANCHES
  const { PROTECTED_BRANCHES } = require('./agent-git-ops');
  assert.equal(PROTECTED_BRANCHES.has(KNOWLEDGE_BRANCH), false);
});

test('knowledgeBranchAllowed defaults to only the shared KB branch', () => {
  assert.equal(knowledgeBranchAllowed('agent-knowledge'), true);
  assert.equal(knowledgeBranchAllowed('main'), false);
  assert.equal(knowledgeBranchAllowed('feature/x'), false);
  assert.equal(knowledgeBranchAllowed(''), false);
  assert.equal(knowledgeBranchAllowed(undefined), false);
});

test('knowledgeBranchAllowed follows a configured branch (#558 AC-3)', () => {
  // The guardrail must no longer hard-reject a configured branch: pass the
  // resolved branch and it permits exactly that one, incl. a protected branch.
  assert.equal(knowledgeBranchAllowed('main', 'main'), true);
  assert.equal(knowledgeBranchAllowed('team-kb', 'team-kb'), true);
  assert.equal(knowledgeBranchAllowed('agent-knowledge', 'main'), false);
  assert.equal(knowledgeBranchAllowed('', 'main'), false);
});

test('resolveKnowledgeBranch returns the configured branch or the default', () => {
  assert.equal(resolveKnowledgeBranch(undefined), KNOWLEDGE_BRANCH);
  assert.equal(resolveKnowledgeBranch({}), KNOWLEDGE_BRANCH);
  assert.equal(resolveKnowledgeBranch({ knowledgeStore: {} }), KNOWLEDGE_BRANCH);
  assert.equal(resolveKnowledgeBranch({ knowledgeStore: { repoRef: {} } }), KNOWLEDGE_BRANCH);
  assert.equal(
    resolveKnowledgeBranch({ knowledgeStore: { repoRef: { branch: '  ' } } }),
    KNOWLEDGE_BRANCH,
  );
  assert.equal(
    resolveKnowledgeBranch({ knowledgeStore: { repoRef: { branch: 'main' } } }),
    'main',
  );
  assert.equal(
    resolveKnowledgeBranch({ knowledgeStore: { repoRef: { branch: '  team-kb  ' } } }),
    'team-kb',
  );
});

test('isProtectedBranch flags well-known protected branches (case-insensitive)', () => {
  assert.deepEqual(PROTECTED_BRANCHES, ['main', 'master', 'develop', 'trunk']);
  assert.equal(isProtectedBranch('main'), true);
  assert.equal(isProtectedBranch('MAIN'), true);
  assert.equal(isProtectedBranch(' master '), true);
  assert.equal(isProtectedBranch('agent-knowledge'), false);
  assert.equal(isProtectedBranch('team-kb'), false);
  assert.equal(isProtectedBranch(''), false);
  assert.equal(isProtectedBranch(undefined), false);
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
