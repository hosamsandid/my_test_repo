'use strict';

// Hill-climbing loop Phase 3 (#1226): before/after measurement verdicts and
// rollback-card synthesis — the step that closes the loop.
//
// Concept `docs/hill-climbing-agent-concept.md` §6. Every applied card
// (#1225) recorded, at apply time: the apply timestamp, a config-version
// reference marking the boundary the change created, the baseline metrics
// snapshot, and the undo payload. The daily pass (#1222) produces a fresh
// snapshot; once a full measurement window has elapsed *after the boundary*,
// this module compares the card's declared target metric before/after and
// renders a verdict:
//
//   improved  → `validated`
//   neutral   → `neutral` (finalises — "the change stays" — only after TWO
//               windows, so a change that merely looks flat at window 1 stays
//               measured and can still flip to validated/regressed at window 2)
//   regressed → the card flips to a **rollback card** citing both windows; the
//               undo is a human click, never auto-reverted (§6).
//   below `minRunsPerWindow`, or a target metric that can't be resolved on
//   either side → `insufficient-data`: verdict deferred, NEVER guessed.
//
// The honesty invariant (AC): a verdict is only ever computed from a window that
// lies entirely AFTER the config boundary — never one that spans two config
// versions of the target object. The boundary comes from the card's
// `configVersionRef` / `appliedAt` (audit + prompt-history timestamps, #1222),
// and the after-window's `fromMs` must be at or after it.
//
// Pure and fs-free, in the discipline of `hill-climb-metrics.js` /
// `hill-climb-cards.js`: no I/O, no LLM, golden-fixture testable. The
// orchestrator (`runHillClimbPass`) reads the store + the fresh snapshot and
// calls `applyVerdicts`; the console executes an approved rollback through the
// same audited choke-points as #1225.

const DAY_MS = 24 * 60 * 60 * 1000;

// Coerce epoch-ms or an ISO/date string to epoch ms; null when it isn't datable.
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

// Which way is "better" for a metric. Only success-rate style metrics improve by
// going UP; every other catalog metric (waste, rework, anomaly recurrence, dead
// config, time-to-done latency) improves by going DOWN. Keyed off the metric's
// leaf name so a `metrics.`-prefixed or bare path resolves the same way.
function metricDirection(targetMetric) {
  const norm = normalizeMetricPath(targetMetric);
  const leaf = norm.split('.').pop();
  if (leaf === 'runSuccessRate' || /successRate$/i.test(leaf)) return 'higher';
  return 'lower';
}

// Strip a leading `metrics.` (heuristic cards name some targets `waste.wasteRuns`
// and others `metrics.anomalyRecurrence`) so both resolve against the snapshot's
// `metrics` block identically.
function normalizeMetricPath(targetMetric) {
  let p = typeof targetMetric === 'string' ? targetMetric.trim() : '';
  if (p.startsWith('metrics.')) p = p.slice('metrics.'.length);
  else if (p === 'metrics') p = '';
  return p;
}

// Resolve a card's `targetMetric` to a comparable NUMBER from a snapshot's
// `metrics` block. Arrays (deadConfig lists) resolve to their length; the
// `timeToDone` object resolves to its p50 latency; a missing/non-numeric leaf is
// unresolved. Returns { value:number|null, found:bool }.
function resolveMetricValue(metricsBlock, targetMetric) {
  const path = normalizeMetricPath(targetMetric);
  if (!path || !metricsBlock || typeof metricsBlock !== 'object') {
    return { value: null, found: false };
  }
  let cur = metricsBlock;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return { value: null, found: false };
    cur = cur[key];
  }
  if (Array.isArray(cur)) return { value: cur.length, found: true };
  if (cur && typeof cur === 'object') {
    // timeToDone → p50 latency is the comparable scalar.
    if (typeof cur.p50Ms === 'number') return { value: cur.p50Ms, found: true };
    return { value: null, found: false };
  }
  if (typeof cur === 'number' && Number.isFinite(cur)) return { value: cur, found: true };
  return { value: null, found: false };
}

