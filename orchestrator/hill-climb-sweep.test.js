'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  runsFromSessionEvents,
  usageByCorrelation,
  configBoundariesFromHistory,
  configBoundariesFromAudit,
  configBoundariesForAgent,
  emitLabelsFromMembers,
  consumedLabelsFromMembers,
  triggerDefsFromMembers,
  reworkTriggerIds,
  wasteSignalsFromEventLog,
} = require('./hill-climb-sweep');

// ── runsFromSessionEvents ────────────────────────────────────────────────────

test('a posted-reply run is success; token cost joins by correlationId', () => {
  const events = [
    { type: 'trigger.fired', correlationId: 'c1', triggerId: 't', triggerType: 'github-event', ts: '2026-08-03T10:00:00.000Z' },
    { type: 'claude.invoke', correlationId: 'c1', ts: '2026-08-03T10:00:01.000Z' },
    { type: 'result', correlationId: 'c1', ts: '2026-08-03T10:01:00.000Z' },
    { type: 'message.posted', correlationId: 'c1', ts: '2026-08-03T10:01:01.000Z' },
  ];
  const usage = new Map([['c1', 1234]]);
  const [run] = runsFromSessionEvents(events, { agentId: 'dev', usageByCorr: usage });
  assert.equal(run.agentId, 'dev');
  assert.equal(run.triggerId, 't');
  assert.equal(run.outcome, 'success');
  assert.equal(run.tokens, 1234);
  assert.equal(run.wakeAt, '2026-08-03T10:00:00.000Z');
});

test('result with no posted reply is a [PASS] run', () => {
  const events = [
    { type: 'trigger.fired', correlationId: 'c', triggerId: 't', ts: '2026-08-03T10:00:00.000Z' },
    { type: 'result', correlationId: 'c', ts: '2026-08-03T10:01:00.000Z' },
  ];
  const [run] = runsFromSessionEvents(events, { agentId: 'a' });
  assert.equal(run.outcome, 'pass');
});

test('an error row makes the run failed; claim-completed marks success + merged', () => {
  const failed = runsFromSessionEvents([
    { type: 'trigger.fired', correlationId: 'c', triggerId: 't', ts: '2026-08-03T10:00:00.000Z' },
    { type: 'error', correlationId: 'c', stage: 'claude', ts: '2026-08-03T10:00:30.000Z' },
  ], { agentId: 'a' });
  assert.equal(failed[0].outcome, 'failed');

  const ok = runsFromSessionEvents([
    { type: 'trigger.fired', correlationId: 'c', triggerId: 't', ts: '2026-08-03T10:00:00.000Z' },
    { type: 'result', correlationId: 'c', ts: '2026-08-03T10:01:00.000Z' },
    { type: 'trigger.claim-completed', correlationId: 'c', ok: true, ts: '2026-08-03T10:01:05.000Z' },
  ], { agentId: 'a' });
  assert.equal(ok[0].outcome, 'success');
  assert.equal(ok[0].merged, true);
});

test('rolled-back claim is failed; DM turns (no trigger.fired) and active runs are dropped', () => {
  const rb = runsFromSessionEvents([
    { type: 'trigger.fired', correlationId: 'c', triggerId: 't', ts: '2026-08-03T10:00:00.000Z' },
    { type: 'result', correlationId: 'c', isError: true, ts: '2026-08-03T10:01:00.000Z' },
    { type: 'trigger.claim-rolled-back', correlationId: 'c', ts: '2026-08-03T10:01:05.000Z' },
  ], { agentId: 'a' });
  assert.equal(rb[0].outcome, 'failed');

  const dm = runsFromSessionEvents([
    { type: 'message.received', correlationId: 'dm1', ts: '2026-08-03T10:00:00.000Z' },
    { type: 'result', correlationId: 'dm1', ts: '2026-08-03T10:00:10.000Z' },
  ], { agentId: 'a' });
  assert.equal(dm.length, 0); // no trigger.fired

  const activeDropped = runsFromSessionEvents([
    { type: 'trigger.fired', correlationId: 'live', triggerId: 't', ts: '2026-08-03T10:00:00.000Z' },
  ], { agentId: 'a', activeCorrelationIds: new Set(['live']) });
  assert.equal(activeDropped.length, 0);
});

test('rework runs are flagged from reworkTriggerIds', () => {
  const runs = runsFromSessionEvents([
    { type: 'trigger.fired', correlationId: 'c', triggerId: 't-rework', ts: '2026-08-03T10:00:00.000Z' },
    { type: 'result', correlationId: 'c', ts: '2026-08-03T10:01:00.000Z' },
    { type: 'message.posted', correlationId: 'c', ts: '2026-08-03T10:01:01.000Z' },
  ], { agentId: 'a', reworkTriggerIds: new Set(['t-rework']) });
  assert.equal(runs[0].rework, true);
});

// ── usage spool ──────────────────────────────────────────────────────────────

