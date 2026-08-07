'use strict';

// Run: node --test orchestrator/context-mount.test.js
// Pure, dependency-free — no npm install needed.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  CONTEXT_MOUNT_TARGET,
  MAX_CONTEXT_MOUNTS,
  DENY_TREES,
  validateHostMountPath,
  buildContextMountSpec,
  buildContextMountSpecs,
  basenameOf,
  slugifyMountName,
  normalizeContextMountsInput,
  resolveContextMounts,
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

test('buildContextMountSpec: read-write opt-in flips the access mode, keeps the relabel (#1289)', () => {
  const spec = buildContextMountSpec('/home/alice/ctx', { readWrite: true });
  assert.deepStrictEqual(spec, {
    type: 'bind',
    source: '/home/alice/ctx',
    destination: '/context',
    options: ['rw', 'z'],
  });
});

test('buildContextMountSpec: read-write defaults off — byte-identical to before (#1289 AC7)', () => {
  const roDefault = buildContextMountSpec('/home/alice/ctx');
  assert.deepStrictEqual(roDefault.options, ['ro', 'z']);
  // An explicit readWrite:false and an empty opts object both stay read-only.
  assert.deepStrictEqual(buildContextMountSpec('/home/alice/ctx', { readWrite: false }).options, ['ro', 'z']);
  assert.deepStrictEqual(buildContextMountSpec('/home/alice/ctx', {}).options, ['ro', 'z']);
});

test('buildContextMountSpec: uses the normalized source path', () => {
  assert.strictEqual(buildContextMountSpec('/home//alice/ctx/').source, '/home/alice/ctx');
});

test('buildContextMountSpec: returns null for an invalid path (fail-closed)', () => {
  assert.strictEqual(buildContextMountSpec('/etc'), null);
  assert.strictEqual(buildContextMountSpec('relative'), null);
  assert.strictEqual(buildContextMountSpec(''), null);
});

test('buildContextMountSpec: honours an explicit target (#1290 /context/<slug>)', () => {
  const spec = buildContextMountSpec('/home/alice/ctx', { target: '/context/docs' });
  assert.deepStrictEqual(spec, {
    type: 'bind',
    source: '/home/alice/ctx',
    destination: '/context/docs',
    options: ['ro', 'z'],
  });
});

/* ─── #1290 multiple folders ─────────────────────────────────────────────── */

test('basenameOf: last path segment', () => {
  assert.strictEqual(basenameOf('/home/alice/ProjectX'), 'ProjectX');
  assert.strictEqual(basenameOf('/home/alice/ctx/'), 'ctx');
  assert.strictEqual(basenameOf('/'), '');
  assert.strictEqual(basenameOf(''), '');
});

test('slugifyMountName: lowercases, replaces unsafe chars, trims, stays stable', () => {
  assert.strictEqual(slugifyMountName('Project X'), 'project-x');
  assert.strictEqual(slugifyMountName('Design Assets!!'), 'design-assets');
  assert.strictEqual(slugifyMountName('  --Requirements--  '), 'requirements');
  assert.strictEqual(slugifyMountName('a/b\\c'), 'a-b-c');
  assert.strictEqual(slugifyMountName('mémo'), 'm-mo');
  assert.strictEqual(slugifyMountName('keep.dots_and-dashes'), 'keep.dots_and-dashes');
  // deterministic → same input always the same output (stability guarantee)
  assert.strictEqual(slugifyMountName('Project X'), slugifyMountName('Project X'));
});

test('slugifyMountName: empty / all-unsafe falls back to "folder"', () => {
  assert.strictEqual(slugifyMountName(''), 'folder');
  assert.strictEqual(slugifyMountName('***'), 'folder');
  assert.strictEqual(slugifyMountName(null), 'folder');
});

test('normalizeContextMountsInput: assigns basename slugs, persists rw only when true', () => {
  const r = normalizeContextMountsInput([
    { path: '/home/a/Requirements' },
    { path: '/home/a/Design Assets', readWrite: true },
  ]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.mounts, [
    { path: '/home/a/Requirements', name: 'Requirements', slug: 'requirements' },
    { path: '/home/a/Design Assets', name: 'Design Assets', slug: 'design-assets', readWrite: true },
  ]);
});

