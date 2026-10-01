'use strict';

// Hill-climbing loop Phase 1 (#1222): the pure metrics core.
//
// Concept `docs/hill-climbing-agent-concept.md` §3.1/§4/§7. This module is the
// deterministic collector: it folds the per-team run inputs the I/O adapter
// (`hill-climb-sweep.js`) reads off disk into a **run ledger** keyed by
// `(agentId, triggerId)` plus the §4 aggregate metric catalog. It is a pure,
// fs-free module in the discipline of `flow-anomaly-detector.js` — no I/O, no
// LLM, golden-fixture testable — so a scheduled pass and a manual pass produce
// byte-identical snapshots for identical inputs (AC).
//
// The catalog is **observational only** (concept §4): no LLM-judged quality
// scores, only mechanically countable facts —
//   - run success rate       successes / (non-`[PASS]` runs)
//   - rework ratio           `revisions-required` cycles per merged PR
//   - time-to-done p50/p90   wake → done (result / `:completed` / merge)
//   - anomaly recurrence     stall identities seen in ≥2 sweeps in the window
//   - waste                  tokens spent on failed/aborted/`[PASS]` runs,
//                            throttle drops, digest folds
//   - dead config            zero-fire triggers, emitted-but-unconsumed labels
//
// Every run is attributed to the prompt/config version that produced it (the
// boundary comes from audit / prompt-history timestamps — see
// `attributeConfigVersion`), so a later phase can measure a change across the
// version boundary. Below `minRunsPerWindow` the snapshot is honestly flagged
// `insufficientData` and the ratio metrics are nulled rather than reported on a
// too-thin sample.

// Coerce an epoch-ms number or an ISO/date string to epoch ms; null when it
// isn't datable. Every timestamp in the input contract (session `ts`, spool
// `ts`, boundary `at`) is one of those two forms.
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

// Linear-interpolated percentile (`p` in 0..100) over a numeric array. Returns
// null for an empty set. Matches the common "type 7" quantile so p50 of an even
// set is the mean of the two middle values — stable and unit-testable.
function percentile(values, p) {
  const xs = (Array.isArray(values) ? values : [])
    .filter((n) => typeof n === 'number' && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0];
  const rank = (p / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
}

// Attribute a run to the config version live when it woke. `boundaries` is the
// per-agent list of `{ version, at }` version markers (prompt-history / audit
// timestamps); order-independent here — we pick the version with the greatest
// `at` not after the run's wake. Falls back to the earliest known version when
// the run predates every boundary, and null when the agent has no boundaries.
function attributeConfigVersion(wakeMs, boundaries) {
  const list = (Array.isArray(boundaries) ? boundaries : [])
    .map((b) => ({ version: b && b.version, atMs: toMs(b && b.at) }))
    .filter((b) => b.atMs != null && b.version != null)
    .sort((a, b) => a.atMs - b.atMs); // oldest → newest
  if (list.length === 0) return null;
  const w = toMs(wakeMs);
  if (w == null) return list[list.length - 1].version; // undatable run → current
  let picked = null;
  for (const b of list) {
    if (b.atMs <= w) picked = b.version;
    else break;
  }
  // A run older than the earliest boundary is attributed to that earliest
  // version (its work still ran under some config we can name).
  return picked != null ? picked : list[0].version;
}

// One run's terminal disposition, normalized to the four buckets the catalog
// counts. `pass` (a `[PASS]` reply) is deliberately excluded from success rate
// but still counts as waste.
const OUTCOMES = Object.freeze(['success', 'failed', 'aborted', 'pass']);
function normalizeOutcome(o) {
  return OUTCOMES.includes(o) ? o : 'failed';
}

// Sum a run's token cost. Accepts a plain number or the normalized
// `{input, output, cacheCreationInput, cacheReadInput}` shape the runtime spools.
function runTokens(run) {
  const t = run && run.tokens;
  if (typeof t === 'number') return Number.isFinite(t) ? t : 0;
  if (t && typeof t === 'object') {
    return ['input', 'output', 'cacheCreationInput', 'cacheReadInput']
      .reduce((s, k) => s + (typeof t[k] === 'number' && Number.isFinite(t[k]) ? t[k] : 0), 0);
  }
  return 0;
}

// Keep only runs whose wake falls inside the measurement window `[fromMs, toBound]`.
// A run with no datable wake (e.g. a DM turn with no trigger.fired) is dropped —
// the hill-climber measures triggered flow work, not ad-hoc chat.
function runsInWindow(runs, fromMs, toBound) {
  const hi = toBound != null ? toBound : Infinity;
  return (Array.isArray(runs) ? runs : []).filter((r) => {
    const t = r && (r.wakeAt != null ? toMs(r.wakeAt) : toMs(r.ranAt));
    return t != null && t >= fromMs && t <= hi;
  });
}

// Group runs into the ledger keyed by `(agentId, triggerId)` — the atom the
// analyst reasons over (a prompt/wiring/threshold change targets one such cell).
function buildRunLedger(runs) {
  const byKey = new Map();
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r) continue;
    const agentId = r.agentId || 'unknown';
    const triggerId = r.triggerId || '(dm)';
    const key = `${agentId}\u0000${triggerId}`;
    let cell = byKey.get(key);
    if (!cell) {
      cell = {
        agentId, triggerId,
        runs: 0, success: 0, failed: 0, aborted: 0, pass: 0,
        merged: 0, rework: 0, tokens: 0,
        _durations: [],
      };
      byKey.set(key, cell);
    }
    cell.runs += 1;
    cell[normalizeOutcome(r.outcome)] += 1;
    if (r.merged) cell.merged += 1;
    if (r.rework) cell.rework += 1;
    cell.tokens += runTokens(r);
    const dur = durationMs(r);
    if (dur != null) cell._durations.push(dur);
  }
  const ledger = [];
  for (const cell of byKey.values()) {
    const { _durations, ...rest } = cell;
    ledger.push({
      ...rest,
      timeToDoneMs: { p50: percentile(_durations, 50), p90: percentile(_durations, 90) },
    });
  }
  // Deterministic order → identical snapshots for identical inputs.
  ledger.sort((a, b) => (a.agentId + a.triggerId).localeCompare(b.agentId + b.triggerId));
  return ledger;
}

