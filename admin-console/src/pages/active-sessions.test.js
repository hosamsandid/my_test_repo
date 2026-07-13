import test from 'node:test';
import assert from 'node:assert/strict';

import { countActiveSessions } from './active-sessions.js';

test('countActiveSessions: counts only busy entries', () => {
  const statuses = [
    { id: 'a', activityState: 'busy' },
    { id: 'b', activityState: 'idle' },
    { id: 'c', activityState: 'busy' },
    { id: 'd', activityState: 'disabled' },
    { id: 'e', activityState: 'offline' },
  ];
  assert.equal(countActiveSessions(statuses), 2);
});

test('countActiveSessions: zero when none busy', () => {
  const statuses = [
    { id: 'a', activityState: 'idle' },
    { id: 'b', activityState: 'offline' },
  ];
  assert.equal(countActiveSessions(statuses), 0);
});

test('countActiveSessions: empty/missing input returns 0', () => {
  assert.equal(countActiveSessions([]), 0);
  assert.equal(countActiveSessions(null), 0);
  assert.equal(countActiveSessions(undefined), 0);
});
