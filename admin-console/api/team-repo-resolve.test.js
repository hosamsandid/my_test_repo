'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reposFromEnv, primaryRepo, isRepoLessEnv, repoVars } = require('./team-repo-resolve');

test('reposFromEnv: modern array, legacy single, and empty shapes', () => {
  assert.deepEqual(
    reposFromEnv({ repositories: [{ url: 'a' }, { url: 'b' }] }),
    [{ url: 'a' }, { url: 'b' }],
  );
  // Legacy single `repository` is lifted into a one-element array.
  assert.deepEqual(reposFromEnv({ repository: { url: 'a' } }), [{ url: 'a' }]);
  // Repo-less environments.
  assert.deepEqual(reposFromEnv({ repositories: [] }), []);
  assert.deepEqual(reposFromEnv({}), []);
  assert.deepEqual(reposFromEnv(null), []);
});

test('primaryRepo returns the first repo or undefined', () => {
  assert.deepEqual(primaryRepo({ repositories: [{ url: 'a' }, { url: 'b' }] }), { url: 'a' });
  assert.equal(primaryRepo({ repositories: [] }), undefined);
  assert.equal(primaryRepo(null), undefined);
});

test('isRepoLessEnv: true only when no usable primary URL (#1623)', () => {
  assert.equal(isRepoLessEnv({ repositories: [{ url: 'git@github.com:o/r.git' }] }), false);
  assert.equal(isRepoLessEnv({ repository: { url: 'git@github.com:o/r.git' } }), false);
  assert.equal(isRepoLessEnv({ repositories: [] }), true);
  assert.equal(isRepoLessEnv({}), true);
  // A repo entry without a URL is not usable.
  assert.equal(isRepoLessEnv({ repositories: [{ branch: 'main' }] }), true);
});

test('repoVars: repo-backed team fills all fields', () => {
  const parsed = { org: 'AccentureCodeFoundry', repo: 'widget' };
  assert.deepEqual(repoVars(parsed, 'git@github.com:AccentureCodeFoundry/widget.git'), {
    repoFullName: 'AccentureCodeFoundry/widget',
    repoOwner: 'AccentureCodeFoundry',
    repoName: 'widget',
    repoUrl: 'git@github.com:AccentureCodeFoundry/widget.git',
  });
});

test('repoVars: repo-less team resolves every field to empty string (#1623)', () => {
  assert.deepEqual(repoVars(null, ''), {
    repoFullName: '',
    repoOwner: '',
    repoName: '',
    repoUrl: '',
  });
  // A missing url argument is coerced to '' as well.
  assert.deepEqual(repoVars(null, undefined).repoUrl, '');
});
