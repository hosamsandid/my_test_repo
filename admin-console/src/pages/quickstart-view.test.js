import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasRepoUrl,
  quickstartEndpoint,
  quickstartBody,
  repoPrerequisitesMet,
  showRepoPrerequisites,
  canSubmitQuickstart,
} from './quickstart-view.js';

// --- hasRepoUrl: the single fork predicate ---------------------------------

test('hasRepoUrl: empty / whitespace / non-string are repo-less', () => {
  assert.equal(hasRepoUrl(''), false);
  assert.equal(hasRepoUrl('   '), false);
  assert.equal(hasRepoUrl(undefined), false);
  assert.equal(hasRepoUrl(null), false);
  assert.equal(hasRepoUrl(42), false);
});

test('hasRepoUrl: any non-blank string is a repo', () => {
  assert.equal(hasRepoUrl('https://github.com/org/repo'), true);
  assert.equal(hasRepoUrl('  git@github.com:o/r.git '), true);
});

// --- quickstartEndpoint: routing (AC3 / AC4 / AC8) -------------------------

test('quickstartEndpoint: repo URL → repo path', () => {
  assert.equal(quickstartEndpoint('https://github.com/org/repo'), '/api/quickstart');
});

test('quickstartEndpoint: empty URL → LLM-only path', () => {
  assert.equal(quickstartEndpoint(''), '/api/quickstart/llm');
  assert.equal(quickstartEndpoint('   '), '/api/quickstart/llm');
});

// --- quickstartBody --------------------------------------------------------

test('quickstartBody: repo path trims the URL and passes optional pickers', () => {
  assert.deepEqual(
    quickstartBody({ url: '  https://github.com/o/r ', tokenId: 't1', sshKeyId: 'k1' }),
    { url: 'https://github.com/o/r', githubTokenId: 't1', sshKeyId: 'k1' },
  );
});

test('quickstartBody: repo path with default (unset) pickers → undefined, not empty string', () => {
  assert.deepEqual(
    quickstartBody({ url: 'https://github.com/o/r', tokenId: '', sshKeyId: '' }),
    { url: 'https://github.com/o/r', githubTokenId: undefined, sshKeyId: undefined },
  );
});

test('quickstartBody: LLM path carries only name + provider (no token / ssh)', () => {
  const body = quickstartBody({ url: '', displayName: '  My Assistant ', llmEndpointId: 'ep1' });
  assert.deepEqual(body, { displayName: 'My Assistant', llmEndpointId: 'ep1' });
  assert.ok(!('githubTokenId' in body));
  assert.ok(!('sshKeyId' in body));
});

// --- prerequisites: enforced only with a repo (AC5) ------------------------

test('repoPrerequisitesMet: needs both a token and an SSH key', () => {
  assert.equal(repoPrerequisitesMet({ hasTokens: true, hasSshKeys: true }), true);
  assert.equal(repoPrerequisitesMet({ hasTokens: true, hasSshKeys: false }), false);
  assert.equal(repoPrerequisitesMet({ hasTokens: false, hasSshKeys: true }), false);
});

test('showRepoPrerequisites: hidden until a repo URL is entered', () => {
  assert.equal(showRepoPrerequisites(''), false);
  assert.equal(showRepoPrerequisites('https://github.com/o/r'), true);
});

// --- canSubmitQuickstart ---------------------------------------------------

test('canSubmit: repo-less needs provider + name, NOT token / ssh (AC4 / AC5)', () => {
  const base = { url: '', hasTokens: false, hasSshKeys: false, hasLlmEndpoints: true };
  assert.equal(canSubmitQuickstart({ ...base, displayName: 'A', selectedLlmId: 'ep1' }), true);
  // Missing name blocks.
  assert.equal(canSubmitQuickstart({ ...base, displayName: '  ', selectedLlmId: 'ep1' }), false);
  // Missing selected provider blocks.
  assert.equal(canSubmitQuickstart({ ...base, displayName: 'A', selectedLlmId: '' }), false);
  // No providers at all blocks.
  assert.equal(
    canSubmitQuickstart({ ...base, hasLlmEndpoints: false, displayName: 'A', selectedLlmId: 'ep1' }),
    false,
  );
});

test('canSubmit: repo path requires the GitHub prerequisites, independent of name', () => {
  const repo = { url: 'https://github.com/o/r', hasLlmEndpoints: false, displayName: '', selectedLlmId: '' };
  assert.equal(canSubmitQuickstart({ ...repo, hasTokens: true, hasSshKeys: true }), true);
  assert.equal(canSubmitQuickstart({ ...repo, hasTokens: true, hasSshKeys: false }), false);
  assert.equal(canSubmitQuickstart({ ...repo, hasTokens: false, hasSshKeys: true }), false);
});
