'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  toMs,
  percentile,
  attributeConfigVersion,
  runTokens,
  durationMs,
  buildRunLedger,
  countAnomalyRecurrence,
  computeHillClimbMetrics,
} = require('./hill-climb-metrics');

// Fixed clock so every case is deterministic (Date.now() is never reached).
const NOW = Date.parse('2026-08-03T12:00:00Z');
const hAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const dAgo = (d) => new Date(NOW - d * 24 * 3600000).toISOString();

// ── low-level helpers ────────────────────────────────────────────────────────

test('toMs coerces ms numbers and ISO strings, rejects garbage', () => {
  assert.equal(toMs(1000), 1000);
  assert.equal(toMs('2026-08-03T12:00:00Z'), NOW);
  assert.equal(toMs('not-a-date'), null);
  assert.equal(toMs(null), null);
});

test('percentile is type-7 interpolated and null on empty', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([10, 20, 30, 40, 50], 90), 46);
});

test('runTokens sums the normalized token shape or a plain number', () => {
  assert.equal(runTokens({ tokens: 42 }), 42);
  assert.equal(runTokens({ tokens: { input: 10, output: 5, cacheCreationInput: 1, cacheReadInput: 4 } }), 20);
  assert.equal(runTokens({ tokens: null }), 0);
});

test('durationMs only measures successful, well-ordered runs', () => {
  assert.equal(durationMs({ outcome: 'success', wakeAt: 1000, doneAt: 3000 }), 2000);
  assert.equal(durationMs({ outcome: 'failed', wakeAt: 1000, doneAt: 3000 }), null);
  assert.equal(durationMs({ outcome: 'success', wakeAt: 3000, doneAt: 1000 }), null); // negative
  assert.equal(durationMs({ outcome: 'success', wakeAt: 1000 }), null); // no done
});

// ── config-version attribution (AC: runs attributed to the version that produced them) ──

test('attributeConfigVersion picks the newest boundary at or before the run', () => {
  const boundaries = [
    { version: 3, at: dAgo(1) },
    { version: 2, at: dAgo(3) },
    { version: 1, at: dAgo(10) },
  ];
  assert.equal(attributeConfigVersion(NOW, boundaries), 3);           // after v3
  assert.equal(attributeConfigVersion(Date.parse(dAgo(2)), boundaries), 2); // between v2 and v3
  assert.equal(attributeConfigVersion(Date.parse(dAgo(20)), boundaries), 1); // before all → earliest
  assert.equal(attributeConfigVersion(NOW, []), null);               // no boundaries
});

// ── anomaly recurrence ───────────────────────────────────────────────────────

test('countAnomalyRecurrence counts identities seen in >=2 sweeps in window', () => {
  const history = [
    { ts: hAgo(1), anomalies: [{ class: 'claim-stalled', objectId: 'pr:1' }, { class: 'gate-idle', objectId: 'issue:9' }] },
    { ts: hAgo(2), anomalies: [{ class: 'claim-stalled', objectId: 'pr:1' }] },  // pr:1 recurs
    { ts: hAgo(3), anomalies: [{ class: 'gate-idle', objectId: 'issue:9' }] },   // issue:9 recurs
    { ts: dAgo(30), anomalies: [{ class: 'claim-stalled', objectId: 'pr:1' }] }, // out of window
  ];
  const fromMs = NOW - 7 * 24 * 3600000;
  assert.equal(countAnomalyRecurrence(history, fromMs, NOW), 2);
});

// ── ledger ───────────────────────────────────────────────────────────────────

test('buildRunLedger groups by (agentId, triggerId) with per-cell rollups', () => {
  const runs = [
    { agentId: 'a', triggerId: 't1', outcome: 'success', wakeAt: 1000, doneAt: 2000, tokens: 100 },
    { agentId: 'a', triggerId: 't1', outcome: 'failed', tokens: 50 },
    { agentId: 'a', triggerId: 't2', outcome: 'success', wakeAt: 0, doneAt: 4000, merged: true, tokens: 10 },
  ];
  const ledger = buildRunLedger(runs);
  assert.equal(ledger.length, 2);
  const t1 = ledger.find((c) => c.triggerId === 't1');
  assert.equal(t1.runs, 2);
  assert.equal(t1.success, 1);
  assert.equal(t1.failed, 1);
  assert.equal(t1.tokens, 150);
  assert.equal(t1.timeToDoneMs.p50, 1000);
  const t2 = ledger.find((c) => c.triggerId === 't2');
  assert.equal(t2.merged, 1);
});

