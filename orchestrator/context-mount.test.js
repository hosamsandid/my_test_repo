'use strict';

// Run: node --test orchestrator/context-mount.test.js
// Pure, dependency-free — no npm install needed.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  CONTEXT_MOUNT_TARGET,
  DENY_TREES,
  validateHostMountPath,
  buildContextMountSpec,
} = require('./context-mount');

test('accepts a plain absolute host directory', () => {
  const r = validateHostMountPath('/home/alice/sharepoint');
  assert.deepStrictEqual(r, { ok: true, path: '/home/alice/sharepoint' });
});

test('accepts /mnt and /Users style locations', () => {
  assert.strictEqual(validateHostMountPath('/mnt/data/ctx').ok, true);
  assert.strictEqual(validateHostMountPath('/Users/bob/Sync').ok, true);
  assert.strictEqual(validateHostMountPath('/data/incoming').ok, true);
});

test('allows spaces and non-ASCII folder names', () => {
  assert.strictEqual(validateHostMountPath('/home/alice/My Documents').ok, true);
  assert.strictEqual(validateHostMountPath('/home/josé/aperçu').ok, true);
});

test('normalizes duplicate slashes, "." and a trailing slash', () => {
  assert.strictEqual(validateHostMountPath('/home//alice/./ctx/').path, '/home/alice/ctx');
  assert.strictEqual(validateHostMountPath('/opt/ctx/').path, '/opt/ctx');
});

test('trims surrounding whitespace', () => {
  assert.strictEqual(validateHostMountPath('  /home/alice/ctx  ').path, '/home/alice/ctx');
});

test('rejects a non-string', () => {
  assert.strictEqual(validateHostMountPath(null).ok, false);
  assert.strictEqual(validateHostMountPath(42).ok, false);
  assert.strictEqual(validateHostMountPath(undefined).ok, false);
});

test('rejects empty / whitespace-only', () => {
  assert.strictEqual(validateHostMountPath('').ok, false);
  assert.strictEqual(validateHostMountPath('   ').ok, false);
});

test('rejects a relative path', () => {
  assert.strictEqual(validateHostMountPath('home/alice/ctx').ok, false);
  assert.strictEqual(validateHostMountPath('./ctx').ok, false);
});

test('rejects ".." traversal segments (AC7)', () => {
  assert.strictEqual(validateHostMountPath('/home/alice/../../etc').ok, false);
  assert.strictEqual(validateHostMountPath('/home/../root').ok, false);
  assert.strictEqual(validateHostMountPath('/..').ok, false);
});

test('rejects the filesystem root', () => {
  assert.strictEqual(validateHostMountPath('/').ok, false);
});

test('rejects control characters / NUL', () => {
  assert.strictEqual(validateHostMountPath('/home/alice/ct\u0000x').ok, false);
  assert.strictEqual(validateHostMountPath('/home/alice/ct\tx').ok, false);
});

test('rejects an over-long path', () => {
  assert.strictEqual(validateHostMountPath('/' + 'a'.repeat(5000)).ok, false);
});

test('rejects every unsafe system tree — the dir itself and a child', () => {
  for (const tree of DENY_TREES) {
    assert.strictEqual(validateHostMountPath(tree).ok, false, `${tree} itself`);
    assert.strictEqual(validateHostMountPath(tree + '/sub').ok, false, `${tree}/sub`);
  }
  // Spot-check the headline ones.
  assert.strictEqual(validateHostMountPath('/etc/passwd').ok, false);
  assert.strictEqual(validateHostMountPath('/root/.ssh').ok, false);
  assert.strictEqual(validateHostMountPath('/proc/1').ok, false);
  assert.strictEqual(validateHostMountPath('/var/lib/containers/storage').ok, false);
});

test('a name that merely starts with a denied tree name is allowed', () => {
  // "/etchings" is not under "/etc"; the guard is path-segment aware.
  assert.strictEqual(validateHostMountPath('/etchings/data').ok, true);
  assert.strictEqual(validateHostMountPath('/usr-data/ctx').ok, true);
});

test('buildContextMountSpec: read-only + SELinux relabel at the fixed target', () => {
  const spec = buildContextMountSpec('/home/alice/ctx');
  // Lowercase OCI runtime-spec Mount keys (libpod `mounts[]`), not the
  // capitalized NamedVolume shape used by `volumes[]`.
  assert.deepStrictEqual(spec, {
    type: 'bind',
    source: '/home/alice/ctx',
    destination: '/context',
    options: ['ro', 'z'],
  });
  assert.strictEqual(CONTEXT_MOUNT_TARGET, '/context');
});

test('buildContextMountSpec: uses the normalized source path', () => {
  assert.strictEqual(buildContextMountSpec('/home//alice/ctx/').source, '/home/alice/ctx');
});

test('buildContextMountSpec: returns null for an invalid path (fail-closed)', () => {
  assert.strictEqual(buildContextMountSpec('/etc'), null);
  assert.strictEqual(buildContextMountSpec('relative'), null);
  assert.strictEqual(buildContextMountSpec(''), null);
});
