const test = require('node:test');
const assert = require('node:assert/strict');

const { pairRepositorySshKeyChanges } = require('./repo-sshkey-pairing');

test('a repo whose sshKeyId is cleared is paired (the data-loss surface)', () => {
  const prev = [{ url: 'git@github.com:o/r.git', sshKeyId: 'personal-key' }];
  const next = [{ url: 'git@github.com:o/r.git', sshKeyId: '' }];
  assert.deepEqual(pairRepositorySshKeyChanges(prev, next), [
    { url: 'git@github.com:o/r.git', prevSshKeyId: 'personal-key', nextSshKeyId: null },
  ]);
});

test('a repo whose sshKeyId is unchanged is NOT paired (no-op dropped)', () => {
  const prev = [{ url: 'u', sshKeyId: 'k1' }];
  const next = [{ url: 'u', sshKeyId: 'k1' }];
  assert.deepEqual(pairRepositorySshKeyChanges(prev, next), []);
});

test('a repo swapped to a different key is paired', () => {
  const prev = [{ url: 'u', sshKeyId: 'k1' }];
  const next = [{ url: 'u', sshKeyId: 'k2' }];
  assert.deepEqual(pairRepositorySshKeyChanges(prev, next), [{ url: 'u', prevSshKeyId: 'k1', nextSshKeyId: 'k2' }]);
});

test('a NEW url (not in prev) has nothing to protect → not paired', () => {
  const prev = [{ url: 'a', sshKeyId: 'k1' }];
  const next = [{ url: 'a', sshKeyId: 'k1' }, { url: 'b', sshKeyId: '' }];
  assert.deepEqual(pairRepositorySshKeyChanges(prev, next), []);
});

test('a removed url is simply absent from the result', () => {
  const prev = [{ url: 'a', sshKeyId: 'k1' }, { url: 'b', sshKeyId: 'k2' }];
  const next = [{ url: 'a', sshKeyId: 'k1' }];
  assert.deepEqual(pairRepositorySshKeyChanges(prev, next), []);
});

test('matches multiple repos independently by url', () => {
  const prev = [{ url: 'a', sshKeyId: 'ka' }, { url: 'b', sshKeyId: 'kb' }];
  const next = [{ url: 'b', sshKeyId: '' }, { url: 'a', sshKeyId: 'ka' }];
  assert.deepEqual(pairRepositorySshKeyChanges(prev, next), [{ url: 'b', prevSshKeyId: 'kb', nextSshKeyId: null }]);
});

test('empty / missing inputs are handled', () => {
  assert.deepEqual(pairRepositorySshKeyChanges(undefined, undefined), []);
  assert.deepEqual(pairRepositorySshKeyChanges([], [{ url: 'a', sshKeyId: 'k' }]), []);
});
