'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('./github-refire');

const DROP = {
  ts: '2026-09-28T10:00:00.000Z', eventId: '555', repo: 'org/repo', event: 'pull_request.labeled', label: 'ready-for-review',
  workItem: { kind: 'pr', number: 42, title: 'Old title', url: 'https://github.com/org/repo/pull/42' },
  outcomes: [
    { agentId: 'rev', triggerId: 't1', status: 'dropped', reason: 'wake-already-armed', digest: false, wakeLabel: 'ready-for-review' },
    { agentId: 'rev', triggerId: 't2', status: 'dropped', reason: 'label-filter', digest: false },
  ],
};
const TRIGGER = { id: 't1', type: 'github-event', enabled: true, labelFilter: 'ready-for-review' };
const found = r.findDroppedOutcome([DROP], { eventId: '555', agentId: 'rev', triggerId: 't1' });

test('only the three protection drops are refirable', () => {
  assert.deepEqual([...r.REFIRABLE_REASONS], ['wake-already-armed', 'throttle', 'internal-dedup']);
  for (const x of ['label-filter', 'self-claim-label', 'history-horizon', 'push-duplicate', null]) {
    assert.equal(r.isRefirableReason(x), false, String(x));
  }
});

test('validateRefireRequest rejects malformed ids and trims the actor', () => {
  assert.equal(r.validateRefireRequest(null).ok, false);
  assert.equal(r.validateRefireRequest({ eventId: '', triggerId: 't' }).ok, false);
  assert.equal(r.validateRefireRequest({ eventId: '1', triggerId: '../x y' }).ok, false);
  assert.deepEqual(r.validateRefireRequest({ eventId: 'refire:ab', triggerId: 't1', actor: ' ana ' }).value,
    { eventId: 'refire:ab', triggerId: 't1', actor: 'ana' });
});

test('findDroppedOutcome picks the outcome by agent AND trigger (several triggers per event)', () => {
  assert.equal(found.outcome.reason, 'wake-already-armed');
  const t2 = r.findDroppedOutcome([DROP], { eventId: '555', agentId: 'rev', triggerId: 't2' });
  assert.equal(t2.outcome.reason, 'label-filter');
  assert.equal(r.findDroppedOutcome([DROP], { eventId: '555', agentId: 'other', triggerId: 't1' }), null);
});

test('planRefire: success carries the logged wake label and the work item', () => {
  const p = r.planRefire({ found, prior: null, trigger: TRIGGER, agentEnabled: true });
  assert.deepEqual(p, { ok: true, wakeLabel: 'ready-for-review', workItem: DROP.workItem });
});

test('planRefire: falls back to the trigger labelFilter when the outcome predates wakeLabel', () => {
  const o = { ...found.outcome }; delete o.wakeLabel;
  const p = r.planRefire({ found: { entry: DROP, outcome: o }, trigger: TRIGGER });
  assert.equal(p.wakeLabel, 'ready-for-review');
});

test('planRefire refusals', () => {
  const code = (args) => r.planRefire({ found, trigger: TRIGGER, agentEnabled: true, ...args }).code;
  assert.equal(code({ found: null }), 'not-found');
  assert.equal(code({ retentionCutoffMs: Date.parse('2026-09-29T00:00:00Z') }), 'not-found');
  assert.equal(code({ found: r.findDroppedOutcome([DROP], { eventId: '555', agentId: 'rev', triggerId: 't2' }) }), 'not-refirable');
  assert.equal(code({ found: { entry: DROP, outcome: { ...found.outcome, status: 'delivered', reason: null } } }), 'not-refirable');
  const prior = { eventId: 'refire:1', ts: '2026-09-28T11:00:00Z', refiredBy: 'ana' };
  const p = r.planRefire({ found, prior, trigger: TRIGGER });
  assert.equal(p.code, 'already-refired');
  assert.match(p.error, /ana/);
  assert.deepEqual(p.refire, { eventId: 'refire:1', by: 'ana', at: '2026-09-28T11:00:00Z' });
  assert.equal(code({ found: { entry: { ...DROP, workItem: null }, outcome: found.outcome } }), 'no-work-item');
  assert.equal(code({ trigger: null }), 'trigger-gone');
  assert.equal(code({ trigger: { ...TRIGGER, enabled: false } }), 'trigger-disabled');
  assert.equal(code({ agentEnabled: false }), 'agent-disabled');
});

test('findPriorRefire matches only a manual-refire row of the same (event, agent, trigger)', () => {
  const refire = {
    eventId: 'refire:abc', source: 'manual-refire', refiredBy: 'ana', ts: '2026-09-28T11:00:00Z',
    refireOf: { eventId: '555', reason: 'wake-already-armed' },
    outcomes: [{ agentId: 'rev', triggerId: 't1', status: 'delivered' }],
  };
  assert.equal(r.findPriorRefire([DROP, refire], { eventId: '555', agentId: 'rev', triggerId: 't1' }), refire);
  assert.equal(r.findPriorRefire([refire], { eventId: '555', agentId: 'rev', triggerId: 't2' }), null);
  assert.equal(r.findPriorRefire([refire], { eventId: '556', agentId: 'rev', triggerId: 't1' }), null);
  assert.equal(r.findPriorRefire([{ ...refire, source: 'internal' }], { eventId: '555', agentId: 'rev', triggerId: 't1' }), null);
});

