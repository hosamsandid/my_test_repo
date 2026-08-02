// Pure, framework-free helpers for making a *running* chat-launched loop
// transparent (#1155): the composer summary card and the session-log loop
// entry. A launched loop keeps its full config client-side (ChatPanel's
// `activeLoop`, from `GET /api/agents/:id/triggers`); live progress rides in
// on the numbered `trigger.fired` session-log rows the runtime now emits
// (`loopIteration` / `loopMaxIterations`). Kept out of the JSX so it carries
// its own node:test suite, mirroring trigger-summary.js / loop-form-options.js.

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
