const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const https = require('https');
const {
  githubApiBase,
  resolveGithubApiTarget,
  DEFAULT_GITHUB_API_BASE,
} = require('./github-api-base');

test('githubApiBase defaults to api.github.com when env is absent', () => {
  assert.equal(githubApiBase({}), 'https://api.github.com');
  assert.equal(DEFAULT_GITHUB_API_BASE, 'https://api.github.com');
});

test('githubApiBase reads GITHUB_API_BASE and strips trailing slashes', () => {
  assert.equal(githubApiBase({ GITHUB_API_BASE: 'http://fake-github' }), 'http://fake-github');
  assert.equal(githubApiBase({ GITHUB_API_BASE: 'http://fake-github/' }), 'http://fake-github');
  assert.equal(githubApiBase({ GITHUB_API_BASE: 'http://fake-github///' }), 'http://fake-github');
});

test('resolveGithubApiTarget: default is byte-identical to the old hardcoded request', () => {
  const t = resolveGithubApiTarget('https://api.github.com');
  assert.equal(t.protocol, 'https:');
  assert.equal(t.hostname, 'api.github.com');
  assert.equal(t.port, undefined, 'no explicit port ⇒ protocol default (443)');
  assert.equal(t.basePath, '', 'no path prefix ⇒ concatenated path is unchanged');
  assert.equal(t.transport, https);
});

test('resolveGithubApiTarget: http base selects the http transport + port', () => {
  const t = resolveGithubApiTarget('http://fake-github:8080');
  assert.equal(t.protocol, 'http:');
  assert.equal(t.hostname, 'fake-github');
  assert.equal(t.port, '8080');
  assert.equal(t.basePath, '');
  assert.equal(t.transport, http);
});

test('resolveGithubApiTarget: a base with a path prefix is preserved (no double slash)', () => {
  const t = resolveGithubApiTarget('http://fake-github/gh/');
  assert.equal(t.basePath, '/gh');
  // Concatenation the poller does must not double the slash.
  assert.equal(`${t.basePath}/repos/o/r/events`, '/gh/repos/o/r/events');
});

test('resolveGithubApiTarget: bare-origin slash path normalises to empty', () => {
  assert.equal(resolveGithubApiTarget('http://fake-github/').basePath, '');
});

test('resolveGithubApiTarget: rejects a non-http(s) scheme', () => {
  assert.throws(() => resolveGithubApiTarget('ftp://example.com'), /http\(s\)/);
});

test('resolveGithubApiTarget: reads process.env by default', () => {
  const prev = process.env.GITHUB_API_BASE;
  try {
    delete process.env.GITHUB_API_BASE;
    assert.equal(resolveGithubApiTarget().hostname, 'api.github.com');
    process.env.GITHUB_API_BASE = 'http://fake-github:9000';
    const t = resolveGithubApiTarget();
    assert.equal(t.hostname, 'fake-github');
    assert.equal(t.port, '9000');
  } finally {
    if (prev === undefined) delete process.env.GITHUB_API_BASE;
    else process.env.GITHUB_API_BASE = prev;
  }
});
