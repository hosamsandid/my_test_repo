import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isImageRefCandidate, parseMessageSegments, hasImageRef } from './chat-image-refs.js';

/* ── isImageRefCandidate ──────────────────────────────────────────────── */

test('isImageRefCandidate accepts the four raster extensions, case-insensitively', () => {
  assert.equal(isImageRefCandidate('chat-uploads/a.png'), true);
  assert.equal(isImageRefCandidate('chat-uploads/a.PNG'), true);
  assert.equal(isImageRefCandidate('a.jpg'), true);
  assert.equal(isImageRefCandidate('a.jpeg'), true);
  assert.equal(isImageRefCandidate('a.gif'), true);
  assert.equal(isImageRefCandidate('a.webp'), true);
});

test('isImageRefCandidate rejects non-image extensions and SVG', () => {
  assert.equal(isImageRefCandidate('chat-uploads/notes.txt'), false);
  assert.equal(isImageRefCandidate('src/foo.js'), false);
  assert.equal(isImageRefCandidate('a.svg'), false);
  assert.equal(isImageRefCandidate('README'), false);
});

test('isImageRefCandidate rejects a /context mount key', () => {
  // A leading slash marks a host-context-mount path (#1286) — out of scope.
  assert.equal(isImageRefCandidate('/context/screenshot.png'), false);
});

test('isImageRefCandidate rejects empty/undefined input', () => {
  assert.equal(isImageRefCandidate(''), false);
  assert.equal(isImageRefCandidate(undefined), false);
});

/* ── parseMessageSegments ─────────────────────────────────────────────── */

test('a message with no @ reference is a single text segment', () => {
  const segs = parseMessageSegments('just a plain message');
  assert.deepEqual(segs, [{ type: 'text', value: 'just a plain message' }]);
});

test('an empty body parses to no segments', () => {
  assert.deepEqual(parseMessageSegments(''), []);
  assert.deepEqual(parseMessageSegments(undefined), []);
});

test('a lone image reference is a single ref segment', () => {
  const segs = parseMessageSegments('@chat-uploads/screenshot.png');
  assert.deepEqual(segs, [{ type: 'ref', raw: '@chat-uploads/screenshot.png', path: 'chat-uploads/screenshot.png' }]);
});

test('an image reference embedded mid-sentence keeps the text before and after (edge case)', () => {
  const segs = parseMessageSegments('look at @chat-uploads/a.png please');
  assert.deepEqual(segs, [
    { type: 'text', value: 'look at ' },
    { type: 'ref', raw: '@chat-uploads/a.png', path: 'chat-uploads/a.png' },
    { type: 'text', value: ' please' },
  ]);
});

test('the same image referenced twice in one message produces two ref segments (edge case)', () => {
  const segs = parseMessageSegments('@a.png and again @a.png');
  assert.deepEqual(segs, [
    { type: 'ref', raw: '@a.png', path: 'a.png' },
    { type: 'text', value: ' and again ' },
    { type: 'ref', raw: '@a.png', path: 'a.png' },
  ]);
});

test('a non-image reference is left inside its surrounding text, not split out (AC5)', () => {
  const segs = parseMessageSegments('see @chat-uploads/notes.txt for details');
  assert.deepEqual(segs, [{ type: 'text', value: 'see @chat-uploads/notes.txt for details' }]);
});

test('image and non-image references mix correctly', () => {
  const segs = parseMessageSegments('@a.png then @b.txt then @c.jpg');
  assert.deepEqual(segs, [
    { type: 'ref', raw: '@a.png', path: 'a.png' },
    { type: 'text', value: ' then @b.txt then ' },
    { type: 'ref', raw: '@c.jpg', path: 'c.jpg' },
  ]);
});

test('a message starting with an image reference has no leading empty text segment', () => {
  const segs = parseMessageSegments('@a.png trailing text');
  assert.equal(segs[0].type, 'ref');
});

/* ── filenames containing a space (#2453) ─────────────────────────────── */

