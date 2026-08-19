'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  entryKind,
  deriveLegacyId,
  withIds,
  removeEntryById,
  summarizeEntry,
} = require('./pending-queue');

test('entryKind classifies every queue entry shape', () => {
  assert.equal(entryKind({ github: { event: 'push' } }), 'github');
  assert.equal(entryKind({ kind: 'github-digest', events: [] }), 'github-digest');
  assert.equal(entryKind({ kind: 'throttle-warning' }), 'throttle-warning');
  assert.equal(entryKind({ kind: 'bp-event-batch' }), 'bp-event-batch');
  assert.equal(entryKind({ kind: 'session-reset', roomId: '!r:x' }), 'session-reset');
  assert.equal(entryKind({ kind: 'session-set', roomId: '!r:x' }), 'session-set');
  assert.equal(entryKind({ triggerId: 'hook-1' }), 'trigger');
  assert.equal(entryKind({}), 'unknown');
  assert.equal(entryKind(null), 'unknown');
  assert.equal(entryKind('nope'), 'unknown');
});

test('withIds keeps stamped ids and backfills legacy entries deterministically', () => {
  const entries = [
    { id: 'abc', kind: 'session-reset' },
    { github: { event: 'push', eventId: '1' } },
  ];
  const first = withIds(entries);
  const second = withIds(entries);
  assert.equal(first[0].id, 'abc');
  assert.match(first[1].id, /^legacy-[0-9a-f]{16}$/);
  // Deterministic: same input → same derived id (so a view→cancel pair agrees).
  assert.equal(first[1].id, second[1].id);
  // Inputs are not mutated.
  assert.equal(entries[1].id, undefined);
});

test('withIds gives two byte-identical legacy entries distinct ids', () => {
  const dup = { github: { event: 'issues.labeled', repo: 'o/r', eventId: '9' } };
  const out = withIds([dup, { ...dup }]);
  assert.notEqual(out[0].id, out[1].id, 'occurrence index must disambiguate duplicates');
});

test('withIds tolerates corrupt / non-array input (AC10)', () => {
  assert.deepEqual(withIds(null), []);
  assert.deepEqual(withIds('garbage'), []);
  assert.deepEqual(withIds(undefined), []);
  // A stray non-object element still gets an id and doesn't throw.
  const out = withIds([42]);
  assert.match(out[0].id, /^legacy-/);
});

test('deriveLegacyId is stable and index-sensitive', () => {
  const e = { github: { eventId: '7' } };
  assert.equal(deriveLegacyId(e, 0), deriveLegacyId(e, 0));
  assert.notEqual(deriveLegacyId(e, 0), deriveLegacyId(e, 1));
});

test('removeEntryById removes one entry and preserves the rest in order (AC5)', () => {
  const entries = [
    { id: 'a', kind: 'session-reset' },
    { id: 'b', kind: 'throttle-warning' },
    { id: 'c', kind: 'session-set' },
  ];
  const { entries: next, removed, changed } = removeEntryById(entries, 'b');
  assert.equal(changed, true);
  assert.equal(removed.id, 'b');
  assert.deepEqual(next.map((e) => e.id), ['a', 'c']);
});

test('removeEntryById no-ops for an unknown id (AC7)', () => {
  const entries = [{ id: 'a' }, { id: 'b' }];
  const { entries: next, removed, changed } = removeEntryById(entries, 'zzz');
  assert.equal(changed, false);
  assert.equal(removed, null);
  assert.deepEqual(next.map((e) => e.id), ['a', 'b']);
});

test('removeEntryById can address and remove a legacy (un-stamped) entry', () => {
  const legacy = [{ github: { event: 'push', eventId: '1' } }, { kind: 'session-reset' }];
  const derivedId = withIds(legacy)[0].id;
  const { removed, changed, entries } = removeEntryById(legacy, derivedId);
  assert.equal(changed, true);
  assert.equal(removed.id, derivedId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'session-reset');
});

test('removeEntryById clearing the last entry yields a valid empty queue (AC8)', () => {
  const { entries: next, changed } = removeEntryById([{ id: 'only' }], 'only');
  assert.equal(changed, true);
  assert.deepEqual(next, []);
});

test('summarizeEntry exposes GitHub fields and omits the payload (AC4)', () => {
  const s = summarizeEntry({
    id: 'x', receivedAt: '2026-07-17T00:00:00Z', triggerId: 't1',
    github: { event: 'pull_request.opened', repo: 'o/r', actor: 'alice', eventId: '42', payload: { huge: 'x'.repeat(1000) } },
  });
  assert.equal(s.kind, 'github');
  assert.equal(s.event, 'pull_request.opened');
  assert.equal(s.repo, 'o/r');
  assert.equal(s.actor, 'alice');
  assert.equal(s.eventId, '42');
  assert.equal(s.triggerId, 't1');
  assert.equal('payload' in s, false, 'payload must never appear in the summary');
});

test('summarizeEntry lifts the label name for a *.labeled event, still omitting the payload (#1649)', () => {
  const s = summarizeEntry({
    id: 'x', receivedAt: '2026-08-12T00:00:00Z',
    github: {
      event: 'issues.labeled', repo: 'o/r', actor: 'alice', eventId: '9',
      payload: { label: { name: 'ready-2' }, issue: { number: 1 } },
    },
  });
  assert.equal(s.event, 'issues.labeled');
  assert.equal(s.label, 'ready-2');
  assert.equal('payload' in s, false, 'payload must never appear in the summary');
});

test('summarizeEntry omits label for a non-label github event (AC2/AC3)', () => {
  const s = summarizeEntry({
    id: 'y', github: { event: 'pull_request.opened', repo: 'o/r', eventId: '42', payload: { pull_request: {} } },
  });
  assert.equal('label' in s, false, 'no empty label artifact on a non-label event');
});

test('summarizeEntry degrades gracefully on a malformed payload.label', () => {
  const s = summarizeEntry({
    id: 'z', github: { event: 'issues.labeled', eventId: '3', payload: { label: {} } },
  });
  assert.equal('label' in s, false);
});

test('summarizeEntry surfaces per-kind hints for non-GitHub entries', () => {
  assert.equal(summarizeEntry({ id: 'd', kind: 'github-digest', count: 5, convKey: 'pr:1' }).count, 5);
  assert.equal(summarizeEntry({ id: 'd', kind: 'github-digest', events: [1, 2] }).count, 2);
  assert.equal(summarizeEntry({ id: 's', kind: 'session-set', roomId: '!r:x' }).roomId, '!r:x');
  assert.equal(summarizeEntry({ id: 'w', kind: 'throttle-warning', convKey: 'push:main' }).convKey, 'push:main');
});
