import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isToolHeartbeat,
  heartbeatTargetIds,
  heartbeatElapsed,
  isTaskStartedEvent,
  formatElapsed,
  mergeToolPairs,
  toolRunView,
  orphanHeartbeatSummary,
  taskStartedRows,
} from './tool-progress.js';

const C = 'corr-1';

function use(id, tool = 'Bash', ts = '2026-10-05T10:00:00.000Z', input = { command: 'sleep 400' }) {
  return { type: 'tool_use', tool, toolId: id, input, ts, correlationId: C };
}
function res(id, ts = '2026-10-05T10:06:12.000Z', content = 'ok') {
  return { type: 'tool_result', toolId: id, ok: true, content, ts, correlationId: C };
}
// Heartbeat as the runtime stores it today: the generic `unknown` envelope.
function hb(parent, n, elapsed, tool = 'Bash') {
  return {
    type: 'unknown',
    ts: '2026-10-05T10:00:30.000Z',
    correlationId: C,
    raw: {
      type: 'tool_progress',
      tool_name: tool,
      parent_tool_use_id: parent,
      elapsed_time_seconds: elapsed,
      heartbeat: true,
      tool_use_id: `${parent}-heartbeat-${n}`,
    },
  };
}

test('isToolHeartbeat: unknown envelope and bare tool_progress', () => {
  assert.equal(isToolHeartbeat(hb('t1', 1, 30)), true);
  assert.equal(isToolHeartbeat({ type: 'tool_progress', tool_use_id: 'x' }), true);
  assert.equal(isToolHeartbeat({ type: 'unknown', raw: { type: 'rate_limit_event' } }), false);
  assert.equal(isToolHeartbeat({ type: 'unknown' }), false);
  assert.equal(isToolHeartbeat(null), false);
});

test('heartbeatTargetIds strips the -heartbeat-N suffix, then the parent', () => {
  assert.deepEqual(heartbeatTargetIds(hb('toolu_1', 3, 90).raw), ['toolu_1']);
  assert.deepEqual(
    heartbeatTargetIds({ tool_use_id: 'inner', parent_tool_use_id: 'task' }),
    ['inner', 'task'],
  );
  assert.deepEqual(heartbeatTargetIds({}), []);
});

test('heartbeatElapsed: numbers only, never NaN', () => {
  assert.equal(heartbeatElapsed({ elapsed_time_seconds: 45 }), 45);
  assert.equal(heartbeatElapsed({ elapsed_time_seconds: '60.5' }), 60.5);
  assert.equal(heartbeatElapsed({}), null);
  assert.equal(heartbeatElapsed({ elapsed_time_seconds: 'abc' }), null);
  assert.equal(heartbeatElapsed({ elapsed_time_seconds: NaN }), null);
  assert.equal(heartbeatElapsed({ elapsed_time_seconds: -1 }), null);
  assert.equal(heartbeatElapsed({ elapsed_time_seconds: true }), null);
});

test('formatElapsed: 45s / 6m 00s / 1h 02m', () => {
  assert.equal(formatElapsed(45), '45s');
  assert.equal(formatElapsed(45.9), '45s');
  assert.equal(formatElapsed(360), '6m 00s');
  assert.equal(formatElapsed(372), '6m 12s');
  assert.equal(formatElapsed(3720), '1h 02m');
  assert.equal(formatElapsed(null), '');
  assert.equal(formatElapsed(NaN), '');
});

