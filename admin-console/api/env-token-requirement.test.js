const test = require('node:test');
const assert = require('node:assert/strict');

const { checkGithubTokenRequirement } = require('./env-token-requirement');

const repo = [{ url: 'git@github.com:org/repo.git' }];

test('repo-less (LLM-only) environment needs no token', () => {
  assert.deepEqual(checkGithubTokenRequirement({ repositories: [], githubTokenId: null }), { ok: true });
  assert.deepEqual(checkGithubTokenRequirement({ repositories: undefined }), { ok: true });
});

test('repo + token → allowed', () => {
  assert.deepEqual(checkGithubTokenRequirement({ repositories: repo, githubTokenId: 'tok' }), { ok: true });
});

test('repo + NO token → blocked (github_token_required, 409)', () => {
  const out = checkGithubTokenRequirement({ repositories: repo, githubTokenId: null });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(out.code, 'github_token_required');
  assert.match(out.error, /GitHub token/);
});

test('repo + NO token + explicit acknowledgement → allowed (reference-only opt-out)', () => {
  assert.deepEqual(
    checkGithubTokenRequirement({ repositories: repo, githubTokenId: null, acknowledgeNoToken: true }),
    { ok: true },
  );
});

test('acknowledgement must be exactly true, not any truthy value', () => {
  assert.equal(checkGithubTokenRequirement({ repositories: repo, githubTokenId: '', acknowledgeNoToken: 'yes' }).ok, false);
  assert.equal(checkGithubTokenRequirement({ repositories: repo, githubTokenId: '', acknowledgeNoToken: 1 }).ok, false);
});

test('entries without a url do not count as repositories', () => {
  // a blank repository row (no url) is not a real repo → still LLM-only
  assert.deepEqual(checkGithubTokenRequirement({ repositories: [{ url: '' }, {}], githubTokenId: null }), { ok: true });
});
