'use strict';

// #2568 — chat-upload filenames: timestamped pasted images, `-<n>` collision suffix.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isGenericPastedImageName, chatUploadBaseName, uniqueFileName } = require('./chat-upload-name');

const AT = new Date(Date.UTC(2026, 8, 29, 16, 49, 12)); // 2026-09-29 16:49:12 UTC

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chat-upload-name-'));
}

/* ── isGenericPastedImageName ─────────────────────────────────────────── */

test('image.<ext> in common raster formats is generic, case-insensitively', () => {
  for (const n of ['image.png', 'image.jpg', 'image.jpeg', 'image.gif', 'image.webp', 'Image.PNG', 'IMAGE.Jpg']) {
    assert.equal(isGenericPastedImageName(n), true, n);
  }
});

test('meaningful names and non-image image.<ext> are not generic', () => {
  for (const n of ['architecture-diagram.png', 'report.pdf', 'image.pdf', 'image.txt', 'image', 'my image.png',
    'image (2).png', 'image-20260929-164912.png', 'screenshot.png', '']) {
    assert.equal(isGenericPastedImageName(n), false, n);
  }
});

/* ── chatUploadBaseName ───────────────────────────────────────────────── */

test('AC1/AC2: a generic pasted image becomes image-YYYYMMDD-HHMMSS.<ext> in UTC', () => {
  assert.equal(chatUploadBaseName('image.png', 'image/png', AT), 'image-20260929-164912.png');
});

test('AC1: the original extension is kept, whatever the format', () => {
  assert.equal(chatUploadBaseName('image.jpg', 'image/jpeg', AT), 'image-20260929-164912.jpg');
  assert.equal(chatUploadBaseName('image.gif', 'image/gif', AT), 'image-20260929-164912.gif');
  assert.equal(chatUploadBaseName('image.webp', 'image/webp', AT), 'image-20260929-164912.webp');
  assert.equal(chatUploadBaseName('Image.PNG', 'image/png', AT), 'image-20260929-164912.PNG');
});

test('AC2: the timestamp is UTC, independent of the local offset of the instant', () => {
  // 00:30 on 2026-09-30 in UTC+02:00 is still 2026-09-29 in UTC.
  const d = new Date('2026-09-30T00:30:05+02:00');
  assert.equal(chatUploadBaseName('image.png', 'image/png', d), 'image-20260929-223005.png');
});

test('AC1: a nameless pasted image takes its extension from the MIME type', () => {
  assert.equal(chatUploadBaseName('', 'image/png', AT), 'image-20260929-164912.png');
  assert.equal(chatUploadBaseName('', 'image/jpeg', AT), 'image-20260929-164912.jpg');
  assert.equal(chatUploadBaseName('', 'IMAGE/WEBP', AT), 'image-20260929-164912.webp');
});

test('a nameless non-image file yields no name (rejected as before)', () => {
  assert.equal(chatUploadBaseName('', 'application/octet-stream', AT), '');
  assert.equal(chatUploadBaseName('', undefined, AT), '');
});

test('AC6: a non-generic name is returned unchanged', () => {
  assert.equal(chatUploadBaseName('architecture-diagram.png', 'image/png', AT), 'architecture-diagram.png');
  assert.equal(chatUploadBaseName('report.pdf', 'application/pdf', AT), 'report.pdf');
  assert.equal(chatUploadBaseName('my screenshot.png', 'image/png', AT), 'my screenshot.png');
});

test('AC3: generated names contain no spaces or parentheses', () => {
  const n = chatUploadBaseName('image.png', 'image/png', AT);
  assert.doesNotMatch(n, /[\s()]/);
});

/* ── uniqueFileName ───────────────────────────────────────────────────── */

test('AC6: a free name is returned unchanged', () => {
  const dir = tmpDir();
  assert.equal(uniqueFileName(dir, 'report.pdf'), 'report.pdf');
});

test('AC5: a collision gets a -<n> suffix before the extension, no spaces or parentheses', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'report.pdf'), '');
  assert.equal(uniqueFileName(dir, 'report.pdf'), 'report-2.pdf');
  fs.writeFileSync(path.join(dir, 'report-2.pdf'), '');
  assert.equal(uniqueFileName(dir, 'report.pdf'), 'report-3.pdf');
});

test('AC5: a collision on an extensionless name appends the suffix', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'README'), '');
  assert.equal(uniqueFileName(dir, 'README'), 'README-2');
});

test('AC4: several images pasted in the same second get unique names', () => {
  const dir = tmpDir();
  const names = [];
  for (let i = 0; i < 3; i++) {
    const n = uniqueFileName(dir, chatUploadBaseName('image.png', 'image/png', AT));
    fs.writeFileSync(path.join(dir, n), '');
    names.push(n);
  }
  assert.deepEqual(names, ['image-20260929-164912.png', 'image-20260929-164912-2.png', 'image-20260929-164912-3.png']);
  for (const n of names) assert.doesNotMatch(n, /[\s()]/);
});

test('AC9: legacy `name (n).ext` files are left alone and do not affect the new suffix', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'image.png'), '');
  fs.writeFileSync(path.join(dir, 'image (2).png'), '');
  assert.equal(uniqueFileName(dir, 'report.pdf'), 'report.pdf');
  assert.equal(uniqueFileName(dir, 'notes (2).txt'), 'notes (2).txt');
});

test('AC7: pasted images uploaded in different seconds list alphabetically in upload order', () => {
  const dir = tmpDir();
  const uploaded = [];
  const start = Date.UTC(2026, 8, 29, 9, 59, 50);
  // 20 pastes, 1 s apart, crossing the minute and hour boundaries — the case where
  // `image (10).png` used to sort before `image (2).png`.
  for (let i = 0; i < 20; i++) {
    const n = uniqueFileName(dir, chatUploadBaseName('image.png', 'image/png', new Date(start + i * 1000)));
    fs.writeFileSync(path.join(dir, n), '');
    uploaded.push(n);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), uploaded);
});
