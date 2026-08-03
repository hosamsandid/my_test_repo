'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  metricDirection,
  normalizeMetricPath,
  resolveMetricValue,
  configBoundaryMs,
  computeVerdict,
  buildRollbackPlan,
  buildRollbackCard,
  applyVerdicts,
} = require('./hill-climb-verdict');

const DAY = 24 * 60 * 60 * 1000;

// A snapshot's metrics block in the shape hill-climb-metrics.js emits.
function metrics(over = {}) {
  return {
    insufficientData: false,
    runSuccessRate: 0.8,
    reworkRatio: 0.5,
    timeToDone: { p50Ms: 1000, p90Ms: 5000 },
    anomalyRecurrence: 0,
    waste: { wasteRuns: 4, failedRunTokens: 100, throttleDrops: 0, digestFolds: 0 },
    deadConfig: { zeroFireTriggers: [], unconsumedEmits: [] },
    ...over,
  };
}

// A full snapshot for a window that lies entirely AFTER `boundaryMs`.
function snapshotAfter(boundaryMs, { over = {}, metricsOver = {}, windowDays = 7, gapDays = 0, totalRuns = 40 } = {}) {
  const fromMs = boundaryMs + gapDays * DAY;
  const toMs = fromMs + windowDays * DAY;
  return {
    teamId: 'team-x', generatedAt: new Date(toMs).toISOString(),
    windowDays, minRunsPerWindow: 20,
    window: { fromMs, toMs, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    totalRuns, insufficientData: totalRuns < 20,
    metrics: metrics(metricsOver),
    byConfigVersion: [],
    ...over,
  };
}

// An applied trigger-hygiene card with baseline (before) metrics.
function appliedCard(over = {}, baselineMetricsOver = {}) {
  const appliedAt = '2026-08-01T00:00:00.000Z';
  return {
    id: 'hc_abc', teamId: 'team-x', class: 'trigger-hygiene',
    object: { kind: 'trigger', id: 'agent-x/nightly' },
    targetMetric: 'waste.wasteRuns',
    status: 'applied',
    appliedAt,
    appliedBy: 'op',
    configVersionRef: { kind: 'trigger-delete', agentId: 'agent-x', triggerId: 'nightly', at: appliedAt },
    baseline: {
      targetMetric: 'waste.wasteRuns',
      generatedAt: appliedAt,
      window: { fromMs: Date.parse(appliedAt) - 7 * DAY, toMs: Date.parse(appliedAt) },
      metrics: metrics({ waste: { wasteRuns: 10, failedRunTokens: 500, throttleDrops: 0, digestFolds: 0 }, ...baselineMetricsOver }),
    },
    undo: { kind: 'restore-trigger', agentId: 'agent-x', trigger: { id: 'nightly', type: 'cron' } },
    cooldownUntil: null,
    ...over,
  };
}

// ── metric resolution ────────────────────────────────────────────────────────

test('normalizeMetricPath strips a leading metrics.', () => {
  assert.equal(normalizeMetricPath('metrics.anomalyRecurrence'), 'anomalyRecurrence');
  assert.equal(normalizeMetricPath('waste.wasteRuns'), 'waste.wasteRuns');
  assert.equal(normalizeMetricPath('metrics'), '');
});

test('metricDirection: only success-rate is higher-is-better', () => {
  assert.equal(metricDirection('runSuccessRate'), 'higher');
  assert.equal(metricDirection('metrics.runSuccessRate'), 'higher');
  assert.equal(metricDirection('waste.wasteRuns'), 'lower');
  assert.equal(metricDirection('reworkRatio'), 'lower');
  assert.equal(metricDirection('metrics.anomalyRecurrence'), 'lower');
});

test('resolveMetricValue: nested number, array length, timeToDone p50, prefix', () => {
  const m = metrics();
  assert.deepEqual(resolveMetricValue(m, 'waste.wasteRuns'), { value: 4, found: true });
  assert.deepEqual(resolveMetricValue(m, 'metrics.waste.wasteRuns'), { value: 4, found: true });
  assert.deepEqual(resolveMetricValue(m, 'runSuccessRate'), { value: 0.8, found: true });
  assert.deepEqual(resolveMetricValue(m, 'timeToDone'), { value: 1000, found: true });
  assert.deepEqual(resolveMetricValue({ ...m, deadConfig: { zeroFireTriggers: [], unconsumedEmits: ['a', 'b'] } }, 'deadConfig.unconsumedEmits'), { value: 2, found: true });
  assert.deepEqual(resolveMetricValue(m, 'nope.gone'), { value: null, found: false });
  assert.deepEqual(resolveMetricValue(null, 'waste.wasteRuns'), { value: null, found: false });
});

test('configBoundaryMs: later of appliedAt and configVersionRef.at', () => {
  const c = appliedCard({ appliedAt: '2026-08-01T00:00:00Z', configVersionRef: { at: '2026-08-01T06:00:00Z' } });
  assert.equal(configBoundaryMs(c), Date.parse('2026-08-01T06:00:00Z'));
  assert.equal(configBoundaryMs({}), null);
});

// ── AC: no verdict from a window spanning two config versions ─────────────────

test('window that starts before the boundary → pending, no verdict (AC4)', () => {
  const card = appliedCard();
  const boundary = Date.parse(card.appliedAt);
  // window starts 3 days BEFORE the boundary → straddles the change.
  const snap = snapshotAfter(boundary - 3 * DAY, {});
  const v = computeVerdict(card, snap, { now: boundary + 10 * DAY });
  assert.equal(v.due, false);
  assert.equal(v.verdict, 'pending');
  assert.equal(v.reason, 'window-spans-boundary');
  assert.equal(v.cardStatus, null);
});

test('window entirely after the boundary → verdict computed', () => {
  const card = appliedCard();
  const boundary = Date.parse(card.appliedAt);
  const snap = snapshotAfter(boundary, {}); // fromMs === boundary
  const v = computeVerdict(card, snap, { now: boundary + 14 * DAY });
  assert.equal(v.due, true);
  assert.ok(['validated', 'neutral', 'regressed'].includes(v.verdict));
});

// ── AC: insufficient-data honesty ─────────────────────────────────────────────

test('below minRunsPerWindow → insufficient-data, verdict deferred, sample reported', () => {
  const card = appliedCard();
  const boundary = Date.parse(card.appliedAt);
  const snap = snapshotAfter(boundary, { totalRuns: 6 }); // < 20 → insufficientData
  const v = computeVerdict(card, snap, { now: boundary + 14 * DAY });
  assert.equal(v.verdict, 'insufficient-data');
  assert.equal(v.due, true);
  assert.equal(v.decided, false);
  assert.equal(v.cardStatus, null);
  assert.equal(v.sampleAfter, 6);
  assert.equal(v.reason, 'below-min-runs');
});

test('unresolvable target metric → insufficient-data (never guessed)', () => {
  const card = appliedCard({ targetMetric: 'waste.doesNotExist', baseline: { targetMetric: 'waste.doesNotExist', window: { fromMs: 0, toMs: 1 }, metrics: metrics() } });
  const boundary = Date.parse(card.appliedAt);
  const snap = snapshotAfter(boundary, {});
  const v = computeVerdict(card, snap, { now: boundary + 14 * DAY });
  assert.equal(v.verdict, 'insufficient-data');
  assert.equal(v.reason, 'metric-unresolved');
});

// ── verdict outcomes ──────────────────────────────────────────────────────────

test('improved target metric (waste down 10→4) → validated', () => {
  const card = appliedCard(); // baseline wasteRuns=10
  const boundary = Date.parse(card.appliedAt);
  const snap = snapshotAfter(boundary, { metricsOver: { waste: { wasteRuns: 4, failedRunTokens: 0, throttleDrops: 0, digestFolds: 0 } } });
  const v = computeVerdict(card, snap, { now: boundary + 14 * DAY });
  assert.equal(v.verdict, 'validated');
  assert.equal(v.cardStatus, 'validated');
  assert.equal(v.before, 10);
  assert.equal(v.after, 4);
});

test('regressed target metric (waste up 10→18) → regressed', () => {
  const card = appliedCard();
  const boundary = Date.parse(card.appliedAt);
  const snap = snapshotAfter(boundary, { metricsOver: { waste: { wasteRuns: 18, failedRunTokens: 0, throttleDrops: 0, digestFolds: 0 } } });
  const v = computeVerdict(card, snap, { now: boundary + 14 * DAY });
  assert.equal(v.verdict, 'regressed');
  assert.equal(v.cardStatus, 'regressed');
});

test('higher-is-better metric respected: success rate up → validated, down → regressed', () => {
  const base = appliedCard({ targetMetric: 'runSuccessRate' }, {});
  base.baseline.targetMetric = 'runSuccessRate';
  base.baseline.metrics = metrics({ runSuccessRate: 0.6 });
  const boundary = Date.parse(base.appliedAt);
  const up = computeVerdict(base, snapshotAfter(boundary, { metricsOver: { runSuccessRate: 0.9 } }), { now: boundary + 14 * DAY });
  assert.equal(up.verdict, 'validated');
  const down = computeVerdict(base, snapshotAfter(boundary, { metricsOver: { runSuccessRate: 0.3 } }), { now: boundary + 14 * DAY });
  assert.equal(down.verdict, 'regressed');
});

test('neutral (waste 10→10) stays applied until two full windows, then finalises', () => {
  const card = appliedCard();
  const boundary = Date.parse(card.appliedAt);
  const flat = { waste: { wasteRuns: 10, failedRunTokens: 500, throttleDrops: 0, digestFolds: 0 } };
  // window 1 (gap 0, one window wide): neutral but not yet finalised.
  const w1 = computeVerdict(card, snapshotAfter(boundary, { metricsOver: flat }), { now: boundary + 8 * DAY });
  assert.equal(w1.verdict, 'neutral');
  assert.equal(w1.decided, false);
  assert.equal(w1.cardStatus, null);
  // window starting two windows after the boundary → finalise neutral.
  const w2 = computeVerdict(card, snapshotAfter(boundary, { metricsOver: flat, gapDays: 14 }), { now: boundary + 25 * DAY });
  assert.equal(w2.verdict, 'neutral');
  assert.equal(w2.decided, true);
  assert.equal(w2.cardStatus, 'neutral');
});

// ── AC: rollback plan restores the exact prior state ──────────────────────────

test('buildRollbackPlan trigger-hygiene → restore the retained trigger JSON', () => {
  const card = appliedCard();
  const plan = buildRollbackPlan(card);
  assert.equal(plan.kind, 'restore-trigger');
  assert.equal(plan.agentId, 'agent-x');
  assert.deepEqual(plan.trigger, { id: 'nightly', type: 'cron' });
});

test('buildRollbackPlan prompt-improvement → revert to the EXACT prior prompt version (#990)', () => {
  const card = appliedCard({
    class: 'prompt-improvement',
    object: { kind: 'agent', id: 'agent-y' },
    targetMetric: 'runSuccessRate',
    undo: { kind: 'prompt-history', agentId: 'agent-y', field: 'systemPrompt', version: 7 },
  });
  const plan = buildRollbackPlan(card);
  assert.equal(plan.kind, 'prompt-revert');
  assert.equal(plan.agentId, 'agent-y');
  assert.equal(plan.field, 'systemPrompt');
  assert.equal(plan.version, 7, 'names the exact prior prompt-history version to restore');
});

test('buildRollbackCard flips a regressed card, cites both windows, carries the plan', () => {
  const card = appliedCard();
  const boundary = Date.parse(card.appliedAt);
  const snap = snapshotAfter(boundary, { metricsOver: { waste: { wasteRuns: 18, failedRunTokens: 0, throttleDrops: 0, digestFolds: 0 } } });
  const v = computeVerdict(card, snap, { now: boundary + 14 * DAY });
  const patch = buildRollbackCard(card, v, { now: boundary + 14 * DAY });
  assert.equal(patch.status, 'regressed');
  assert.equal(patch.rollback.available, true);
  assert.equal(patch.rollback.plan.kind, 'restore-trigger');
  assert.ok(patch.rollback.citedWindows.before);
  assert.ok(patch.rollback.citedWindows.after);
  assert.equal(patch.verdict.verdict, 'regressed');
});

// ── applyVerdicts fold ────────────────────────────────────────────────────────

test('applyVerdicts only measures applied cards and transitions decided ones', () => {
  const boundary = Date.parse('2026-08-01T00:00:00.000Z');
  const cards = [
    appliedCard({ id: 'c-validated' }), // baseline waste 10
    appliedCard({ id: 'c-regressed' }),
    { id: 'c-open', status: 'open', class: 'trigger-hygiene', object: { kind: 'trigger', id: 'a/x' }, targetMetric: 'waste.wasteRuns' },
  ];
  // A snapshot where waste dropped → the applied cards validate.
  const snap = snapshotAfter(boundary, { metricsOver: { waste: { wasteRuns: 4, failedRunTokens: 0, throttleDrops: 0, digestFolds: 0 } } });
  const out = applyVerdicts(cards, snap, { now: boundary + 14 * DAY });
  const byId = Object.fromEntries(out.cards.map((c) => [c.id, c]));
  assert.equal(byId['c-validated'].status, 'validated');
  assert.equal(byId['c-regressed'].status, 'validated'); // same snapshot → also validated
  assert.equal(byId['c-open'].status, 'open', 'open cards are not measured');
  assert.equal(out.transitioned, 2);
  // input not mutated
  assert.equal(cards[0].status, 'applied');
});

test('applyVerdicts: a pending (window-spans-boundary) card is left untouched', () => {
  const card = appliedCard();
  const boundary = Date.parse(card.appliedAt);
  const snap = snapshotAfter(boundary - 3 * DAY, {}); // straddles boundary
  const out = applyVerdicts([card], snap, { now: boundary + 10 * DAY });
  assert.equal(out.cards[0].status, 'applied');
  assert.equal(out.cards[0].verdict, undefined);
  assert.equal(out.transitioned, 0);
});

test('applyVerdicts regressed → rollback card with plan', () => {
  const card = appliedCard();
  const boundary = Date.parse(card.appliedAt);
  const snap = snapshotAfter(boundary, { metricsOver: { waste: { wasteRuns: 20, failedRunTokens: 0, throttleDrops: 0, digestFolds: 0 } } });
  const out = applyVerdicts([card], snap, { now: boundary + 14 * DAY });
  assert.equal(out.cards[0].status, 'regressed');
  assert.equal(out.cards[0].rollback.plan.kind, 'restore-trigger');
});
