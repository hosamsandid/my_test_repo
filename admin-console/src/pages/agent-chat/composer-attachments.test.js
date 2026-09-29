import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isImageAttachment,
  partitionFiles,
  createAttachment,
  addAttachments,
  markUploading,
  markUploaded,
  markFailed,
  removeAttachment,
  hasAttachment,
  anyUploading,
  hasRefToken,
  removeRefToken,
  pruneToDraft,
} from './composer-attachments.js';

const file = (name, type = '') => ({ name, type });

test('isImageAttachment: the four raster formats isImageRefCandidate accepts (AC1)', () => {
  for (const n of ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'SHOT.PNG', 'image (13).png']) {
    assert.equal(isImageAttachment(file(n)), true, n);
  }
});

test('isImageAttachment: non-image files keep today\'s behaviour (AC12)', () => {
  for (const n of ['doc.pdf', 'notes.txt', 'logo.svg', 'archive.zip']) {
    assert.equal(isImageAttachment(file(n)), false, n);
  }
  // An explicit non-image extension wins over a (spoofed) image MIME type.
  assert.equal(isImageAttachment(file('x.pdf', 'image/png')), false);
  assert.equal(isImageAttachment(null), false);
});

test('isImageAttachment: an extension-less clipboard file falls back to its MIME type', () => {
  assert.equal(isImageAttachment(file('', 'image/png')), true);
  assert.equal(isImageAttachment(file('blob', 'image/webp')), true);
  assert.equal(isImageAttachment(file('blob', 'image/svg+xml')), false);
  assert.equal(isImageAttachment(file('blob', 'application/pdf')), false);
});

test('partitionFiles splits images from other files, preserving order', () => {
  const a = file('a.png'), b = file('b.pdf'), c = file('c.jpg'), d = file('d.txt');
  assert.deepEqual(partitionFiles([a, b, c, d]), { images: [a, c], others: [b, d] });
  assert.deepEqual(partitionFiles(null), { images: [], others: [] });
});

test('a new attachment starts uploading, with no ref (AC2/AC3)', () => {
  assert.deepEqual(createAttachment(1, file('a.png')), { id: 1, name: 'a.png', status: 'uploading', ref: null });
});

test('several images at once are listed in attach order (AC7)', () => {
  const list = addAttachments([createAttachment(1, file('a.png'))], [
    createAttachment(2, file('b.png')),
    createAttachment(3, file('c.png')),
  ]);
  assert.deepEqual(list.map(a => a.id), [1, 2, 3]);
});

test('status transitions: uploaded, failed, retry (AC4/AC5)', () => {
  let list = [createAttachment(1, file('a.png')), createAttachment(2, file('b.png'))];
  assert.equal(anyUploading(list), true);
  list = markUploaded(list, 1, 'chat-uploads/a.png');
  list = markFailed(list, 2);
  assert.deepEqual(list.map(a => [a.status, a.ref]), [['uploaded', 'chat-uploads/a.png'], ['failed', null]]);
  assert.equal(anyUploading(list), false);
  list = markUploading(list, 2);
  assert.equal(list[1].status, 'uploading');
  assert.equal(anyUploading(list), true);
});

test('removeAttachment drops one card only (AC6)', () => {
  const list = [createAttachment(1, file('a.png')), createAttachment(2, file('b.png'))];
  const next = removeAttachment(list, 1);
  assert.deepEqual(next.map(a => a.id), [2]);
  assert.equal(hasAttachment(next, 1), false);
  assert.equal(hasAttachment(next, 2), true);
});

test('hasRefToken finds a padded token and respects token boundaries', () => {
  const ref = 'chat-uploads/image-20260929-101010.png';
  assert.equal(hasRefToken(`look @${ref} here`, ref), true);
  assert.equal(hasRefToken(`@${ref}`, ref), true);
  assert.equal(hasRefToken(`see @${ref}.`, ref), true);   // sentence full stop
  assert.equal(hasRefToken(`see @${ref}, ok`, ref), true);
  assert.equal(hasRefToken(`see ${ref}`, ref), false);      // no '@'
  assert.equal(hasRefToken(`x@${ref}`, ref), false);        // '@' mid-word
  assert.equal(hasRefToken(`@${ref}.bak`, ref), false);     // a longer filename
  assert.equal(hasRefToken(`@${ref.replace('.png', '')}-2.png`, ref), false);
  assert.equal(hasRefToken('', ref), false);
  assert.equal(hasRefToken(`@${ref}`, ''), false);
});

test('hasRefToken handles refs with spaces and regex metacharacters (#2453)', () => {
  const ref = 'chat-uploads/image (13).png';
  assert.equal(hasRefToken(`@${ref} and more`, ref), true);
  assert.equal(hasRefToken('@chat-uploads/image (14).png', ref), false);
});

test('removeRefToken removes the token and one padding space (AC6)', () => {
  const ref = 'chat-uploads/a.png';
  assert.equal(removeRefToken(`@${ref} `, ref), '');
  assert.equal(removeRefToken(`hello @${ref} world`, ref), 'hello world');
  assert.equal(removeRefToken(`hello @${ref}`, ref), 'hello');
  assert.equal(removeRefToken(`@${ref} @chat-uploads/b.png `, ref), '@chat-uploads/b.png ');
  // Leaves a different, longer filename alone.
  assert.equal(removeRefToken(`@${ref}.bak `, ref), `@${ref}.bak `);
  // Removes every occurrence.
  assert.equal(removeRefToken(`@${ref} x @${ref} `, ref), 'x ');
});

test('pruneToDraft drops uploaded cards whose token was deleted by hand (AC10)', () => {
  const list = [
    markUploaded([createAttachment(1, file('a.png'))], 1, 'chat-uploads/a.png')[0],
    markUploaded([createAttachment(2, file('b.png'))], 2, 'chat-uploads/b.png')[0],
    createAttachment(3, file('c.png')),                   // still uploading
    markFailed([createAttachment(4, file('d.png'))], 4)[0], // failed
  ];
  const next = pruneToDraft(list, 'text @chat-uploads/b.png ');
  assert.deepEqual(next.map(a => a.id), [2, 3, 4]);
});

test('pruneToDraft returns the same list when nothing changed', () => {
  const list = markUploaded([createAttachment(1, file('a.png'))], 1, 'chat-uploads/a.png');
  assert.equal(pruneToDraft(list, '@chat-uploads/a.png '), list);
  const empty = [];
  assert.equal(pruneToDraft(empty, 'anything'), empty);
});

test('the same image pasted twice yields two independent cards and refs', () => {
  let list = addAttachments([], [createAttachment(1, file('image.png')), createAttachment(2, file('image.png'))]);
  list = markUploaded(list, 1, 'chat-uploads/image-20260929-101010.png');
  list = markUploaded(list, 2, 'chat-uploads/image-20260929-101010-2.png');
  const draft = '@chat-uploads/image-20260929-101010.png @chat-uploads/image-20260929-101010-2.png ';
  assert.equal(pruneToDraft(list, draft), list);
  const without1 = removeRefToken(draft, list[0].ref);
  assert.equal(without1, '@chat-uploads/image-20260929-101010-2.png ');
  assert.deepEqual(pruneToDraft(list, without1).map(a => a.id), [2]);
});