test('findTwinDelivery returns the newest earlier delivery of the same item + label', () => {
  const drop = { ...DROP, outcomes: [{ agentId: 'rev', triggerId: 't1', status: 'dropped', reason: 'internal-dedup', wakeLabel: 'ready-for-review' }] };
  const older = { ts: '2026-09-28T09:00:00Z', eventId: 'a', repo: 'org/repo', label: 'ready-for-review', workItem: { number: 42 }, source: 'internal',
    outcomes: [{ agentId: 'rev', triggerId: 't1', status: 'delivered', wakeLabel: 'ready-for-review' }] };
  const newer = { ...older, ts: '2026-09-28T09:59:00Z', eventId: 'b' };
  const later = { ...older, ts: '2026-09-28T12:00:00Z', eventId: 'c' };
  const otherLabel = { ...older, ts: '2026-09-28T09:59:30Z', eventId: 'd', label: 'x', outcomes: [{ agentId: 'rev', triggerId: 't1', status: 'delivered', wakeLabel: 'x' }] };
  const otherItem = { ...older, ts: '2026-09-28T09:59:40Z', eventId: 'e', workItem: { number: 43 } };
  const twin = r.findTwinDelivery([older, newer, later, otherLabel, otherItem, drop], { entry: drop, agentId: 'rev', triggerId: 't1', wakeLabel: 'ready-for-review' });
  assert.deepEqual(twin, { eventId: 'b', triggerId: 't1', ts: '2026-09-28T09:59:00Z', source: 'internal' });
  assert.equal(r.findTwinDelivery([drop], { entry: drop, agentId: 'rev', triggerId: 't1', wakeLabel: 'ready-for-review' }), null);
});

test('triggerCorrelationId matches the runner stamp', () => {
  assert.equal(r.triggerCorrelationId('t1', 'refire:ab'), 'trigger:t1:gh:refire:ab');
  assert.equal(r.triggerCorrelationId('t1', null), null);
});

test('checkItemState: refuses merged, closed, label gone and label claimed; passes open + labelled', () => {
  const ok = { state: 'open', labels: [{ name: 'ready-for-review' }] };
  assert.equal(r.checkItemState(null, { kind: 'pr', wakeLabel: 'x' }).code, 'github-unavailable');
  assert.equal(r.checkItemState({ ...ok, state: 'closed', merged: true }, { kind: 'pr', wakeLabel: 'ready-for-review' }).code, 'item-merged');
  assert.equal(r.checkItemState({ ...ok, merged_at: '2026-01-01' }, { kind: 'pr', wakeLabel: 'ready-for-review' }).code, 'item-merged');
  assert.equal(r.checkItemState({ ...ok, state: 'closed' }, { kind: 'issue', wakeLabel: 'ready-for-review' }).code, 'item-closed');
  assert.equal(r.checkItemState({ state: 'open', labels: [] }, { kind: 'pr', wakeLabel: 'ready-for-review' }).code, 'label-gone');
  const wip = r.checkItemState({ state: 'open', labels: [{ name: 'ready-for-review:wip' }] }, { kind: 'pr', wakeLabel: 'ready-for-review' });
  assert.equal(wip.code, 'label-claimed');
  assert.match(wip.error, /ready-for-review:wip/);
  assert.deepEqual(r.checkItemState(ok, { kind: 'pr', wakeLabel: 'ready-for-review' }), { ok: true });
  assert.deepEqual(r.checkItemState({ state: 'open', labels: [] }, { kind: 'pr', wakeLabel: null }), { ok: true });
});

test('buildRefireEvent + buildRefirePendingEntry produce the poller-shaped delivery', () => {
  const ev = r.buildRefireEvent({ entry: DROP, wakeLabel: 'ready-for-review', title: 'New title', closesIssues: [7], actor: 'ana', eventId: 'refire:ab', now: '2026-09-29T00:00:00Z' });
  assert.deepEqual(ev, {
    id: 'refire:ab', actor: { login: 'ana' }, repo: { name: 'org/repo' }, created_at: '2026-09-29T00:00:00Z',
    payload: {
      action: 'labeled', label: { name: 'ready-for-review' },
      pull_request: { number: 42, html_url: 'https://github.com/org/repo/pull/42', title: 'New title', closesIssues: [7] },
    },
  });
  const issueEv = r.buildRefireEvent({ entry: { ...DROP, event: 'issues.opened', workItem: { kind: 'issue', number: 9 } }, wakeLabel: null, eventId: 'refire:cd', now: 'n' });
  assert.deepEqual(issueEv.payload, { action: 'opened', issue: { number: 9, html_url: 'https://github.com/org/repo/issues/9' } });
  assert.equal(issueEv.actor.login, 'console');

  const refireOf = { eventId: '555', reason: 'wake-already-armed', ts: DROP.ts };
  const pending = r.buildRefirePendingEntry({ triggerId: 't1', key: 'pull_request.labeled', ghEvent: ev, wakeLabel: 'ready-for-review', refireOf });
  assert.deepEqual(pending, {
    triggerId: 't1', source: 'manual-refire', wakeLabel: 'ready-for-review', refireOf,
    github: { event: 'pull_request.labeled', eventId: 'refire:ab', repo: 'org/repo', actor: 'ana', createdAt: '2026-09-29T00:00:00Z', payload: ev.payload },
  });
  assert.deepEqual(r.buildRefireLogFields({ entry: DROP, outcome: found.outcome, actor: 'ana' }),
    { source: 'manual-refire', refiredBy: 'ana', refireOf: { eventId: '555', reason: 'wake-already-armed', ts: DROP.ts } });
});

test('refireKey distinguishes triggers', () => {
  assert.notEqual(r.refireKey({ eventId: '1', agentId: 'a', triggerId: 't1' }), r.refireKey({ eventId: '1', agentId: 'a', triggerId: 't2' }));
});
