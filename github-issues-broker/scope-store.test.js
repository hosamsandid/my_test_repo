'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ScopeStore, safeName, normRepo } = require('./scope-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh-scope-store-'));
}

test('safeName collapses unsafe characters and never yields empty', () => {
  assert.equal(safeName('team-abc'), 'team-abc');
  assert.equal(safeName('a/../b'), 'a_.._b'); // separators collapse; dots are legal filename chars
  assert.equal(safeName('a/b'), 'a_b');
  assert.equal(safeName('').length > 0, true);
  assert.equal(safeName(null).length > 0, true);
});

test('normRepo accepts owner/name (string or object) and rejects junk', () => {
  assert.deepEqual(normRepo('acme/widgets'), { fullName: 'acme/widgets', defaultBranch: null });
  assert.deepEqual(normRepo({ fullName: 'a/b', defaultBranch: 'dev' }), { fullName: 'a/b', defaultBranch: 'dev' });
  assert.deepEqual(normRepo({ full_name: 'a/b', branch: 'main' }), { fullName: 'a/b', defaultBranch: 'main' });
  assert.equal(normRepo('nope'), null);
  assert.equal(normRepo(null), null);
});

test('setCredentials + reposFor never leak the token; hasToken reflects binding', () => {
  const s = new ScopeStore({});
  s.setCredentials({
    'team-a': { token: 'ghp_secret', repos: [{ fullName: 'acme/widgets', defaultBranch: 'main' }] },
    'team-b': { token: '', repos: [{ fullName: 'acme/other' }] },
  });
  const a = s.reposFor('team-a');
  assert.equal(a.known, true);
  assert.equal(a.hasToken, true);
  assert.deepEqual(a.repos, [{ fullName: 'acme/widgets', defaultBranch: 'main' }]);
  assert.equal(JSON.stringify(a).includes('ghp_secret'), false);

  const b = s.reposFor('team-b');
  assert.equal(b.hasToken, false); // token bound but blank → "configure a token"

  const unknown = s.reposFor('team-z');
  assert.deepEqual(unknown, { repos: [], hasToken: false, known: false });
});

test('tokenForRepo is the authorization guard (repo must be in the scope env)', () => {
  const s = new ScopeStore({});
  s.setCredentials({ 'team-a': { token: 'tok', repos: [{ fullName: 'acme/widgets' }] } });
  assert.equal(s.tokenForRepo('team-a', 'acme/widgets'), 'tok');
  assert.equal(s.tokenForRepo('team-a', 'acme/not-mine'), null); // outside scope → refused
  assert.equal(s.tokenForRepo('team-b', 'acme/widgets'), null);  // unknown scope → refused
});

test('last-used selection persists per (scope,user) and survives a reload', () => {
  const dir = tmpDir();
  const s = new ScopeStore({ stateDir: dir });
  assert.equal(s.loadPref('team-a', 'alice'), null);
  s.savePref('team-a', 'alice', { repo: 'acme/widgets', state: 'open' });
  s.savePref('team-a', 'bob', { repo: 'acme/other' });

  const s2 = new ScopeStore({ stateDir: dir });
  assert.equal(s2.loadPref('team-a', 'alice').repo, 'acme/widgets');
  assert.equal(s2.loadPref('team-a', 'bob').repo, 'acme/other');
  assert.equal(s2.count('team-a'), 2);
});

test('pickLastUsed returns the globally most-recently-used scope, not first-in-list (#1650)', () => {
  const dir = tmpDir();
  const s = new ScopeStore({ stateDir: dir });
  // team-a saved earlier, team-b later — team-b is the one actually used last
  s.savePref('team-a', 'alice', { repo: 'acme/a', state: 'open', updatedAt: '2026-01-01T00:00:00Z' });
  s.savePref('team-b', 'alice', { repo: 'acme/b', state: 'all', updatedAt: '2026-06-01T00:00:00Z' });
  // list order puts team-a first; the fix must still pick team-b by updatedAt
  assert.deepEqual(s.pickLastUsed(['team-a', 'team-b'], 'alice'), { team: 'team-b', repo: 'acme/b', state: 'all' });
  assert.deepEqual(s.pickLastUsed(['team-b', 'team-a'], 'alice'), { team: 'team-b', repo: 'acme/b', state: 'all' });
});

test('pickLastUsed preserves the `all` state and is per-user', () => {
  const dir = tmpDir();
  const s = new ScopeStore({ stateDir: dir });
  s.savePref('team-a', 'alice', { repo: 'acme/a', state: 'all', updatedAt: '2026-01-01T00:00:00Z' });
  s.savePref('team-a', 'bob', { repo: 'acme/z', state: 'closed', updatedAt: '2026-02-01T00:00:00Z' });
  assert.equal(s.pickLastUsed(['team-a'], 'alice').state, 'all'); // not coerced to open
  assert.equal(s.pickLastUsed(['team-a'], 'bob').repo, 'acme/z'); // bob's own selection
});

test('pickLastUsed skips prefs without a repo, is null when none, and falls back to order without timestamps', () => {
  const dir = tmpDir();
  const s = new ScopeStore({ stateDir: dir });
  assert.equal(s.pickLastUsed(['team-a', 'team-b'], 'alice'), null); // first-ever visit
  s.savePref('team-a', 'alice', { state: 'open' }); // no repo → not restorable
  assert.equal(s.pickLastUsed(['team-a'], 'alice'), null);
  // legacy prefs (pre-#1650) carry no updatedAt → deterministic list-order fallback
  s.savePref('team-a', 'alice', { repo: 'acme/a', state: 'open' });
  s.savePref('team-b', 'alice', { repo: 'acme/b', state: 'open' });
  assert.equal(s.pickLastUsed(['team-a', 'team-b'], 'alice').team, 'team-a');
});

test('teardown reaps a scope\'s in-memory creds and persisted prefs only', () => {
  const dir = tmpDir();
  const s = new ScopeStore({ stateDir: dir });
  s.setCredentials({ 'team-a': { token: 't', repos: [{ fullName: 'a/b' }] }, 'team-b': { token: 't', repos: [] } });
  s.savePref('team-a', 'alice', { repo: 'a/b' });
  s.savePref('team-b', 'carol', { repo: 'a/b' });

  const removed = s.teardown('team-a');
  assert.equal(removed, 1);
  assert.equal(s.credsFor('team-a'), null);
  assert.equal(s.loadPref('team-a', 'alice'), null);
  // team-b untouched (granularity-agnostic teardown by scopeId)
  assert.equal(s.credsFor('team-b') !== null, true);
  assert.equal(s.loadPref('team-b', 'carol').repo, 'a/b');
});

test('a crafted scopeId cannot write outside the prefs directory', () => {
  const dir = tmpDir();
  const s = new ScopeStore({ stateDir: dir });
  const written = s.savePref('../../evil', 'alice', { repo: 'a/b' });
  assert.equal(written.repo, 'a/b');
  const prefsDir = path.join(dir, 'prefs');
  const files = fs.readdirSync(prefsDir);
  assert.equal(files.length, 1);
  // the real safety property: no path separator, so the write stays inside prefs/
  assert.equal(files[0].includes('/'), false);
  assert.equal(path.dirname(s.prefPath('../../evil', 'alice')), prefsDir);
  // and nothing escaped into the state dir's parent
  assert.equal(fs.existsSync(path.join(dir, '..', 'evil__alice.json')), false);
});
