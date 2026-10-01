import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  hasSnapshot,
  isMaintenance,
  formatPercent,
  formatInt,
  formatCompact,
  formatDuration,
  snapshotMeta,
  metricTiles,
  cardClassLabel,
  cardStatusBadge,
  cardsFromResponse,
  splitCards,
  cardAction,
  cardObjectLabel,
  formatMetricValue,
  verdictLine,
  evidenceLines,
  cardActionNotice,
} from './hill-climb-view.js';

// A representative snapshot with a sufficient sample — mirrors the shape
// computeHillClimbMetrics (#1222) persists.
function fullSnapshot() {
  return {
    teamId: 'team-x',
    generatedAt: '2026-08-03T10:00:00.000Z',
    windowDays: 7,
    minRunsPerWindow: 20,
    window: { from: '2026-07-27T10:00:00.000Z', to: '2026-08-03T10:00:00.000Z' },
    totalRuns: 42,
    insufficientData: false,
    metrics: {
      insufficientData: false,
      runSuccessRate: 0.874,
      reworkRatio: 0.5,
      timeToDone: { p50Ms: 7_320_000, p90Ms: 26_400_000 },
      anomalyRecurrence: 3,
      waste: { wasteRuns: 6, failedRunTokens: 123456, throttleDrops: 2, digestFolds: 1 },
      deadConfig: { zeroFireTriggers: [{ agentId: 'a', triggerId: 't' }], unconsumedEmits: ['x', 'y'] },
    },
  };
}

test('hasSnapshot / isMaintenance interpret the API envelopes', () => {
  assert.equal(hasSnapshot({ teamId: 't', snapshot: fullSnapshot() }), true);
  assert.equal(hasSnapshot({ teamId: 't', snapshot: null }), false);
  assert.equal(hasSnapshot(null), false);
  assert.equal(isMaintenance({ maintenance: true, snapshot: null }), true);
  assert.equal(isMaintenance({ maintenance: false, snapshot: fullSnapshot() }), false);
  assert.equal(isMaintenance({}), false);
});

test('formatPercent rounds a 0..1 ratio and nulls non-numbers', () => {
  assert.equal(formatPercent(0.874), '87%');
  assert.equal(formatPercent(1), '100%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(null), null);
  assert.equal(formatPercent(undefined), null);
});

test('formatInt / formatCompact', () => {
  assert.equal(formatInt(1234), '1,234');
  assert.equal(formatInt(0), '0');
  assert.equal(formatInt(NaN), '0');
  assert.equal(formatCompact(123456), '123.5k');
  assert.equal(formatCompact(1_234_567), '1.2M');
  assert.equal(formatCompact(999), '999');
});

test('formatDuration spans seconds → days', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(180_000), '3m');
  assert.equal(formatDuration(7_320_000), '2h 2m');
  assert.equal(formatDuration(7_200_000), '2h');
  assert.equal(formatDuration(100_800_000), '1d 4h');
  assert.equal(formatDuration(-1), null);
  assert.equal(formatDuration(null), null);
});

test('snapshotMeta pulls header data with defaults', () => {
  const meta = snapshotMeta(fullSnapshot());
  assert.equal(meta.totalRuns, 42);
  assert.equal(meta.minRuns, 20);
  assert.equal(meta.windowDays, 7);
  assert.equal(meta.insufficientData, false);
  assert.equal(meta.from, '2026-07-27T10:00:00.000Z');
  const empty = snapshotMeta(null);
  assert.equal(empty.totalRuns, 0);
  assert.equal(empty.generatedAt, null);
});

test('metricTiles renders real values when the sample is sufficient', () => {
  const tiles = metricTiles(fullSnapshot());
  const by = Object.fromEntries(tiles.map((t) => [t.key, t]));
  assert.equal(by['success-rate'].state, 'ok');
  assert.equal(by['success-rate'].value, '87%');
  assert.equal(by['rework-ratio'].value, '0.50 / PR');
  assert.equal(by['time-to-done'].value, '2h 2m');
  assert.equal(by['time-to-done'].sub, 'p90 7h 20m');
  assert.equal(by['anomaly-recurrence'].value, '3');
  assert.equal(by['waste'].value, '6 runs');
  assert.equal(by['waste'].sub, '123.5k tokens');
  assert.equal(by['dead-config'].value, '3'); // 1 zero-fire + 2 unconsumed
});

