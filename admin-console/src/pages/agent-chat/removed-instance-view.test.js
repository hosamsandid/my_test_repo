import test from 'node:test';
import assert from 'node:assert/strict';

import {
  removedInstancesLabel, showRemovedInstances, reapReasonLabel, itemUrl, itemLabel,
  removedInstanceName, archivedChatNotice, removedInstancesCollapseEntity, sessionPageLabel,
  removedInstanceFacts, formatArchiveDate, archivedAgentUserId, archiveSessionUrl,
} from './removed-instance-view.js';
import { chatMessagesFromEvents } from './chat-event-message.js';

const role = { id: 't-dev', displayName: 'Developer', poolArchiveCount: 2 };

test('#2944 AC3: the group shows a count and is hidden when empty', () => {
  assert.equal(removedInstancesLabel(2), 'Removed instances (2)');
  assert.equal(showRemovedInstances(role), true);
  assert.equal(showRemovedInstances({ ...role, poolArchiveCount: 0 }), false);
  assert.equal(showRemovedInstances({ id: 'x' }), false);
  assert.deepEqual(removedInstancesCollapseEntity('t-dev'), { kind: 'archive', id: 't-dev' });
});

test('#2944 AC3: every reap reason reads as words', () => {
  assert.equal(reapReasonLabel('done'), 'ticket released');
  assert.equal(reapReasonLabel('idle-timeout'), 'idle timeout');
  assert.equal(reapReasonLabel('hard-timeout'), 'hard timeout');
  assert.equal(reapReasonLabel('pr-closed'), 'PR wait ended');
  assert.equal(reapReasonLabel('deleted'), 'deleted manually');
  assert.equal(reapReasonLabel(null), 'reason not recorded');
});

test('#2944 AC3: the item links to GitHub only when it is a ticket of a real repo', () => {
  assert.equal(itemUrl('o/r', '12'), 'https://github.com/o/r/issues/12');
  assert.equal(itemUrl('o/r', 12), 'https://github.com/o/r/issues/12');
  assert.equal(itemUrl(null, '12'), null);
  assert.equal(itemUrl('javascript:alert(1)', '12'), null);
  assert.equal(itemUrl('o/r', 'cobol-batch'), null);
  assert.equal(itemLabel('12'), '#12');
  assert.equal(itemLabel('cobol-batch'), 'cobol-batch');
  assert.equal(itemLabel(null), null);
});

test('removedInstanceName: named after its role and item, like a live instance', () => {
  assert.equal(removedInstanceName({ instanceId: 't-dev-i12', item: '12' }, role), 'Developer · #12');
  // A pre-#2944 archive recorded no item: parsed from the id.
  assert.equal(removedInstanceName({ instanceId: 't-dev-i12', item: null }, role), 'Developer · #12');
  assert.equal(removedInstanceName({ instanceId: 'odd', item: null }, role), 'odd');
});

test('#2944 AC10: an archive without chat says so', () => {
  assert.equal(archivedChatNotice({ hasChat: true }), null);
  assert.match(archivedChatNotice({ hasChat: false, legacy: true }), /^No chat history was archived.*before chat archiving existed/);
  assert.match(archivedChatNotice({ hasChat: false, legacy: false }), /could not be read/);
});

test('sessionPageLabel: only for a transcript of more than one page', () => {
  assert.equal(sessionPageLabel(0, 1), null);
  assert.equal(sessionPageLabel(0, 3), 'Part 3 of 3');
  assert.equal(sessionPageLabel(2, 3), 'Part 1 of 3');
});

test('#2944 AC4: chatMessagesFromEvents — one mapping for live and archived chat', () => {
  const chunk = [
    { type: 'm.room.message', event_id: '$2', sender: '@a:local', origin_server_ts: 2, content: { body: 'two', 'io.aee.author': { username: 'u' } } },
    { type: 'm.room.message', event_id: '$x', unsigned: { redacted_because: {} }, content: {} },
    { type: 'm.room.member', event_id: '$m' },
    { type: 'm.room.message', event_id: '$1', sender: '@b:local', origin_server_ts: 1, content: { body: 'one', msgtype: 'm.notice' } },
  ];
  const out = chatMessagesFromEvents(chunk);
  assert.deepEqual(out.map(m => m.event_id), ['$1', '$2'], 'oldest first, no redactions or state events');
  assert.equal(out[0].msgtype, 'm.notice');
  assert.equal(out[1].msgtype, 'm.text');
  assert.deepEqual(out[1]['io.aee.author'], { username: 'u' });
  assert.deepEqual(chatMessagesFromEvents(null), []);
});

test('#2944 AC3: an entry lists id, spawned, removed, reason and expiry; unknowns left out', () => {
  const opts = { locale: 'en-GB', timeZone: 'UTC' };
  const facts = removedInstanceFacts({
    instanceId: 't-dev-i12', spawnedAt: '2026-10-01T08:00:00Z', archivedAt: '2026-10-02T09:30:00Z',
    reason: 'idle-timeout', expiresAt: '2026-11-01T09:30:00Z',
  }, opts);
  assert.deepEqual(facts.map(([k]) => k), ['Instance', 'Spawned', 'Removed', 'Reason', 'Readable until']);
  assert.equal(facts[3][1], 'idle timeout');
  assert.match(facts[1][1], /1 Oct 2026/);
  const legacy = removedInstanceFacts({ instanceId: 'x', spawnedAt: null, archivedAt: '2026-10-02T09:30:00Z', reason: null, expiresAt: '2026-11-01T09:30:00Z' }, opts);
  assert.deepEqual(legacy.map(([k]) => k), ['Instance', 'Removed', 'Reason', 'Readable until']);
  assert.equal(formatArchiveDate('nope'), null);
});

test('#2944 AC4: the archived instance renders as its own agent user; session pages by URL', () => {
  assert.equal(archivedAgentUserId('@t-dev:hs.example', 't-dev-i7'), '@t-dev-i7:hs.example');
  assert.equal(archivedAgentUserId(null, 't-dev-i7'), '@t-dev-i7:local');
  assert.equal(archiveSessionUrl('t-dev', 't-dev-i7~1', '!r:local', 2),
    '/api/agents/t-dev/pool-archive/t-dev-i7~1/session/!r%3Alocal?limit=500&page=2');
});
