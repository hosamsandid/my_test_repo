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

test('sanitizeSearchTerms strips qualifier colons and collapses whitespace', () => {
  assert.equal(gh.sanitizeSearchTerms('  fix   login  '), 'fix login');
  // a user-typed qualifier is neutralised (colon → space), so it can never
  // broaden the scope or reach the body
  assert.equal(gh.sanitizeSearchTerms('repo:evil/x in:body secret'), 'repo evil/x in body secret');
  assert.equal(gh.sanitizeSearchTerms(''), '');
  assert.equal(gh.sanitizeSearchTerms(null), '');
});

test('buildSearchQuery scopes to the repo, title and type — user text leads', () => {
  assert.equal(
    gh.buildSearchQuery({ owner: 'acme', name: 'widgets', text: 'login bug', state: 'open' }),
    'login bug repo:acme/widgets type:issue in:title state:open',
  );
  // state:all drops the state qualifier
  assert.equal(
    gh.buildSearchQuery({ owner: 'a', name: 'b', text: 'x', state: 'all' }),
    'x repo:a/b type:issue in:title',
  );
  // an empty query still returns the repo's issues (no title constraint)
  assert.equal(
    gh.buildSearchQuery({ owner: 'a', name: 'b', text: '', state: 'closed' }),
    'repo:a/b type:issue in:title state:closed',
  );
  // an injected qualifier is defused before it reaches q
  assert.equal(
    gh.buildSearchQuery({ owner: 'a', name: 'b', text: 'repo:other/z', state: 'open' }),
    'repo other/z repo:a/b type:issue in:title state:open',
  );
});

test('buildRequest search_issues targets /search/issues with an encoded q + paging', () => {
  const r = gh.buildRequest('search_issues', { repo: 'acme/widgets', text: 'log in', state: 'open', page: 2, perPage: 999 });
  assert.equal(r.method, 'GET');
  assert.equal(
    r.path,
    '/search/issues?q=' + encodeURIComponent('log in repo:acme/widgets type:issue in:title state:open') + '&per_page=100&page=2',
  );
  // defaults: state→open, page→1, per_page→30
  const d = gh.buildRequest('search_issues', { repo: 'a/b' });
  assert.match(d.path, /per_page=30&page=1$/);
  assert.match(decodeURIComponent(d.path), /repo:a\/b type:issue in:title state:open/);
  // an invalid repo is still rejected before any path is built
  assert.throws(() => gh.buildRequest('search_issues', { repo: 'bad repo' }), /invalid repository/);
});

test('shapeSearchResult narrows items, drops PRs and surfaces total/incomplete', () => {
  const shaped = gh.shapeSearchResult({
    total_count: 42,
    incomplete_results: true,
    items: [
      { number: 3, title: 'Real', state: 'open', labels: [] },
      { number: 4, title: 'A PR', state: 'open', pull_request: { url: 'x' } },
    ],
  });
  assert.equal(shaped.issues.length, 1);
  assert.equal(shaped.issues[0].number, 3);
  assert.equal(shaped.totalCount, 42);
  assert.equal(shaped.incompleteResults, true);
  // a malformed payload degrades to an empty, safe shape
  assert.deepEqual(gh.shapeSearchResult(null), { issues: [], totalCount: 0, incompleteResults: false });
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

test('search_issues maps the item type to type:issue / type:pr / no type qualifier (#2746)', () => {
  const q = (type) => decodeURIComponent(gh.buildRequest('search_issues', { repo: 'a/b', text: 'x', type }).path);
  assert.match(q(undefined), /x repo:a\/b type:issue in:title state:open/);
  assert.match(q('issues'), /x repo:a\/b type:issue in:title state:open/);
  assert.match(q('prs'), /x repo:a\/b type:pr in:title state:open/);
  assert.match(q('all'), /x repo:a\/b in:title state:open/);
  assert.equal(/type:/.test(q('all')), false);
  // an unknown type falls back to issues, never widens the scope
  assert.match(q('weird'), /type:issue/);
});

test('normType defaults to issues and accepts only issues | prs | all (#2746)', () => {
  assert.equal(gh.normType(), 'issues');
  assert.equal(gh.normType('PRS'), 'prs');
  assert.equal(gh.normType('all'), 'all');
  assert.equal(gh.normType('pulls'), 'issues');
});

test('shapeIssueList / shapeSearchResult filter by item type and flag PRs (#2746)', () => {
  const raw = [
    { number: 1, title: 'Issue', state: 'open' },
    { number: 2, title: 'A PR', state: 'open', pull_request: { url: 'x' } },
  ];
  assert.deepEqual(gh.shapeIssueList(raw, 'prs').map((i) => i.number), [2]);
  assert.equal(gh.shapeIssueList(raw, 'prs')[0].isPullRequest, true);
  assert.deepEqual(gh.shapeIssueList(raw, 'all').map((i) => i.number), [1, 2]);
  assert.deepEqual(gh.shapeIssueList(raw, 'issues').map((i) => i.number), [1]);
  assert.deepEqual(gh.shapeSearchResult({ items: raw }, 'prs').issues.map((i) => i.number), [2]);
  assert.deepEqual(gh.shapeSearchResult({ items: raw }, 'all').issues.map((i) => i.number), [1, 2]);
});

test('labelTargetKind reports the fast-path kind of a labelled item (#2746)', () => {
  assert.equal(gh.labelTargetKind(gh.shapeIssue({ number: 1, pull_request: { url: 'x' } })), 'pr');
  assert.equal(gh.labelTargetKind(gh.shapeIssue({ number: 1 })), 'issue');
  assert.equal(gh.labelTargetKind(null), 'issue');
  assert.equal(gh.LABEL_TARGET_KIND_HEADER, 'x-aee-label-target-kind');
});

test('isPullRequest / shapeIssueList drop PRs by default (issues view)', () => {
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
