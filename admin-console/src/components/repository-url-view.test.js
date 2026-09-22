import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGitHubUrl, isGitHubSshUrl, canonicalizeRepoUrlForSshKey,
} from './repository-url-view.js';

// parseGitHubUrl — the frontend mirror of admin-console/api/repo-identity.js's
// golden parser: every github.com URL form, tolerant of `.git`/trailing slash/
// `www.`, and `null` (never a throw) for anything else.
test('parseGitHubUrl: recognizes every github.com URL form', () => {
  const forms = [
    'git@github.com:org/repo.git',
    'git@github.com:org/repo',
    'ssh://git@github.com/org/repo.git',
    'ssh://git@github.com/org/repo',
    'https://github.com/org/repo',
    'https://github.com/org/repo.git',
    'http://github.com/org/repo',
    'https://www.github.com/org/repo',
    'https://github.com/org/repo/',
    'github.com/org/repo',
  ];
  for (const url of forms) {
    const parsed = parseGitHubUrl(url);
    assert.ok(parsed, `expected ${url} to parse`);
    assert.equal(parsed.org, 'org');
    assert.equal(parsed.repo, 'repo');
    assert.equal(parsed.sshUrl, 'git@github.com:org/repo.git');
    assert.equal(parsed.httpsUrl, 'https://github.com/org/repo.git');
  }
});

test('parseGitHubUrl: returns null (never throws) for non-github / empty / odd input', () => {
  assert.equal(parseGitHubUrl(''), null);
  assert.equal(parseGitHubUrl(null), null);
  assert.equal(parseGitHubUrl(undefined), null);
  assert.equal(parseGitHubUrl('https://gitlab.com/org/repo'), null);
  assert.equal(parseGitHubUrl('git@gitlab.com:org/repo.git'), null);
  assert.equal(parseGitHubUrl('https://example.com/git/org/repo'), null);
  // A path with unexpected characters is rejected like the backend does.
  assert.equal(parseGitHubUrl('https://github.com/org/re po'), null);
});

test('isGitHubSshUrl: only the two github.com SSH forms are SSH', () => {
  assert.equal(isGitHubSshUrl('git@github.com:org/repo.git'), true);
  assert.equal(isGitHubSshUrl('ssh://git@github.com/org/repo'), true);
  assert.equal(isGitHubSshUrl('https://github.com/org/repo'), false);
  assert.equal(isGitHubSshUrl('github.com/org/repo'), false);
  assert.equal(isGitHubSshUrl(''), false);
});

// canonicalizeRepoUrlForSshKey — the AC contract of #2345.

test('AC1/AC3a: an https github.com URL with a key selected rewrites to SSH', () => {
  assert.equal(
    canonicalizeRepoUrlForSshKey('https://github.com/org/repo', 'key-1'),
    'git@github.com:org/repo.git',
  );
});

test('AC3b: a key already selected, then the https URL is committed → rewrite', () => {
  // Same pure result regardless of which happened first — the ordering lives in
  // the component (blur vs select), the decision is one function.
  assert.equal(
    canonicalizeRepoUrlForSshKey('https://github.com/acme/widgets', 'key-9'),
    'git@github.com:acme/widgets.git',
  );
});

test('AC4: the rewritten URL always ends in .git, with or without the pasted suffix', () => {
  assert.equal(
    canonicalizeRepoUrlForSshKey('https://github.com/org/repo', 'k'),
    'git@github.com:org/repo.git',
  );
  assert.equal(
    canonicalizeRepoUrlForSshKey('https://github.com/org/repo.git', 'k'),
    'git@github.com:org/repo.git',
  );
});

test('edge: www. prefix and a trailing slash are still recognized and rewritten', () => {
  assert.equal(
    canonicalizeRepoUrlForSshKey('https://www.github.com/org/repo/', 'k'),
    'git@github.com:org/repo.git',
  );
});

test('AC7: a non-github URL with a key selected is left completely untouched', () => {
  assert.equal(
    canonicalizeRepoUrlForSshKey('https://gitlab.com/org/repo', 'k'),
    'https://gitlab.com/org/repo',
  );
  assert.equal(
    canonicalizeRepoUrlForSshKey('https://git.internal/team/repo.git', 'k'),
    'https://git.internal/team/repo.git',
  );
});

test('AC8: an already-SSH github URL with a key selected is a no-op (no double .git)', () => {
  assert.equal(
    canonicalizeRepoUrlForSshKey('git@github.com:org/repo.git', 'k'),
    'git@github.com:org/repo.git',
  );
  // ssh:// form is preserved as the user typed it, not folded to scp-style.
  assert.equal(
    canonicalizeRepoUrlForSshKey('ssh://git@github.com/org/repo', 'k'),
    'ssh://git@github.com/org/repo',
  );
});

test('AC10/AC6: no SSH key selected → untouched (incl. clearing after a conversion)', () => {
  // No key: an HTTPS URL is left for the GitHub Token path, exactly as today.
  assert.equal(
    canonicalizeRepoUrlForSshKey('https://github.com/org/repo', ''),
    'https://github.com/org/repo',
  );
  // AC6: clearing the key does not reverse-rewrite — an already-SSH URL stays SSH.
  assert.equal(
    canonicalizeRepoUrlForSshKey('git@github.com:org/repo.git', ''),
    'git@github.com:org/repo.git',
  );
  assert.equal(canonicalizeRepoUrlForSshKey('https://github.com/org/repo', null), 'https://github.com/org/repo');
});

test('unparseable / still-typing text with a key selected is left as-is', () => {
  assert.equal(canonicalizeRepoUrlForSshKey('https://github.com/org', 'k'), 'https://github.com/org');
  assert.equal(canonicalizeRepoUrlForSshKey('', 'k'), '');
});
