import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isTaskTool,
  applyTaskOp,
  snapshotTasks,
  annotateTaskRows,
  formatTodoSummary,
} from './task-todo.js';

// ── Helpers ───────────────────────────────────────────────────────────────

// Build a merged tool render row (as SessionLogPanel's mergeToolPairs emits).
function toolRow(tool, input, { toolId, correlationId } = {}) {
  return {
    kind: 'tool',
    ts: '2026-01-01T00:00:00Z',
    correlationId: correlationId ?? null,
    toolUse: { tool, toolId: toolId ?? `toolu_${tool}`, input },
    toolResult: null,
  };
}

function fold(events) {
  const state = { byId: new Map(), order: [], seq: 0 };
  for (const [tool, input] of events) applyTaskOp(state, tool, input);
  return snapshotTasks(state);
}

// ── isTaskTool ──────────────────────────────────────────────────────────────

test('isTaskTool recognises the current + legacy task tools', () => {
  for (const t of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite']) {
    assert.equal(isTaskTool(t), true, t);
  }
  for (const t of ['Read', 'Write', 'Bash', 'Edit', 'Grep', undefined, null, '']) {
    assert.equal(isTaskTool(t), false, String(t));
  }
});

// ── Incremental fold: create / update / delete ────────────────────────────

test('TaskCreate adds tasks in creation order, all pending', () => {
  const todos = fold([
    ['TaskCreate', { subject: 'Design', description: 'plan it' }],
    ['TaskCreate', { subject: 'Build', activeForm: 'Building' }],
  ]);
  assert.deepEqual(todos, [
    { content: 'Design', activeForm: '', status: 'pending' },
    { content: 'Build', activeForm: 'Building', status: 'pending' },
  ]);
});

test('TaskUpdate keyed on the creation-order id mutates the right task', () => {
  const todos = fold([
    ['TaskCreate', { subject: 'A' }],
    ['TaskCreate', { subject: 'B' }],
    ['TaskCreate', { subject: 'C' }],
    ['TaskUpdate', { taskId: '2', status: 'in_progress' }],
    ['TaskUpdate', { taskId: '1', status: 'completed' }],
  ]);
  assert.deepEqual(todos, [
    { content: 'A', activeForm: '', status: 'completed' },
    { content: 'B', activeForm: '', status: 'in_progress' },
    { content: 'C', activeForm: '', status: 'pending' },
  ]);
});

test('numeric taskId matches the string creation-order id', () => {
  const todos = fold([
    ['TaskCreate', { subject: 'A' }],
    ['TaskUpdate', { taskId: 1, status: 'completed' }],
  ]);
  assert.equal(todos[0].status, 'completed');
});

test('TaskUpdate can change subject / activeForm as well as status', () => {
  const todos = fold([
    ['TaskCreate', { subject: 'Draft' }],
    ['TaskUpdate', { taskId: '1', subject: 'Draft v2', activeForm: 'Drafting v2', status: 'in_progress' }],
  ]);
  assert.deepEqual(todos, [
    { content: 'Draft v2', activeForm: 'Drafting v2', status: 'in_progress' },
  ]);
});

test('TaskUpdate status=deleted drops the task, not a ghost', () => {
  const todos = fold([
    ['TaskCreate', { subject: 'A' }],
    ['TaskCreate', { subject: 'B' }],
    ['TaskUpdate', { taskId: '1', status: 'deleted' }],
  ]);
  assert.deepEqual(todos, [{ content: 'B', activeForm: '', status: 'pending' }]);
});

test('deleting a task then creating another does not reuse the id', () => {
  const todos = fold([
    ['TaskCreate', { subject: 'A' }],  // id 1
    ['TaskCreate', { subject: 'B' }],  // id 2
    ['TaskUpdate', { taskId: '2', status: 'deleted' }],
    ['TaskCreate', { subject: 'C' }],  // id 3, not 2
    ['TaskUpdate', { taskId: '3', status: 'completed' }],
  ]);
  assert.deepEqual(todos, [
    { content: 'A', activeForm: '', status: 'pending' },
    { content: 'C', activeForm: '', status: 'completed' },
  ]);
});

// ── Graceful degradation ──────────────────────────────────────────────────

test('TaskUpdate for an unseen id creates a stub rather than dropping it', () => {
  const todos = fold([
    ['TaskUpdate', { taskId: '5', status: 'in_progress', subject: 'Recovered' }],
  ]);
  assert.deepEqual(todos, [{ content: 'Recovered', activeForm: '', status: 'in_progress' }]);
});

test('a stubbed high id keeps later creates from colliding', () => {
  const todos = fold([
    ['TaskUpdate', { taskId: '3', status: 'in_progress' }], // stub id 3
    ['TaskCreate', { subject: 'New' }],                     // must be id 4
    ['TaskUpdate', { taskId: '4', status: 'completed' }],
  ]);
  assert.equal(todos.length, 2);
  assert.equal(todos[1].content, 'New');
  assert.equal(todos[1].status, 'completed');
});

test('TaskUpdate with no taskId is a no-op', () => {
  const state = { byId: new Map(), order: [], seq: 0 };
  assert.equal(applyTaskOp(state, 'TaskUpdate', { status: 'completed' }), false);
  assert.deepEqual(snapshotTasks(state), []);
});

