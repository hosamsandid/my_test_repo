import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  DEFAULT_FONT_SIZE,
  clampFontSize,
  stepFontSize,
  canIncrease,
  canDecrease,
  resolveInitialFontSize,
  storageKey,
  loadStoredFontSize,
  saveStoredFontSize,
} from './chat-font-size.js';

// A minimal localStorage stand-in.
function makeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

test('range constants match the issue (10–18px, default 12)', () => {
  assert.equal(MIN_FONT_SIZE, 10);
  assert.equal(MAX_FONT_SIZE, 18);
  assert.equal(DEFAULT_FONT_SIZE, 12);
});

test('clampFontSize coerces, rounds and clamps to [10,18]', () => {
  assert.equal(clampFontSize(12), 12);
  assert.equal(clampFontSize('14'), 14);
  assert.equal(clampFontSize(9), 10);   // below floor
  assert.equal(clampFontSize(99), 18);  // above ceiling
  assert.equal(clampFontSize(12.6), 13); // rounds
  assert.equal(clampFontSize('nope'), DEFAULT_FONT_SIZE);
  assert.equal(clampFontSize(undefined), DEFAULT_FONT_SIZE);
  assert.equal(clampFontSize(null), DEFAULT_FONT_SIZE);
  assert.equal(clampFontSize(NaN), DEFAULT_FONT_SIZE);
});

test('stepFontSize steps and clamps at both ends', () => {
  assert.equal(stepFontSize(12, 1), 13);
  assert.equal(stepFontSize(12, -1), 11);
  assert.equal(stepFontSize(18, 1), 18);   // clamped at ceiling
  assert.equal(stepFontSize(10, -1), 10);  // clamped at floor
  assert.equal(stepFontSize('bad', 1), DEFAULT_FONT_SIZE + 1);
});

test('canIncrease / canDecrease gate the +/- buttons', () => {
  assert.equal(canIncrease(17), true);
  assert.equal(canIncrease(18), false);
  assert.equal(canDecrease(11), true);
  assert.equal(canDecrease(10), false);
});

test('resolveInitialFontSize prefers the server value for a user WITH a record', () => {
  assert.equal(
    resolveInitialFontSize({ sessionValue: 16, storedValue: 14, hasServerRecord: true }),
    16,
  );
  // Server default (12) with no local override → 12.
  assert.equal(
    resolveInitialFontSize({ sessionValue: 12, storedValue: null, hasServerRecord: true }),
    12,
  );
});

test('resolveInitialFontSize prefers the local value for a principal WITHOUT a record (env admin)', () => {
  // Env admin: the session always reports the 12px default; the local override wins.
  assert.equal(
    resolveInitialFontSize({ sessionValue: 12, storedValue: 16, hasServerRecord: false }),
    16,
  );
  // No local override → default.
  assert.equal(
    resolveInitialFontSize({ sessionValue: 12, storedValue: null, hasServerRecord: false }),
    12,
  );
});

test('resolveInitialFontSize falls back to default with nothing usable', () => {
  assert.equal(
    resolveInitialFontSize({ sessionValue: undefined, storedValue: null, hasServerRecord: false }),
    DEFAULT_FONT_SIZE,
  );
  // Out-of-range stored value is clamped, not rejected.
  assert.equal(
    resolveInitialFontSize({ sessionValue: undefined, storedValue: 99, hasServerRecord: false }),
    MAX_FONT_SIZE,
  );
});

test('storageKey is per-username', () => {
  assert.equal(storageKey('alice'), 'agentChat.fontSize.alice');
  assert.equal(storageKey('admin'), 'agentChat.fontSize.admin');
  assert.equal(storageKey(undefined), 'agentChat.fontSize.anon');
  // Two users on one browser get distinct keys → no cross-user leak.
  assert.notEqual(storageKey('alice'), storageKey('bob'));
});

test('save + load round-trips through the store', () => {
  const store = makeStore();
  saveStoredFontSize('alice', 16, store);
  assert.equal(store.getItem('agentChat.fontSize.alice'), '16');
  assert.equal(loadStoredFontSize('alice', store), 16);
  // Unset → null so the caller falls through to session/default.
  assert.equal(loadStoredFontSize('bob', store), null);
});

test('loadStoredFontSize clamps a stale out-of-range value', () => {
  const store = makeStore({ 'agentChat.fontSize.alice': '99' });
  assert.equal(loadStoredFontSize('alice', store), 18);
});

test('loadStoredFontSize returns null on a non-numeric stored value', () => {
  const store = makeStore({ 'agentChat.fontSize.alice': 'garbage' });
  assert.equal(loadStoredFontSize('alice', store), null);
});

test('save is best-effort — a throwing store does not blow up', () => {
  const throwing = { setItem: () => { throw new Error('quota'); }, getItem: () => null };
  assert.doesNotThrow(() => saveStoredFontSize('alice', 14, throwing));
  assert.equal(loadStoredFontSize('alice', throwing), null);
});