// The config-version boundary an applied card created: the moment after which the
// new config was live. `configVersionRef.at` is the exact mutation timestamp the
// console stamped; `appliedAt` is the card-record time. Use the later of the two
// present values so the after-window is guaranteed to sit past the change.
function configBoundaryMs(card) {
  const applied = toMs(card && card.appliedAt);
  const refAt = card && card.configVersionRef ? toMs(card.configVersionRef.at) : null;
  const candidates = [applied, refAt].filter((n) => n != null);
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

// Compute the before/after verdict for ONE applied card against a fresh snapshot.
// Pure. Returns a summary object; `cardStatus` is the lifecycle status to
// transition the card to, or null when the card must stay `applied` (verdict
// pending / deferred). See the module header for the state machine.
//
// opts: { now, windowDays, minRunsPerWindow, relativeBand=0.05, absoluteBand=0 }.
// windowDays / minRunsPerWindow default to the snapshot's own values.
function computeVerdict(card, afterSnapshot, opts = {}) {
  const now = toMs(opts.now) != null ? toMs(opts.now) : Date.now();
  const snap = afterSnapshot && typeof afterSnapshot === 'object' ? afterSnapshot : {};
  const windowDays = Number.isFinite(opts.windowDays) && opts.windowDays > 0
    ? opts.windowDays
    : (Number.isFinite(snap.windowDays) && snap.windowDays > 0 ? snap.windowDays : 7);
  const minRuns = Number.isFinite(opts.minRunsPerWindow) && opts.minRunsPerWindow >= 0
    ? opts.minRunsPerWindow
    : (Number.isFinite(snap.minRunsPerWindow) && snap.minRunsPerWindow >= 0 ? snap.minRunsPerWindow : 20);
  const relativeBand = Number.isFinite(opts.relativeBand) && opts.relativeBand >= 0 ? opts.relativeBand : 0.05;
  const absoluteBand = Number.isFinite(opts.absoluteBand) && opts.absoluteBand >= 0 ? opts.absoluteBand : 0;

  const targetMetric = (card && typeof card.targetMetric === 'string' && card.targetMetric.trim())
    ? card.targetMetric.trim()
    : (card && card.baseline && typeof card.baseline.targetMetric === 'string' ? card.baseline.targetMetric : '');
  const direction = metricDirection(targetMetric);

  const boundaryMs = configBoundaryMs(card);
  const win = snap.window || null;
  const windowFromMs = win ? (win.fromMs != null ? toMs(win.fromMs) : toMs(win.from)) : null;
  const windowToMs = win ? (win.toMs != null ? toMs(win.toMs) : toMs(win.to)) : null;

  const base = {
    targetMetric, direction, boundaryMs, windowFromMs, windowToMs,
    sampleAfter: Number.isFinite(snap.totalRuns) ? snap.totalRuns : null,
    minRunsPerWindow: minRuns, windowDays, decidedAt: new Date(now).toISOString(),
  };

  if (boundaryMs == null) {
    return { ...base, due: false, decided: false, verdict: 'pending', cardStatus: null, reason: 'card-not-applied' };
  }
  // AC (no verdict from a window spanning two config versions): the after-window
  // must lie ENTIRELY after the boundary. If it can't be dated, or its start is
  // before the boundary, the window still straddles the change → defer, no verdict.
  if (windowFromMs == null) {
    return { ...base, due: false, decided: false, verdict: 'pending', cardStatus: null, reason: 'no-window' };
  }
  if (windowFromMs < boundaryMs) {
    return { ...base, due: false, decided: false, verdict: 'pending', cardStatus: null, reason: 'window-spans-boundary' };
  }

  // Below the run floor, or a target metric that can't be resolved on either
  // side of the boundary → insufficient data. Verdict deferred, never guessed;
  // the sample size is reported so the analyst can be told (concept §6).
  const before = resolveMetricValue(card.baseline && card.baseline.metrics, targetMetric);
  const after = resolveMetricValue(snap.metrics, targetMetric);
  if (snap.insufficientData === true || before.value == null || after.value == null) {
    return {
      ...base, due: true, decided: false, verdict: 'insufficient-data', cardStatus: null,
      before: before.value, after: after.value,
      reason: snap.insufficientData === true ? 'below-min-runs' : 'metric-unresolved',
    };
  }

  const delta = after.value - before.value;
  const betterBy = direction === 'higher' ? delta : -delta;
  const band = Math.max(absoluteBand, relativeBand * Math.abs(before.value));

  let verdict;
  if (betterBy > band) verdict = 'validated';
  else if (betterBy < -band) verdict = 'regressed';
  else verdict = 'neutral';

  const summary = {
    ...base, due: true,
    before: before.value, after: after.value, delta, betterBy, band,
    windows: {
      before: card.baseline ? card.baseline.window || null : null,
      after: win,
    },
  };

  if (verdict === 'validated') {
    return { ...summary, decided: true, verdict: 'validated', cardStatus: 'validated' };
  }
  if (verdict === 'regressed') {
    return { ...summary, decided: true, verdict: 'regressed', cardStatus: 'regressed' };
  }
  // Neutral: "the change stays", but only FINALISE after two full windows so a
  // change that merely looks flat at window 1 keeps being measured and can still
  // flip to validated/regressed. Until then the card stays `applied`.
  const twoWindowsMs = boundaryMs + 2 * windowDays * DAY_MS;
  if (windowFromMs >= twoWindowsMs || (windowToMs != null && windowToMs >= twoWindowsMs)) {
    return { ...summary, decided: true, verdict: 'neutral', cardStatus: 'neutral' };
  }
  return { ...summary, decided: false, verdict: 'neutral', cardStatus: null, reason: 'neutral-pending-second-window' };
}

// The rollback plan for a regressed card: the class-specific undo descriptor the
// console executes through the SAME audited choke-points as the apply (#1225,
// §3.3). Read straight off the `undo` payload the applier retained at apply time
// so the reversal restores the EXACT prior state — for a prompt card, the exact
// prior prompt version via #990 history (AC). Pure.
function buildRollbackPlan(card) {
  const cls = card && card.class;
  const undo = card && card.undo && typeof card.undo === 'object' ? card.undo : {};
  const objAgent = card && card.object && typeof card.object.id === 'string'
    ? card.object.id.split('/')[0] : null;
  switch (cls) {
    case 'trigger-hygiene':
      // #1225 retained the deleted trigger JSON — re-create it verbatim.
      return {
        kind: 'restore-trigger',
        agentId: undo.agentId || objAgent || null,
        trigger: undo.trigger || null,
      };
    case 'prompt-improvement':
      // Restore the exact prior prompt version through #990 prompt-history revert.
      return {
        kind: 'prompt-revert',
        agentId: undo.agentId || objAgent || null,
        field: undo.field || 'systemPrompt',
        version: undo.version != null ? undo.version
          : (undo.priorVersion != null ? undo.priorVersion : null),
      };
    case 'flow-wiring':
      return {
        kind: 'restore-port',
        agentId: undo.agentId || objAgent || null,
        previousValue: undo.previousValue != null ? undo.previousValue : null,
      };
    case 'threshold-tuning':
      return {
        kind: 'restore-value',
        agentId: undo.agentId || objAgent || null,
        previousValue: undo.previousValue != null ? undo.previousValue : null,
      };
    default:
      return { kind: 'manual', note: 'no automated undo for this card class' };
  }
}

// The patch that flips a regressed applied card into a rollback card. Keeps the
// baseline + undo for the ledger, cites BOTH measurement windows, and records
// the verdict. The rollback is offered to a human (surfaced like an open card);
// nothing here reverts anything.
function buildRollbackCard(card, verdict, { now = Date.now() } = {}) {
  const nowIso = new Date(toMs(now) != null ? toMs(now) : Date.now()).toISOString();
  const tm = verdict.targetMetric;
  return {
    status: 'regressed',
    updatedAt: nowIso,
    verdict: summarizeVerdict(verdict),
    rollback: {
      available: true,
      reason: `target metric '${tm}' regressed from ${verdict.before} to ${verdict.after} after the change`,
      plan: buildRollbackPlan(card),
      citedWindows: {
        before: card.baseline ? card.baseline.window || null : null,
        after: verdict.windows ? verdict.windows.after : verdict.windowFromMs,
      },
    },
  };
}

// Compact, serialisable verdict record stamped onto a card (drops the transient
// cardStatus/decided flags — the card's own `status` carries the outcome).
function summarizeVerdict(v) {
  return {
    verdict: v.verdict,
    targetMetric: v.targetMetric,
    direction: v.direction,
    before: v.before != null ? v.before : null,
    after: v.after != null ? v.after : null,
    delta: v.delta != null ? v.delta : null,
    sampleAfter: v.sampleAfter != null ? v.sampleAfter : null,
    minRunsPerWindow: v.minRunsPerWindow,
    reason: v.reason || null,
    boundaryMs: v.boundaryMs != null ? v.boundaryMs : null,
    decidedAt: v.decidedAt,
  };
}

// Fold the verdict step over the whole store against a fresh snapshot. Only
// `applied` cards are measured; a decided verdict transitions the card
// (validated/neutral/regressed → rollback), an undecided one records the latest
// attempt (pending/insufficient/neutral-awaiting-window) without changing the
// lifecycle status so it is re-checked next pass. Mutates copies, never the
// input. Returns { cards, transitioned, verdicts } where `verdicts` is the
// per-card summary for the pass report.
function applyVerdicts(existingCards, afterSnapshot, opts = {}) {
  const now = toMs(opts.now) != null ? toMs(opts.now) : Date.now();
  const cards = (Array.isArray(existingCards) ? existingCards : []).map((c) => ({ ...c }));
  const verdicts = [];
  let transitioned = 0;

  for (const card of cards) {
    if (!card || card.status !== 'applied') continue;
    const v = computeVerdict(card, afterSnapshot, { ...opts, now });
    verdicts.push({ id: card.id, class: card.class, verdict: v.verdict, reason: v.reason || null });

    if (!v.due) {
      // Window hasn't elapsed / spans the boundary: don't touch the card at all.
      continue;
    }
    // Record the latest verdict attempt for transparency (the analyst is told
    // the sample size on insufficient-data; the ledger shows a pending neutral).
    card.verdict = summarizeVerdict(v);
    if (v.cardStatus === 'validated' || v.cardStatus === 'neutral') {
      card.status = v.cardStatus;
      card.updatedAt = new Date(now).toISOString();
      if (v.cardStatus === 'neutral') {
        card.autoClosedAt = new Date(now).toISOString();
      }
      transitioned += 1;
    } else if (v.cardStatus === 'regressed') {
      Object.assign(card, buildRollbackCard(card, v, { now }));
      transitioned += 1;
    } else {
      // insufficient-data or neutral-awaiting-second-window: stays `applied`.
      card.updatedAt = new Date(now).toISOString();
    }
  }

  return { cards, transitioned, verdicts };
}

module.exports = {
  DAY_MS,
  toMs,
  metricDirection,
  normalizeMetricPath,
  resolveMetricValue,
  configBoundaryMs,
  computeVerdict,
  buildRollbackPlan,
  buildRollbackCard,
  summarizeVerdict,
  applyVerdicts,
};
