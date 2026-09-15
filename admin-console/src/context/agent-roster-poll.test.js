import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldTickPoll, shouldRefreshOnVisible } from './agent-roster-poll.js';

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
