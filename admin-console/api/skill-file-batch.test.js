'use strict';

// #2837 — atomic multi-file save behind the full-screen skill editor.
// planBatch is pure; applyBatch runs against a real temp directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const B = require('./skill-file-batch');

const LISTING = {
  files: ['SKILL.md', 'references/a.md', 'references/deep/b.md', 'scripts/run.sh', 'skill.json'],
  dirs: ['references', 'references/deep', 'scripts', 'empty'],
};

function tmpSkill() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-batch-'));
  const put = (rel, txt) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  };
  put('SKILL.md', '---\nname: x\ndescription: y\n---\nbody');
  put('references/a.md', 'A');
  put('references/deep/b.md', 'B');
  put('scripts/run.sh', 'echo');
  put('skill.json', '{}');
  fs.mkdirSync(path.join(dir, 'empty'));
  return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const has = (dir, rel) => fs.existsSync(path.join(dir, rel));

/* ─── path validation (AC17, AC24 path traversal) ─────────────────────── */

test('normalizeRelPath refuses traversal, absolute, empty and odd segments', () => {
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a/./b', 'a//b', 'a/', 'C:/x', 'a\\b', 'a\u0000b', null, 42, 'x'.repeat(300)]) {
    assert.equal(B.normalizeRelPath(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(B.normalizeRelPath('references/deep/c.md'), 'references/deep/c.md');
});

test('planBatch refuses traversal in every op kind', () => {
  for (const body of [
    { deletes: ['../other/SKILL.md'] },
    { moves: [{ from: 'references/a.md', to: '../escape.md' }] },
    { writes: [{ path: '/abs.md', content: 'x' }] },
    { mkdirs: ['a/../../b'] },
  ]) {
    const r = B.planBatch(body, LISTING);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.match(r.error, /invalid/);
  }
});

/* ─── protected paths (AC21) ───────────────────────────────────────────── */

test('SKILL.md cannot be deleted, renamed or moved; it can be written', () => {
  assert.match(B.planBatch({ deletes: ['SKILL.md'] }, LISTING).error, /cannot be deleted/);
  assert.match(B.planBatch({ moves: [{ from: 'SKILL.md', to: 'docs/SKILL.md' }] }, LISTING).error, /cannot be renamed or moved/);
  assert.equal(B.planBatch({ writes: [{ path: 'SKILL.md', content: 'x' }] }, LISTING).ok, true);
});

test('platform sidecars and _archive are not addressable', () => {
  for (const body of [
    { writes: [{ path: 'skill.json', content: '{}' }] },
    { deletes: ['skill.json'] },
    { writes: [{ path: 'provenance.json', content: '{}' }] },
    { mkdirs: ['_archive/x'] },
  ]) {
    const r = B.planBatch(body, LISTING);
    assert.equal(r.ok, false);
    assert.match(r.error, /managed by the platform/);
  }
});

/* ─── collisions & consistency (AC17/AC18) ─────────────────────────────── */

test('move onto an existing file is refused (409); onto a deleted one is allowed', () => {
  const r = B.planBatch({ moves: [{ from: 'references/a.md', to: 'scripts/run.sh' }] }, LISTING);
  assert.equal(r.status, 409);
  assert.equal(B.planBatch({ deletes: ['scripts/run.sh'], moves: [{ from: 'references/a.md', to: 'scripts/run.sh' }] }, LISTING).ok, true);
});

test('folder move relocates members and refuses member collisions', () => {
  assert.equal(B.planBatch({ moves: [{ from: 'references', to: 'docs' }] }, LISTING).ok, true);
  assert.match(B.planBatch({ moves: [{ from: 'references', to: 'references/inner' }] }, LISTING).error, /into itself/);
  const listing = { files: [...LISTING.files, 'docs/a.md'], dirs: [...LISTING.dirs, 'docs'] };
  assert.equal(B.planBatch({ moves: [{ from: 'references', to: 'docs' }] }, listing).status, 409);
});

test('missing sources, double moves and moved-then-deleted are refused', () => {
  assert.equal(B.planBatch({ deletes: ['nope.md'] }, LISTING).status, 409);
  assert.equal(B.planBatch({ moves: [{ from: 'nope.md', to: 'x.md' }] }, LISTING).status, 409);
  assert.match(B.planBatch({ moves: [{ from: 'scripts/run.sh', to: 'a' }, { from: 'scripts/run.sh', to: 'b' }] }, LISTING).error, /moved twice/);
  assert.match(B.planBatch({ moves: [{ from: 'references', to: 'docs' }], deletes: ['references/a.md'] }, LISTING).error, /both moved and deleted/);
});

test('a file cannot also be a folder in the final state', () => {
  const r = B.planBatch({ writes: [{ path: 'scripts', content: 'x' }] }, LISTING);
  assert.equal(r.status, 409);
});

test('size limits are enforced with 413', () => {
  const big = 'x'.repeat(B.MAX_FILE_BYTES + 1);
  assert.equal(B.planBatch({ writes: [{ path: 'big.txt', content: big }] }, LISTING).status, 413);
  const chunk = 'x'.repeat(B.MAX_FILE_BYTES);
  const writes = Array.from({ length: 4 }, (_, i) => ({ path: `f${i}.txt`, content: chunk }));
  assert.match(B.planBatch({ writes }, LISTING).error, /exceeds/);
});

test('empty batch and malformed base64 are refused', () => {
  assert.match(B.planBatch({}, LISTING).error, /nothing to save/);
  assert.match(B.planBatch({ writes: [{ path: 'a.bin', contentBase64: '***' }] }, LISTING).error, /base64/);
});

/* ─── apply (AC10/AC11/AC22) ────────────────────────────────────────────── */

test('applyBatch: delete, rename+edit, folder move, upload, new empty folder', () => {
  const dir = tmpSkill();
  try {
    const body = {
      deletes: ['scripts'],
      moves: [{ from: 'references', to: 'docs' }, { from: 'empty', to: 'still-empty' }],
      writes: [
        { path: 'docs/a.md', content: 'A2' },               // edit travels with the folder move
        { path: 'docs/new/upload.bin', contentBase64: Buffer.from([0, 1, 2]).toString('base64') },
        { path: 'SKILL.md', content: '---\nname: x\ndescription: z\n---\n' },
      ],
      mkdirs: ['assets/icons'],
    };
    const r = B.planBatch(body, LISTING);
    assert.equal(r.ok, true, r.error);
    B.applyBatch(dir, r.plan);
    assert.equal(has(dir, 'scripts'), false);
    assert.equal(has(dir, 'references'), false);
    assert.equal(read(dir, 'docs/a.md'), 'A2');
    assert.equal(read(dir, 'docs/deep/b.md'), 'B');
    assert.deepEqual([...fs.readFileSync(path.join(dir, 'docs/new/upload.bin'))], [0, 1, 2]);
    assert.ok(fs.statSync(path.join(dir, 'assets/icons')).isDirectory(), 'empty folders are persisted');
    assert.ok(fs.statSync(path.join(dir, 'still-empty')).isDirectory());
    assert.equal(has(dir, B.HOLD_DIR), false, 'holding area is cleaned up');
    assert.deepEqual(B.listSkillDirs(dir), ['assets', 'assets/icons', 'docs', 'docs/deep', 'docs/new', 'still-empty']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('applyBatch: swapping two files through moves', () => {
  const dir = tmpSkill();
  try {
    const listing = { files: [...LISTING.files], dirs: [...LISTING.dirs] };
    // a → deep/b's name and b → a's name collide in the final state only if both
    // stay; with both moved the swap is legal.
    const r = B.planBatch({ moves: [{ from: 'references/a.md', to: 'references/deep/b.md' }, { from: 'references/deep/b.md', to: 'references/a.md' }] }, listing);
    assert.equal(r.ok, true, r.error);
    B.applyBatch(dir, r.plan);
    assert.equal(read(dir, 'references/a.md'), 'B');
    assert.equal(read(dir, 'references/deep/b.md'), 'A');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('applyBatch refuses writing through a symlinked folder that leaves the skill', () => {
  const dir = tmpSkill();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-outside-'));
  try {
    fs.symlinkSync(outside, path.join(dir, 'link'));
    const r = B.planBatch({ writes: [{ path: 'link/pwned.txt', content: 'x' }] }, LISTING);
    assert.equal(r.ok, true); // the listing does not know the symlink — apply must catch it
    assert.throws(() => B.applyBatch(dir, r.plan), /escapes the skill directory/);
    assert.equal(fs.existsSync(path.join(outside, 'pwned.txt')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
