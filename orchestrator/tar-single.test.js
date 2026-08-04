'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildTar, splitName, BLOCK } = require('./tar-single');

test('buildTar output length is block-aligned with a two-block trailer', () => {
  const tar = buildTar([{ name: 'a.txt', body: Buffer.from('hi') }]);
  assert.equal(tar.length % BLOCK, 0);
  // last two blocks are the zero trailer
  const trailer = tar.slice(tar.length - BLOCK * 2);
  assert.ok(trailer.every((b) => b === 0));
});

test('splitName keeps short paths whole and splits long ones on a slash', () => {
  assert.deepEqual(splitName('a/b.txt'), { name: 'a/b.txt', prefix: '' });
  const deep = 'p/' + 'x'.repeat(90) + '/' + 'y'.repeat(90);
  const s = splitName(deep);
  assert.ok(Buffer.byteLength(s.name) <= 100);
  assert.ok(Buffer.byteLength(s.prefix) <= 155);
  // A single 120-char component cannot be represented → null.
  assert.equal(splitName('z'.repeat(120)), null);
});

test('buildTar rejects an empty entry list', () => {
  assert.throws(() => buildTar([]), /at least one entry/);
});

test('the archive is a valid tar that system tar can list and extract', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-single-'));
  try {
    const tar = buildTar([
      { name: 'hello.txt', body: Buffer.from('Hello, Welt!\n') },
      { name: 'sub/deep/note.md', body: Buffer.from('# nested\n') },
      { name: 'bin.dat', body: Buffer.from([0, 1, 2, 3, 255]) },
    ]);
    const tf = path.join(dir, 'out.tar');
    fs.writeFileSync(tf, tar);

    const listing = execFileSync('tar', ['-tf', tf], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(listing, ['bin.dat', 'hello.txt', 'sub/deep/note.md']);

    const ex = path.join(dir, 'ex');
    fs.mkdirSync(ex);
    execFileSync('tar', ['-xf', tf, '-C', ex]);
    assert.equal(fs.readFileSync(path.join(ex, 'hello.txt'), 'utf8'), 'Hello, Welt!\n');
    assert.equal(fs.readFileSync(path.join(ex, 'sub/deep/note.md'), 'utf8'), '# nested\n');
    assert.deepEqual([...fs.readFileSync(path.join(ex, 'bin.dat'))], [0, 1, 2, 3, 255]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a body whose length is a multiple of 512 still round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-single-'));
  try {
    const body = Buffer.alloc(1024, 0x41); // exactly two blocks, no padding
    const tar = buildTar([{ name: 'aligned.bin', body }]);
    const tf = path.join(dir, 'a.tar');
    fs.writeFileSync(tf, tar);
    const ex = path.join(dir, 'ex');
    fs.mkdirSync(ex);
    execFileSync('tar', ['-xf', tf, '-C', ex]);
    assert.deepEqual(fs.readFileSync(path.join(ex, 'aligned.bin')), body);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
