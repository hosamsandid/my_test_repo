import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLoopSummaryModel,
  isLoopFired,
  latestLoopProgress,
  progressLabel,
  loopFiredLabel,
  loopOutcomeMeta,
  loopRecordSummary,
  buildLoopRecordModel,
  loopRecordToInitialValues,
  liveLoopSignal,
  runningLaunchedLoop,
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

// ── finished-loop record (#1231) ─────────────────────────────────────────────

test('loopOutcomeMeta: labels + tone for every terminal outcome (AC5)', () => {
  assert.deepEqual(loopOutcomeMeta('done'), { label: 'Done', tone: 'success' });
  assert.deepEqual(loopOutcomeMeta('exhausted'), { label: 'Exhausted', tone: 'neutral' });
  assert.deepEqual(loopOutcomeMeta('paused'), { label: 'Paused', tone: 'warning' });
  assert.deepEqual(loopOutcomeMeta('stopped'), { label: 'Stopped', tone: 'neutral' });
  // Unknown falls back to a neutral, non-empty label.
  assert.equal(loopOutcomeMeta('weird').tone, 'neutral');
  assert.equal(loopOutcomeMeta(undefined).label, 'Finished');
});

test('loopRecordSummary: "<Outcome> · <ran> of <cap>" (AC5)', () => {
  assert.equal(
    loopRecordSummary({ outcome: 'exhausted', iterations: 10, config: { maxIterations: 10 } }),
    'Exhausted · 10 of 10');
  assert.equal(
    loopRecordSummary({ outcome: 'stopped', iterations: 3, config: { maxIterations: 10 } }),
    'Stopped · 3 of 10');
  // No cap known → drop the " of N" tail.
  assert.equal(loopRecordSummary({ outcome: 'done', iterations: 2, config: {} }), 'Done · 2');
  // No iteration count → label only.
  assert.equal(loopRecordSummary({ outcome: 'done', config: { maxIterations: 5 } }), 'Done');
});

test('buildLoopRecordModel: reuses buildLoopSummaryModel for config + adds outcome (AC3/AC5)', () => {
  const m = buildLoopRecordModel({
    outcome: 'stopped',
    iterations: 3,
    config: {
      prompt: 'Fix the flake',
      maxIterations: 10,
      until: { command: 'npm test' },
      verify: { command: 'npm run lint' },
    },
  });
  assert.equal(m.prompt, 'Fix the flake');
  assert.deepEqual(m.stop.map(r => r.key), ['maxIterations', 'until']);
  assert.equal(m.verify.kind, 'command');
  assert.equal(m.outcome, 'stopped');
  assert.equal(m.iterations, 3);
  assert.equal(m.summary, 'Stopped · 3 of 10');
  assert.equal(m.progress, null); // a finished loop has no live progress
});

test('buildLoopRecordModel: minimal record renders no blank stop rows (AC3)', () => {
  const m = buildLoopRecordModel({ outcome: 'done', iterations: 2, config: { prompt: 'go', maxIterations: 2 } });
  assert.deepEqual(m.stop.map(r => r.key), ['maxIterations']);
  assert.equal(m.verify.kind, 'self');
});

test('loopRecordToInitialValues: seeds the launcher, drops id, keeps only set fields (AC7/AC8)', () => {
  const vals = loopRecordToInitialValues({
    triggerId: 'loop-old',
    description: 'nightly flake hunt',
    outcome: 'exhausted',
    iterations: 10,
    config: {
      prompt: 'Fix the flake',
      maxIterations: 10,
      until: { command: 'npm test' },
      maxTokens: 2000000,
      minGapSeconds: 60,
      verify: { agentId: 'reviewer-1' },
    },
  });
  assert.equal(vals.type, 'loop');
  assert.equal(vals.prompt, 'Fix the flake');
  assert.equal(vals.maxIterations, 10);
  assert.deepEqual(vals.until, { command: 'npm test' });
  assert.equal(vals.maxTokens, 2000000);
  assert.equal(vals.minGapSeconds, 60);
  assert.deepEqual(vals.verify, { agentId: 'reviewer-1' });
  assert.equal(vals.description, 'nightly flake hunt');
  // The old trigger id must NOT be carried — starting creates a fresh loop.
  assert.ok(!('id' in vals));
});

test('loopRecordToInitialValues: minimal record omits unset optional fields', () => {
  const vals = loopRecordToInitialValues({ outcome: 'done', config: { prompt: 'go', maxIterations: 3 } });
  assert.deepEqual(vals, { type: 'loop', prompt: 'go', maxIterations: 3 });
});

// ── live loop signals (#2683) ────────────────────────────────────────────────

test('liveLoopSignal: a finished-loop record is a finished signal for its trigger', () => {
  assert.deepEqual(
    liveLoopSignal({ body: 'Loop finished', 'io.aee.loop-record': { triggerId: 'loop-1', outcome: 'exhausted', iterations: 2 } }),
    { kind: 'finished', triggerId: 'loop-1' });
  assert.deepEqual(liveLoopSignal({ 'io.aee.loop-record': { outcome: 'done' } }),
    { kind: 'finished', triggerId: null });
});

test('liveLoopSignal: a loop trigger notice is an iteration signal', () => {
  assert.deepEqual(
    liveLoopSignal({ 'io.aee.trigger': { triggerId: 'loop-1', triggerType: 'loop', event: null } }),
    { kind: 'iteration', triggerId: 'loop-1' });
});

test('liveLoopSignal: other messages and non-loop trigger notices are ignored', () => {
  assert.equal(liveLoopSignal({ body: 'hello' }), null);
  assert.equal(liveLoopSignal({ 'io.aee.trigger': { triggerId: 'c', triggerType: 'cron' } }), null);
  assert.equal(liveLoopSignal({ 'io.aee.loop-record': null, 'io.aee.trigger': null }), null);
  assert.equal(liveLoopSignal(null), null);
  assert.equal(liveLoopSignal(undefined), null);
});

test('runningLaunchedLoop: picks the launched loop, never a declarative loop or other trigger', () => {
  const list = [
    { id: 'c', type: 'cron' },
    { id: 'decl', type: 'loop' },
    { id: 'run', type: 'loop', launched: true },
  ];
  assert.equal(runningLaunchedLoop(list, new Set()).id, 'run');
  assert.equal(runningLaunchedLoop(list).id, 'run');
  assert.equal(runningLaunchedLoop([{ id: 'c', type: 'cron' }], new Set()), null);
  assert.equal(runningLaunchedLoop(null, new Set()), null);
});

test('runningLaunchedLoop: a loop the live timeline reported finished stays gone from a lagging list', () => {
  const list = [{ id: 'run', type: 'loop', launched: true }];
  assert.equal(runningLaunchedLoop(list, new Set(['run'])), null);
  assert.equal(runningLaunchedLoop(list, ['run']), null);
  // A different (newly started) loop is still reported.
  const next = [...list, { id: 'run-2', type: 'loop', launched: true }];
  assert.equal(runningLaunchedLoop(next, new Set(['run'])).id, 'run-2');
});
