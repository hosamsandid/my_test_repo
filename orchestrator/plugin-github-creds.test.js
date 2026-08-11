'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolveScopeGithubCredentials, teamScopeIdsFromGrants, unique } = require('./plugin-github-creds');

// A stand-in "owner/name" parser matching the poller's contract (returns a full
// name string or null); rejects non-GitHub junk.
function parseRepoFullName(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

test('unique preserves first-seen order and drops nullish', () => {
  assert.deepEqual(unique(['a', 'b', 'a', null, 'c', undefined]), ['a', 'b', 'c']);
});

test('resolveScopeGithubCredentials maps team → env token + repos', () => {
  const envs = {
    'team-a': { githubTokenId: 'tok-a', repositories: [
      { url: 'git@github.com:acme/widgets.git', branch: 'main' },
      { url: 'https://github.com/acme/tools', branch: 'dev' },
    ] },
    'team-b': { githubTokenId: 'tok-b', repositories: [{ url: 'git@github.com:acme/other.git' }] },
  };
  const tokens = { 'tok-a': '  ghp_a  ', 'tok-b': 'ghp_b' };

  const out = resolveScopeGithubCredentials(['team-a', 'team-b'], {
    envForScope: (id) => envs[id] || null,
    readToken: (id) => tokens[id] || null,
    parseRepoFullName,
  });

  assert.equal(out['team-a'].token, 'ghp_a'); // trimmed
  assert.deepEqual(out['team-a'].repos, [
    { fullName: 'acme/widgets', defaultBranch: 'main' },
    { fullName: 'acme/tools', defaultBranch: 'dev' },
  ]);
  assert.equal(out['team-b'].token, 'ghp_b');
  assert.deepEqual(out['team-b'].repos, [{ fullName: 'acme/other', defaultBranch: 'main' }]);
});

test('a scope with no env / no token / no repos still gets a present-but-empty entry', () => {
  const out = resolveScopeGithubCredentials(['team-none', 'team-notoken'], {
    envForScope: (id) => (id === 'team-notoken' ? { githubTokenId: null, repositories: [{ url: 'git@github.com:a/b.git' }] } : null),
    readToken: () => null,
    parseRepoFullName,
  });
  assert.deepEqual(out['team-none'], { token: '', repos: [] });
  assert.equal(out['team-notoken'].token, '');
  assert.deepEqual(out['team-notoken'].repos, [{ fullName: 'a/b', defaultBranch: 'main' }]);
});

test('resolver de-dups repos and tolerates a throwing collaborator', () => {
  const out = resolveScopeGithubCredentials(['team-a', 'team-a'], {
    envForScope: () => ({ githubTokenId: 'x', repositories: [
      { url: 'git@github.com:a/b.git' }, { url: 'https://github.com/a/b' }, { url: 'not-a-repo' },
    ] }),
    readToken: () => { throw new Error('token file missing'); },
    parseRepoFullName,
  });
  assert.equal(Object.keys(out).length, 1);
  assert.equal(out['team-a'].token, ''); // readToken threw → empty, not a crash
  assert.deepEqual(out['team-a'].repos, [{ fullName: 'a/b', defaultBranch: 'main' }]);
});

test('resolver requires its collaborators', () => {
  assert.throws(() => resolveScopeGithubCredentials(['x'], {}), /envForScope is required/);
});

test('teamScopeIdsFromGrants extracts unique team ids and skips agent-granularity', () => {
  const grants = [
    { agentId: 'team-a-dev', teamId: 'team-a', scopeGranularity: 'team' },
    { agentId: 'team-a-ba', teamId: 'team-a', scopeGranularity: 'team' },
    { agentId: 'team-b-dev', teamId: 'team-b', scopeGranularity: 'team' },
    { agentId: 'solo', teamId: 'solo', scopeGranularity: 'agent' },
  ];
  assert.deepEqual(teamScopeIdsFromGrants(grants), ['team-a', 'team-b']);
  assert.deepEqual(teamScopeIdsFromGrants([]), []);
});
