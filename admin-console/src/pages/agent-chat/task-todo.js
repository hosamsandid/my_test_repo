// Pure helpers for the Session Log's live TODO surfaces (#255, #1662).
//
// The agent runtime once tracked its checklist with a single `TodoWrite` tool
// call that carried the ENTIRE todo list (`input.todos`) on every call, so
// "latest wins, no merging" (the #255 design) was enough. It now tracks tasks
// INCREMENTALLY with `TaskCreate` / `TaskUpdate` (and `TaskList` / `TaskGet`
// for reads): each event mutates one task, and no single event contains the
// whole list. These helpers fold that event stream into the current task list,
// expressed in the SAME `{ content, activeForm, status }` shape the existing
// PinnedTodoPanel / TodoList components already render — so the frontend view
// is unchanged, only how the list is assembled differs.
//
// Field mapping (issue #1662 Open Question 3):
//   TaskCreate  input: { subject, description?, activeForm? }  → new task
//   TaskUpdate  input: { taskId, status?, subject?, activeForm? } → mutate/remove
//   status:     'pending' | 'in_progress' | 'completed' | 'deleted'
// Task ids are assigned by the runtime in creation order ("1", "2", …); since
// TaskCreate's input carries no id, we assign the same 1-based creation-order
// id so a later TaskUpdate keyed on `taskId` matches. An update for an unseen
// id degrades gracefully (a stub task is created) rather than being dropped.

const TASK_WRITE_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']);
const TASK_READ_TOOLS = new Set(['TaskList', 'TaskGet']);

// Shown in place of a blank row when a TaskUpdate lands on an id whose
// TaskCreate fell outside the current fold window (#2203) — a status-only
// update (the realistic shape) never has a subject to fill the gap with.
const UNKNOWN_CONTENT_PLACEHOLDER = '(task created earlier in this session)';

/** True for any of the current task-tracking tools (writes and reads) plus the
 *  legacy `TodoWrite`, so the Session Log renders them as rich TODO entries. */
export function isTaskTool(tool) {
  return TASK_WRITE_TOOLS.has(tool) || TASK_READ_TOOLS.has(tool);
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

function firstStr(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

function emptyState() {
  return { byId: new Map(), order: [], seq: 0 };
}

function normalizeCreated(input) {
  return {
    content: firstStr(input?.subject, input?.content, input?.description),
    activeForm: str(input?.activeForm),
    status: 'pending',
  };
}

function normalizeTodoItem(t) {
  const status = str(t?.status) || 'pending';
  return {
    content: firstStr(t?.content, t?.subject, t?.activeForm),
    activeForm: str(t?.activeForm),
    status,
  };
}

/**
 * Apply one task tool call `(tool, input)` to a mutable fold `state`.
 * Returns true iff the call changed the task list (writes that mutate);
 * reads (`TaskList` / `TaskGet`) and no-op updates return false.
 *
 * `state` = { byId: Map<id, task>, order: string[], seq: number }.
 */
export function applyTaskOp(state, tool, input) {
  if (tool === 'TodoWrite') {
    // Legacy full-list snapshot — replace the whole list (kept so historical
    // TodoWrite session logs still render; #1662 "must not regress").
    state.byId = new Map();
    state.order = [];
    state.seq = 0;
    const todos = Array.isArray(input?.todos) ? input.todos : [];
    for (const t of todos) {
      const id = String(++state.seq);
      state.byId.set(id, normalizeTodoItem(t));
      state.order.push(id);
    }
    return true;
  }

  if (tool === 'TaskCreate') {
    const id = String(++state.seq);
    state.byId.set(id, normalizeCreated(input));
    state.order.push(id);
    return true;
  }

  if (tool === 'TaskUpdate') {
    const id = input && input.taskId != null ? String(input.taskId) : '';
    if (!id) return false;

    if (str(input.status) === 'deleted') {
      if (!state.byId.has(id)) return false;
      state.byId.delete(id);
      state.order = state.order.filter((x) => x !== id);
      return true;
    }

    let task = state.byId.get(id);
    if (!task) {
      // Update for an id we never saw created (diverged numbering, missed
      // event, resumed session): create a stub so the update still shows.
      // `contentUnknown` distinguishes this from a legitimately empty
      // content and drives the placeholder `snapshotTasks` renders instead
      // of a blank row (#2203) — it clears the moment real content arrives.
      task = { content: '', activeForm: '', status: 'pending', contentUnknown: true };
      state.byId.set(id, task);
      state.order.push(id);
      const n = Number(id);
      if (Number.isFinite(n) && n > state.seq) state.seq = n;
    }
    if (typeof input.subject === 'string' && input.subject.length > 0) {
      task.content = input.subject;
      task.contentUnknown = false;
    }
    if (input.activeForm != null) task.activeForm = str(input.activeForm);
    if (typeof input.status === 'string' && input.status.length > 0) task.status = input.status;
    return true;
  }

  // TaskList / TaskGet — reads, no mutation.
  return false;
}

/** Immutable snapshot of the current task list (creation order). */
export function snapshotTasks(state) {
  return state.order.map((id) => {
    const t = state.byId.get(id);
    const content = t.contentUnknown && !t.content ? UNKNOWN_CONTENT_PLACEHOLDER : t.content;
    return { content, activeForm: t.activeForm, status: t.status };
  });
}

/** Extract a `(tool, input, toolId, correlationId)` op from a render row —
 *  from a merged `{ kind:'tool', toolUse }` row or a raw `tool_use` event. */
function taskOpFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.kind === 'tool' && row.toolUse && isTaskTool(row.toolUse.tool)) {
    return {
      tool: row.toolUse.tool,
      input: row.toolUse.input,
      toolId: row.toolUse.toolId || null,
      correlationId: row.correlationId != null ? row.correlationId : null,
    };
  }
  if (row.type === 'tool_use' && isTaskTool(row.tool)) {
    return {
      tool: row.tool,
      input: row.input,
      toolId: row.toolId || null,
      correlationId: row.correlationId != null ? row.correlationId : null,
    };
  }
  return null;
}

