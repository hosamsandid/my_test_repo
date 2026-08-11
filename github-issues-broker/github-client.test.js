'use strict';

const test = require('node:test');
const assert = require('node:assert');
const gh = require('./github-client');

test('parseRepoFullName accepts owner/name and rejects junk', () => {
  assert.deepEqual(gh.parseRepoFullName('acme/widgets'), { owner: 'acme', name: 'widgets' });
  assert.deepEqual(gh.parseRepoFullName('  a.b_c/d-e.f  '), { owner: 'a.b_c', name: 'd-e.f' });
  assert.equal(gh.parseRepoFullName('nope'), null);
  assert.equal(gh.parseRepoFullName('a/b/c'), null);
  assert.equal(gh.parseRepoFullName('a/b?x=1'), null);
  assert.equal(gh.parseRepoFullName(''), null);
  assert.equal(gh.parseRepoFullName(null), null);
});

test('buildRequest list_issues clamps + defaults state/page/per_page', () => {
  const r = gh.buildRequest('list_issues', { repo: 'acme/widgets' });
  assert.equal(r.method, 'GET');
  assert.equal(r.path, '/repos/acme/widgets/issues?state=open&per_page=30&page=1');

  const r2 = gh.buildRequest('list_issues', { repo: 'acme/widgets', state: 'closed', perPage: 999, page: 4 });
  assert.equal(r2.path, '/repos/acme/widgets/issues?state=closed&per_page=100&page=4');

  // an unknown state falls back to open; a bad page falls back to 1
  const r3 = gh.buildRequest('list_issues', { repo: 'acme/widgets', state: 'weird', page: -3 });
  assert.match(r3.path, /state=open&per_page=30&page=1$/);
});

test('buildRequest get_issue encodes the number and validates it', () => {
  assert.equal(gh.buildRequest('get_issue', { repo: 'a/b', number: 42 }).path, '/repos/a/b/issues/42');
  assert.throws(() => gh.buildRequest('get_issue', { repo: 'a/b', number: 0 }), /invalid issue number/);
  assert.throws(() => gh.buildRequest('get_issue', { repo: 'a/b', number: 'x' }), /invalid issue number/);
});

test('buildRequest add_label / remove_label shape the write', () => {
  const add = gh.buildRequest('add_label', { repo: 'a/b', number: 7, label: 'ready' });
  assert.equal(add.method, 'POST');
  assert.equal(add.path, '/repos/a/b/issues/7/labels');
  assert.deepEqual(add.body, { labels: ['ready'] });

  const rm = gh.buildRequest('remove_label', { repo: 'a/b', number: 7, label: 'ready for review' });
  assert.equal(rm.method, 'DELETE');
  assert.equal(rm.path, '/repos/a/b/issues/7/labels/ready%20for%20review');
});

test('buildRequest rejects an invalid repo and an empty label', () => {
  assert.throws(() => gh.buildRequest('list_issues', { repo: 'bad repo' }), /invalid repository/);
  assert.throws(() => gh.buildRequest('add_label', { repo: 'a/b', number: 1, label: '   ' }), /non-empty label/);
  assert.throws(() => gh.buildRequest('nope', { repo: 'a/b' }), /unknown github operation/);
});

test('a path component cannot break out of the REST path', () => {
  // A traversal attempt fails parseRepoFullName before it can reach a path.
  assert.throws(() => gh.buildRequest('get_issue', { repo: '../../etc/passwd', number: 1 }), /invalid repository/);
});

test('isPullRequest / shapeIssueList drop PRs (MVP is issues-only)', () => {
  assert.equal(gh.isPullRequest({ pull_request: { url: 'x' } }), true);
  assert.equal(gh.isPullRequest({ number: 1 }), false);
  const raw = [
    { number: 1, title: 'Issue', state: 'open', labels: [{ name: 'bug', color: 'f00' }] },
    { number: 2, title: 'A PR', state: 'open', pull_request: { url: 'x' } },
  ];
  const list = gh.shapeIssueList(raw);
  assert.equal(list.length, 1);
  assert.equal(list[0].number, 1);
  assert.deepEqual(list[0].labels, [{ name: 'bug', color: 'f00', description: null }]);
});

test('shapeIssue narrows the payload and normalizes labels (string or object)', () => {
  const s = gh.shapeIssue({
    number: 9, title: 'T', state: 'open', body: 'B',
    labels: ['plain', { name: 'ready', color: '84f5d0', description: 'go' }],
    user: { login: 'alice' }, comments: 3, html_url: 'http://x', updated_at: '2026-01-01',
  });
  assert.equal(s.number, 9);
  assert.equal(s.user, 'alice');
  assert.equal(s.comments, 3);
  assert.deepEqual(s.labels[0], { name: 'plain', color: null, description: null });
  assert.deepEqual(s.labels[1], { name: 'ready', color: '84f5d0', description: 'go' });
  assert.equal(s.isPullRequest, false);
  assert.equal(gh.shapeIssue(null), null);
});

test('mapGithubError gives actionable, non-raw messages', () => {
  assert.match(gh.mapGithubError(401, {}), /rejected/i);
  assert.match(gh.mapGithubError(403, { message: 'x' }), /permission/i);
  assert.match(gh.mapGithubError(403, { message: 'API rate limit exceeded' }), /rate limit/i);
  assert.match(gh.mapGithubError(404, {}, { op: 'get_issue' }), /not found/i);
  assert.match(gh.mapGithubError(404, {}, { op: 'remove_label' }), /nothing to remove/i);
  assert.match(gh.mapGithubError(422, { message: 'Validation failed' }), /Validation failed/);
});

test('apiBaseFrom honours GITHUB_API_BASE and strips trailing slashes', () => {
  assert.equal(gh.apiBaseFrom({}), 'https://api.github.com');
  assert.equal(gh.apiBaseFrom({ GITHUB_API_BASE: 'http://fake-github:8080/' }), 'http://fake-github:8080');
});

test('call injects the token, targets the API base, and shapes success', async () => {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify([{ number: 1, title: 'X', state: 'open', labels: [] }]),
    };
  };
  try {
    const { status, data } = await gh.call('list_issues', { repo: 'a/b' }, { token: 'secret', apiBase: 'http://fake-github' });
    assert.equal(status, 200);
    assert.equal(Array.isArray(data), true);
    assert.equal(calls[0].url, 'http://fake-github/repos/a/b/issues?state=open&per_page=30&page=1');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer secret');
  } finally {
    global.fetch = orig;
  }
});

test('call treats remove_label 404 as an idempotent no-op', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, text: async () => '{"message":"Label does not exist"}' });
  try {
    const r = await gh.call('remove_label', { repo: 'a/b', number: 1, label: 'x' }, { token: 't', apiBase: 'http://fg' });
    assert.equal(r.status, 200);
    assert.equal(r.noop, true);
  } finally {
    global.fetch = orig;
  }
});

test('call throws a mapped error on a non-2xx (not a raw status)', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403, text: async () => '{"message":"Resource not accessible"}' });
  try {
    await assert.rejects(
      () => gh.call('add_label', { repo: 'a/b', number: 1, label: 'ready' }, { token: 't', apiBase: 'http://fg' }),
      /permission/i,
    );
  } finally {
    global.fetch = orig;
  }
});
