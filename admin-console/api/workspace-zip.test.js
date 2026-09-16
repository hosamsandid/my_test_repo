'use strict';

// #2318 — the pure pre-flight sizing for the per-directory ZIP download.
// api.js binds port 4000 on require (#651), so the route itself is not unit
// tested; this covers the deterministic seam it delegates to — the size/count
// walk, the symlink-skip containment, the empty-directory signal and the
// refusal message — over a real temp directory tree.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  WORKSPACE_ZIP_MAX_BYTES,
  WORKSPACE_ZIP_MAX_FILES,
  EMPTY_ZIP,
  measureWorkspaceDir,
  formatBytes,
  describeOversizeDir,
} = require('./workspace-zip');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-zip-test-'));
}

test('measures bytes and counts files across nested directories', async () => {
  const root = mkTmp();
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');            // 5 bytes
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'world!!');   // 7 bytes
  fs.mkdirSync(path.join(root, 'sub', 'deep'));
  fs.writeFileSync(path.join(root, 'sub', 'deep', 'c.bin'), Buffer.alloc(10));

  const m = await measureWorkspaceDir(root);
  assert.equal(m.bytes, 22);
  assert.equal(m.files, 3);
  // entries = 3 files + 2 subdirectories
  assert.equal(m.entries, 5);
  assert.equal(m.over, false);
});

test('an empty directory reports zero entries (the empty-ZIP signal, AC13)', async () => {
  const root = mkTmp();
  const m = await measureWorkspaceDir(root);
  assert.deepEqual(m, { bytes: 0, files: 0, entries: 0, over: false });
});

test('a directory of only empty subdirectories is NOT the empty case', async () => {
  const root = mkTmp();
  fs.mkdirSync(path.join(root, 'empty-sub'));
  const m = await measureWorkspaceDir(root);
  assert.equal(m.files, 0);
  assert.equal(m.entries, 1); // the subdirectory is an archivable entry
});

test('symlinks are skipped, not followed — no linked content is measured (AC6/D5)', async () => {
  const outside = mkTmp();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x'.repeat(1000));
  fs.mkdirSync(path.join(outside, 'tree'));
  fs.writeFileSync(path.join(outside, 'tree', 'more.txt'), 'y'.repeat(2000));

  const root = mkTmp();
  fs.writeFileSync(path.join(root, 'real.txt'), 'z'.repeat(4));
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link-file'));
    fs.symlinkSync(path.join(outside, 'tree'), path.join(root, 'link-dir'));
  } catch {
    return; // platform without symlink support — nothing to assert
  }

  const m = await measureWorkspaceDir(root);
  // Only the one real file is counted; neither the linked file's 1000 bytes nor
  // the linked directory's 2000 are pulled in.
  assert.equal(m.bytes, 4);
  assert.equal(m.files, 1);
  assert.equal(m.entries, 1);
});

test('over is set when the byte ceiling is exceeded, actual totals preserved', async () => {
  const root = mkTmp();
  fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(50));
  const m = await measureWorkspaceDir(root, { maxBytes: 10, maxFiles: WORKSPACE_ZIP_MAX_FILES });
  assert.equal(m.over, true);
  assert.equal(m.bytes, 50); // the whole tree is walked so the number is exact
  assert.equal(m.files, 1);
});

test('over is set when the file-count ceiling is exceeded', async () => {
  const root = mkTmp();
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(root, `f${i}`), '');
  const m = await measureWorkspaceDir(root, { maxBytes: WORKSPACE_ZIP_MAX_BYTES, maxFiles: 3 });
  assert.equal(m.over, true);
  assert.equal(m.files, 5);
});

test('an unreadable subdirectory is skipped rather than throwing', async () => {
  const root = mkTmp();
  fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
  const locked = path.join(root, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'hidden.txt'), 'nope');
  fs.chmodSync(locked, 0o000);
  try {
    const m = await measureWorkspaceDir(root);
    // The locked directory is still an entry; its unreadable contents are not
    // measured, and no error is thrown.
    assert.ok(m.entries >= 1);
    assert.equal(m.over, false);
  } finally {
    fs.chmodSync(locked, 0o755); // restore so the temp dir can be cleaned up
  }
});

test('EMPTY_ZIP is a valid 22-byte end-of-central-directory record', () => {
  assert.equal(EMPTY_ZIP.length, 22);
  assert.equal(EMPTY_ZIP.readUInt32LE(0), 0x06054b50); // EOCD signature
});

test('describeOversizeDir names the size, count and an alternative', () => {
  const msg = describeOversizeDir({ bytes: 3 * 1024 * 1024 * 1024, files: 42 });
  assert.match(msg, /3\.0 GB/);
  assert.match(msg, /42 files/);
  assert.match(msg, /Export agent workspace as ZIP/);
  // Singular file wording.
  assert.match(describeOversizeDir({ bytes: 5, files: 1 }), /1 file\b/);
});

test('formatBytes scales through the units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});