test('a lone image reference whose filename contains a space is a single ref segment', () => {
  const segs = parseMessageSegments('@chat-uploads/my screenshot.png');
  assert.deepEqual(segs, [
    { type: 'ref', raw: '@chat-uploads/my screenshot.png', path: 'chat-uploads/my screenshot.png' },
  ]);
});

test('the legacy de-dupe shape `image (2).png` (space + parens, pre-#2568 uploads) still previews', () => {
  const segs = parseMessageSegments('@chat-uploads/image (2).png');
  assert.deepEqual(segs, [
    { type: 'ref', raw: '@chat-uploads/image (2).png', path: 'chat-uploads/image (2).png' },
  ]);
});

test('a space-containing reference mid-sentence still splits the surrounding text', () => {
  const segs = parseMessageSegments('here is @chat-uploads/my screenshot.png ok');
  assert.deepEqual(segs, [
    { type: 'text', value: 'here is ' },
    { type: 'ref', raw: '@chat-uploads/my screenshot.png', path: 'chat-uploads/my screenshot.png' },
    { type: 'text', value: ' ok' },
  ]);
});

test('two space-containing references in one message stay separate', () => {
  const segs = parseMessageSegments('@a b.png and @c d.png');
  assert.deepEqual(segs, [
    { type: 'ref', raw: '@a b.png', path: 'a b.png' },
    { type: 'text', value: ' and ' },
    { type: 'ref', raw: '@c d.png', path: 'c d.png' },
  ]);
});

test('a space-containing non-image reference stays inside its text (no image ext to anchor)', () => {
  const segs = parseMessageSegments('see @my notes.txt for details');
  assert.deepEqual(segs, [{ type: 'text', value: 'see @my notes.txt for details' }]);
});

test('the path ends at the first image extension, not at a trailing word', () => {
  // `please` after the extension is not part of the filename.
  const segs = parseMessageSegments('@chat-uploads/a.png please');
  assert.deepEqual(segs, [
    { type: 'ref', raw: '@chat-uploads/a.png', path: 'chat-uploads/a.png' },
    { type: 'text', value: ' please' },
  ]);
});

test('a lookalike extension (`.pngx`) is not treated as an image reference', () => {
  const segs = parseMessageSegments('@chat-uploads/a.pngx');
  assert.deepEqual(segs, [{ type: 'text', value: '@chat-uploads/a.pngx' }]);
});

test('a /context mount key with a space is not treated as an image reference', () => {
  const segs = parseMessageSegments('@/context/my screenshot.png');
  assert.deepEqual(segs, [{ type: 'text', value: '@/context/my screenshot.png' }]);
});

/* ── hasImageRef ──────────────────────────────────────────────────────── */

test('hasImageRef is false for a plain-text-only segment list', () => {
  assert.equal(hasImageRef(parseMessageSegments('no refs here')), false);
});

test('hasImageRef is true once at least one ref segment is present', () => {
  assert.equal(hasImageRef(parseMessageSegments('@a.png')), true);
});

/* ── timestamped pasted-image names (#2568) ───────────────────────────── */

test('a timestamped pasted-image name is a single ref segment', () => {
  const segs = parseMessageSegments('@chat-uploads/image-20260929-164912.png');
  assert.deepEqual(segs, [
    { type: 'ref', raw: '@chat-uploads/image-20260929-164912.png', path: 'chat-uploads/image-20260929-164912.png' },
  ]);
});

test('the `-<n>` de-dupe shape of several pastes in one message stays separate', () => {
  const segs = parseMessageSegments('@chat-uploads/image-20260929-164912.png @chat-uploads/image-20260929-164912-2.png');
  assert.deepEqual(segs, [
    { type: 'ref', raw: '@chat-uploads/image-20260929-164912.png', path: 'chat-uploads/image-20260929-164912.png' },
    { type: 'text', value: ' ' },
    { type: 'ref', raw: '@chat-uploads/image-20260929-164912-2.png', path: 'chat-uploads/image-20260929-164912-2.png' },
  ]);
});