test('usageByCorrelation sums the token shape per correlationId', () => {
  const map = usageByCorrelation([
    { correlationId: 'c1', tokens: { input: 10, output: 5, cacheCreationInput: 0, cacheReadInput: 5 } },
    { correlationId: 'c1', tokens: { input: 1, output: 1, cacheCreationInput: 0, cacheReadInput: 0 } },
    { correlationId: 'c2', tokens: { input: 100, output: 0, cacheCreationInput: 0, cacheReadInput: 0 } },
  ]);
  assert.equal(map.get('c1'), 22);
  assert.equal(map.get('c2'), 100);
});

// ── config boundaries (AC: version attribution from prompt-history / audit) ───

test('configBoundariesFromHistory maps history[] to {version, at}', () => {
  const b = configBoundariesFromHistory({
    v: 1, field: 'systemPrompt',
    history: [
      { version: 3, at: '2026-08-01T00:00:00.000Z' },
      { version: 2, at: '2026-07-20T00:00:00.000Z' },
      { version: 1, at: '2026-07-10T00:00:00.000Z' },
    ],
  });
  assert.equal(b.length, 3);
  assert.deepEqual(b[0], { version: 3, at: '2026-08-01T00:00:00.000Z' });
});

test('configBoundariesFromAudit synthesizes monotonic versions from successful writes', () => {
  const audit = [
    { ts: '2026-08-01T00:00:00.000Z', resource: '/api/agents/dev', method: 'PUT', outcome: 'success' },
    { ts: '2026-07-20T00:00:00.000Z', resource: '/api/agents/dev/triggers', method: 'POST', outcome: 'success' },
    { ts: '2026-07-15T00:00:00.000Z', resource: '/api/agents/dev', method: 'GET', outcome: 'success' }, // GET ignored
    { ts: '2026-07-10T00:00:00.000Z', resource: '/api/agents/other', method: 'PUT', outcome: 'success' }, // other agent
    { ts: '2026-07-05T00:00:00.000Z', resource: '/api/agents/dev', method: 'PUT', outcome: 'denied' }, // not success
  ];
  const b = configBoundariesFromAudit(audit, 'dev');
  assert.deepEqual(b, [
    { version: 1, at: '2026-07-20T00:00:00.000Z' },
    { version: 2, at: '2026-08-01T00:00:00.000Z' },
  ]);
});

test('configBoundariesForAgent prefers prompt-history, falls back to audit', () => {
  const audit = [{ ts: '2026-08-01T00:00:00.000Z', resource: '/api/agents/dev', method: 'PUT', outcome: 'success' }];
  const withHist = configBoundariesForAgent({ history: [{ version: 9, at: '2026-08-02T00:00:00.000Z' }] }, audit, 'dev');
  assert.equal(withHist[0].version, 9);
  const noHist = configBoundariesForAgent(null, audit, 'dev');
  assert.equal(noHist[0].version, 1);
});

// ── dead-config derivations ──────────────────────────────────────────────────

test('emit/consumed/trigger derivations from member configs', () => {
  const members = [
    { id: 'dev', emits: ['ready-for-review'], triggers: [{ id: 't-dev', labelFilter: 'ready' }] },
    { id: 'rev', outcomes: { options: [{ actions: [{ type: 'setLabel', label: 'ready-to-merge' }] }] },
      triggers: [{ id: 't-rev', labelFilter: 'ready-for-review' }, { id: 't-rework', labelFilter: 'revisions-required' }] },
  ];
  assert.deepEqual(emitLabelsFromMembers(members).sort(), ['ready-for-review', 'ready-to-merge']);
  assert.deepEqual(consumedLabelsFromMembers(members).sort(), ['ready', 'ready-for-review', 'revisions-required']);
  assert.deepEqual(triggerDefsFromMembers(members), [
    { agentId: 'dev', triggerId: 't-dev', labelFilter: 'ready' },
    { agentId: 'rev', triggerId: 't-rev', labelFilter: 'ready-for-review' },
    { agentId: 'rev', triggerId: 't-rework', labelFilter: 'revisions-required' },
  ]);
  assert.deepEqual([...reworkTriggerIds(members)], ['t-rework']);
});

test('triggerDefsFromMembers carries the display fields and the activation stamp (#2710)', () => {
  const members = [{
    id: 'acme-rev', displayName: 'Reviewer',
    triggers: [
      { id: 't1', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready-for-review',
        createdAt: '2026-08-01T00:00:00Z', activatedAt: '2026-08-02T00:00:00Z' },
      { id: 't2', type: 'cron', createdAt: '2026-07-01T00:00:00Z' },
      { id: 't3' },
    ],
  }];
  assert.deepEqual(triggerDefsFromMembers(members), [
    { agentId: 'acme-rev', triggerId: 't1', agentName: 'Reviewer', type: 'github-event',
      events: ['issues.labeled'], labelFilter: 'ready-for-review', since: '2026-08-02T00:00:00Z' },
    { agentId: 'acme-rev', triggerId: 't2', agentName: 'Reviewer', type: 'cron', since: '2026-07-01T00:00:00Z' },
    { agentId: 'acme-rev', triggerId: 't3', agentName: 'Reviewer' },
  ]);
});