// Wake→done latency for a successful run (ms), or null when either boundary is
// missing or the run didn't succeed (a failed run has no meaningful "done").
function durationMs(run) {
  if (!run || normalizeOutcome(run.outcome) !== 'success') return null;
  const w = toMs(run.wakeAt);
  const d = toMs(run.doneAt);
  if (w == null || d == null || d < w) return null;
  return d - w;
}

// Count recurring stall identities across the anomaly-history sweeps (#1221) in
// the window. Identity = `class|objectId` (what recurrence detection keys on);
// a stall counts as recurrent when it appears in ≥2 distinct sweeps.
function countAnomalyRecurrence(anomalyHistory, fromMs, toBound) {
  const perId = new Map(); // identity → Set of sweep timestamps
  for (const sweep of Array.isArray(anomalyHistory) ? anomalyHistory : []) {
    const t = toMs(sweep && sweep.ts);
    if (t == null || t < fromMs || (toBound != null && t > toBound)) continue;
    for (const a of Array.isArray(sweep && sweep.anomalies) ? sweep.anomalies : []) {
      if (!a || a.class == null || a.objectId == null) continue;
      const id = `${a.class}\u0000${a.objectId}`;
      if (!perId.has(id)) perId.set(id, new Set());
      perId.get(id).add(t);
    }
  }
  let recurring = 0;
  for (const sweeps of perId.values()) if (sweeps.size >= 2) recurring += 1;
  return recurring;
}

