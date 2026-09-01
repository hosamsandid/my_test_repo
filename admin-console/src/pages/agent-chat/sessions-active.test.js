import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionsFromResponse,
  activeSessionCount,
  isAgentRunning,
  removeSession,
  hasActiveTriggerSessionForRoom,
} from './sessions-active.js';

test('sessionsFromResponse returns the sessions array', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(sessionsFromResponse({ sessions }), sessions);
});

test('sessionsFromResponse collapses non-array / missing / error bodies to []', () => {
  assert.deepEqual(sessionsFromResponse(null), []);
  assert.deepEqual(sessionsFromResponse(undefined), []);
  assert.deepEqual(sessionsFromResponse({}), []);
  assert.deepEqual(sessionsFromResponse({ sessions: null }), []);
  assert.deepEqual(sessionsFromResponse({ sessions: 'nope' }), []);
  assert.deepEqual(sessionsFromResponse({ error: 'boom' }), []);
});

test('activeSessionCount counts sessions and tolerates non-arrays', () => {
  assert.equal(activeSessionCount([{ id: 'a' }, { id: 'b' }]), 2);
  assert.equal(activeSessionCount([]), 0);
  assert.equal(activeSessionCount(null), 0);
  assert.equal(activeSessionCount(undefined), 0);
});

test('isAgentRunning is true iff there is at least one session', () => {
  assert.equal(isAgentRunning([{ id: 'a' }]), true);
  assert.equal(isAgentRunning([]), false);
  assert.equal(isAgentRunning(null), false);
});

test('removeSession drops the matching id and returns a new array', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const next = removeSession(sessions, 'b');
  assert.deepEqual(next.map((s) => s.id), ['a', 'c']);
  // input untouched (immutability)
  assert.deepEqual(sessions.map((s) => s.id), ['a', 'b', 'c']);
  assert.notEqual(next, sessions);
});

test('removeSession is a no-op for an absent id', () => {
  const sessions = [{ id: 'a' }];
  assert.deepEqual(removeSession(sessions, 'zzz').map((s) => s.id), ['a']);
});

test('removeSession tolerates a non-array', () => {
  assert.deepEqual(removeSession(null, 'a'), []);
});

// hasActiveTriggerSessionForRoom
test('hasActiveTriggerSessionForRoom returns true when a trigger session matches the room', () => {
  const sessions = [
    { id: '1', type: 'trigger', roomId: '!abc:local' },
    { id: '2', type: 'dm',      roomId: '!abc:local' },
  ];
  assert.equal(hasActiveTriggerSessionForRoom(sessions, '!abc:local'), true);
});

test('hasActiveTriggerSessionForRoom returns false when type is not trigger', () => {
  const sessions = [{ id: '1', type: 'dm', roomId: '!abc:local' }];
  assert.equal(hasActiveTriggerSessionForRoom(sessions, '!abc:local'), false);
});

test('hasActiveTriggerSessionForRoom returns false when roomId differs', () => {
  const sessions = [{ id: '1', type: 'trigger', roomId: '!other:local' }];
  assert.equal(hasActiveTriggerSessionForRoom(sessions, '!abc:local'), false);
});

test('hasActiveTriggerSessionForRoom returns false on empty sessions', () => {
  assert.equal(hasActiveTriggerSessionForRoom([], '!abc:local'), false);
});

test('hasActiveTriggerSessionForRoom returns false on null/missing args', () => {
  assert.equal(hasActiveTriggerSessionForRoom(null, '!abc:local'), false);
  assert.equal(hasActiveTriggerSessionForRoom(undefined, '!abc:local'), false);
  assert.equal(hasActiveTriggerSessionForRoom([{ id: '1', type: 'trigger', roomId: '!abc:local' }], null), false);
  assert.equal(hasActiveTriggerSessionForRoom([{ id: '1', type: 'trigger', roomId: '!abc:local' }], ''), false);
});

test('hasActiveTriggerSessionForRoom handles concurrent runs with different rooms', () => {
  const sessions = [
    { id: '1', type: 'trigger', roomId: '!room1:local' },
    { id: '2', type: 'trigger', roomId: '!room2:local' },
  ];
  assert.equal(hasActiveTriggerSessionForRoom(sessions, '!room1:local'), true);
  assert.equal(hasActiveTriggerSessionForRoom(sessions, '!room2:local'), true);
  assert.equal(hasActiveTriggerSessionForRoom(sessions, '!room3:local'), false);
});