// ── full catalog: a rich, deterministic golden window ────────────────────────

// A team with two agents. 24 runs so it clears the default floor of 20.
function goldenInputs() {
  const runs = [];
  // developer/t-dev: 10 success, 2 failed, 1 aborted, 1 pass
  for (let i = 0; i < 10; i++) runs.push({ agentId: 'dev', triggerId: 't-dev', outcome: 'success', wakeAt: hAgo(20 + i), doneAt: hAgo(19.5 + i), tokens: 1000, merged: true });
  for (let i = 0; i < 2; i++) runs.push({ agentId: 'dev', triggerId: 't-dev', outcome: 'failed', wakeAt: hAgo(10 + i), tokens: 500 });
  runs.push({ agentId: 'dev', triggerId: 't-dev', outcome: 'aborted', wakeAt: hAgo(9), tokens: 200 });
  runs.push({ agentId: 'dev', triggerId: 't-dev', outcome: 'pass', wakeAt: hAgo(8), tokens: 50 });
  // reviewer/t-rev: 8 success, 2 rework cycles
  for (let i = 0; i < 8; i++) runs.push({ agentId: 'rev', triggerId: 't-rev', outcome: 'success', wakeAt: hAgo(15 + i), doneAt: hAgo(14 + i), tokens: 300 });
  for (let i = 0; i < 2; i++) runs.push({ agentId: 'rev', triggerId: 't-rev', outcome: 'success', wakeAt: hAgo(5 + i), doneAt: hAgo(4 + i), tokens: 300, rework: true });
  return {
    runs,
    anomalyHistory: [
      { ts: hAgo(1), anomalies: [{ class: 'claim-stalled', objectId: 'pr:7' }] },
      { ts: hAgo(2), anomalies: [{ class: 'claim-stalled', objectId: 'pr:7' }] },
    ],
    triggerDefs: [
      { agentId: 'dev', triggerId: 't-dev' },
      { agentId: 'rev', triggerId: 't-rev' },
      { agentId: 'rev', triggerId: 't-never' }, // zero-fire
    ],
    emitLabels: ['ready-for-review', 'ready-to-merge', 'orphan-label'],
    consumedLabels: ['ready-for-review', 'ready-to-merge'],
    mergedPrCount: 10,
    throttleDrops: 3,
    digestFolds: 2,
  };
}

test('computeHillClimbMetrics folds the full §4 catalog on a healthy window', () => {
  const out = computeHillClimbMetrics(goldenInputs(), { now: NOW, windowDays: 7, minRunsPerWindow: 20 });

  assert.equal(out.totalRuns, 24);
  assert.equal(out.insufficientData, false);
  assert.equal(out.windowDays, 7);

  // success rate excludes the single [PASS] run: 20 success / 23 non-pass runs
  assert.equal(out.metrics.runSuccessRate, 20 / 23);
  // rework ratio: 2 rework cycles / 10 merged PRs
  assert.equal(out.metrics.reworkRatio, 0.2);
  // time-to-done present (successful runs have durations)
  assert.ok(out.metrics.timeToDone.p50Ms > 0);
  // anomaly recurrence: pr:7 seen twice
  assert.equal(out.metrics.anomalyRecurrence, 1);
  // waste: 2 failed + 1 aborted + 1 pass = 4 runs; tokens 500*2+200+50 = 1250
  assert.equal(out.metrics.waste.wasteRuns, 4);
  assert.equal(out.metrics.waste.failedRunTokens, 1250);
  assert.equal(out.metrics.waste.throttleDrops, 3);
  assert.equal(out.metrics.waste.digestFolds, 2);
  // dead config: t-never never fired; orphan-label emitted but not consumed
  assert.deepEqual(out.metrics.deadConfig.zeroFireTriggers, [{ agentId: 'rev', triggerId: 't-never' }]);
  assert.deepEqual(out.metrics.deadConfig.unconsumedEmits, ['orphan-label']);
  // ledger has the two firing cells
  assert.equal(out.ledger.length, 2);
});

