const { test } = require('node:test');
const assert = require('node:assert');
const { githubApiBase, DEFAULT_GITHUB_API_BASE } = require('./github-api-base');

test('defaults to api.github.com when env is absent (byte-identical URL)', () => {
  assert.equal(githubApiBase({}), 'https://api.github.com');
  assert.equal(DEFAULT_GITHUB_API_BASE, 'https://api.github.com');
  // The wizard builds `${base}/repos/o/r` — the default keeps that unchanged.
  assert.equal(`${githubApiBase({})}/repos/o/r`, 'https://api.github.com/repos/o/r');
});

test('reads GITHUB_API_BASE and strips trailing slashes', () => {
  assert.equal(githubApiBase({ GITHUB_API_BASE: 'http://fake-github' }), 'http://fake-github');
  assert.equal(githubApiBase({ GITHUB_API_BASE: 'http://fake-github/' }), 'http://fake-github');
  assert.equal(
    `${githubApiBase({ GITHUB_API_BASE: 'http://fake-github/' })}/repos/o/r`,
    'http://fake-github/repos/o/r',
  );
});

test('reads process.env by default', () => {
  const prev = process.env.GITHUB_API_BASE;
  try {
    delete process.env.GITHUB_API_BASE;
    assert.equal(githubApiBase(), 'https://api.github.com');
    process.env.GITHUB_API_BASE = 'http://fake-github:9000';
    assert.equal(githubApiBase(), 'http://fake-github:9000');
  } finally {
    if (prev === undefined) delete process.env.GITHUB_API_BASE;
    else process.env.GITHUB_API_BASE = prev;
  }
});
