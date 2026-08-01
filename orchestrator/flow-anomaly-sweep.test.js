'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  objectKind,
  eventObjectRef,
  labelAppliedAt,
  issueToDetectorObject,
  prsForIssue,
  runsFromSessionEvents,
  resolveThresholds,
} = require('./flow-anomaly-sweep');
const { DEFAULT_THRESHOLDS } = require('./flow-anomaly-detector');

test('objectKind distinguishes PRs from issues by the pull_request field', () => {
  assert.equal(objectKind({ number: 1 }), 'issue');
  assert.equal(objectKind({ number: 2, pull_request: { url: 'x' } }), 'pr');
});

test('eventObjectRef reads kind+number from a raw github event payload', () => {
  assert.deepEqual(eventObjectRef({ pull_request: { number: 949 } }), { kind: 'pr', number: 949 });
  assert.deepEqual(eventObjectRef({ issue: { number: 902 } }), { kind: 'issue', number: 902 });
  // issue_comment on a PR → PR scope
  assert.deepEqual(eventObjectRef({ issue: { number: 5, pull_request: {} } }), { kind: 'pr', number: 5 });
  assert.equal(eventObjectRef({ ref: 'refs/heads/x' }), null);
  assert.equal(eventObjectRef(null), null);
});

test('labelAppliedAt returns the last labeled event not later removed', () => {
  const timeline = [
    { event: 'labeled', label: { name: 'ready' }, created_at: '2026-07-29T10:00:00Z' },
    { event: 'unlabeled', label: { name: 'ready' }, created_at: '2026-07-29T10:30:00Z' },
    { event: 'labeled', label: { name: 'ready' }, created_at: '2026-07-29T11:00:00Z' },
    { event: 'labeled', label: { name: 'other' }, created_at: '2026-07-29T09:00:00Z' },
  ];
  assert.equal(labelAppliedAt(timeline, 'ready'), '2026-07-29T11:00:00Z');
  assert.equal(labelAppliedAt(timeline, 'other'), '2026-07-29T09:00:00Z');
  assert.equal(labelAppliedAt(timeline, 'missing'), null);
});

test('labelAppliedAt returns null when the label was removed and not re-added', () => {
  const timeline = [
    { event: 'labeled', label: { name: 'ready' }, created_at: '2026-07-29T10:00:00Z' },
    { event: 'unlabeled', label: { name: 'ready' }, created_at: '2026-07-29T10:30:00Z' },
  ];
  assert.equal(labelAppliedAt(timeline, 'ready'), null);
});

test('issueToDetectorObject maps an issues-API item + timeline into a detector object', () => {
  const item = {
    number: 902, html_url: 'https://gh/issues/902', title: 'x', state: 'open',
    created_at: '2026-07-29T10:00:00Z', updated_at: '2026-07-29T11:00:00Z',
    labels: [{ name: 'ready' }, 'plain-string-label'],
  };
  const timeline = [{ event: 'labeled', label: { name: 'ready' }, created_at: '2026-07-29T10:05:00Z' }];
  const obj = issueToDetectorObject(item, { timeline, linkedPrNumbers: [55] });
  assert.equal(obj.kind, 'issue');
  assert.equal(obj.number, 902);
  assert.equal(obj.state, 'open');
  assert.deepEqual(obj.labels[0], { name: 'ready', appliedAt: '2026-07-29T10:05:00Z' });
  assert.equal(obj.labels[1].name, 'plain-string-label');
  assert.deepEqual(obj.linkedPrNumbers, [55]);
});

test('issueToDetectorObject flags a PR and detects merged', () => {
  const item = { number: 949, state: 'closed', pull_request: { merged_at: '2026-07-29T12:00:00Z' }, labels: [] };
  const obj = issueToDetectorObject(item);
  assert.equal(obj.kind, 'pr');
  assert.equal(obj.merged, true);
  assert.equal(obj.state, 'closed');
});

test('prsForIssue links by #-mention and by branch token, loosely', () => {
  const prs = [
    { number: 10, title: 'Fix thing', body: 'closes #902', head: { ref: 'fix/thing' } },
    { number: 11, title: 'unrelated', body: '', head: { ref: 'feat/902-do-it' } },
    { number: 12, title: 'no link', body: 'mentions 9021 not 902', head: { ref: 'x' } },
  ];
  assert.deepEqual(prsForIssue(prs, 902).sort(), [10, 11]);
});

test('runsFromSessionEvents groups rows into object-tied runs; marks active from the registry', () => {
  const events = [
    { type: 'trigger.fired', correlationId: 'c1', ts: 1000, github: { payload: { pull_request: { number: 949 } } } },
    { type: 'claude.invoke', correlationId: 'c1', ts: 1001 },
    { type: 'message.posted', correlationId: 'c1', ts: 2000 },
    // A DM run with no github object — dropped.
    { type: 'claude.invoke', correlationId: 'dm1', ts: 3000 },
    // An active run still in the registry.
    { type: 'trigger.fired', correlationId: 'c2', ts: 4000, github: { payload: { issue: { number: 5 } } } },
  ];
  const runs = runsFromSessionEvents(events, new Set(['c2']));
  const byNum = Object.fromEntries(runs.map((r) => [r.number, r]));
  assert.equal(runs.length, 2);
  assert.equal(byNum[949].kind, 'pr');
  assert.equal(byNum[949].active, false);
  assert.equal(byNum[949].finishedAt, 2000);
  assert.equal(byNum[5].active, true);
});

test('resolveThresholds merges valid overrides and ignores bad ones', () => {
  assert.deepEqual(resolveThresholds(null), { ...DEFAULT_THRESHOLDS });
  const r = resolveThresholds({ wakeNotClaimedMs: 5 * 60000, claimStalledMs: -1, gateIdleMs: 'nope' });
  assert.equal(r.wakeNotClaimedMs, 5 * 60000);
  assert.equal(r.claimStalledMs, DEFAULT_THRESHOLDS.claimStalledMs, 'negative ignored');
  assert.equal(r.gateIdleMs, DEFAULT_THRESHOLDS.gateIdleMs, 'non-number ignored');
});