test('triggerDefsFromMembers falls back to the epoch in a console-generated id when unstamped (#2710)', () => {
  const members = [{
    id: 'dev',
    triggers: [
      { id: 't1790817163431', type: 'cron' },        // POST /api/agents/:id/triggers id
      { id: 't1790817163431042', type: 'loop' },     // Flow editor uid (+ random suffix)
      { id: 't1790817163431', type: 'cron', createdAt: '2026-07-01T00:00:00Z' }, // stamp wins
      { id: 'nightly-sweep', type: 'cron' },         // agent-authored id: no age signal
      { id: 't123', type: 'cron' },                  // too short to be an epoch
    ],
  }];
  const since = triggerDefsFromMembers(members).map((t) => t.since);
  const fromId = new Date(1790817163431).toISOString();
  assert.deepEqual(since, [fromId, fromId, '2026-07-01T00:00:00Z', undefined, undefined]);
});

// ── waste signals from the event log ─────────────────────────────────────────

test('wasteSignalsFromEventLog counts dropped/digest outcomes in window', () => {
  const NOW = Date.parse('2026-08-03T12:00:00Z');
  const fromMs = NOW - 7 * 24 * 3600000;
  const entries = [
    { ts: '2026-08-03T10:00:00.000Z', outcomes: [{ status: 'dropped' }, { status: 'delivered' }] },
    { ts: '2026-08-03T11:00:00.000Z', outcomes: [{ status: 'digest' }, { status: 'digest' }] },
    { ts: '2026-06-01T00:00:00.000Z', outcomes: [{ status: 'dropped' }] }, // out of window
  ];
  const w = wasteSignalsFromEventLog(entries, fromMs, NOW);
  assert.deepEqual(w, { throttleDrops: 1, digestFolds: 2 });
});

test('#2693: wasteSignalsFromEventLog counts a delivered+digest outcome (the poller\'s burst shape) as a digest fold', () => {
  const NOW = Date.parse('2026-08-03T12:00:00Z');
  const entries = [
    { ts: '2026-08-03T11:00:00.000Z', outcomes: [
      { status: 'delivered', digest: true }, { status: 'delivered', digest: false }, { status: 'reaped', reason: null },
    ] },
  ];
  assert.deepEqual(wasteSignalsFromEventLog(entries, NOW - 3600000, NOW), { throttleDrops: 0, digestFolds: 1 });
});

test('wasteSignalsFromEventLog scopes to the team agents when given a set', () => {
  const NOW = Date.parse('2026-08-03T12:00:00Z');
  const fromMs = NOW - 7 * 24 * 3600000;
  const entries = [
    { ts: '2026-08-03T10:00:00.000Z', outcomes: [{ status: 'dropped', agentId: 'mine' }, { status: 'dropped', agentId: 'other' }] },
    { ts: '2026-08-03T11:00:00.000Z', outcomes: [{ status: 'digest', agentId: 'mine' }] },
  ];
  const w = wasteSignalsFromEventLog(entries, fromMs, NOW, new Set(['mine']));
  assert.deepEqual(w, { throttleDrops: 1, digestFolds: 1 });
});

test('#2113: a blocked claim is failed, not the success its posted reply implies', () => {
  // Verify-before-claim: the run completed and posted a reply, but its declared
  // post-condition did not hold, so the claim stayed `<wake>:wip` and the work
  // item was NOT delivered. Without the `trigger.claim-blocked` case this run
  // falls through to the `result` + `message.posted` rule and is measured a
  // SUCCESS — which would move #2113's false success from the label onto the
  // metrics surface instead of removing it.
  const blocked = runsFromSessionEvents([
    { type: 'trigger.fired', correlationId: 'c', triggerId: 't', ts: '2026-08-03T10:00:00.000Z' },
    { type: 'result', correlationId: 'c', ts: '2026-08-03T10:01:00.000Z' },
    { type: 'message.posted', correlationId: 'c', ts: '2026-08-03T10:01:02.000Z' },
    {
      type: 'trigger.claim-blocked', correlationId: 'c', kept: 'ready-to-merge:wip',
      postcondition: 'merged', reason: 'pull request #2105 is not merged',
      ts: '2026-08-03T10:01:05.000Z',
    },
  ], { agentId: 'a' });
  assert.equal(blocked[0].outcome, 'failed');
  assert.notEqual(blocked[0].merged, true);

  // A claim with no post-condition is unaffected: no blocked row is emitted, so
  // the pre-#2113 success rule still applies.
  const plain = runsFromSessionEvents([
    { type: 'trigger.fired', correlationId: 'c', triggerId: 't', ts: '2026-08-03T10:00:00.000Z' },
    { type: 'result', correlationId: 'c', ts: '2026-08-03T10:01:00.000Z' },
    { type: 'message.posted', correlationId: 'c', ts: '2026-08-03T10:01:02.000Z' },
  ], { agentId: 'a' });
  assert.equal(plain[0].outcome, 'success');
});
