import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coachmarkKey,
  hasSeenCoachmark,
  markCoachmarkSeen,
  HOVER_CORRELATION_COACHMARK,
} from './coachmark.js';

// A minimal injectable localStorage stand-in.
function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

test('coachmarkKey is per-user and per-id', () => {
  assert.equal(
    coachmarkKey('sessions-hover-correlation', 'alice'),
    'agentChat.coachmark.sessions-hover-correlation.alice',
  );
  // Two users get distinct keys → no cross-user leakage on a shared browser.
  assert.notEqual(
    coachmarkKey(HOVER_CORRELATION_COACHMARK, 'alice'),
    coachmarkKey(HOVER_CORRELATION_COACHMARK, 'bob'),
  );
});

test('coachmarkKey falls back to an anon bucket without a username', () => {
  assert.equal(
    coachmarkKey(HOVER_CORRELATION_COACHMARK, null),
    'agentChat.coachmark.sessions-hover-correlation.anon',
  );
  assert.equal(
    coachmarkKey(HOVER_CORRELATION_COACHMARK, undefined),
    'agentChat.coachmark.sessions-hover-correlation.anon',
  );
});

test('a fresh user has not seen the coachmark', () => {
  const store = fakeStore();
  assert.equal(hasSeenCoachmark(HOVER_CORRELATION_COACHMARK, 'alice', store), false);
});

test('marking seen makes hasSeen return true across "sessions"', () => {
  const store = fakeStore();
  markCoachmarkSeen(HOVER_CORRELATION_COACHMARK, 'alice', store);
  // A brand-new read (simulating a later session) sees the persisted flag.
  assert.equal(hasSeenCoachmark(HOVER_CORRELATION_COACHMARK, 'alice', store), true);
});

test("one user's dismissal does not affect another user", () => {
  const store = fakeStore();
  markCoachmarkSeen(HOVER_CORRELATION_COACHMARK, 'alice', store);
  assert.equal(hasSeenCoachmark(HOVER_CORRELATION_COACHMARK, 'alice', store), true);
  assert.equal(hasSeenCoachmark(HOVER_CORRELATION_COACHMARK, 'bob', store), false);
});

test('a non-"seen" stored value is treated as not seen', () => {
  const store = fakeStore({
    [coachmarkKey(HOVER_CORRELATION_COACHMARK, 'alice')]: 'something-else',
  });
  assert.equal(hasSeenCoachmark(HOVER_CORRELATION_COACHMARK, 'alice', store), false);
});

test('missing store degrades gracefully (not seen, no throw)', () => {
  assert.equal(hasSeenCoachmark(HOVER_CORRELATION_COACHMARK, 'alice', null), false);
  assert.doesNotThrow(() => markCoachmarkSeen(HOVER_CORRELATION_COACHMARK, 'alice', null));
});

test('a throwing store is swallowed on both read and write', () => {
  const throwing = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  assert.equal(hasSeenCoachmark(HOVER_CORRELATION_COACHMARK, 'alice', throwing), false);
  assert.doesNotThrow(() => markCoachmarkSeen(HOVER_CORRELATION_COACHMARK, 'alice', throwing));
});
