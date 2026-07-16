'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROTATION_DEFAULTS,
  rotationConfig,
  archiveName,
  parseArchiveSeq,
  listArchives,
  nextArchiveSeq,
  shouldRotate,
  planPrune,
} = require('./session-rotation');

const ROOM = '!abc:host.name';

test('archiveName joins roomId + seq + .jsonl', () => {
  assert.equal(archiveName(ROOM, 1), '!abc:host.name.1.jsonl');
  assert.equal(archiveName('!r:local', 42), '!r:local.42.jsonl');
});

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
});

test('parseArchiveSeq requires the WHOLE room id to prefix-match', () => {
  // Room id whose homeserver part ends in a number.
  const room = '!r:1.2.3';
  assert.equal(parseArchiveSeq('!r:1.2.3.5.jsonl', room), 5); // archive seq 5
  assert.equal(parseArchiveSeq('!r:1.2.3.jsonl', room), null); // live file
  // A different room's archive does not match.
  assert.equal(parseArchiveSeq('!r:9.9.9.5.jsonl', room), null);
});

test('listArchives returns entries ascending by seq', () => {
  const names = [
    '!abc:host.name.jsonl',        // live — excluded
    '!abc:host.name.3.jsonl',
    '!abc:host.name.1.jsonl',
    '!abc:host.name.10.jsonl',
    'unrelated.jsonl',
    '!abc:host.name.current.json', // pointer — excluded
  ];
  assert.deepEqual(listArchives(names, ROOM).map(a => a.seq), [1, 3, 10]);
});

test('nextArchiveSeq is one past the highest, or 1 when none', () => {
  assert.equal(nextArchiveSeq([], ROOM), 1);
  assert.equal(nextArchiveSeq(['!abc:host.name.jsonl'], ROOM), 1);
  assert.equal(
    nextArchiveSeq(['!abc:host.name.1.jsonl', '!abc:host.name.7.jsonl'], ROOM),
    8,
  );
});

test('shouldRotate fires at/above the threshold only', () => {
  assert.equal(shouldRotate(7_999_999, 8_000_000), false);
  assert.equal(shouldRotate(8_000_000, 8_000_000), true);
  assert.equal(shouldRotate(9_000_000, 8_000_000), true);
  // A non-positive threshold never rotates (guarded, but be explicit).
  assert.equal(shouldRotate(9_000_000, 0), false);
});

test('planPrune drops archives beyond the newest maxCount (oldest first)', () => {
  const archives = [1, 2, 3, 4, 5, 6].map(seq => ({
    name: archiveName(ROOM, seq), seq, mtimeMs: 1_000 + seq,
  }));
  const doomed = planPrune(archives, { maxCount: 3, maxAgeMs: 0, now: 10_000 });
  assert.deepEqual(doomed, [
    archiveName(ROOM, 1),
    archiveName(ROOM, 2),
    archiveName(ROOM, 3),
  ]);
});

test('planPrune drops archives older than maxAgeMs', () => {
  const now = 1_000_000;
  const day = 24 * 60 * 60 * 1000;
  const archives = [
    { name: archiveName(ROOM, 1), seq: 1, mtimeMs: now - 40 * day }, // old
    { name: archiveName(ROOM, 2), seq: 2, mtimeMs: now - 10 * day }, // fresh
  ];
  const doomed = planPrune(archives, { maxCount: 0, maxAgeMs: 30 * day, now });
  assert.deepEqual(doomed, [archiveName(ROOM, 1)]);
});

test('planPrune unions the age and count rules without duplicates', () => {
  const now = 1_000_000;
  const day = 24 * 60 * 60 * 1000;
  const archives = [
    { name: archiveName(ROOM, 1), seq: 1, mtimeMs: now - 40 * day }, // old AND overflow
    { name: archiveName(ROOM, 2), seq: 2, mtimeMs: now - 1 * day },  // overflow only
    { name: archiveName(ROOM, 3), seq: 3, mtimeMs: now - 1 * day },  // kept
  ];
  const doomed = planPrune(archives, { maxCount: 1, maxAgeMs: 30 * day, now });
  assert.deepEqual(doomed.sort(), [archiveName(ROOM, 1), archiveName(ROOM, 2)].sort());
});

test('planPrune with both axes disabled keeps everything', () => {
  const archives = [1, 2, 3].map(seq => ({
    name: archiveName(ROOM, seq), seq, mtimeMs: 1,
  }));
  assert.deepEqual(planPrune(archives, { maxCount: 0, maxAgeMs: 0, now: 9 }), []);
});

test('rotationConfig defaults and env overrides', () => {
  assert.deepEqual(rotationConfig({}), ROTATION_DEFAULTS);
  assert.deepEqual(
    rotationConfig({
      AEE_SESSION_ROTATE_BYTES: '16000000',
      AEE_SESSION_ROTATE_KEEP: '3',
      AEE_SESSION_ROTATE_MAX_AGE_DAYS: '7',
    }),
    { maxBytes: 16_000_000, maxCount: 3, maxAgeDays: 7 },
  );
});

test('rotationConfig refuses a non-positive size cap (never disable rotation)', () => {
  assert.equal(rotationConfig({ AEE_SESSION_ROTATE_BYTES: '0' }).maxBytes,
    ROTATION_DEFAULTS.maxBytes);
  assert.equal(rotationConfig({ AEE_SESSION_ROTATE_BYTES: '-5' }).maxBytes,
    ROTATION_DEFAULTS.maxBytes);
  assert.equal(rotationConfig({ AEE_SESSION_ROTATE_BYTES: 'nonsense' }).maxBytes,
    ROTATION_DEFAULTS.maxBytes);
});

test('rotationConfig allows 0 for count/age (unbounded on that axis)', () => {
  const c = rotationConfig({ AEE_SESSION_ROTATE_KEEP: '0', AEE_SESSION_ROTATE_MAX_AGE_DAYS: '0' });
  assert.equal(c.maxCount, 0);
  assert.equal(c.maxAgeDays, 0);
});
