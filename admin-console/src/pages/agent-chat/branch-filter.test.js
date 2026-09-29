import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBranchFilter, branchFilterFormError, branchFilterToInput, branchFilterBody } from './branch-filter.js';
import { summarizeGithubEventTrigger } from './trigger-summary.js';

test('#2570 AC2/AC3: blank, whitespace or commas only = every branch; entries split and trimmed', () => {
  assert.deepEqual(parseBranchFilter(' , ,'), []);
  assert.deepEqual(parseBranchFilter('main, feature/* ,main'), ['main', 'feature/*']);
  assert.equal(branchFilterBody(' , '), null);
  assert.deepEqual(branchFilterBody('main, feature/*'), ['main', 'feature/*']);
  assert.equal(branchFilterBody('main', { show: false }), null, 'a hidden field clears the stored filter');
});

test('#2570 AC7: the stored array round-trips through the form field', () => {
  const stored = ['main', 'feature/*'];
  assert.equal(branchFilterToInput(stored), 'main, feature/*');
  assert.deepEqual(branchFilterBody(branchFilterToInput(stored)), stored);
  assert.equal(branchFilterToInput(undefined), '');
});

test('#2570 edge: an entry that can never name a branch is a clear form error', () => {
  assert.equal(branchFilterFormError(''), null);
  assert.equal(branchFilterFormError('main, feature/**, release-*, v1.?'), null);
  assert.equal(branchFilterFormError('/'), 'Branches: "/" must not start or end with "/".');
  assert.match(branchFilterFormError('main, my branch'), /"my branch" contains whitespace/);
  assert.match(branchFilterFormError('a//b'), /"\/\/"/);
});

test('#2570 AC8/AC9: the card summary names the branches, for push only', () => {
  assert.equal(summarizeGithubEventTrigger({ events: ['push'], branchFilter: ['main', 'feature/*'] }).branches, 'main, feature/*');
  assert.equal(summarizeGithubEventTrigger({ events: ['push'] }).branches, null);
  assert.equal(summarizeGithubEventTrigger({ events: ['issues.opened'], branchFilter: ['main'] }).branches, null);
  assert.equal(summarizeGithubEventTrigger({ events: ['push', 'issues.opened'], branchFilter: 'main' }).branches, 'main');
});
