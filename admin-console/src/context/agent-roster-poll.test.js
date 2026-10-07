import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldTickPoll, shouldRefreshOnVisible, isStaleRosterResponse, nextSnapshotStaleSince,
} from './agent-roster-poll.js';

test('shouldTickPoll: fires while visible', () => {
  assert.equal(shouldTickPoll(false), true);
});

test('shouldTickPoll: is suppressed while the tab is hidden', () => {
  assert.equal(shouldTickPoll(true), false);
});

test('shouldRefreshOnVisible: hidden -> visible triggers an immediate refresh', () => {
  assert.equal(shouldRefreshOnVisible(true, false), true);
});

test('shouldRefreshOnVisible: visible -> hidden does not', () => {
  assert.equal(shouldRefreshOnVisible(false, true), false);
});

test('shouldRefreshOnVisible: visible -> visible (no-op event) does not', () => {
  assert.equal(shouldRefreshOnVisible(false, false), false);
});

test('shouldRefreshOnVisible: hidden -> hidden (no-op event) does not', () => {
  assert.equal(shouldRefreshOnVisible(true, true), false);
});

// A realistic sequence: visible at start, tab hidden, several ticks skipped
// while hidden, then the tab comes back and one immediate refresh fires on
// top of the resumed interval.
test('a hide/show sequence pauses ticks and refreshes exactly once on return', () => {
  let hidden = false;
  const actions = [];

  function tick() {
    if (shouldTickPoll(hidden)) actions.push('tick-poll');
  }
  function visibilityChange(nextHidden) {
    const prevHidden = hidden;
    hidden = nextHidden;
    if (shouldRefreshOnVisible(prevHidden, nextHidden)) actions.push('visible-refresh');
  }

  tick(); // visible: polls
  visibilityChange(true); // tab hidden: no refresh fired for hiding
  tick(); // hidden: skipped
  tick(); // hidden: skipped
  visibilityChange(false); // tab visible again: one immediate refresh
  tick(); // visible again: polls

  assert.deepEqual(actions, ['tick-poll', 'visible-refresh', 'tick-poll']);
});

test('#2705 isStaleRosterResponse: an older request landing after a newer one is dropped', () => {
  // poll #1 leaves before a Materialize, refetch #2 after it; #2 lands first.
  assert.equal(isStaleRosterResponse(1, 2), true);
  assert.equal(isStaleRosterResponse(3, 2), false);
  assert.equal(isStaleRosterResponse(1, 0), false, 'the first response is always applied');
});

test('#566 nextSnapshotStaleSince: hiding ages the snapshot, a fetch landing in a visible tab refreshes it', () => {
  assert.equal(nextSnapshotStaleSince(null, 'hidden', true, 100), 100);
  assert.equal(nextSnapshotStaleSince(100, 'landed', false, 200), null);
  assert.equal(nextSnapshotStaleSince(null, 'landed', true, 300), 300, 'landed while still hidden: it ages from the landing');
  assert.equal(nextSnapshotStaleSince(100, 'landed', true, 300), 300, 'a hidden landing is newer data than the hide');
  assert.equal(nextSnapshotStaleSince(100, 'other', false, 400), 100, 'an unknown event changes nothing');
});

test('#566 nextSnapshotStaleSince: re-hiding before the refresh lands keeps the older freshness moment', () => {
  let since = nextSnapshotStaleSince(null, 'landed', false, 0); // first load, visible
  assert.equal(since, null);
  since = nextSnapshotStaleSince(since, 'hidden', true, 1_000);
  assert.equal(since, 1_000, 'while hidden');
  // Visible again, then hidden again before the refresh settles: the data is
  // still the 1 000 ms snapshot, so it must not be re-stamped 5 000.
  since = nextSnapshotStaleSince(since, 'hidden', true, 5_000);
  assert.equal(since, 1_000);
  since = nextSnapshotStaleSince(since, 'landed', false, 6_000);
  assert.equal(since, null);
});
