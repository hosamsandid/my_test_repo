import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLoopSummaryModel,
  isLoopFired,
  latestLoopProgress,
  progressLabel,
  loopFiredLabel,
} from './loop-run-view.js';

// ── buildLoopSummaryModel ────────────────────────────────────────────────────

test('buildLoopSummaryModel: full config surfaces every configured stop row (AC2/AC3)', () => {
  const m = buildLoopSummaryModel({
    prompt: 'Fix the failing tests',
    maxIterations: 25,
    until: { command: 'npm test' },
    maxTokens: 2000000,
    minGapSeconds: 300,
    verify: { agentId: 'team-x-reviewer' },
  });
  assert.equal(m.prompt, 'Fix the failing tests');
  const keys = m.stop.map(r => r.key);
  assert.deepEqual(keys, ['maxIterations', 'until', 'maxTokens', 'minGapSeconds']);
  assert.equal(m.stop.find(r => r.key === 'maxIterations').value, '25');
  assert.equal(m.stop.find(r => r.key === 'until').value, 'npm test');
  assert.equal(m.stop.find(r => r.key === 'maxTokens').value, '2M');
  assert.equal(m.stop.find(r => r.key === 'minGapSeconds').value, '5 min');
});

test('buildLoopSummaryModel: minimal config omits unset rows, no blanks (AC3 edge case)', () => {
  const m = buildLoopSummaryModel({ prompt: 'Do the thing', maxIterations: 5 });
  assert.deepEqual(m.stop.map(r => r.key), ['maxIterations']);
  // No `until`, `maxTokens`, `minGapSeconds` rows at all.
  assert.equal(m.stop.length, 1);
});

test('buildLoopSummaryModel: verify variants (AC4)', () => {
  assert.deepEqual(
    buildLoopSummaryModel({ verify: { agentId: 'rev' } }).verify,
    { kind: 'agent', label: 'Verified by', value: 'rev' });
  assert.deepEqual(
    buildLoopSummaryModel({ verify: { command: 'lint' } }).verify,
    { kind: 'command', label: 'Verified by command', value: 'lint' });
  assert.deepEqual(
    buildLoopSummaryModel({ verify: { selfGraded: true } }).verify,
    { kind: 'self', label: 'Verification', value: 'Self-graded' });
  assert.deepEqual(
    buildLoopSummaryModel({ verify: { flow: true } }).verify,
    { kind: 'flow', label: 'Verification', value: 'Flow hand-off (downstream QS chain)' });
  // Absent verify ⇒ explicit self-graded, never blank.
  assert.deepEqual(
    buildLoopSummaryModel({}).verify,
    { kind: 'self', label: 'Verification', value: 'Self-graded' });
});

test('buildLoopSummaryModel: gap seconds not divisible by 60 render as seconds', () => {
  const m = buildLoopSummaryModel({ maxIterations: 3, minGapSeconds: 90 });
  assert.equal(m.stop.find(r => r.key === 'minGapSeconds').value, '90 sec');
});

test('buildLoopSummaryModel: progress fills cap from maxIterations when absent', () => {
  const m = buildLoopSummaryModel({ maxIterations: 10 }, { iteration: 3 });
  assert.deepEqual(m.progress, { iteration: 3, maxIterations: 10 });
});

test('buildLoopSummaryModel: no/invalid progress ⇒ null (neutral running state, AC5)', () => {
  assert.equal(buildLoopSummaryModel({ maxIterations: 10 }).progress, null);
  assert.equal(buildLoopSummaryModel({ maxIterations: 10 }, { iteration: 0 }).progress, null);
  assert.equal(buildLoopSummaryModel({ maxIterations: 10 }, {}).progress, null);
});

test('buildLoopSummaryModel: tolerates a null/garbage trigger', () => {
  const m = buildLoopSummaryModel(null);
  assert.equal(m.prompt, '');
  assert.deepEqual(m.stop, []);
  assert.equal(m.verify.kind, 'self');
  assert.equal(m.progress, null);
});

// ── isLoopFired / latestLoopProgress ────────────────────────────────────────

test('isLoopFired: only a loop trigger.fired qualifies', () => {
  assert.equal(isLoopFired({ type: 'trigger.fired', triggerType: 'loop' }), true);
  assert.equal(isLoopFired({ type: 'trigger.fired', triggerType: 'cron' }), false);
  assert.equal(isLoopFired({ type: 'message.posted' }), false);
  assert.equal(isLoopFired(null), false);
});

test('latestLoopProgress: newest matching loop firing wins (AC5/AC6)', () => {
  const events = [
    { type: 'trigger.fired', triggerType: 'loop', triggerId: 'lp', loopIteration: 1, loopMaxIterations: 5 },
    { type: 'assistant_text', text: '…' },
    { type: 'trigger.fired', triggerType: 'loop', triggerId: 'lp', loopIteration: 2, loopMaxIterations: 5 },
    { type: 'trigger.fired', triggerType: 'loop', triggerId: 'other', loopIteration: 9, loopMaxIterations: 9 },
  ];
  assert.deepEqual(latestLoopProgress(events, 'lp'), { iteration: 2, maxIterations: 5 });
});

test('latestLoopProgress: an un-numbered newest firing ⇒ null (neutral, AC5)', () => {
  const events = [
    { type: 'trigger.fired', triggerType: 'loop', triggerId: 'lp', loopIteration: 1, loopMaxIterations: 5 },
    { type: 'trigger.fired', triggerType: 'loop', triggerId: 'lp' }, // legacy, no number
  ];
  assert.equal(latestLoopProgress(events, 'lp'), null);
});

test('latestLoopProgress: no matching event / bad input ⇒ null', () => {
  assert.equal(latestLoopProgress([{ type: 'trigger.fired', triggerType: 'cron', triggerId: 'lp' }], 'lp'), null);
  assert.equal(latestLoopProgress([], 'lp'), null);
  assert.equal(latestLoopProgress(null, 'lp'), null);
  assert.equal(latestLoopProgress([{ type: 'trigger.fired', triggerType: 'loop', loopIteration: 1 }], null), null);
});

test('latestLoopProgress: matches on legacy `id` field when triggerId absent', () => {
  const events = [{ type: 'trigger.fired', triggerType: 'loop', id: 'lp', loopIteration: 4, loopMaxIterations: 7 }];
  assert.deepEqual(latestLoopProgress(events, 'lp'), { iteration: 4, maxIterations: 7 });
});

// ── labels ──────────────────────────────────────────────────────────────────

test('progressLabel: cap present, cap absent, and neutral', () => {
  assert.equal(progressLabel({ iteration: 3, maxIterations: 25 }), 'Iteration 3 of 25');
  assert.equal(progressLabel({ iteration: 3, maxIterations: null }), 'Iteration 3');
  assert.equal(progressLabel(null), 'Running…');
  assert.equal(progressLabel({ iteration: 0 }), 'Running…');
});

test('loopFiredLabel: numbered, capped and legacy', () => {
  assert.equal(loopFiredLabel({ loopIteration: 3, loopMaxIterations: 25 }), 'Loop · iteration 3 of 25');
  assert.equal(loopFiredLabel({ loopIteration: 3 }), 'Loop · iteration 3');
  assert.equal(loopFiredLabel({}), 'Loop iteration');
});
