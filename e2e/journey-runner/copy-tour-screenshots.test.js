const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  manifestScreenshotPaths,
  planCopy,
  clearDest,
  copyOne,
} = require('./copy-tour-screenshots');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tour-shots-'));
}

test('manifestScreenshotPaths flattens every step screenshotPath in order', () => {
  const dir = tmpdir();
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      chapters: [
        { id: 'a', steps: [{ screenshotPath: 'a/one.png' }, { screenshotPath: 'a/two.png' }] },
        { id: 'b', steps: [{ screenshotPath: 'b/one.png' }] },
        { id: 'c', steps: [{ id: 'no-shot' }] }, // step without a screenshotPath is skipped
      ],
    }),
  );
  assert.deepEqual(manifestScreenshotPaths(manifestPath), [
    'a/one.png',
    'a/two.png',
    'b/one.png',
  ]);
});

test('manifestScreenshotPaths tolerates a manifest with no chapters', () => {
  const dir = tmpdir();
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ chapters: [] }));
  assert.deepEqual(manifestScreenshotPaths(manifestPath), []);
});

test('planCopy splits referenced paths into present (copy) and absent (missing)', () => {
  const artifactsDir = tmpdir();
  fs.mkdirSync(path.join(artifactsDir, 'a'), { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, 'a', 'one.png'), 'PNG1');
  // a/two.png intentionally absent.

  const { copy, missing } = planCopy({
    screenshotPaths: ['a/one.png', 'a/two.png'],
    artifactsDir,
  });
  assert.deepEqual(copy, ['a/one.png']);
  assert.deepEqual(missing, ['a/two.png']);
});

test('copyOne creates nested dirs and copies bytes verbatim', () => {
  const artifactsDir = tmpdir();
  const destDir = tmpdir();
  fs.mkdirSync(path.join(artifactsDir, 'chap'), { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, 'chap', 'step.png'), 'BYTES');

  copyOne('chap/step.png', { artifactsDir, destDir });
  assert.equal(fs.readFileSync(path.join(destDir, 'chap', 'step.png'), 'utf8'), 'BYTES');
});

test('clearDest removes PNGs and subdirs but keeps a README', () => {
  const destDir = tmpdir();
  fs.mkdirSync(path.join(destDir, 'chap'), { recursive: true });
  fs.writeFileSync(path.join(destDir, 'chap', 'old.png'), 'OLD');
  fs.writeFileSync(path.join(destDir, 'stray.png'), 'STRAY');
  fs.writeFileSync(path.join(destDir, 'README.md'), 'keep me');

  clearDest(destDir);
  assert.equal(fs.existsSync(path.join(destDir, 'chap')), false);
  assert.equal(fs.existsSync(path.join(destDir, 'stray.png')), false);
  assert.equal(fs.readFileSync(path.join(destDir, 'README.md'), 'utf8'), 'keep me');
});

test('clearDest is a no-op on a missing directory', () => {
  const destDir = path.join(tmpdir(), 'does-not-exist');
  assert.doesNotThrow(() => clearDest(destDir));
});