/**
 * Walk ordered render rows once, folding every task tool call into a running
 * list. Each task row gets a `taskSnapshot` (the list as of that row) so the
 * inline event stream can show a rich checklist + `<done>/<total> · <step>`
 * summary; the final list drives the pinned TODO panel.
 *
 * Returns:
 *   rows:            the input rows, with `taskSnapshot` attached to task rows
 *   todos:           the final assembled list ({content,activeForm,status}[])
 *   lastToolId:      toolId of the last list-CHANGING event (drives the pinned
 *                    panel's dismiss-until-next-change contract, #273/AC6)
 *   lastCorrelationId: its correlationId (cross-panel hover)
 */
export function annotateTaskRows(rows) {
  const state = emptyState();
  let lastToolId = null;
  let lastCorrelationId = null;
  const list = Array.isArray(rows) ? rows : [];

  const outRows = list.map((row) => {
    const op = taskOpFromRow(row);
    if (!op) return row;
    const changed = applyTaskOp(state, op.tool, op.input);
    if (changed) {
      lastToolId = op.toolId;
      lastCorrelationId = op.correlationId;
    }
    return { ...row, taskSnapshot: snapshotTasks(state) };
  });

  return {
    rows: outRows,
    todos: snapshotTasks(state),
    lastToolId,
    lastCorrelationId,
  };
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * One-line summary of a task list: `<done>/<total> · <current step>`.
 * Current step = the in-progress task's active form (or title); else the first
 * pending title; else "all done". Mirrors the #255 fallback order exactly.
 * Unchanged in spirit from the original TodoWrite summary — now driven by the
 * folded list rather than a single call's `input.todos`.
 */
export function formatTodoSummary(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return '(no todos)';
  const total = todos.length;
  const done = todos.filter((t) => t?.status === 'completed').length;
  const active = todos.find((t) => t?.status === 'in_progress');
  const label = active
    ? (active.activeForm || active.content || '')
    : (done === total ? 'all done' : (todos.find((t) => t?.status === 'pending')?.content || ''));
  return `${done}/${total} · ${truncate(label, 60)}`;
}