test('insufficient data suppresses ONLY the ratio tiles as an explicit state', () => {
  const snap = fullSnapshot();
  snap.insufficientData = true;
  snap.totalRuns = 4;
  snap.metrics.insufficientData = true;
  snap.metrics.runSuccessRate = null;
  snap.metrics.reworkRatio = null;
  snap.metrics.timeToDone = null;
  const by = Object.fromEntries(metricTiles(snap).map((t) => [t.key, t]));
  // Ratio metrics → explicit insufficient state, never a zero.
  for (const k of ['success-rate', 'rework-ratio', 'time-to-done']) {
    assert.equal(by[k].state, 'insufficient', `${k} must be insufficient`);
    assert.equal(by[k].value, null, `${k} must not show a value`);
  }
  // Counting metrics stay meaningful on a thin sample.
  assert.equal(by['anomaly-recurrence'].state, 'ok');
  assert.equal(by['anomaly-recurrence'].value, '3');
  assert.equal(by['waste'].state, 'ok');
  assert.equal(by['dead-config'].state, 'ok');
});

test('a sufficient sample with no denominator renders an honest none, not zero', () => {
  const snap = fullSnapshot();
  snap.metrics.reworkRatio = null;   // no merged PRs
  snap.metrics.timeToDone = null;    // no completed runs
  snap.metrics.runSuccessRate = null; // no gradable runs
  const by = Object.fromEntries(metricTiles(snap).map((t) => [t.key, t]));
  assert.equal(by['rework-ratio'].state, 'none');
  assert.equal(by['rework-ratio'].note, 'No merged PRs in the window.');
  assert.equal(by['time-to-done'].state, 'none');
  assert.equal(by['success-rate'].state, 'none');
});

// ── improvement cards (#1224–#1226 frontend) ─────────────────────────────────

