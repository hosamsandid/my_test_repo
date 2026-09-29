'use strict';

// #2570: push-trigger branch filter — parsing and GitHub-Actions-style matching.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseBranchFilter, pushBranch, branchMatchesPattern, branchFilterMatches,
} = require('./branch-filter');

test('parseBranchFilter: splits on commas, trims, drops empties and duplicates (AC3)', () => {
  assert.deepEqual(parseBranchFilter(' main , feature/* ,, main '), ['main', 'feature/*']);
  assert.deepEqual(parseBranchFilter(['main', ' dev, release-* ']), ['main', 'dev', 'release-*']);
});

test('parseBranchFilter: empty, whitespace/commas only and junk are no filter (AC2)', () => {
  for (const raw of [undefined, null, '', '   ', ' , ,', [], ['', ' '], 42, {}, [7]]) {
    assert.deepEqual(parseBranchFilter(raw), [], JSON.stringify(raw));
  }
});

test('pushBranch: refs/heads/<branch> → branch; tags and junk → null', () => {
  assert.equal(pushBranch({ payload: { ref: 'refs/heads/feature/a/b' } }), 'feature/a/b');
  assert.equal(pushBranch({ payload: { ref: 'refs/tags/v1.0' } }), null);
  assert.equal(pushBranch({ payload: {} }), null);
  assert.equal(pushBranch(null), null);
});

test('exact entries match case-sensitively and whole-name only (AC4)', () => {
  assert.equal(branchMatchesPattern('main', 'main'), true);
  assert.equal(branchMatchesPattern('main-old', 'main'), false);
  assert.equal(branchMatchesPattern('release/main', 'main'), false);
  assert.equal(branchMatchesPattern('Main', 'main'), false);
});

test('wildcards follow the GitHub-Actions convention (AC5)', () => {
  const cases = [
    ['feature/*', 'feature/login', true],
    ['feature/*', 'feature/a/b', false],
    ['feature/**', 'feature/login', true],
    ['feature/**', 'feature/a/b', true],
    ['release-*', 'release-1.2', true],
    ['*', 'main', true],
    ['*', 'feature/x', false],
    ['**', 'feature/x', true],
    ['*-hotfix', 'v2-hotfix', true],
  ];
  for (const [pattern, branch, want] of cases) {
    assert.equal(branchMatchesPattern(branch, pattern), want, `${pattern} vs ${branch}`);
  }
});

test('glob-looking characters other than * are literal (edge case)', () => {
  assert.equal(branchMatchesPattern('fix?', 'fix?'), true);
  assert.equal(branchMatchesPattern('fixa', 'fix?'), false);
  assert.equal(branchMatchesPattern('a', '[ab]'), false);
  assert.equal(branchMatchesPattern('[ab]-1', '[ab]-*'), true);
  assert.equal(branchMatchesPattern('release-1x2', 'release-1.*'), false);
});

test('branchFilterMatches: any entry wins; empty filter matches everything incl. tags', () => {
  assert.equal(branchFilterMatches('dev', ['main', 'dev']), true);
  assert.equal(branchFilterMatches('agent-knowledge', ['main', 'feature/*']), false);
  assert.equal(branchFilterMatches(null, []), true);
  assert.equal(branchFilterMatches(null, ['*']), false, 'a tag push never matches a non-empty filter');
});
