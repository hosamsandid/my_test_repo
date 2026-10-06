// Pure, React-free tool-call pairing for the Session Log (#2841, #651
// convention). One tool call renders as ONE block: its `tool_use`, the matching
// `tool_result`, the CLI's `tool_progress` heartbeats (~every 30 s while the
// call is in flight) and the `system / task_started` row Claude Code emits for
// it are all folded into a single `{ kind: 'tool', … }` row.
//
// Heartbeats reach the log as the runtime's generic envelope
// `{ type: 'unknown', raw: { type: 'tool_progress', … } }` (agent-entrypoint.py
// does not map them), so stored logs and live tails are recognised the same
// way. Same idea as the #870 thinking_tokens consolidation, but attached to the
// tool block the heartbeat belongs to.

const HEARTBEAT_ID_SUFFIX = /-heartbeat-\d+$/;

// A `tool_progress` heartbeat — the generic `unknown` envelope (how the runtime
// stores it) or a bare `tool_progress` event.
export function isToolHeartbeat(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.type === 'tool_progress') return true;
  return ev.type === 'unknown' && !!ev.raw && typeof ev.raw === 'object' && ev.raw.type === 'tool_progress';
}

function heartbeatRaw(ev) {
  return ev.type === 'tool_progress' ? ev : ev.raw;
}

// The tool ids a heartbeat may refer to, most specific first. Observed shape:
// `tool_use_id: "<id>-heartbeat-<n>"` + `parent_tool_use_id: "<id>"`; the SDK
// shape names the running tool in `tool_use_id` and its sub-agent parent in
// `parent_tool_use_id`. Trying the inner id first attaches a sub-agent's tool
// heartbeat to that inner tool, never to the parent Task block.
export function heartbeatTargetIds(raw) {
  const ids = [];
  const own = typeof raw?.tool_use_id === 'string' ? raw.tool_use_id : '';
  if (own) {
    const stripped = own.replace(HEARTBEAT_ID_SUFFIX, '');
    if (stripped) ids.push(stripped);
  }
  const parent = typeof raw?.parent_tool_use_id === 'string' ? raw.parent_tool_use_id : '';
  if (parent && !ids.includes(parent)) ids.push(parent);
  return ids;
}

