'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pruneErrors,
  recordPollError,
  clearPollFailure,
  deriveWatchHealth,
  summariseWatchHealth,
  MAX_RECENT_ERRORS,
} = require('./watch-health');

const T = (iso) => Date.parse(iso);

test('recordPollError: prepends newest-first, caps the ring, stamps lastErrorAt', () => {
  let cur = {};
  for (let i = 1; i <= MAX_RECENT_ERRORS + 3; i += 1) {
    cur = recordPollError(cur, { message: `err ${i}` }, T('2026-01-01T12:00:00Z') + i * 1000);
  }
  assert.equal(cur.recentErrors.length, MAX_RECENT_ERRORS);
  assert.equal(cur.recentErrors[0].message, `err ${MAX_RECENT_ERRORS + 3}`); // newest first
  assert.ok(cur.lastErrorAt);
});

test('recordPollError: does not mutate the input cursor', () => {
  const cur = { seen: ['x'], consecutiveFailures: 2 };
  const next = recordPollError(cur, { message: 'boom' }, T('2026-01-01T12:00:00Z'));
  assert.equal(cur.recentErrors, undefined);
  assert.deepEqual(next.seen, ['x']);
  assert.equal(next.consecutiveFailures, 2); // the caller still owns this field
});

test('pruneErrors: drops entries older than 24h and anything malformed', () => {
  const now = T('2026-01-02T12:00:00Z');
  const kept = pruneErrors([
    { at: '2026-01-02T11:00:00Z', message: 'recent' },
    { at: '2026-01-01T00:00:00Z', message: 'stale' },     // > 24h
    { at: 'garbage', message: 'bad date' },
    { at: '2026-01-02T10:00:00Z' },                        // no message
    null,
  ], now);
  assert.deepEqual(kept.map((e) => e.message), ['recent']);
});

test('clearPollFailure: resets active-failure fields, keeps the ring, drops lastErrorAt only when the ring empties', () => {
  const now = T('2026-01-02T12:00:00Z');
  const withRecent = clearPollFailure(
    { consecutiveFailures: 3, skipUntil: 'x', lastErrorAt: '2026-01-02T11:00:00Z', recentErrors: [{ at: '2026-01-02T11:00:00Z', message: 'e' }] },
    now,
  );
  assert.equal(withRecent.consecutiveFailures, 0);
  assert.equal(withRecent.skipUntil, undefined);
  assert.equal(withRecent.recentErrors.length, 1);
  assert.equal(withRecent.lastErrorAt, '2026-01-02T11:00:00Z');

  const allStale = clearPollFailure(
    { consecutiveFailures: 3, lastErrorAt: '2026-01-01T00:00:00Z', recentErrors: [{ at: '2026-01-01T00:00:00Z', message: 'old' }] },
    now,
  );
  assert.deepEqual(allStale.recentErrors, []);
  assert.equal(allStale.lastErrorAt, undefined);
});

test('deriveWatchHealth: failing / degraded / watching', () => {
  const now = T('2026-01-02T12:00:00Z');

  assert.equal(deriveWatchHealth({ consecutiveFailures: 2, skipUntil: '2026-01-02T12:05:00Z' }, now).status, 'failing');

  assert.equal(deriveWatchHealth({
    consecutiveFailures: 0,
    lastErrorAt: '2026-01-02T11:30:00Z',
    recentErrors: [{ at: '2026-01-02T11:30:00Z', message: 'blip' }],
  }, now).status, 'degraded');

  // recovered long ago → back to watching, ring aged out
  assert.equal(deriveWatchHealth({
    consecutiveFailures: 0,
    lastErrorAt: '2026-01-02T09:00:00Z',
    recentErrors: [{ at: '2026-01-02T09:00:00Z', message: 'old blip' }],
  }, now).status, 'watching');

  assert.equal(deriveWatchHealth({ seen: [], lastPolledAt: '2026-01-02T11:59:00Z' }, now).status, 'watching');
});

test('deriveWatchHealth: surfaces the detail the failure panel renders', () => {
  const now = T('2026-01-02T12:00:00Z');
  const h = deriveWatchHealth({
    consecutiveFailures: 3,
    skipUntil: '2026-01-02T12:05:00Z',
    lastPolledAt: '2026-01-02T11:40:00Z',
    seen: ['ENG-1:1'],
    recentErrors: [
      { at: '2026-01-02T11:58:00Z', message: 'Jira rejected the credential (401).' },
      { at: '2026-01-02T11:55:00Z', message: 'ETIMEDOUT' },
    ],
  }, now);
  assert.equal(h.consecutiveFailures, 3);
  assert.equal(h.skipUntil, '2026-01-02T12:05:00Z');
  assert.equal(h.seenCount, 1);
  assert.equal(h.baselined, true);
  assert.equal(h.recentErrors.length, 2);
});

test('summariseWatchHealth: counts + worst', () => {
  assert.deepEqual(
    summariseWatchHealth([{ status: 'watching' }, { status: 'watching' }, { status: 'failing' }, { status: 'degraded' }]),
    { watching: 2, degraded: 1, failing: 1, total: 4, worst: 'failing' },
  );
  assert.equal(summariseWatchHealth([{ status: 'watching' }, { status: 'degraded' }]).worst, 'degraded');
  assert.equal(summariseWatchHealth([]).worst, 'watching');
});
