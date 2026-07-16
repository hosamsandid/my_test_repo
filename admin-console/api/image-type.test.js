'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectRasterImageType, imageContentType } = require('./image-type');

function header(bytes, len = 16) {
  const b = Buffer.alloc(len, 0x20); // pad with spaces so length >= 12
  Buffer.from(bytes).copy(b, 0);
  return b;
}

test('detects PNG magic bytes', () => {
  const buf = header([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(detectRasterImageType(buf), 'png');
});

test('detects JPEG magic bytes', () => {
  const buf = header([0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(detectRasterImageType(buf), 'jpeg');
});

test('detects GIF87a and GIF89a', () => {
  assert.equal(detectRasterImageType(header([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])), 'gif');
  assert.equal(detectRasterImageType(header([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'gif');
});

test('detects WebP (RIFF....WEBP)', () => {
  const buf = header([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(detectRasterImageType(buf), 'webp');
});

test('detection is content-based, not extension-based (a real PNG regardless of name)', () => {
  // wrong-extension robustness (E2): only the bytes matter.
  const png = header([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(detectRasterImageType(png), 'png');
});

test('SVG is not detected as a raster image (D2/E3)', () => {
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.equal(detectRasterImageType(svg), null);
});

test('arbitrary binary / text is not an image', () => {
  assert.equal(detectRasterImageType(Buffer.from('hello world, just some text here')), null);
  assert.equal(detectRasterImageType(header([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])), null);
});

test('empty / too-short buffer returns null (E4)', () => {
  assert.equal(detectRasterImageType(Buffer.alloc(0)), null);
  assert.equal(detectRasterImageType(Buffer.from([0x89, 0x50])), null);
  assert.equal(detectRasterImageType(null), null);
  assert.equal(detectRasterImageType(undefined), null);
});

test('imageContentType maps each supported type to its mime', () => {
  assert.equal(imageContentType('png'), 'image/png');
  assert.equal(imageContentType('jpeg'), 'image/jpeg');
  assert.equal(imageContentType('gif'), 'image/gif');
  assert.equal(imageContentType('webp'), 'image/webp');
  assert.equal(imageContentType('svg'), null);
  assert.equal(imageContentType(null), null);
});
