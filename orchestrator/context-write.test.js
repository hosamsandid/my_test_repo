'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildDeleteArgv,
  buildMoveArgv,
  buildPrepareUploadArgv,
  statusForWriteCode,
  sanitizeUploadSegment,
  sanitizeUploadName,
  WRITE_PROGRAM,
} = require('./context-write');

/* ─── argv builders ─────────────────────────────────────────────────────── */

test('argv builders emit python3 -c <program> <mode> <args...>', () => {
  assert.deepEqual(buildDeleteArgv('docs/a.txt').slice(0, 4), ['python3', '-c', WRITE_PROGRAM, 'delete']);
  assert.deepEqual(buildDeleteArgv('docs/a.txt')[4], 'docs/a.txt');
  const mv = buildMoveArgv('a/x.txt', 'b');
  assert.deepEqual([mv[3], mv[4], mv[5]], ['move', 'a/x.txt', 'b']);
  const up = buildPrepareUploadArgv('docs', 'r.pdf');
  assert.deepEqual([up[3], up[4], up[5]], ['prepare-upload', 'docs', 'r.pdf']);
});

/* ─── name sanitising ───────────────────────────────────────────────────── */

test('sanitizeUploadSegment applies the workspace allowlist and caps length', () => {
  assert.equal(sanitizeUploadSegment('report (final).pdf'), 'report (final).pdf');
  assert.equal(sanitizeUploadSegment('a/../b'), 'b');           // basename only
  assert.equal(sanitizeUploadSegment('wild$name*.txt'), 'wild_name_.txt');
  const long = 'x'.repeat(150) + '.xlsx';
  const capped = sanitizeUploadSegment(long);
  assert.ok(Buffer.byteLength(capped) <= 100);
  assert.ok(capped.endsWith('.xlsx'));                          // extension preserved
});

test('sanitizeUploadName drops traversal/empty segments and keeps subpaths', () => {
  assert.equal(sanitizeUploadName('a/b/c.txt'), 'a/b/c.txt');
  assert.equal(sanitizeUploadName('../../etc/passwd'), 'etc/passwd');
  assert.equal(sanitizeUploadName('./x/./y.txt'), 'x/y.txt');
  assert.equal(sanitizeUploadName('a\\b\\c.txt'), 'a/b/c.txt'); // backslashes normalised
  assert.equal(sanitizeUploadName(''), '');
  assert.equal(sanitizeUploadName('../..'), '');               // only traversal → nothing left
  assert.equal(sanitizeUploadName('...'), '...');              // three dots is a legit name
});

/* ─── status table ──────────────────────────────────────────────────────── */

test('statusForWriteCode maps write codes and defers to the browse table', () => {
  assert.equal(statusForWriteCode('exists'), 409);
  assert.equal(statusForWriteCode('no-op'), 400);
  assert.equal(statusForWriteCode('read-only'), 403);
  assert.equal(statusForWriteCode('invalid-path'), 400); // from browse table
  assert.equal(statusForWriteCode('denied'), 403);       // from browse table
  assert.equal(statusForWriteCode('not-found'), 404);    // from browse table
  assert.equal(statusForWriteCode('io-error'), 500);     // default
});

/* ─── the WRITE_PROGRAM itself, exercised against a fake /context ─────────
 * The program hard-codes ROOT="/context". We can still test its logic by
 * pointing os.path at a temp dir via a tiny shim: run the program with a
 * modified source where ROOT is our temp dir. This keeps the containment and
 * collision logic honest without a container.                                */

function runProgram(rootDir, args) {
  const src = WRITE_PROGRAM.replace('ROOT = "/context"', `ROOT = ${JSON.stringify(rootDir)}`);
  const out = execFileSync('python3', ['-c', src, ...args], { encoding: 'utf8' });
  return JSON.parse(out);
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-write-'));
}

test('WRITE_PROGRAM delete removes a file and reports its type', () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'note.txt'), 'hi');
    const r = runProgram(root, ['delete', 'note.txt']);
    assert.deepEqual(r, { deleted: 'note.txt', type: 'file' });
    assert.equal(fs.existsSync(path.join(root, 'note.txt')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('WRITE_PROGRAM delete removes a directory tree', () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'x');
    const r = runProgram(root, ['delete', 'sub']);
    assert.equal(r.type, 'dir');
    assert.equal(fs.existsSync(path.join(root, 'sub')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('WRITE_PROGRAM refuses to delete the mount root or escape it', () => {
  const root = tmpRoot();
  try {
    assert.equal(runProgram(root, ['delete', '']).code, 'invalid-path');
    // A symlink pointing outside is not followed off the mount.
    const outside = tmpRoot();
    fs.writeFileSync(path.join(outside, 'secret'), 's');
    fs.symlinkSync(outside, path.join(root, 'link'));
    const r = runProgram(root, ['delete', 'link/secret']);
    assert.equal(r.code, 'invalid-path');
    assert.equal(fs.existsSync(path.join(outside, 'secret')), true);
    fs.rmSync(outside, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('WRITE_PROGRAM move renames within the mount and refuses a clobber', () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, 'dst'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    const r = runProgram(root, ['move', 'a.txt', 'dst']);
    assert.deepEqual(r, { moved: 'a.txt' });
    assert.equal(fs.existsSync(path.join(root, 'dst', 'a.txt')), true);

    // Clobber: a second file of the same name already at the destination.
    fs.writeFileSync(path.join(root, 'a.txt'), 'y');
    assert.equal(runProgram(root, ['move', 'a.txt', 'dst']).code, 'exists');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('WRITE_PROGRAM move refuses a folder into its own descendant', () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, 'd', 'inner'), { recursive: true });
    assert.equal(runProgram(root, ['move', 'd', 'd/inner']).code, 'invalid-path');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('WRITE_PROGRAM prepare-upload validates the dir and de-duplicates the name', () => {
  const root = tmpRoot();
  try {
    const r1 = runProgram(root, ['prepare-upload', '', 'report.pdf']);
    assert.equal(r1.base, fs.realpathSync(root));
    assert.equal(r1.entry, 'report.pdf');

    fs.writeFileSync(path.join(root, 'report.pdf'), 'x');
    const r2 = runProgram(root, ['prepare-upload', '', 'report.pdf']);
    assert.equal(r2.entry, 'report (2).pdf');  // collision-free

    // A missing target directory is reported, not created.
    assert.equal(runProgram(root, ['prepare-upload', 'nope', 'a.txt']).code, 'not-a-dir');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
