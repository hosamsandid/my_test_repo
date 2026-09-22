import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  notifyStorageKey,
  loadStoredNotifyEnabled,
  saveStoredNotifyEnabled,
  resolveInitialNotifyEnabled,
  notificationsSupported,
  getNotificationPermission,
  requestNotificationPermission,
  computeBackNotifications,
  selectUnnotified,
  notificationTitleFor,
  notificationTagFor,
  isConsoleInForeground,
} from './agent-back-notification.js';

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

// ── preference store ─────────────────────────────────────────────────────────

test('storage key is per-username', () => {
  assert.equal(notifyStorageKey('alice'), 'agentChat.notifyOnBack.alice');
  assert.equal(notifyStorageKey(''), 'agentChat.notifyOnBack.anon');
  assert.equal(notifyStorageKey(undefined), 'agentChat.notifyOnBack.anon');
});

test('load/save round-trips a boolean; unset reads null', () => {
  const store = makeStore();
  assert.equal(loadStoredNotifyEnabled('alice', store), null);
  saveStoredNotifyEnabled('alice', true, store);
  assert.equal(loadStoredNotifyEnabled('alice', store), true);
  saveStoredNotifyEnabled('alice', false, store);
  assert.equal(loadStoredNotifyEnabled('alice', store), false);
  // A different user is isolated.
  assert.equal(loadStoredNotifyEnabled('bob', store), null);
});

test('resolveInitialNotifyEnabled: server record trusts session value', () => {
  assert.equal(resolveInitialNotifyEnabled({ sessionValue: true, storedValue: false, hasServerRecord: true }), true);
  assert.equal(resolveInitialNotifyEnabled({ sessionValue: false, storedValue: true, hasServerRecord: true }), false);
});

test('resolveInitialNotifyEnabled: no server record prefers local, else session, else off', () => {
  assert.equal(resolveInitialNotifyEnabled({ sessionValue: false, storedValue: true, hasServerRecord: false }), true);
  assert.equal(resolveInitialNotifyEnabled({ sessionValue: true, storedValue: null, hasServerRecord: false }), true);
  assert.equal(resolveInitialNotifyEnabled({ sessionValue: undefined, storedValue: null, hasServerRecord: false }), false);
  assert.equal(resolveInitialNotifyEnabled({}), false);
});

// ── permission wrappers ──────────────────────────────────────────────────────

test('notificationsSupported / getNotificationPermission reflect the Notification API', () => {
  assert.equal(notificationsSupported({}), false);
  assert.equal(getNotificationPermission({}), 'unsupported');
  const win = { Notification: { permission: 'granted' } };
  assert.equal(notificationsSupported(win), true);
  assert.equal(getNotificationPermission(win), 'granted');
});

test('requestNotificationPermission resolves the promise form', async () => {
  const win = { Notification: { permission: 'default', requestPermission: () => Promise.resolve('granted') } };
  assert.equal(await requestNotificationPermission(win), 'granted');
});

test('requestNotificationPermission tolerates the legacy callback form', async () => {
  const win = {
    Notification: {
      permission: 'granted',
      requestPermission: (cb) => { cb('granted'); /* returns undefined (legacy) */ },
    },
  };
  assert.equal(await requestNotificationPermission(win), 'granted');
});

test('requestNotificationPermission returns unsupported when the API is absent', async () => {
  assert.equal(await requestNotificationPermission({}), 'unsupported');
});

// ── turn-completion detection ────────────────────────────────────────────────

const messaged = new Set(['a']);

test('AC1: busy→done with a newer response, for a messaged agent, is a candidate', () => {
  const prev = [{ id: 'a', activityState: 'busy', lastResponseAt: 100, displayName: 'Alpha' }];
  const next = [{ id: 'a', activityState: 'idle', lastResponseAt: 200, displayName: 'Alpha' }];
  const out = computeBackNotifications(prev, next, { manuallyMessaged: messaged });
  assert.deepEqual(out, [{ id: 'a', displayName: 'Alpha', lastResponseAt: 200 }]);
});

test('AC5/AC6: an agent not manually messaged is never a candidate', () => {
  const prev = [{ id: 'b', activityState: 'busy', lastResponseAt: 100 }];
  const next = [{ id: 'b', activityState: 'idle', lastResponseAt: 200 }];
  assert.deepEqual(computeBackNotifications(prev, next, { manuallyMessaged: messaged }), []);
  // With no messaged set at all, nothing fires.
  assert.deepEqual(computeBackNotifications(prev, next, {}), []);
});

test('no baseline (agent unseen in prev poll) never fires', () => {
  const next = [{ id: 'a', activityState: 'idle', lastResponseAt: 200 }];
  assert.deepEqual(computeBackNotifications([], next, { manuallyMessaged: messaged }), []);
});