test('plain use/result pairing is unchanged (no run info)', () => {
  const out = mergeToolPairs([use('a'), res('a')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool');
  assert.equal(out[0].run, null);
  assert.deepEqual(out[0].toolResult, { ok: true, content: 'ok' });
  assert.equal(out[0]._key, 'tool-a-0');
});

test('heartbeats fold into the pending tool block — no extra rows', () => {
  const out = mergeToolPairs([use('a'), hb('a', 1, 30), hb('a', 2, 60), hb('a', 12, 360)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].run.heartbeats, 3);
  assert.equal(out[0].run.elapsedSeconds, 360);
  assert.equal(out[0].run.lastHeartbeat.tool_use_id, 'a-heartbeat-12');
  assert.deepEqual(toolRunView(out[0].run, false), { state: 'running', elapsedText: '6m 00s', label: 'running · 6m 00s' });
});

test('a new heartbeat updates the same block in place (stable key)', () => {
  const before = mergeToolPairs([use('a'), hb('a', 1, 30)]);
  const after = mergeToolPairs([use('a'), hb('a', 1, 30), hb('a', 2, 60)]);
  assert.equal(before.length, after.length);
  assert.equal(before[0]._key, after[0]._key);
  assert.equal(after[0].run.elapsedSeconds, 60);
});

test('final duration after the result — only when heartbeats were seen', () => {
  const out = mergeToolPairs([use('a'), hb('a', 1, 30), hb('a', 12, 360), res('a')]);
  assert.equal(out[0].run.durationSeconds, 372);
  assert.deepEqual(toolRunView(out[0].run, true), { state: 'done', elapsedText: '6m 12s', label: 'took 6m 12s' });
  const quick = mergeToolPairs([use('b'), res('b', '2026-10-05T10:00:02.000Z')]);
  assert.equal(toolRunView(quick[0].run, true).state, null);
});

test('final duration falls back to the heartbeat when timestamps are missing', () => {
  const u = { ...use('a'), ts: undefined };
  const out = mergeToolPairs([u, hb('a', 1, 90), res('a')]);
  assert.equal(out[0].run.durationSeconds, 90);
});

test('a heartbeat after the result is ignored', () => {
  const out = mergeToolPairs([use('a'), hb('a', 1, 30), res('a'), hb('a', 2, 60)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].run.heartbeats, 1);
  assert.equal(toolRunView(out[0].run, true).state, 'done');
});

test('parallel pending tools each show their own time', () => {
  const out = mergeToolPairs([use('a'), use('b'), hb('a', 1, 30), hb('b', 1, 90), hb('a', 2, 60)]);
  assert.equal(out.length, 2);
  assert.equal(out[0].run.elapsedSeconds, 60);
  assert.equal(out[1].run.elapsedSeconds, 90);
});

test('orphan heartbeats collapse into one row per parent, updated in place', () => {
  const out = mergeToolPairs([hb('gone', 1, 30), hb('gone', 2, 60), hb('other', 1, 30), hb('gone', 12, 360)]);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'tool_progress_orphan');
  assert.equal(out[0]._key, 'hb-gone');
  assert.equal(out[0].heartbeats, 3);
  assert.equal(orphanHeartbeatSummary(out[0]), 'Bash still running · 6m 00s');
  assert.equal(out[1]._key, 'hb-other');
});

test('a sub-agent tool heartbeat attaches to the inner tool, not the Task block', () => {
  const task = use('task1', 'Task', undefined, { description: 'research' });
  const inner = use('inner1', 'Bash');
  // SDK shape: tool_use_id names the running tool, parent_tool_use_id the sub-agent.
  const beat = {
    type: 'unknown', correlationId: C,
    raw: { type: 'tool_progress', tool_name: 'Bash', tool_use_id: 'inner1', parent_tool_use_id: 'task1', elapsed_time_seconds: 45 },
  };
  const out = mergeToolPairs([task, inner, beat]);
  assert.equal(out[0].run, null);
  assert.equal(out[1].run.elapsedSeconds, 45);
});

test('missing elapsed time keeps the cue without a time', () => {
  const beat = hb('a', 1, undefined);
  const out = mergeToolPairs([use('a'), beat]);
  assert.deepEqual(toolRunView(out[0].run, false), { state: 'running', elapsedText: '', label: 'running' });
});

test('an aborted run stops the cue at the last time (result row of the run)', () => {
  const out = mergeToolPairs([use('a'), hb('a', 1, 120), { type: 'result', correlationId: C, ok: false }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].run.ended, true);
  assert.deepEqual(toolRunView(out[0].run, false), { state: 'stopped', elapsedText: '2m 00s', label: 'stopped after 2m 00s' });
});

test('historical session (opts.ended) renders the same; never a perpetual spinner', () => {
  const events = [use('a'), hb('a', 1, 30), hb('a', 12, 360), res('a'), use('b'), hb('b', 1, 30)];
  const out = mergeToolPairs(events, { ended: true });
  assert.equal(out.length, 2);
  assert.equal(toolRunView(out[0].run, true).label, 'took 6m 12s');
  assert.equal(toolRunView(out[1].run, false).state, 'stopped');
});

test('task_started with a matching tool folds into that block', () => {
  const ts = {
    type: 'system_event', subtype: 'task_started', correlationId: C,
    raw: { type: 'system', subtype: 'task_started', task_id: 'bx1', tool_use_id: 'a', task_type: 'local_bash', is_backgrounded: false, description: 'sleep' },
  };
  assert.equal(isTaskStartedEvent(ts), true);
  const out = mergeToolPairs([use('a'), ts, res('a')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].run.task.taskId, 'bx1');
  assert.deepEqual(taskStartedRows(out[0].run.task), [['task', 'bx1'], ['type', 'local_bash'], ['mode', 'foreground']]);
  // No heartbeats → no duration cue, but the task info is still folded.
  assert.equal(toolRunView(out[0].run, true).state, null);
});

test('unmatched task_started and other events pass through unchanged', () => {
  const ts = { type: 'system_event', subtype: 'task_started', raw: { tool_use_id: 'nope', task_id: 'x' } };
  const upd = { type: 'system_event', subtype: 'task_updated', raw: { tool_use_id: 'a' } };
  const other = { type: 'unknown', raw: { type: 'rate_limit_event' }, _key: 'k1' };
  const out = mergeToolPairs([use('a'), ts, upd, other]);
  assert.equal(out.length, 4);
  assert.equal(out[1].subtype, 'task_started');
  assert.equal(out[2].subtype, 'task_updated');
  assert.equal(out[3]._key, 'k1');
  assert.equal(out[0].run, null);
});

test('orphan tool_result passes through for the single-sided block', () => {
  const out = mergeToolPairs([res('zzz')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'tool_result');
});
