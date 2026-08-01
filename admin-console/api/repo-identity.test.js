const test = require('node:test');
const assert = require('node:assert/strict');

const { parseGitHubUrl, deriveRepoIdentity } = require('./repo-identity');

// The four github.com URL forms parseGitHubUrl accepts. For each, deriveRepoIdentity
// MUST return a value deep-equal to parseGitHubUrl — the fix is additive, github
// behaviour is byte-for-byte unchanged (#667 acceptance ask #1).
const GITHUB_FORMS = [
  'git@github.com:AccentureCodeFoundry/314092_agent-execution-environment.git',
  'ssh://git@github.com/AccentureCodeFoundry/314092_agent-execution-environment.git',
  'https://github.com/AccentureCodeFoundry/314092_agent-execution-environment.git',
  'github.com/AccentureCodeFoundry/314092_agent-execution-environment',
];

test('deriveRepoIdentity matches parseGitHubUrl for every github.com form', () => {
  for (const url of GITHUB_FORMS) {
    const canonical = parseGitHubUrl(url);
    assert.deepEqual(
      deriveRepoIdentity(url),
      canonical,
      `deriveRepoIdentity diverged from parseGitHubUrl for ${url}`,
    );
    // Sanity: every github form resolves to the same canonical identity.
    assert.equal(canonical.org, 'AccentureCodeFoundry');
    assert.equal(canonical.repo, '314092_agent-execution-environment');
    assert.equal(canonical.sshUrl, 'git@github.com:AccentureCodeFoundry/314092_agent-execution-environment.git');
    assert.equal(canonical.httpsUrl, 'https://github.com/AccentureCodeFoundry/314092_agent-execution-environment.git');
  }
});

test('deriveRepoIdentity derives {org, repo} from the last two path segments of a non-github http remote', () => {
  const id = deriveRepoIdentity('http://git-remote/e2e/fixture.git');
  assert.equal(id.org, 'e2e');
  assert.equal(id.repo, 'fixture');
  // No canonical ssh form for a non-github remote; the original URL is preserved.
  assert.equal(id.sshUrl, null);
  assert.equal(id.httpsUrl, 'http://git-remote/e2e/fixture.git');
});

test('deriveRepoIdentity strips a trailing slash and .git suffix on the non-github path', () => {
  assert.deepEqual(
    deriveRepoIdentity('http://git-remote/team/repo/'),
    { org: 'team', repo: 'repo', sshUrl: null, httpsUrl: 'http://git-remote/team/repo/' },
  );
  assert.equal(deriveRepoIdentity('https://gitea.internal/grp/proj.git').repo, 'proj');
});

test('deriveRepoIdentity uses the last two segments when the path is deeper', () => {
  const id = deriveRepoIdentity('http://host:3000/scm/team/repo.git');
  assert.equal(id.org, 'team');
  assert.equal(id.repo, 'repo');
});

test('deriveRepoIdentity applies the github char validation to derived segments', () => {
  // A path segment with a character parseGitHubUrl would reject must not be
  // smuggled into the member trigger repo fields via the fallback.
  assert.throws(
    () => deriveRepoIdentity('http://git-remote/e2e/repo$weird'),
    /Could not derive owner\/repo/,
  );
});

test('deriveRepoIdentity throws on an unparseable / single-segment URL', () => {
  assert.throws(() => deriveRepoIdentity('http://git-remote/onlyone'), /Could not derive owner\/repo/);
  assert.throws(() => deriveRepoIdentity(''), /Could not derive owner\/repo/);
  assert.throws(() => deriveRepoIdentity(null), /Could not derive owner\/repo/);
});