test('AC3: a completion caught across a coarse (throttled) poll — idle→idle with a newer response, no busy sample — still fires', () => {
  // A backgrounded tab throttles the poll to ~1/min, so a whole busy→done turn
  // can complete between two polls and the transient busy state is never sampled.
  // Anchoring on "lastResponseAt advanced while now idle" catches it anyway.
  const prev = [{ id: 'a', activityState: 'idle', lastResponseAt: 100, displayName: 'Alpha' }];
  const next = [{ id: 'a', activityState: 'idle', lastResponseAt: 200, displayName: 'Alpha' }];
  assert.deepEqual(
    computeBackNotifications(prev, next, { manuallyMessaged: messaged }),
    [{ id: 'a', displayName: 'Alpha', lastResponseAt: 200 }],
  );
});

test('edge: busy→offline / busy→disabled (ended with no user response) do not fire', () => {
  const prevOff = [{ id: 'a', activityState: 'busy', lastResponseAt: 100 }];
  assert.deepEqual(
    computeBackNotifications(prevOff, [{ id: 'a', activityState: 'offline', lastResponseAt: 100 }], { manuallyMessaged: messaged }),
    [],
  );
  assert.deepEqual(
    computeBackNotifications(prevOff, [{ id: 'a', activityState: 'disabled', lastResponseAt: 100 }], { manuallyMessaged: messaged }),
    [],
  );
});

test('edge: busy→done with an unchanged lastResponseAt (no genuine response) does not fire', () => {
  const prev = [{ id: 'a', activityState: 'busy', lastResponseAt: 100 }];
  const next = [{ id: 'a', activityState: 'idle', lastResponseAt: 100 }];
  assert.deepEqual(computeBackNotifications(prev, next, { manuallyMessaged: messaged }), []);
});

test('AC9: multiple qualifying agents each produce a candidate', () => {
  const many = new Set(['a', 'c']);
  const prev = [
    { id: 'a', activityState: 'busy', lastResponseAt: 1 },
    { id: 'c', activityState: 'busy', lastResponseAt: 1 },
  ];
  const next = [
    { id: 'a', activityState: 'idle', lastResponseAt: 2, displayName: 'Alpha' },
    { id: 'c', activityState: 'active', lastResponseAt: 2, displayName: 'Gamma' },
  ];
  const out = computeBackNotifications(prev, next, { manuallyMessaged: many });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(o => o.id).sort(), ['a', 'c']);
});

test('ISO-string lastResponseAt timestamps are compared correctly', () => {
  const prev = [{ id: 'a', activityState: 'busy', lastResponseAt: '2026-01-01T00:00:00Z' }];
  const next = [{ id: 'a', activityState: 'idle', lastResponseAt: '2026-01-01T00:01:00Z' }];
  assert.equal(computeBackNotifications(prev, next, { manuallyMessaged: messaged }).length, 1);
});

// ── per-turn dedupe ──────────────────────────────────────────────────────────

test('selectUnnotified fires once per turn and records the key', () => {
  const c = [{ id: 'a', displayName: 'Alpha', lastResponseAt: 200 }];
  const first = selectUnnotified(c, {});
  assert.equal(first.toFire.length, 1);
  assert.equal(first.notified.a, '200');
  // The same turn again is suppressed (flapping busy↔done edge case).
  const second = selectUnnotified(c, first.notified);
  assert.equal(second.toFire.length, 0);
  // A later turn for the same agent fires again (no permanent suppression).
  const third = selectUnnotified([{ id: 'a', lastResponseAt: 300 }], second.notified);
  assert.equal(third.toFire.length, 1);
  assert.equal(third.notified.a, '300');
});

// ── presentation ─────────────────────────────────────────────────────────────

test('notificationTitleFor uses the display name, no body content', () => {
  assert.equal(notificationTitleFor('Alpha'), 'Alpha is back');
  assert.equal(notificationTitleFor(''), 'Agent is back');
  assert.equal(notificationTitleFor(undefined), 'Agent is back');
});

test('notificationTagFor is stable per agent so a new turn replaces the popup', () => {
  assert.equal(notificationTagFor('a'), 'aee-agent-back-a');
});

// ── foreground gate (#2409 AC1/AC2) ──────────────────────────────────────────

test('isConsoleInForeground: only visible AND focused counts as foreground', () => {
  // AC1 baseline: a hidden tab is away regardless of focus.
  assert.equal(isConsoleInForeground({ visibilityState: 'hidden', hasFocus: () => true }), false);
  // AC2: visible but the window lost OS focus (another app/monitor) is away.
  assert.equal(isConsoleInForeground({ visibilityState: 'visible', hasFocus: () => false }), false);
  // Being looked at: visible and focused.
  assert.equal(isConsoleInForeground({ visibilityState: 'visible', hasFocus: () => true }), true);
});

test('isConsoleInForeground: a missing signal falls back to the other, missing doc is "away"', () => {
  // No hasFocus → fall back to visibility only (visible ⇒ foreground).
  assert.equal(isConsoleInForeground({ visibilityState: 'visible' }), true);
  // No visibilityState → fall back to focus only.
  assert.equal(isConsoleInForeground({ hasFocus: () => false }), false);
  assert.equal(isConsoleInForeground({ hasFocus: () => true }), true);
  // No document at all → treat as away (allow firing) rather than throw.
  assert.equal(isConsoleInForeground(null), false);
});
