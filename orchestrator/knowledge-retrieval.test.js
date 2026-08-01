'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RETRIEVAL_SOURCES, validateRetrieval, applyRetrieval, lastUsedAt } = require('./knowledge-retrieval');

const NOW = '2026-08-01T12:00:00Z';

test('validateRetrieval: accepts search/digest with hex ids, stamps server clock when ts is unusable', () => {
  const ok = validateRetrieval({ source: 'search', entryIds: ['a'.repeat(12), 'a'.repeat(12), 'b'.repeat(12)], ts: '2026-08-01T11:00:00Z' }, { now: NOW });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.entryIds, ['a'.repeat(12), 'b'.repeat(12)]); // deduped
  assert.equal(ok.ts, '2026-08-01T11:00:00Z');
  const stamped = validateRetrieval({ source: 'digest', entryIds: ['c'.repeat(12)], ts: 'garbage' }, { now: NOW });
  assert.equal(stamped.ok, true);
  assert.equal(stamped.ts, NOW);
});

test('validateRetrieval: rejects unknown source, empty/malformed ids, missing clock', () => {
  assert.equal(validateRetrieval({ source: 'scoped', entryIds: ['a'.repeat(12)] }, { now: NOW }).ok, false); // #917 adds it later
  assert.equal(validateRetrieval({ source: 'search', entryIds: [] }, { now: NOW }).ok, false);
  assert.equal(validateRetrieval({ source: 'search', entryIds: ['not-hex'] }, { now: NOW }).ok, false);
  assert.equal(validateRetrieval({ source: 'search', entryIds: ['a'.repeat(12)] }, {}).ok, false);
  assert.equal(validateRetrieval(null, { now: NOW }).ok, false);
  assert.deepEqual(RETRIEVAL_SOURCES, ['search', 'digest']);
});

test('applyRetrieval: search and digest update their own fields; since is first-write-stable', () => {
  const s1 = applyRetrieval({}, { source: 'search', entryIds: ['a'.repeat(12)], ts: '2026-08-01T10:00:00Z' });
  assert.equal(s1.since, '2026-08-01T10:00:00Z');
  assert.deepEqual(s1.entries['a'.repeat(12)], { lastSearchAt: '2026-08-01T10:00:00Z', searchHits: 1 });
  const s2 = applyRetrieval(s1, { source: 'digest', entryIds: ['a'.repeat(12), 'b'.repeat(12)], ts: NOW });
  assert.equal(s2.since, '2026-08-01T10:00:00Z'); // baseline preserved
  assert.deepEqual(s2.entries['a'.repeat(12)], {
    lastSearchAt: '2026-08-01T10:00:00Z', searchHits: 1, lastDigestAt: NOW, digestCount: 1,
  });
  assert.deepEqual(s2.entries['b'.repeat(12)], { lastDigestAt: NOW, digestCount: 1 });
  const s3 = applyRetrieval(s2, { source: 'search', entryIds: ['a'.repeat(12)], ts: '2026-08-02T09:00:00Z' });
  assert.equal(s3.entries['a'.repeat(12)].searchHits, 2);
  assert.equal(s3.entries['a'.repeat(12)].lastSearchAt, '2026-08-02T09:00:00Z');
  // pure: inputs untouched
  assert.equal(s2.entries['a'.repeat(12)].searchHits, 1);
});

test('applyRetrieval: tolerates a mangled prior aggregate (counters restart, never throw)', () => {
  const s = applyRetrieval({ since: 42, entries: { ['a'.repeat(12)]: { searchHits: 'NaN' } } },
    { source: 'search', entryIds: ['a'.repeat(12)], ts: NOW });
  assert.equal(s.entries['a'.repeat(12)].searchHits, 1);
  assert.equal(s.since, NOW);
});

test('lastUsedAt: freshest of both signals, null when never retrieved', () => {
  assert.equal(lastUsedAt({ lastSearchAt: '2026-08-01T10:00:00Z', lastDigestAt: '2026-08-01T11:00:00Z' }), '2026-08-01T11:00:00Z');
  assert.equal(lastUsedAt({ lastSearchAt: '2026-08-01T10:00:00Z' }), '2026-08-01T10:00:00Z');
  assert.equal(lastUsedAt({}), null);
  assert.equal(lastUsedAt(null), null);
});
