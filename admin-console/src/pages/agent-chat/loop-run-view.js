// Pure, framework-free helpers for making a *running* chat-launched loop
// transparent (#1155): the composer summary card and the session-log loop
// entry. A launched loop keeps its full config client-side (ChatPanel's
// `activeLoop`, from `GET /api/agents/:id/triggers`); live progress rides in
// on the numbered `trigger.fired` session-log rows the runtime now emits
// (`loopIteration` / `loopMaxIterations`). Kept out of the JSX so it carries
// its own node:test suite, mirroring trigger-summary.js / loop-form-options.js.

import { isLaunchedLoop } from './trigger-summary.js';

// Compact a token budget for a badge: 2000000 → "2M", 500000 → "500k",
// 750 → "750". (Local copy — trigger-summary.js keeps its own private one.)
function compactTokens(n) {
  return n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${Math.round(n / 1_000)}k`
      : String(n);
}

// Human-friendly gap, e.g. 60 → "1 min", 90 → "90 sec", 300 → "5 min".
function formatGap(sec) {
  if (sec % 60 === 0) {
    const m = sec / 60;
    return `${m} min`;
  }
  return `${sec} sec`;
}

// A verifier row for the summary (AC4). A chat-launched loop is a standalone
// run, so an absent/empty `verify` means the loop grades itself — surface that
// explicitly ("Self-graded") rather than leaving the row blank.
function buildVerifyRow(v) {
  if (v && typeof v === 'object') {
    if (v.agentId && String(v.agentId).trim()) {
      return { kind: 'agent', label: 'Verified by', value: String(v.agentId).trim() };
    }
    if (v.command && String(v.command).trim()) {
      return { kind: 'command', label: 'Verified by command', value: String(v.command).trim() };
    }
    if (v.flow === true) {
      return { kind: 'flow', label: 'Verification', value: 'Flow hand-off (downstream QS chain)' };
    }
  }
  return { kind: 'self', label: 'Verification', value: 'Self-graded' };
}

// Normalise a progress hint (from latestLoopProgress or an API) into
// `{ iteration, maxIterations|null }`, or null when there is nothing usable.
// A missing / <1 iteration means "no reliable count yet" → neutral running
// state (never a fabricated number, AC5 edge case).
function normalizeProgress(progress, fallbackMax) {
  if (!progress || typeof progress !== 'object') return null;
  const it = Number(progress.iteration);
  if (!Number.isFinite(it) || it < 1) return null;
  const rawCap = Number(progress.maxIterations);
  const cap = Number.isFinite(rawCap) && rawCap > 0
    ? rawCap
    : (Number.isFinite(fallbackMax) && fallbackMax > 0 ? fallbackMax : null);
  return { iteration: it, maxIterations: cap };
}

// Structured, render-ready model of a running loop's configuration + progress.
// Returns `{ prompt, stop: [{key,label,value}], verify: {kind,label,value},
// progress: {iteration, maxIterations|null} | null }`. Every stop-condition row
// is omitted unless the field was actually configured (AC3) — so a minimal loop
// renders cleanly with no blank rows. `maxIterations` is required by the loop
// schema, so it is always present when valid.
export function buildLoopSummaryModel(trigger, progress = null) {
  const t = trigger && typeof trigger === 'object' ? trigger : {};
  const prompt = typeof t.prompt === 'string' ? t.prompt : '';

  const stop = [];
  const max = Number(t.maxIterations);
  const hasMax = Number.isFinite(max) && max > 0;
  if (hasMax) stop.push({ key: 'maxIterations', label: 'Max iterations', value: String(max) });

  const untilCmd = t.until && typeof t.until === 'object' ? t.until.command : null;
  if (untilCmd && String(untilCmd).trim()) {
    stop.push({ key: 'until', label: 'Stops when', value: String(untilCmd).trim() });
  }

  const maxTokens = Number(t.maxTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    stop.push({ key: 'maxTokens', label: 'Token budget', value: compactTokens(maxTokens) });
  }

  const gap = Number(t.minGapSeconds);
  if (Number.isFinite(gap) && gap > 0) {
    stop.push({ key: 'minGapSeconds', label: 'Gap between runs', value: formatGap(gap) });
  }

  return {
    prompt,
    stop,
    verify: buildVerifyRow(t.verify),
    progress: normalizeProgress(progress, hasMax ? max : null),
  };
}

// Whether a session-log event is a loop iteration firing (#1155 AC7).
export function isLoopFired(event) {
  return !!event && event.type === 'trigger.fired' && event.triggerType === 'loop';
}

// Newest loop-iteration progress for a given trigger id, derived from a
// session-log event list (oldest→newest, as the backfill endpoint returns
// them). Returns `{ iteration, maxIterations|null }`, or null when no numbered
// loop firing for that trigger is present — a launched loop between iterations,
// or a legacy un-numbered firing, both read as a neutral running state (AC5).
export function latestLoopProgress(events, triggerId) {
  if (!Array.isArray(events) || !triggerId) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!isLoopFired(ev)) continue;
    if ((ev.triggerId || ev.id) !== triggerId) continue;
    const it = Number(ev.loopIteration);
    if (!Number.isFinite(it) || it < 1) return null;
    const cap = Number(ev.loopMaxIterations);
    return { iteration: it, maxIterations: Number.isFinite(cap) && cap > 0 ? cap : null };
  }
  return null;
}