// The main entry: fold all per-team inputs into the §4 catalog + ledger.
//
// inputs = {
//   runs,             per-run records (see contract above)
//   anomalyHistory,   parsed anomaly-history.jsonl sweeps
//   configBoundaries, { <agentId>: [{version, at}] } version markers
//   triggerDefs,      [{ agentId, triggerId }] declared triggers (for zero-fire)
//   emitLabels,       string[] labels the team's roles declare they emit
//   consumedLabels,   string[] labels some trigger listens for
//   mergedPrCount,    merged PRs in window (rework-ratio denominator)
//   throttleDrops,    events dropped by the conversation throttle
//   digestFolds,      events folded into burst digests
// }
// opts = { windowDays=7, minRunsPerWindow=20, now=Date.now(), excludeAgents=[] }
function computeHillClimbMetrics(inputs = {}, opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) && opts.windowDays > 0 ? opts.windowDays : 7;
  const minRunsPerWindow = Number.isFinite(opts.minRunsPerWindow) && opts.minRunsPerWindow >= 0
    ? opts.minRunsPerWindow : 20;
  const nowMs = toMs(opts.now) != null ? toMs(opts.now) : Date.now();
  const fromMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const exclude = new Set(Array.isArray(opts.excludeAgents) ? opts.excludeAgents : []);

  const boundaries = inputs.configBoundaries && typeof inputs.configBoundaries === 'object'
    ? inputs.configBoundaries : {};

  // In-window runs, minus excluded agents, each stamped with its config version.
  const runs = runsInWindow(inputs.runs, fromMs, nowMs)
    .filter((r) => !exclude.has(r.agentId))
    .map((r) => ({ ...r, configVersion: attributeConfigVersion(r.wakeAt != null ? r.wakeAt : r.ranAt, boundaries[r.agentId]) }));

  const totalRuns = runs.length;
  const insufficientData = totalRuns < minRunsPerWindow;

  // ── success rate (excludes `[PASS]`) ──────────────────────────────────────
  const nonPass = runs.filter((r) => normalizeOutcome(r.outcome) !== 'pass');
  const successes = nonPass.filter((r) => normalizeOutcome(r.outcome) === 'success').length;
  const runSuccessRate = nonPass.length ? successes / nonPass.length : null;

  // ── rework ratio (revisions-required cycles per merged PR) ─────────────────
  const reworkCycles = runs.filter((r) => r.rework).length;
  const mergedPrCount = Number.isFinite(inputs.mergedPrCount)
    ? inputs.mergedPrCount
    : runs.filter((r) => r.merged).length;
  const reworkRatio = mergedPrCount > 0 ? reworkCycles / mergedPrCount : null;

  // ── time-to-done p50/p90 (successful runs only) ────────────────────────────
  const durations = runs.map(durationMs).filter((d) => d != null);
  const timeToDone = durations.length
    ? { p50Ms: percentile(durations, 50), p90Ms: percentile(durations, 90) }
    : null;

  // ── anomaly recurrence ────────────────────────────────────────────────────
  const anomalyRecurrence = countAnomalyRecurrence(inputs.anomalyHistory, fromMs, nowMs);

  // ── waste ─────────────────────────────────────────────────────────────────
  const wasteRuns = runs.filter((r) => ['failed', 'aborted', 'pass'].includes(normalizeOutcome(r.outcome)));
  const waste = {
    wasteRuns: wasteRuns.length,
    failedRunTokens: wasteRuns.reduce((s, r) => s + runTokens(r), 0),
    throttleDrops: Number.isFinite(inputs.throttleDrops) ? inputs.throttleDrops : 0,
    digestFolds: Number.isFinite(inputs.digestFolds) ? inputs.digestFolds : 0,
  };

  // ── dead config ───────────────────────────────────────────────────────────
  // A trigger activated inside the window has not been observed for a whole
  // window yet, so "zero fires this window" is no evidence it is dead (#2710).
  // Unstamped (legacy) triggers count as old.
  const firedTriggers = new Set(runs.filter((r) => r.triggerId).map((r) => `${r.agentId}\u0000${r.triggerId}`));
  const zeroFireTriggers = (Array.isArray(inputs.triggerDefs) ? inputs.triggerDefs : [])
    .filter((t) => t && t.triggerId && !exclude.has(t.agentId))
    .filter((t) => !firedTriggers.has(`${t.agentId}\u0000${t.triggerId}`))
    .filter((t) => {
      const since = t.since ? Date.parse(t.since) : NaN;
      return !(Number.isFinite(since) && since > fromMs);
    })
    .map((t) => ({
      agentId: t.agentId,
      triggerId: t.triggerId,
      ...(t.agentName ? { agentName: t.agentName } : {}),
      ...(t.type ? { type: t.type } : {}),
      ...(Array.isArray(t.events) && t.events.length ? { events: t.events } : {}),
      ...(t.labelFilter ? { labelFilter: t.labelFilter } : {}),
    }));
  const consumed = new Set((Array.isArray(inputs.consumedLabels) ? inputs.consumedLabels : []).filter(Boolean));
  const unconsumedEmits = [...new Set((Array.isArray(inputs.emitLabels) ? inputs.emitLabels : []).filter(Boolean))]
    .filter((l) => !consumed.has(l))
    .sort();

  const ledger = buildRunLedger(runs);

  // Per-config-version rollup so a later phase can compare before/after a change.
  const byConfigVersion = buildVersionRollup(runs);

  return {
    windowDays,
    minRunsPerWindow,
    window: {
      fromMs, toMs: nowMs,
      from: new Date(fromMs).toISOString(),
      to: new Date(nowMs).toISOString(),
    },
    totalRuns,
    insufficientData,
    ledger,
    metrics: {
      insufficientData,
      // Ratio metrics are only trustworthy above the floor — null them out (with
      // the honesty flag) rather than report a rate off a handful of runs.
      runSuccessRate: insufficientData ? null : runSuccessRate,
      reworkRatio: insufficientData ? null : reworkRatio,
      timeToDone: insufficientData ? null : timeToDone,
      // Counting metrics stay meaningful even on a thin sample.
      anomalyRecurrence,
      waste,
      deadConfig: { zeroFireTriggers, unconsumedEmits },
    },
    byConfigVersion,
  };
}

// Roll runs up per (agentId, configVersion) — the boundary a Phase-3 before/after
// verdict is measured across. Only success/fail counts + rate; deterministic order.
function buildVersionRollup(runs) {
  const byKey = new Map();
  for (const r of runs) {
    const version = r.configVersion != null ? r.configVersion : '(unversioned)';
    const key = `${r.agentId}\u0000${version}`;
    let cell = byKey.get(key);
    if (!cell) {
      cell = { agentId: r.agentId, version, runs: 0, success: 0, failed: 0, aborted: 0, pass: 0 };
      byKey.set(key, cell);
    }
    cell.runs += 1;
    cell[normalizeOutcome(r.outcome)] += 1;
  }
  const out = [];
  for (const cell of byKey.values()) {
    const nonPass = cell.success + cell.failed + cell.aborted;
    out.push({ ...cell, runSuccessRate: nonPass ? cell.success / nonPass : null });
  }
  out.sort((a, b) => (a.agentId + String(a.version)).localeCompare(b.agentId + String(b.version)));
  return out;
}

module.exports = {
  toMs,
  percentile,
  attributeConfigVersion,
  runTokens,
  durationMs,
  buildRunLedger,
  countAnomalyRecurrence,
  buildVersionRollup,
  computeHillClimbMetrics,
  OUTCOMES,
};
