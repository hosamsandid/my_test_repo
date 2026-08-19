import test from 'node:test';
import assert from 'node:assert/strict';

import { computeChatCounts, computeAgentStatusMap } from './agent-statuses.js';

test('computeChatCounts: counts busy and unread, skips disabled/offline', () => {
  const list = [
    { id: 'a', activityState: 'busy', lastResponseAt: null },
    { id: 'b', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z' }, // unread (never viewed)
    { id: 'c', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z' }, // viewed after → not unread
    { id: 'd', activityState: 'disabled', lastResponseAt: '2026-01-01T00:00:10Z' },
    { id: 'e', activityState: 'offline', lastResponseAt: '2026-01-01T00:00:10Z' },
  ];
  const viewed = { c: Date.parse('2026-01-01T00:00:20Z') };
  assert.deepEqual(computeChatCounts(list, viewed), { busy: 1, unread: 1 });
});

test('computeChatCounts: an idle agent that never responded is not unread', () => {
  const list = [{ id: 'a', activityState: 'idle', lastResponseAt: null }];
  assert.deepEqual(computeChatCounts(list, {}), { busy: 0, unread: 0 });
});

test('computeChatCounts: tolerates non-array / missing viewed', () => {
  assert.deepEqual(computeChatCounts(null, null), { busy: 0, unread: 0 });
  assert.deepEqual(computeChatCounts(undefined), { busy: 0, unread: 0 });
});

test('computeAgentStatusMap: precedence disabled > offline > busy > unread', () => {
  const list = [
    { id: 'a', activityState: 'disabled', lastResponseAt: '2026-01-01T00:00:10Z' },
    { id: 'b', activityState: 'offline', lastResponseAt: '2026-01-01T00:00:10Z' },
    { id: 'c', activityState: 'busy' },
    { id: 'd', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z' }, // unread
  ];
  assert.deepEqual(computeAgentStatusMap(list, {}), {
    a: 'disabled', b: 'offline', c: 'busy', d: 'unread',
  });
});

test('computeAgentStatusMap: active when it has a session or has responded but is viewed', () => {
  const viewed = { d: Date.parse('2026-01-01T00:00:20Z'), e: Date.parse('2026-01-01T00:00:20Z') };
  const list = [
    { id: 'd', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z', hasSession: false }, // responded, viewed → active
    { id: 'e', activityState: 'idle', lastResponseAt: null, hasSession: true }, // session, no response → active
    { id: 'f', activityState: 'idle', lastResponseAt: null, hasSession: false }, // nothing → idle
  ];
  assert.deepEqual(computeAgentStatusMap(list, viewed), { d: 'active', e: 'active', f: 'idle' });
});

test('computeAgentStatusMap: tolerates a non-array list', () => {
  assert.deepEqual(computeAgentStatusMap(null, {}), {});
});
