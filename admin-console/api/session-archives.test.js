'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArchiveSeq,
  orderedArchiveNames,
  baseRoomOfSessionFile,
} = require('./session-archives');

const ROOM = '!abc:host.name';

test('parseArchiveSeq matches only real archives of the room', () => {
  assert.equal(parseArchiveSeq('!abc:host.name.1.jsonl', ROOM), 1);
  assert.equal(parseArchiveSeq('!abc:host.name.12.jsonl', ROOM), 12);
  // The live file is not an archive.
  assert.equal(parseArchiveSeq('!abc:host.name.jsonl', ROOM), null);
  // The session pointer is not an archive.
  assert.equal(parseArchiveSeq('!abc:host.name.current.json', ROOM), null);
  // A different room's file does not match.
  assert.equal(parseArchiveSeq('!other:host.name.1.jsonl', ROOM), null);
  // seq must be >= 1 and canonical (no leading zeros).
  assert.equal(parseArchiveSeq('!abc:host.name.0.jsonl', ROOM), null);
  assert.equal(parseArchiveSeq('!abc:host.name.01.jsonl', ROOM), null);
  // Non-string input.
  assert.equal(parseArchiveSeq(null, ROOM), null);
});

test('parseArchiveSeq mirrors the writer for numeric-tail room ids', () => {
  const room = '!r:1.2.3';
  assert.equal(parseArchiveSeq('!r:1.2.3.5.jsonl', room), 5);
  assert.equal(parseArchiveSeq('!r:1.2.3.jsonl', room), null); // live file
  assert.equal(parseArchiveSeq('!r:9.9.9.5.jsonl', room), null); // other room
});

test('orderedArchiveNames returns archive names oldest→newest, excluding live/pointer', () => {
  const names = [
    '!abc:host.name.jsonl',         // live — excluded
    '!abc:host.name.3.jsonl',
    '!abc:host.name.1.jsonl',
    '!abc:host.name.10.jsonl',
    'unrelated.jsonl',
    '!abc:host.name.current.json',  // pointer — excluded
  ];
  assert.deepEqual(orderedArchiveNames(names, ROOM), [
    '!abc:host.name.1.jsonl',
    '!abc:host.name.3.jsonl',
    '!abc:host.name.10.jsonl',
  ]);
});

test('orderedArchiveNames tolerates a null/empty listing', () => {
  assert.deepEqual(orderedArchiveNames(null, ROOM), []);
  assert.deepEqual(orderedArchiveNames([], ROOM), []);
});

test('baseRoomOfSessionFile resolves a live file to itself', () => {
  const names = ['!abc:host.name.jsonl'];
  assert.equal(baseRoomOfSessionFile('!abc:host.name.jsonl', names), '!abc:host.name');
});

test('baseRoomOfSessionFile resolves an archive to its base room (live file present)', () => {
  const names = ['!abc:host.name.jsonl', '!abc:host.name.2.jsonl'];
  assert.equal(baseRoomOfSessionFile('!abc:host.name.2.jsonl', names), '!abc:host.name');
});

test('baseRoomOfSessionFile disambiguates numeric homeserver tails via the live file', () => {
  // `!r:1.2.3.jsonl` is the LIVE file of room `!r:1.2.3` when that live file is
  // the one present — it must map to `!r:1.2.3`, not be read as seq 3 of `!r:1.2`.
  const liveSet = ['!r:1.2.3.jsonl'];
  assert.equal(baseRoomOfSessionFile('!r:1.2.3.jsonl', liveSet), '!r:1.2.3');

  // But when `!r:1.2.jsonl` exists in the same dir, `!r:1.2.3.jsonl` is that
  // room's archive seq 3.
  const archiveSet = ['!r:1.2.jsonl', '!r:1.2.3.jsonl'];
  assert.equal(baseRoomOfSessionFile('!r:1.2.3.jsonl', archiveSet), '!r:1.2');
});

test('baseRoomOfSessionFile accepts a Set for existingNames', () => {
  const set = new Set(['!abc:host.name.jsonl', '!abc:host.name.4.jsonl']);
  assert.equal(baseRoomOfSessionFile('!abc:host.name.4.jsonl', set), '!abc:host.name');
});

test('baseRoomOfSessionFile treats an orphan numeric-suffixed file as a live file', () => {
  // No `!abc:host.name.jsonl` present, so `.5.jsonl` is not an archive — its
  // stem is returned verbatim (defensive: never lose the file).
  assert.equal(baseRoomOfSessionFile('!abc:host.name.5.jsonl', []), '!abc:host.name.5');
});

test('baseRoomOfSessionFile ignores non-jsonl names', () => {
  assert.equal(baseRoomOfSessionFile('!abc:host.name.current.json', []), null);
  assert.equal(baseRoomOfSessionFile('notafile', []), null);
});
