import test from 'node:test';
import assert from 'node:assert/strict';

import { computeChatCounts, computeAgentStatusMap } from './agent-statuses.js';

test('computeChatCounts: counts busy and only manually-messaged unread, skips disabled/offline', () => {
  const list = [
    { id: 'a', activityState: 'busy', lastResponseAt: null },
    { id: 'b', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z' }, // unread + manually messaged → counts
    { id: 'c', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z' }, // viewed after → not unread
    { id: 'd', activityState: 'disabled', lastResponseAt: '2026-01-01T00:00:10Z' },
    { id: 'e', activityState: 'offline', lastResponseAt: '2026-01-01T00:00:10Z' },
  ];
  const viewed = { c: Date.parse('2026-01-01T00:00:20Z') };
  assert.deepEqual(computeChatCounts(list, viewed, ['b']), { busy: 1, unread: 1 });
});

test('computeChatCounts: an auto-triggered unread (not manually messaged) is NOT counted', () => {
  const list = [
    { id: 'a', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z' }, // unread but auto → not counted
    { id: 'b', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z' }, // unread + manual → counted
  ];
  assert.deepEqual(computeChatCounts(list, {}, ['b']), { busy: 0, unread: 1 });
  // With no manually-messaged signal at all, no unread is counted (#2429 AC8).
  assert.deepEqual(computeChatCounts(list, {}), { busy: 0, unread: 0 });
});

test('computeChatCounts: an idle agent that never responded is not unread', () => {
  const list = [{ id: 'a', activityState: 'idle', lastResponseAt: null }];
  assert.deepEqual(computeChatCounts(list, {}, ['a']), { busy: 0, unread: 0 });
});

test('computeChatCounts: tolerates non-array / missing viewed / missing manual set', () => {
  assert.deepEqual(computeChatCounts(null, null), { busy: 0, unread: 0 });
  assert.deepEqual(computeChatCounts(undefined), { busy: 0, unread: 0 });
});

test('computeChatCounts: accepts a Set for manuallyMessaged', () => {
  const list = [{ id: 'b', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z' }];
  assert.deepEqual(computeChatCounts(list, {}, new Set(['b'])), { busy: 0, unread: 1 });
});

test('computeAgentStatusMap: precedence disabled > offline > busy > unread', () => {
  const list = [
    { id: 'a', activityState: 'disabled', lastResponseAt: '2026-01-01T00:00:10Z' },
    { id: 'b', activityState: 'offline', lastResponseAt: '2026-01-01T00:00:10Z' },
    { id: 'c', activityState: 'busy' },
    { id: 'd', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z' }, // unread, manually messaged
  ];
  assert.deepEqual(computeAgentStatusMap(list, {}, ['d']), {
    a: 'disabled', b: 'offline', c: 'busy', d: 'unread',
  });
});

test('computeAgentStatusMap: unread splits into solid (manual) vs hollow (auto)', () => {
  const list = [
    { id: 'manual', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z' },
    { id: 'auto', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z' },
  ];
  assert.deepEqual(computeAgentStatusMap(list, {}, ['manual']), {
    manual: 'unread', auto: 'unread-auto',
  });
});

test('computeAgentStatusMap: solid green takes precedence when both apply (AC7)', () => {
  // Manually messaged AND has an unread response → solid, not hollow.
  const list = [{ id: 'x', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z' }];
  assert.deepEqual(computeAgentStatusMap(list, {}, new Set(['x'])), { x: 'unread' });
});

test('computeAgentStatusMap: former active (session or viewed past response) folds into idle', () => {
  const viewed = { d: Date.parse('2026-01-01T00:00:20Z'), e: Date.parse('2026-01-01T00:00:20Z') };
  const list = [
    { id: 'd', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z', hasSession: false }, // responded, viewed → idle
    { id: 'e', activityState: 'idle', lastResponseAt: null, hasSession: true }, // session, no response → idle
    { id: 'f', activityState: 'idle', lastResponseAt: null, hasSession: false }, // nothing → idle
  ];
  assert.deepEqual(computeAgentStatusMap(list, viewed), { d: 'idle', e: 'idle', f: 'idle' });
});

test('computeAgentStatusMap: no state is ever "active" any more (blue removed, AC1)', () => {
  const list = [
    { id: 'a', activityState: 'idle', lastResponseAt: '2026-01-01T00:00:10Z', hasSession: true },
  ];
  const map = computeAgentStatusMap(list, { a: Date.parse('2026-01-01T00:00:20Z') });
  assert.equal(map.a, 'idle');
  assert.ok(!Object.values(map).includes('active'));
});

test('computeAgentStatusMap: tolerates a non-array list', () => {
  assert.deepEqual(computeAgentStatusMap(null, {}), {});
});
