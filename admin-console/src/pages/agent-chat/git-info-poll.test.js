import test from 'node:test';
import assert from 'node:assert/strict';
import { gitInfoPollArmed } from './git-info-poll.js';

test('#2923: no agent → never armed', () => {
  assert.equal(gitInfoPollArmed({ agentId: null, roomId: '!r', historyLoadedFor: '!r' }), false);
});

test('#2923: waits for the open room\'s history before polling git-info', () => {
  const base = { agentId: 'a', agentEnabled: true, roomId: '!r' };
  assert.equal(gitInfoPollArmed({ ...base, historyLoadedFor: null }), false);
  assert.equal(gitInfoPollArmed({ ...base, historyLoadedFor: '!other' }), false, 'previous chat\'s history does not count');
  assert.equal(gitInfoPollArmed({ ...base, historyLoadedFor: '!r' }), true);
});

test('#2923: an enabled agent still creating its DM is not armed yet', () => {
  assert.equal(gitInfoPollArmed({ agentId: 'a', agentEnabled: true, roomId: null, historyLoadedFor: null }), false);
  assert.equal(gitInfoPollArmed({ agentId: 'a', roomId: null, historyLoadedFor: null }), false);
});

test('#2923: a disabled agent without a room has no history to wait for', () => {
  assert.equal(gitInfoPollArmed({ agentId: 'a', agentEnabled: false, roomId: null, historyLoadedFor: null }), true);
});