test('zero-fire skips triggers activated inside the window (#2710)', () => {
  const inputs = goldenInputs();
  inputs.triggerDefs = [
    { agentId: 'dev', triggerId: 't-dev' },
    { agentId: 'rev', triggerId: 't-new', since: hAgo(0.05) }, // 3 minutes old
    { agentId: 'rev', triggerId: 't-old', since: dAgo(30), agentName: 'Reviewer', type: 'github-event',
      events: ['issues.labeled'], labelFilter: 'ready-for-review' },
    { agentId: 'rev', triggerId: 't-legacy' }, // no stamp → treated as old
  ];
  const out = computeHillClimbMetrics(inputs, { now: NOW, windowDays: 7, minRunsPerWindow: 20 });
  assert.deepEqual(out.metrics.deadConfig.zeroFireTriggers, [
    { agentId: 'rev', triggerId: 't-old', agentName: 'Reviewer', type: 'github-event',
      events: ['issues.labeled'], labelFilter: 'ready-for-review' },
    { agentId: 'rev', triggerId: 't-legacy' },
  ]);
});

test('a freshly created cron trigger is left out of zeroFireTriggers (#2710 review B1)', () => {
  const { triggerDefsFromMembers } = require('./hill-climb-sweep');
  const created = NOW - 3 * 60000; // 3 minutes old
  const inputs = goldenInputs();
  inputs.triggerDefs = triggerDefsFromMembers([{
    id: 'dev',
    triggers: [
      { id: `t${created}`, type: 'cron', cron: '0 9 * * *', createdAt: new Date(created).toISOString() }, // console POST
      { id: `t${created + 1}`, type: 'cron', cron: '0 9 * * *' },  // unstamped, console-generated id
      { id: `t${NOW - 30 * 24 * 3600000}`, type: 'cron', cron: '0 9 * * *' }, // id from 30 days ago
    ],
  }]);
  const out = computeHillClimbMetrics(inputs, { now: NOW, windowDays: 7, minRunsPerWindow: 20 });
  assert.deepEqual(out.metrics.deadConfig.zeroFireTriggers.map((t) => t.triggerId), [`t${NOW - 30 * 24 * 3600000}`]);
});

test('insufficient-data below minRunsPerWindow nulls the ratio metrics but keeps counts', () => {
  const inputs = goldenInputs();
  const out = computeHillClimbMetrics(inputs, { now: NOW, windowDays: 7, minRunsPerWindow: 100 });
  assert.equal(out.insufficientData, true);
  assert.equal(out.metrics.insufficientData, true);
  assert.equal(out.metrics.runSuccessRate, null);
  assert.equal(out.metrics.reworkRatio, null);
  assert.equal(out.metrics.timeToDone, null);
  // counting metrics survive
  assert.equal(out.metrics.anomalyRecurrence, 1);
  assert.equal(out.metrics.waste.wasteRuns, 4);
  assert.deepEqual(out.metrics.deadConfig.unconsumedEmits, ['orphan-label']);
});

test('runs outside the window and excluded agents are dropped', () => {
  const inputs = {
    runs: [
      { agentId: 'dev', triggerId: 't', outcome: 'success', wakeAt: dAgo(30), tokens: 1 }, // too old
      { agentId: 'dev', triggerId: 't', outcome: 'success', wakeAt: hAgo(1), tokens: 1 },
      { agentId: 'noisy', triggerId: 't', outcome: 'failed', wakeAt: hAgo(1), tokens: 1 },
    ],
  };
  const out = computeHillClimbMetrics(inputs, { now: NOW, minRunsPerWindow: 0, excludeAgents: ['noisy'] });
  assert.equal(out.totalRuns, 1);
});

test('identical inputs produce identical snapshots (deterministic)', () => {
  const a = computeHillClimbMetrics(goldenInputs(), { now: NOW });
  const b = computeHillClimbMetrics(goldenInputs(), { now: NOW });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('per-config-version rollup attributes runs across a boundary', () => {
  const inputs = {
    runs: [
      { agentId: 'dev', triggerId: 't', outcome: 'failed', wakeAt: hAgo(48), tokens: 1 },  // v1 era
      { agentId: 'dev', triggerId: 't', outcome: 'failed', wakeAt: hAgo(47), tokens: 1 },  // v1 era
      { agentId: 'dev', triggerId: 't', outcome: 'success', wakeAt: hAgo(1), tokens: 1 },  // v2 era
    ],
    configBoundaries: { dev: [{ version: 2, at: hAgo(24) }, { version: 1, at: dAgo(10) }] },
  };
  const out = computeHillClimbMetrics(inputs, { now: NOW, minRunsPerWindow: 0 });
  const v1 = out.byConfigVersion.find((v) => v.version === 1);
  const v2 = out.byConfigVersion.find((v) => v.version === 2);
  assert.equal(v1.runs, 2);
  assert.equal(v1.runSuccessRate, 0);
  assert.equal(v2.runs, 1);
  assert.equal(v2.runSuccessRate, 1);
});