// Short label for a running loop's progress chip, e.g. "Iteration 3 of 25",
// "Iteration 3", or "Running…" when no reliable count is available (AC5).
export function progressLabel(progress) {
  if (!progress || typeof progress !== 'object') return 'Running…';
  const it = Number(progress.iteration);
  if (!Number.isFinite(it) || it < 1) return 'Running…';
  const cap = Number(progress.maxIterations);
  return Number.isFinite(cap) && cap > 0 ? `Iteration ${it} of ${cap}` : `Iteration ${it}`;
}

// ── finished-loop record (#1231) ─────────────────────────────────────────────
// A launched loop self-removes on any terminal outcome, so the running
// `LoopSummaryCard` unmounts and its config vanishes. The runtime persists a
// structured `io.aee.loop-record` payload on the terminal message — config +
// terminal outcome + iterations — so the finished loop stays reviewable in
// scrollback and re-runnable. These helpers turn that payload into a render
// model and back into the launcher's `initialValues`, reusing the running
// card's `buildLoopSummaryModel` so both surfaces show the same fields.

// Display metadata for a terminal outcome: a human label and a semantic tone
// the card colours by. Unknown outcomes fall back to a neutral label.
export function loopOutcomeMeta(outcome) {
  switch (outcome) {
    case 'done':      return { label: 'Done',      tone: 'success' };
    case 'exhausted': return { label: 'Exhausted', tone: 'neutral' };
    case 'paused':    return { label: 'Paused',    tone: 'warning' };
    case 'stopped':   return { label: 'Stopped',   tone: 'neutral' };
    default:          return { label: outcome ? String(outcome) : 'Finished', tone: 'neutral' };
  }
}

// A compact "<Outcome> · <ran> of <cap>" summary chip for the finished-loop
// card (AC5). Omits the " of <cap>" tail when no cap is known.
export function loopRecordSummary(record) {
  const r = record && typeof record === 'object' ? record : {};
  const { label } = loopOutcomeMeta(r.outcome);
  const it = Number(r.iterations);
  const ran = Number.isFinite(it) && it >= 0 ? it : null;
  const cap = Number(r.config && r.config.maxIterations);
  const capOk = Number.isFinite(cap) && cap > 0;
  if (ran == null) return label;
  return capOk ? `${label} · ${ran} of ${cap}` : `${label} · ${ran}`;
}

// Structured, render-ready model of a *finished* loop (#1231). Reuses
// `buildLoopSummaryModel` for the shared config fields (prompt / stop rows /
// verify) so the persisted card and the running card render identically, and
// adds the terminal outcome + iteration count. `progress` is intentionally
// null — a finished loop has no live progress.
export function buildLoopRecordModel(record) {
  const r = record && typeof record === 'object' ? record : {};
  const config = r.config && typeof r.config === 'object' ? r.config : {};
  const base = buildLoopSummaryModel(config, null);
  const it = Number(r.iterations);
  return {
    ...base,
    outcome: r.outcome || null,
    outcomeMeta: loopOutcomeMeta(r.outcome),
    iterations: Number.isFinite(it) && it >= 0 ? it : null,
    summary: loopRecordSummary(r),
  };
}