test('normalizeContextMountsInput: de-duplicates colliding slugs (same basename / same path twice)', () => {
  const r = normalizeContextMountsInput([
    { path: '/home/a/docs' },
    { path: '/home/b/docs' },
    { path: '/home/a/docs' },
  ]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.mounts.map(m => m.slug), ['docs', 'docs-2', 'docs-3']);
});

test('normalizeContextMountsInput: honours a supplied slug (target stability across edits)', () => {
  const r = normalizeContextMountsInput([
    { path: '/home/a/renamed', name: 'A new label', slug: 'original' },
  ]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mounts[0].slug, 'original');
  assert.strictEqual(r.mounts[0].name, 'A new label');
});

test('normalizeContextMountsInput: an empty array is valid (clears)', () => {
  assert.deepStrictEqual(normalizeContextMountsInput([]), { ok: true, mounts: [] });
});

test('normalizeContextMountsInput: rejects a bad path, a non-array, and over-cap', () => {
  assert.strictEqual(normalizeContextMountsInput([{ path: '/etc' }]).ok, false);
  assert.strictEqual(normalizeContextMountsInput([{ path: 'relative' }]).ok, false);
  assert.strictEqual(normalizeContextMountsInput('nope').ok, false);
  const tooMany = Array.from({ length: MAX_CONTEXT_MOUNTS + 1 }, (_, i) => ({ path: `/home/a/f${i}` }));
  assert.strictEqual(normalizeContextMountsInput(tooMany).ok, false);
});

test('resolveContextMounts: multi-folder field → /context/<slug> targets', () => {
  const cfg = {
    contextMounts: [
      { path: '/host/req', name: 'Requirements', slug: 'requirements' },
      { path: '/host/design', name: 'Design', slug: 'design', readWrite: true },
    ],
  };
  assert.deepStrictEqual(resolveContextMounts(cfg), [
    { path: '/host/req', name: 'Requirements', slug: 'requirements', target: '/context/requirements', readWrite: false },
    { path: '/host/design', name: 'Design', slug: 'design', target: '/context/design', readWrite: true },
  ]);
});

test('resolveContextMounts: legacy single folder → bare /context (AC7 backward compat)', () => {
  assert.deepStrictEqual(resolveContextMounts({ contextMount: '/host/ctx' }), [
    { path: '/host/ctx', name: 'ctx', slug: null, target: '/context', readWrite: false },
  ]);
  assert.deepStrictEqual(resolveContextMounts({ contextMount: '/host/ctx', contextMountRw: true }), [
    { path: '/host/ctx', name: 'ctx', slug: null, target: '/context', readWrite: true },
  ]);
});

test('resolveContextMounts: no mount → empty (AC9 byte-identical to today)', () => {
  assert.deepStrictEqual(resolveContextMounts({}), []);
  assert.deepStrictEqual(resolveContextMounts(null), []);
  assert.deepStrictEqual(resolveContextMounts({ contextMounts: [] }), []);
});

test('resolveContextMounts: de-dups slugs defensively for a hand-edited config', () => {
  const cfg = { contextMounts: [{ path: '/a/x', slug: 'x' }, { path: '/b/x', slug: 'x' }] };
  assert.deepStrictEqual(resolveContextMounts(cfg).map(m => m.target), ['/context/x', '/context/x-2']);
});

test('buildContextMountSpecs: one spec per folder at its target; skips invalid (fail-closed)', () => {
  const specs = buildContextMountSpecs([
    { path: '/host/req', target: '/context/requirements' },
    { path: '/etc', target: '/context/bad' },              // invalid → skipped
    { path: '/host/design', target: '/context/design', readWrite: true },
  ]);
  assert.deepStrictEqual(specs, [
    { type: 'bind', source: '/host/req', destination: '/context/requirements', options: ['ro', 'z'] },
    { type: 'bind', source: '/host/design', destination: '/context/design', options: ['rw', 'z'] },
  ]);
});

test('buildContextMountSpecs: a single legacy folder is byte-identical to the pre-#1290 spec', () => {
  const legacy = resolveContextMounts({ contextMount: '/host/ctx', contextMountRw: true });
  assert.deepStrictEqual(buildContextMountSpecs(legacy), [buildContextMountSpec('/host/ctx', { readWrite: true })]);
});
