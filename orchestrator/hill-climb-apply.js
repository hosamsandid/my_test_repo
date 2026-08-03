'use strict';

// Hill-climbing loop Phase 2b (#1225): the applier's orchestrator-side core.
//
// Concept `docs/hill-climbing-agent-concept.md` §3.3. Cards never write config
// directly — each card class declares an *apply path* that is an existing,
// audited console endpoint, and application is governed by a per-team autonomy
// dial. The applier is split across the two containers exactly like #1224's
// store/analyst split: the ADMIN CONSOLE runs the actual mutation through the
// existing choke-point (as the acting human, so audit + prompt-history
// attribution fire) and holds the trigger guard + staleness check against live
// config (`admin-console/api/hill-climb-apply-guard.js`); the ORCHESTRATOR owns
// the card store + the per-team autonomy config, so this module — the fs-free,
// LLM-free core it calls — holds only:
//
//   - the autonomy dial (0 collector-only / 1 report / 2 propose+apply; 3 is not
//     authored in v1 and is treated as its ceiling, 2, for applying),
//   - and the applied-card patch (apply timestamp + config-version reference +
//     baseline window snapshot + the undo payload) that #1226 reads to measure
//     the change across the config boundary.
//
// (The admin-console image copies only `api/*.js` and can't require from here,
// so the console-side guard lives in its own vendored-style module; the two are
// disjoint — no logic is duplicated.)

// The per-team autonomy dial (§3.3). 0 = collector only (no cards), 1 = cards
// are raised but read-only, 2 = one-click Apply. 3 (restricted auto-apply) is
// not authored in v1; clamp it to its ceiling of 2 so an imported bundle that
// declares 3 still behaves as the highest manual level rather than unlocking
// something that does not exist. Anything else (missing/garbage) defaults to 2,
// the shipped default, matching `hillClimbCardConfig` in the orchestrator.
function resolveAutonomy(hillClimbCfg) {
  const a = hillClimbCfg && typeof hillClimbCfg === 'object' ? hillClimbCfg.autonomy : undefined;
  if (a === 0 || a === 1) return a;
  if (a === 3) return 2;
  return 2;
}

// Applying a card requires autonomy 2. At 0/1 the Apply action is denied
// server-side (not merely hidden), so a direct API call can't apply either.
function canApplyAtAutonomy(autonomy) {
  return autonomy >= 2;
}

// The patch stamped onto a card the moment it is applied (§3 point 3; consumed
// by #1226). Pure so it is golden-testable and identical whether the scheduled
// or the manual path applies. `snapshot` is the latest metrics snapshot (the
// baseline the before/after comparison rests on); `undo` is the class-specific
// reversal payload the console gathered from the live object *before* mutating
// (for trigger-hygiene, the deleted trigger JSON — "card retains the deleted
// trigger"); `configVersionRef` marks the config boundary the change created.
// `cooldownUntil` (one full window) keeps a re-detected finding from bumping the
// applied card and contaminating its own measurement (concept budget rule).
function buildAppliedPatch(card, {
  now = Date.now(),
  appliedBy = null,
  snapshot = null,
  undo = null,
  configVersionRef = null,
  windowDays = 7,
} = {}) {
  const nowIso = new Date(now).toISOString();
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 7;
  const cooldownUntil = new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
  return {
    status: 'applied',
    appliedAt: nowIso,
    appliedBy: appliedBy ? String(appliedBy) : null,
    updatedAt: nowIso,
    configVersionRef: configVersionRef || null,
    baseline: buildBaseline(card, snapshot),
    undo: undo || null,
    cooldownUntil,
  };
}

// The before-window baseline #1226 measures against: the target metric named on
// the card and the snapshot that established it. Kept small (the metric name,
// the snapshot's window + generation time, and its metrics block) so the card
// store stays a ledger, not a copy of every snapshot.
function buildBaseline(card, snapshot) {
  const targetMetric = card && typeof card.targetMetric === 'string' ? card.targetMetric : null;
  if (!snapshot || typeof snapshot !== 'object') {
    return { targetMetric, generatedAt: null, window: null, metrics: null };
  }
  return {
    targetMetric,
    generatedAt: snapshot.generatedAt || null,
    window: snapshot.window || null,
    metrics: snapshot.metrics || null,
  };
}

module.exports = {
  resolveAutonomy,
  canApplyAtAutonomy,
  buildAppliedPatch,
  buildBaseline,
};