// Turn a persisted loop record into the loop launcher's `initialValues` so
// "Start again" (AC7/AC8) opens the configuration dialog pre-filled with the
// finished loop's settings. Only the fields `TriggerForm` reads for a loop are
// emitted; `id` is deliberately omitted so starting creates a NEW independent
// loop rather than colliding with the removed trigger.
export function loopRecordToInitialValues(record) {
  const r = record && typeof record === 'object' ? record : {};
  const config = r.config && typeof r.config === 'object' ? r.config : {};
  const values = { type: 'loop' };
  if (typeof config.prompt === 'string') values.prompt = config.prompt;
  if (Number.isFinite(Number(config.maxIterations))) values.maxIterations = Number(config.maxIterations);
  if (config.until && typeof config.until === 'object'
      && typeof config.until.command === 'string' && config.until.command.trim()) {
    values.until = { command: config.until.command };
  }
  if (Number.isFinite(Number(config.maxTokens))) values.maxTokens = Number(config.maxTokens);
  if (Number.isFinite(Number(config.minGapSeconds))) values.minGapSeconds = Number(config.minGapSeconds);
  if (config.verify && typeof config.verify === 'object') values.verify = config.verify;
  if (typeof r.description === 'string' && r.description) values.description = r.description;
  return values;
}

// Label for a loop `trigger.fired` row in the session log (#1155 AC7): a loop
// iteration reads as a loop and carries its number, never a bare
// "Trigger fired: <id>". Falls back to a plain "Loop iteration" when the row
// predates the numbered payload.
export function loopFiredLabel(event) {
  const it = Number(event?.loopIteration);
  if (!Number.isFinite(it) || it < 1) return 'Loop iteration';
  const cap = Number(event?.loopMaxIterations);
  return Number.isFinite(cap) && cap > 0
    ? `Loop · iteration ${it} of ${cap}`
    : `Loop · iteration ${it}`;
}

// ── live loop signals (#2683) ────────────────────────────────────────────────
// The composer's running state is polled from the trigger list every 15 s, but
// the live timeline already tells us when a loop moves on: the runtime posts a
// `⚡ Trigger fired` notice (`io.aee.trigger`, triggerType 'loop') before each
// iteration, and the terminal message carries `io.aee.loop-record` — posted
// only AFTER a launched loop removed itself from triggers.json. These helpers
// let ChatPanel react to those events at once instead of waiting for the poll.

// Classify a live Matrix event's content: `{ kind: 'finished', triggerId }` for
// a finished-loop record, `{ kind: 'iteration', triggerId }` for a loop's
// trigger notice, else null. `triggerId` is null when the payload lacks one.
export function liveLoopSignal(content) {
  if (!content || typeof content !== 'object') return null;
  const record = content['io.aee.loop-record'];
  if (record && typeof record === 'object') {
    return { kind: 'finished', triggerId: record.triggerId ? String(record.triggerId) : null };
  }
  const trig = content['io.aee.trigger'];
  if (trig && typeof trig === 'object' && trig.triggerType === 'loop') {
    return { kind: 'iteration', triggerId: trig.triggerId ? String(trig.triggerId) : null };
  }
  return null;
}

// The running launched loop in a trigger list, skipping ids the live timeline
// already reported as finished. On an isolated agent volume the orchestrator's
// canonical copy can still list the loop for a moment after its record arrived
// (the removal is posted asynchronously), and that stale row must not bring
// the "Loop running" banner back.
export function runningLaunchedLoop(list, finishedIds) {
  if (!Array.isArray(list)) return null;
  const done = finishedIds instanceof Set ? finishedIds : new Set(finishedIds || []);
  return list.find(t => isLaunchedLoop(t) && !done.has(t.id)) || null;
}
