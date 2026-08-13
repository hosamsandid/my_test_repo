const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readTourManifest, EMPTY_MANIFEST, DEFAULT_MANIFEST_PATH } = require('./tour-manifest-loader');

function tmpFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-manifest-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

test('missing file → empty manifest', () => {
  assert.deepEqual(readTourManifest('/no/such/tour-manifest.json'), EMPTY_MANIFEST);
});

test('valid manifest is returned as-is', () => {
  const manifest = { generated: 'x', chapters: [{ id: 'a', order: 1, title: 'A', steps: [] }] };
  const p = tmpFile('tour-manifest.json', JSON.stringify(manifest));
  assert.deepEqual(readTourManifest(p), manifest);
});

test('corrupt JSON → empty manifest', () => {
  const p = tmpFile('tour-manifest.json', '{ not valid json');
  assert.deepEqual(readTourManifest(p), EMPTY_MANIFEST);
});

test('valid JSON but wrong shape (no chapters array) → empty manifest', () => {
  const p = tmpFile('tour-manifest.json', JSON.stringify({ chapters: 'nope' }));
  assert.deepEqual(readTourManifest(p), EMPTY_MANIFEST);
  const p2 = tmpFile('tour-manifest.json', JSON.stringify([1, 2, 3]));
  assert.deepEqual(readTourManifest(p2), EMPTY_MANIFEST);
});

test('default path constant points at the co-located manifest', () => {
  assert.ok(DEFAULT_MANIFEST_PATH.endsWith(path.join('helper-chat', 'tour-manifest.json')));
  // Whatever is on disk today, the default-path read must never throw.
  assert.ok(Array.isArray(readTourManifest().chapters));
});