function openCard(over = {}) {
  return {
    id: 'hc_1', teamId: 'team-x', class: 'trigger-hygiene',
    object: { kind: 'trigger', id: 'reviewer/on-pr-opened' },
    title: "Trigger 'on-pr-opened' has not fired this window",
    detail: 'Zero fires over the window.',
    evidence: [{ type: 'metric', ref: 'metrics.deadConfig.zeroFireTriggers', value: 'reviewer/on-pr-opened' }],
    targetMetric: 'waste.wasteRuns', riskClass: 'low', status: 'open', source: 'heuristic',
    seen: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

test('cardsFromResponse normalizes the envelope and distinguishes unknown autonomy from 0', () => {
  assert.deepEqual(cardsFromResponse({ teamId: 't', autonomy: 0, cards: [openCard()] }).autonomy, 0);
  assert.equal(cardsFromResponse({ teamId: 't', cards: [] }).autonomy, null);
  assert.deepEqual(cardsFromResponse(null).cards, []);
});

test('splitCards puts regressed before open and closes the rest into the ledger, newest first', () => {
  const cards = [
    openCard({ id: 'a', status: 'open' }),
    openCard({ id: 'b', status: 'validated', updatedAt: '2026-08-02T00:00:00.000Z' }),
    openCard({ id: 'c', status: 'regressed' }),
    openCard({ id: 'd', status: 'applied', updatedAt: '2026-08-03T00:00:00.000Z' }),
    openCard({ id: 'e', status: 'dismissed', updatedAt: '2026-08-01T00:00:00.000Z' }),
  ];
  const { actionable, ledger } = splitCards(cards);
  assert.deepEqual(actionable.map((c) => c.id), ['c', 'a']);
  assert.deepEqual(ledger.map((c) => c.id), ['d', 'b', 'e']);
});

test('cardAction gates apply on autonomy and on the wired class set', () => {
  // Autonomy 2 + wired class → live Apply.
  assert.deepEqual(cardAction(openCard(), 2), { kind: 'apply', enabled: true, hint: null });
  // Autonomy below 2 → disabled with an autonomy hint (server denies anyway).
  const locked = cardAction(openCard(), 1);
  assert.equal(locked.kind, 'apply');
  assert.equal(locked.enabled, false);
  assert.match(locked.hint, /autonomy level 2/);
  // A class whose apply path is not wired yet → disabled with a wiring hint.
  const unwired = cardAction(openCard({ class: 'prompt-improvement' }), 2);
  assert.equal(unwired.enabled, false);
  assert.match(unwired.hint, /not wired yet/);
});

test('cardAction offers rollback only for a regressed card with a wired plan', () => {
  const regressed = openCard({
    status: 'regressed',
    rollback: { available: true, reason: 'metric regressed', plan: { kind: 'restore-trigger', agentId: 'reviewer', trigger: { id: 't' } } },
  });
  assert.deepEqual(cardAction(regressed, 2), { kind: 'rollback', enabled: true, hint: null });
  const noPlan = cardAction(openCard({ status: 'regressed', rollback: { plan: { kind: 'prompt-revert' } } }), 2);
  assert.equal(noPlan.kind, 'rollback');
  assert.equal(noPlan.enabled, false);
  assert.match(noPlan.hint, /not wired yet/);
  // Terminal statuses offer nothing.
  assert.equal(cardAction(openCard({ status: 'validated' }), 2).kind, null);
  assert.equal(cardAction(openCard({ status: 'applied' }), 2).kind, null);
});

test('card labels, badges, object and evidence render-helpers', () => {
  assert.equal(cardClassLabel('trigger-hygiene'), 'Trigger hygiene');
  assert.equal(cardClassLabel('mystery-class'), 'mystery-class');
  assert.deepEqual(cardStatusBadge('validated'), { label: 'Validated', tone: 'ok' });
  assert.deepEqual(cardStatusBadge('regressed'), { label: 'Regressed', tone: 'error' });
  assert.equal(cardStatusBadge('unheard-of').tone, 'muted');
  assert.equal(cardObjectLabel(openCard()), 'trigger · reviewer/on-pr-opened');
  assert.equal(cardObjectLabel({}), null);
  assert.deepEqual(evidenceLines(openCard()),
    ['metric · metrics.deadConfig.zeroFireTriggers · reviewer/on-pr-opened']);
  assert.deepEqual(evidenceLines({ evidence: null }), []);
});

test('verdictLine summarizes a recorded before/after, trimming numbers', () => {
  assert.equal(verdictLine(openCard()), null);
  const withVerdict = openCard({
    status: 'validated',
    verdict: { verdict: 'validated', targetMetric: 'waste.wasteRuns', before: 6, after: 2.3333333, delta: -3.667 },
  });
  assert.equal(verdictLine(withVerdict), 'waste.wasteRuns 6 → 2.333');
  assert.equal(formatMetricValue(null), '—');
  assert.equal(formatMetricValue(0.874999), '0.875');
});

// #2709 — a 502 applied-not-recorded (applied:true) means the trigger IS gone;
// the notice must say so instead of "Could not apply".
const apiError = (message, extra = {}) => Object.assign(new Error(message), extra);

test('cardActionNotice: success notices per action', () => {
  assert.deepEqual(cardActionNotice('apply', null),
    { tone: 'info', text: 'Card applied — its effect is measured over the next window.' });
  assert.deepEqual(cardActionNotice('rollback', null),
    { tone: 'info', text: 'Card rolled back — the change was reverted.' });
  assert.deepEqual(cardActionNotice('dismiss', null),
    { tone: 'info', text: 'Card dismissed — it will not be raised again.' });
});

test('cardActionNotice: applied-not-recorded with applied:true reads "applied, but not recorded"', () => {
  const n = cardActionNotice('apply', apiError('applied-not-recorded', { status: 502, code: 'applied-not-recorded', applied: true }));
  assert.equal(n.tone, 'error');
  assert.match(n.text, /^Card applied, but not recorded/);
  assert.match(n.text, /WAS made \(the trigger is deleted\)/);
  assert.match(n.text, /Do not apply it again/);
  assert.doesNotMatch(n.text, /Could not/);
});

test('cardActionNotice: rolled-back-not-recorded with rolledBack:true reads "rolled back, but not recorded"', () => {
  const n = cardActionNotice('rollback', apiError('rolled-back-not-recorded', { status: 502, code: 'rolled-back-not-recorded', rolledBack: true }));
  assert.match(n.text, /^Card rolled back, but not recorded/);
  assert.doesNotMatch(n.text, /Could not/);
});

test('cardActionNotice: every other failure (or the code without the flag) stays "Could not …"', () => {
  assert.deepEqual(cardActionNotice('apply', apiError('stale-card', { status: 409, code: 'stale-card' })),
    { tone: 'error', text: 'Could not apply the card: stale-card' });
  // The flag is the contract, not the code alone.
  assert.match(cardActionNotice('apply', apiError('applied-not-recorded', { code: 'applied-not-recorded' })).text, /^Could not apply/);
  // A flag on the other action's code does not leak across.
  assert.match(cardActionNotice('rollback', apiError('x', { code: 'applied-not-recorded', applied: true })).text, /^Could not rollback/);
  assert.equal(cardActionNotice('dismiss', apiError('card not found', { status: 404 })).text, 'Could not dismiss the card: card not found');
});

// #651 source guards (JSX is not executed here): the panel routes BOTH outcomes
// of a card action through cardActionNotice, and apiCall carries the flags.
test('ImprovementsPanel renders card-action outcomes via cardActionNotice; apiCall carries applied/rolledBack', () => {
  const panel = fs.readFileSync(new URL('./ImprovementsPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /setNotice\(cardActionNotice\(action, null\)\);/);
  assert.match(panel, /\} catch \(err\) \{\s*setNotice\(cardActionNotice\(action, err\)\);/);
  assert.doesNotMatch(panel, /Could not \$\{action\} the card/);
  const useApi = fs.readFileSync(new URL('../../hooks/useApi.js', import.meta.url), 'utf8');
  assert.match(useApi, /if \(err && err\.applied === true\) e\.applied = true;/);
  assert.match(useApi, /if \(err && err\.rolledBack === true\) e\.rolledBack = true;/);
});