test('malformed / missing inputs degrade without throwing', () => {
  const state = { byId: new Map(), order: [], seq: 0 };
  assert.doesNotThrow(() => {
    applyTaskOp(state, 'TaskCreate', undefined);
    applyTaskOp(state, 'TaskCreate', null);
    applyTaskOp(state, 'TaskUpdate', {});
    applyTaskOp(state, 'TodoWrite', { todos: 'nope' });
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────

test('TaskList / TaskGet are reads — no mutation, return false', () => {
  const state = { byId: new Map(), order: [], seq: 0 };
  applyTaskOp(state, 'TaskCreate', { subject: 'A' });
  assert.equal(applyTaskOp(state, 'TaskList', {}), false);
  assert.equal(applyTaskOp(state, 'TaskGet', { taskId: '1' }), false);
  assert.deepEqual(snapshotTasks(state), [{ content: 'A', activeForm: '', status: 'pending' }]);
});

// ── Legacy TodoWrite (backward compatibility) ───────────────────────────────

test('TodoWrite replaces the whole list (latest wins)', () => {
  const todos = fold([
    ['TaskCreate', { subject: 'stale' }],
    ['TodoWrite', { todos: [
      { content: 'X', status: 'completed' },
      { content: 'Y', activeForm: 'Doing Y', status: 'in_progress' },
    ] }],
  ]);
  assert.deepEqual(todos, [
    { content: 'X', activeForm: '', status: 'completed' },
    { content: 'Y', activeForm: 'Doing Y', status: 'in_progress' },
  ]);
});

// ── formatTodoSummary ───────────────────────────────────────────────────────

test('formatTodoSummary: empty', () => {
  assert.equal(formatTodoSummary([]), '(no todos)');
  assert.equal(formatTodoSummary(undefined), '(no todos)');
});

test('formatTodoSummary: in-progress task is the current step (activeForm preferred)', () => {
  const todos = [
    { content: 'A', status: 'completed' },
    { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
    { content: 'C', status: 'pending' },
  ];
  assert.equal(formatTodoSummary(todos), '1/3 · Doing B');
});

test('formatTodoSummary: no in-progress falls back to first pending', () => {
  const todos = [
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'pending' },
  ];
  assert.equal(formatTodoSummary(todos), '1/2 · B');
});

test('formatTodoSummary: all complete says "all done"', () => {
  const todos = [
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'completed' },
  ];
  assert.equal(formatTodoSummary(todos), '2/2 · all done');
});

// ── annotateTaskRows ────────────────────────────────────────────────────────

test('annotateTaskRows attaches a per-row snapshot reflecting state so far', () => {
  const rows = [
    toolRow('TaskCreate', { subject: 'A' }, { toolId: 't1', correlationId: 'c1' }),
    toolRow('TaskCreate', { subject: 'B' }, { toolId: 't2', correlationId: 'c1' }),
    toolRow('TaskUpdate', { taskId: '1', status: 'completed' }, { toolId: 't3', correlationId: 'c1' }),
  ];
  const { rows: out, todos, lastToolId, lastCorrelationId } = annotateTaskRows(rows);

  assert.equal(out[0].taskSnapshot.length, 1);
  assert.equal(out[1].taskSnapshot.length, 2);
  assert.equal(out[1].taskSnapshot[0].status, 'pending'); // not yet completed at row 1
  assert.equal(out[2].taskSnapshot[0].status, 'completed');

  // Earlier snapshots must not be mutated by later ops (immutability).
  assert.equal(out[0].taskSnapshot[0].status, 'pending');

  assert.deepEqual(todos, [
    { content: 'A', activeForm: '', status: 'completed' },
    { content: 'B', activeForm: '', status: 'pending' },
  ]);
  assert.equal(lastToolId, 't3');
  assert.equal(lastCorrelationId, 'c1');
});

test('annotateTaskRows: non-task rows pass through untouched', () => {
  const readRow = { kind: 'tool', toolUse: { tool: 'Read', toolId: 'r1', input: { file_path: '/x' } } };
  const textRow = { type: 'assistant_text', text: 'hi' };
  const { rows: out } = annotateTaskRows([readRow, textRow]);
  assert.equal(out[0], readRow);   // same reference, no taskSnapshot
  assert.equal(out[1], textRow);
  assert.equal('taskSnapshot' in out[0], false);
});

test('annotateTaskRows: reads do not advance lastToolId (dismiss contract)', () => {
  const rows = [
    toolRow('TaskCreate', { subject: 'A' }, { toolId: 'create1' }),
    toolRow('TaskList', {}, { toolId: 'list1' }),
  ];
  const { lastToolId } = annotateTaskRows(rows);
  assert.equal(lastToolId, 'create1'); // the read (list1) did not change the list
});

test('annotateTaskRows: raw tool_use rows (unmerged) are folded too', () => {
  const rows = [
    { type: 'tool_use', tool: 'TaskCreate', toolId: 'u1', correlationId: 'c1', input: { subject: 'A' } },
  ];
  const { rows: out, todos } = annotateTaskRows(rows);
  assert.equal(out[0].taskSnapshot.length, 1);
  assert.deepEqual(todos, [{ content: 'A', activeForm: '', status: 'pending' }]);
});

test('annotateTaskRows: no task tools → empty list, null lastToolId (no panel)', () => {
  const { todos, lastToolId } = annotateTaskRows([
    { kind: 'tool', toolUse: { tool: 'Bash', toolId: 'b1', input: { command: 'ls' } } },
  ]);
  assert.deepEqual(todos, []);
  assert.equal(lastToolId, null);
});

test('annotateTaskRows: all tasks deleted → empty list (no ghosts, no panel)', () => {
  const rows = [
    toolRow('TaskCreate', { subject: 'A' }, { toolId: 't1' }),
    toolRow('TaskUpdate', { taskId: '1', status: 'deleted' }, { toolId: 't2' }),
  ];
  const { todos } = annotateTaskRows(rows);
  assert.deepEqual(todos, []);
});
