import test from 'node:test';
import assert from 'node:assert/strict';
import { isImageData, imageSrcUrl } from './workspace-image.js';

test('isImageData: true only for a binary file with an imageType', () => {
  assert.equal(isImageData({ binary: true, imageType: 'png' }), true);
  assert.equal(isImageData({ binary: true, imageType: 'jpeg' }), true);
});

test('isImageData: false for non-image binaries and text', () => {
  assert.equal(isImageData({ binary: true, imageType: null }), false);
  assert.equal(isImageData({ binary: true }), false);
  assert.equal(isImageData({ binary: false, imageType: 'png' }), false); // never happens, but guard
  assert.equal(isImageData({ binary: false, content: 'hello' }), false);
  assert.equal(isImageData(null), false);
  assert.equal(isImageData(undefined), false);
});

test('imageSrcUrl builds an encoded image endpoint URL', () => {
  assert.equal(
    imageSrcUrl('cobol-agent', 'memory/diagram.png'),
    '/api/agents/cobol-agent/workspace/image?path=memory%2Fdiagram.png',
  );
});

test('imageSrcUrl encodes spaces and special characters', () => {
  assert.equal(
    imageSrcUrl('a b', 'dir/my shot (1).png'),
    '/api/agents/a%20b/workspace/image?path=dir%2Fmy%20shot%20(1).png',
  );
});

test('imageSrcUrl returns null without both args', () => {
  assert.equal(imageSrcUrl('', 'x.png'), null);
  assert.equal(imageSrcUrl('a', ''), null);
  assert.equal(imageSrcUrl(null, null), null);
});