// Elapsed seconds reported by a heartbeat, or null when missing/non-numeric
// (the indicator then shows the running cue without a time — never NaN).
export function heartbeatElapsed(raw) {
  const v = raw?.elapsed_time_seconds;
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// `system / task_started` naming a tool call (`tool_use_id`).
export function isTaskStartedEvent(ev) {
  return !!ev && ev.type === 'system_event' && ev.subtype === 'task_started'
    && typeof ev.raw?.tool_use_id === 'string' && ev.raw.tool_use_id !== '';
}

// Human-readable duration: `45s`, `6m 00s`, `1h 02m`. '' when unknown.
export function formatElapsed(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

function tsMs(ts) {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

function taskInfo(raw) {
  return {
    taskId: typeof raw.task_id === 'string' ? raw.task_id : null,
    taskType: typeof raw.task_type === 'string' ? raw.task_type : null,
    backgrounded: typeof raw.is_backgrounded === 'boolean' ? raw.is_backgrounded : null,
    description: typeof raw.description === 'string' ? raw.description : null,
  };
}

/**
 * Walk the event list once and fold every tool call into one row:
 *   { kind: 'tool', ts, correlationId, toolUse, toolResult, run, _key }
 * `run` is null for a call that produced neither heartbeat nor task_started,
 * else { heartbeats, elapsedSeconds, lastHeartbeat, task, ended,
 * durationSeconds }:
 *   * heartbeats       — count folded in before the result;
 *   * elapsedSeconds   — latest heartbeat's elapsed time (null if unknown);
 *   * lastHeartbeat    — that heartbeat's raw payload (AC8, for debugging);
 *   * task             — the folded task_started info (task id, type, …);
 *   * ended            — still pending, but its run is over (a `result` row of
 *                        the same run followed, or `opts.ended`): no running cue;
 *   * durationSeconds  — once finished, the call's final duration (the result
 *                        row's timestamp minus the use's, or the last heartbeat
 *                        when that is larger) — only when heartbeats were seen.
 *
 * Unpaired uses keep `toolResult: null`; orphan results pass through for
 * LogEvent's single-sided ToolBlock. A heartbeat whose tool is not in the list
 * collapses into ONE `tool_progress_orphan` row per tool id, updated in place.
 * A heartbeat arriving after its tool's result is ignored (never re-opens it).
 * task_started without a matching tool keeps its own row. Everything else
 * passes through untouched, keeping an upstream stable `_key` (#870).
 */
export function mergeToolPairs(events, opts = {}) {
  const out = [];
  if (!Array.isArray(events)) return out;
  const indexByToolId = new Map();  // every tool block seen so far
  const pending = new Set();        // tool ids still awaiting a result
  const orphanByToolId = new Map(); // tool id → index of its collapsed heartbeat row
  const useTsByToolId = new Map();

  const withRun = (row) => row.run || {
    heartbeats: 0, elapsedSeconds: null, lastHeartbeat: null, task: null,
    ended: false, durationSeconds: null,
  };

  events.forEach((ev, idx) => {
    if (!ev || typeof ev !== 'object') {
      out.push({ ...ev, _key: `e${idx}` });
      return;
    }
    if (ev.type === 'tool_use' && ev.toolId) {
      indexByToolId.set(ev.toolId, out.length);
      pending.add(ev.toolId);
      useTsByToolId.set(ev.toolId, tsMs(ev.ts));
      out.push({
        kind: 'tool',
        ts: ev.ts,
        correlationId: ev.correlationId,
        toolUse: { tool: ev.tool, toolId: ev.toolId, input: ev.input },
        toolResult: null,
        run: null,
        _key: `tool-${ev.toolId}-${idx}`,
      });
      return;
    }
    if (ev.type === 'tool_result' && ev.toolId && pending.has(ev.toolId)) {
      const i = indexByToolId.get(ev.toolId);
      pending.delete(ev.toolId);
      const target = out[i];
      let run = target.run;
      if (run && run.heartbeats > 0) {
        const start = useTsByToolId.get(ev.toolId);
        const end = tsMs(ev.ts);
        const byTs = start != null && end != null && end >= start ? (end - start) / 1000 : null;
        const byHb = run.elapsedSeconds;
        const duration = byTs != null && (byHb == null || byTs >= byHb) ? byTs : byHb;
        run = { ...run, ended: false, durationSeconds: duration };
      }
      out[i] = { ...target, toolResult: { ok: ev.ok !== false, content: ev.content }, run };
      return;
    }
    if (isToolHeartbeat(ev)) {
      const raw = heartbeatRaw(ev);
      const ids = heartbeatTargetIds(raw);
      const known = ids.find(id => indexByToolId.has(id));
      if (known) {
        // Late heartbeat for a finished call: dropped, it must not re-open it.
        if (!pending.has(known)) return;
        const i = indexByToolId.get(known);
        const run = withRun(out[i]);
        const elapsed = heartbeatElapsed(raw);
        out[i] = {
          ...out[i],
          run: {
            ...run,
            heartbeats: run.heartbeats + 1,
            elapsedSeconds: elapsed ?? run.elapsedSeconds,
            lastHeartbeat: raw,
          },
        };
        return;
      }
      const id = ids[0] || '';
      const elapsed = heartbeatElapsed(raw);
      if (orphanByToolId.has(id)) {
        const i = orphanByToolId.get(id);
        const prev = out[i];
        out[i] = {
          ...prev,
          heartbeats: prev.heartbeats + 1,
          elapsedSeconds: elapsed ?? prev.elapsedSeconds,
          tool: (typeof raw?.tool_name === 'string' && raw.tool_name) || prev.tool,
          raw,
        };
        return;
      }
      orphanByToolId.set(id, out.length);
      out.push({
        type: 'tool_progress_orphan',
        ts: ev.ts,
        correlationId: ev.correlationId,
        toolId: id,
        tool: (typeof raw?.tool_name === 'string' && raw.tool_name) || null,
        heartbeats: 1,
        elapsedSeconds: elapsed,
        raw,
        _key: `hb-${id || idx}`,
      });
      return;
    }
    if (isTaskStartedEvent(ev) && indexByToolId.has(ev.raw.tool_use_id)) {
      const i = indexByToolId.get(ev.raw.tool_use_id);
      out[i] = { ...out[i], run: { ...withRun(out[i]), task: { ...taskInfo(ev.raw), raw: ev.raw } } };
      return;
    }
    if (ev.type === 'result') {
      // The run is over: a call of it still pending was cut off (abort/stop).
      for (const id of pending) {
        const i = indexByToolId.get(id);
        if (out[i].correlationId === ev.correlationId && out[i].run) {
          out[i] = { ...out[i], run: { ...out[i].run, ended: true } };
        }
      }
    }
    out.push({ ...ev, _key: ev._key ?? `e${idx}` });
  });

  if (opts.ended) {
    for (const id of pending) {
      const i = indexByToolId.get(id);
      if (out[i].run) out[i] = { ...out[i], run: { ...out[i].run, ended: true } };
    }
  }
  return out;
}

/**
 * Display state of one tool block's run, for ToolBlock:
 *   { state: 'running' | 'stopped' | 'done' | null, elapsedText, label }
 * `null` state = nothing new to show (no heartbeat folded in).
 */
export function toolRunView(run, finished) {
  if (!run || !(run.heartbeats > 0)) return { state: null, elapsedText: '', label: '' };
  if (finished) {
    const text = formatElapsed(run.durationSeconds);
    return { state: 'done', elapsedText: text, label: text ? `took ${text}` : '' };
  }
  const text = formatElapsed(run.elapsedSeconds);
  if (run.ended) {
    return { state: 'stopped', elapsedText: text, label: text ? `stopped after ${text}` : 'stopped' };
  }
  return { state: 'running', elapsedText: text, label: text ? `running · ${text}` : 'running' };
}

// Summary line of a collapsed orphan heartbeat row (AC6).
export function orphanHeartbeatSummary(row) {
  const tool = row?.tool || 'Tool';
  const text = formatElapsed(row?.elapsedSeconds);
  return text ? `${tool} still running · ${text}` : `${tool} still running`;
}

// Readable [label, value] rows for the folded task_started info (AC11).
export function taskStartedRows(task) {
  if (!task) return [];
  const rows = [];
  if (task.taskId) rows.push(['task', task.taskId]);
  if (task.taskType) rows.push(['type', task.taskType]);
  if (task.backgrounded !== null && task.backgrounded !== undefined) {
    rows.push(['mode', task.backgrounded ? 'background' : 'foreground']);
  }
  return rows;
}
