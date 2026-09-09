'use strict';

// Unit tests for the session-cookie signing key (#2059).
// Run: node --test admin-console/api/session-secret.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveSessionSecret, DEFAULT_SECRET_FILE } = require('./session-secret');

function tmpFile(name = 'session-secret') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sess-secret-')), 'auth', name);
}

test('an operator-set AUTH_SESSION_SECRET always wins, and touches no file', () => {
  const file = tmpFile();
  const got = resolveSessionSecret({ env: { AUTH_SESSION_SECRET: '  explicit-key  ' }, file });
  assert.deepEqual(got, { secret: 'explicit-key', source: 'env' });
  assert.equal(fs.existsSync(file), false, 'no key file is created when one is configured');
});

test('with no configured secret, a random key is generated and persisted at 0600', () => {
  const file = tmpFile();
  const first = resolveSessionSecret({ env: {}, file });

  assert.equal(first.source, 'file-created');
  assert.match(first.secret, /^[0-9a-f]{64}$/, '32 random bytes, hex-encoded');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), first.secret);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'a signing key is not world-readable');

  // Stable across restarts — the property the old credential derivation had,
  // and the reason an ephemeral key would be a regression rather than a fix.
  const second = resolveSessionSecret({ env: {}, file });
  assert.deepEqual(second, { secret: first.secret, source: 'file' });
});

test('the persisted key is never derived from the configured credential (#2059 AC4)', () => {
  // The regression this file exists to prevent: an operator who sets a strong
  // password on the Users page but leaves ADMIN_PASSWORD=admin in .env must not
  // end up with a guessable cookie signing key, because a forged cookie is a
  // login by another route.
  const a = resolveSessionSecret({
    env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin' }, file: tmpFile(),
  });
  const b = resolveSessionSecret({
    env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin' }, file: tmpFile(),
  });
  assert.notEqual(a.secret, b.secret, 'two stacks with identical credentials get different keys');
  assert.ok(!a.secret.includes('admin'));
});

test('a blank AUTH_SESSION_SECRET is treated as unset, not as an empty key', () => {
  // docker-compose passes `AUTH_SESSION_SECRET: "${AUTH_SESSION_SECRET:-}"`, so
  // the variable is always PRESENT and usually empty. An empty HMAC key would
  // be a catastrophic silent default.
  for (const blank of ['', '   ', undefined]) {
    const got = resolveSessionSecret({ env: { AUTH_SESSION_SECRET: blank }, file: tmpFile() });
    assert.equal(got.source, 'file-created');
    assert.match(got.secret, /^[0-9a-f]{64}$/);
  }
});

test('an unwritable volume falls back to a process-random key, never a predictable one', () => {
  // Force ENOTDIR with a FILE where a parent directory is expected (`chmod`
  // would be vacuous — the suite runs as root, which ignores permission bits).
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-secret-bad-'));
  const blocker = path.join(base, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const file = path.join(blocker, 'auth', 'session-secret');
  assert.throws(() => fs.mkdirSync(path.dirname(file), { recursive: true }), /ENOTDIR/,
    'the path really is unusable');

  const got = resolveSessionSecret({ env: {}, file });
  assert.equal(got.source, 'ephemeral');
  assert.match(got.secret, /^[0-9a-f]{64}$/);
  // Failing SAFE: everyone re-authenticates after a restart. Failing OPEN would
  // be reusing a well-known constant so sessions survive.
  assert.notEqual(resolveSessionSecret({ env: {}, file }).secret, got.secret);
});

test('a key another process wrote first is adopted rather than clobbered', () => {
  // Two console processes on one volume must agree about which cookies are
  // valid; overwriting the winner's key would invalidate what it already signed.
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'written-by-the-other-process\n');

  const got = resolveSessionSecret({ env: {}, file });
  assert.deepEqual(got, { secret: 'written-by-the-other-process', source: 'file' });
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'written-by-the-other-process');
});

test('an empty key file is not adopted as an empty secret', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '\n');
  const got = resolveSessionSecret({ env: {}, file });
  assert.match(got.secret, /^[0-9a-f]{64}$/);
  assert.notEqual(got.secret, '');
});

test('the default key location is on the shared workspace volume', () => {
  // It has to be a persisted volume, or every restart signs everybody out.
  assert.equal(DEFAULT_SECRET_FILE, '/workspace/auth/session-secret');
});
