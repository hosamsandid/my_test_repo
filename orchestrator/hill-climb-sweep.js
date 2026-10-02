'use strict';

// Pure adapters for the hill-climb metrics sweep (#1222).
//
// The orchestrator does the actual I/O — read each team member's session JSONL
// (`sessions/*.jsonl` + rotated archives), the per-agent usage spool
// (`usage-spool.jsonl`), the team's `anomaly-history.jsonl` (#1221), the GitHub
// event-transparency log, and the audit / `.agent-studio/prompt-history.json` version
// boundaries. The bug-prone part is turning that raw JSON/JSONL into the pure
// metrics module's input contract, so that translation lives here — pure and
// fs-free — exactly as `flow-anomaly-sweep.js` sits in front of
// `flow-anomaly-detector.js`. `hill-climb-metrics.js` then folds the catalog.
//
// Nothing here reads the filesystem; every function takes already-parsed rows.

// ── runs from a single agent's session log ───────────────────────────────────
//
// Group one agent's session-log rows by `correlationId` into run records the
// metrics module consumes. Only correlations with a `trigger.fired` row become
// runs — the hill-climber measures triggered flow work, not ad-hoc DM turns.
//
// outcome is derived from the reliable markers (concept §4 / the runtime's
// claim-swap contract):
//   - `trigger.claim-rolled-back`      → failed (github double-failure)
//   - `trigger.claim-completed` ok     → success (github work delivered)
//   - `trigger.claim-blocked`          → failed (#2113: the run finished but its
//     declared post-condition did not hold, so the claim stayed `<wake>:wip` and
//     the work item was NOT delivered). Without this case such a run falls
//     through to the `result`+`message.posted` rule and is measured as a
//     SUCCESS — which would just move #2113's false-success from the label onto
//     the metrics surface. `failed` (not a fifth outcome) because OUTCOMES in
//     hill-climb-metrics.js is a frozen four-value vocabulary, and an
//     undelivered outcome is a failure of the flow step either way.
//   - an `error` row (stage claude) or a `result` with `isError` → failed
//   - a `result` with a posted reply   → success
//   - a `result` with NO `message.posted` → pass (`[PASS]`/empty-after-harvest)
//   - no `result` at all               → aborted (crashed / killed / incomplete)
//
// `opts.agentId` tags every run; `opts.usageByCorr` (from the usage spool) joins
// token cost; `opts.reworkTriggerIds` marks a run whose wake was a rework cycle
// (a `revisions-required`-class listener); `opts.activeCorrelationIds` drops runs
// still in flight so an in-progress run isn't miscounted as aborted.
function runsFromSessionEvents(events, opts = {}) {
  const agentId = opts.agentId || 'unknown';
  const usageByCorr = opts.usageByCorr instanceof Map ? opts.usageByCorr : new Map();
  const reworkTriggers = opts.reworkTriggerIds instanceof Set ? opts.reworkTriggerIds : new Set();
  const active = opts.activeCorrelationIds instanceof Set ? opts.activeCorrelationIds : new Set();

  const byCorr = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    const corr = ev.correlationId;
    if (!corr) continue;
    let g = byCorr.get(corr);
    if (!g) { g = { correlationId: corr }; byCorr.set(corr, g); }
    switch (ev.type) {
      case 'trigger.fired':
        g.wakeAt = ev.ts || g.wakeAt || null;
        g.triggerId = ev.triggerId || g.triggerId || null;
        g.triggerType = ev.triggerType || g.triggerType || null;
        if (ev.github && typeof ev.github === 'object') g.github = ev.github;
        break;
      case 'result':
        g.hasResult = true;
        g.doneAt = ev.ts || g.doneAt || null;
        if (ev.isError) g.hasError = true;
        break;
      case 'message.posted':
        g.messagePosted = true;
        g.doneAt = g.doneAt || ev.ts || null;
        break;
      case 'error':
        if (ev.stage === 'claude') g.hasError = true;
        break;
      case 'trigger.claim-completed':
        if (ev.ok !== false) { g.claimCompleted = true; g.doneAt = ev.ts || g.doneAt || null; }
        break;
      case 'trigger.claim-rolled-back':
        g.rolledBack = true;
        break;
      case 'trigger.claim-blocked':
        g.claimBlocked = true;
        break;
      default:
        break;
    }
  }

  const runs = [];
  for (const g of byCorr.values()) {
    if (g.wakeAt == null) continue;          // no wake → not a tracked run
    if (active.has(g.correlationId)) continue; // still running → don't measure yet
    let outcome;
    if (g.rolledBack) outcome = 'failed';
    // Before the `hasResult` rules: a blocked claim (#2113) always has a
    // `result` row (the run completed), so testing it later would never fire.
    else if (g.claimBlocked && !g.claimCompleted) outcome = 'failed';
    else if (g.claimCompleted) outcome = 'success';
    else if (g.hasError) outcome = 'failed';
    else if (g.hasResult) outcome = g.messagePosted ? 'success' : 'pass';
    else outcome = 'aborted';
    runs.push({
      agentId,
      triggerId: g.triggerId || '(unknown)',
      correlationId: g.correlationId,
      wakeAt: g.wakeAt,
      doneAt: g.doneAt || null,
      outcome,
      tokens: usageByCorr.get(g.correlationId) || 0,
      merged: !!g.claimCompleted, // github work delivered a merged artifact
      rework: g.triggerId ? reworkTriggers.has(g.triggerId) : false,
    });
  }
  return runs;
}

// ── token cost per run, from the usage spool ─────────────────────────────────
//
// Build a `correlationId → total tokens` map from usage-spool records. Each
// record's `tokens` is the normalized {input,output,cacheCreationInput,
// cacheReadInput} shape; we sum all four (the run's whole token footprint).
function usageByCorrelation(spoolRecords) {
  const map = new Map();
  for (const rec of Array.isArray(spoolRecords) ? spoolRecords : []) {
    if (!rec || !rec.correlationId) continue;
    const t = rec.tokens && typeof rec.tokens === 'object' ? rec.tokens : {};
    const sum = ['input', 'output', 'cacheCreationInput', 'cacheReadInput']
      .reduce((s, k) => s + (typeof t[k] === 'number' && Number.isFinite(t[k]) ? t[k] : 0), 0);
    map.set(rec.correlationId, (map.get(rec.correlationId) || 0) + sum);
  }
  return map;
}

// ── config-version boundaries ────────────────────────────────────────────────
//
// From an agent's `.agent-studio/prompt-history.json` (newest-first `history[]`), the
// authoritative per-agent version markers. Each entry already carries a monotonic
// `version` and the change timestamp `at` — exactly the boundary the metrics
// module attributes runs against.
function configBoundariesFromHistory(promptHistory) {
  const hist = promptHistory && Array.isArray(promptHistory.history) ? promptHistory.history : [];
  return hist
    .filter((h) => h && h.version != null && h.at)
    .map((h) => ({ version: h.version, at: h.at }));
}

// Fallback when an agent has no prompt-history: derive boundaries from the audit
// trail. Keep only successful mutating writes to THIS agent's config
// (`PUT /api/agents/<id>` and its sub-resources), oldest→newest, and synthesize a
// monotonic version number. Broader than prompt-history (covers trigger/skill/env
// edits) but content-blind — good enough to bucket runs across a change.
function configBoundariesFromAudit(auditEntries, agentId) {
  if (!agentId) return [];
  const prefix = `/api/agents/${agentId}`;
  const marks = (Array.isArray(auditEntries) ? auditEntries : [])
    .filter((e) => e && e.outcome === 'success' && typeof e.resource === 'string'
      && (e.resource === prefix || e.resource.startsWith(`${prefix}/`))
      && e.method && e.method !== 'GET' && e.ts)
    .map((e) => e.ts)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return marks.map((at, i) => ({ version: i + 1, at }));
}

// Prefer prompt-history (real versions) and fall back to audit-derived markers.
function configBoundariesForAgent(promptHistory, auditEntries, agentId) {
  const fromHist = configBoundariesFromHistory(promptHistory);
  if (fromHist.length) return fromHist;
  return configBoundariesFromAudit(auditEntries, agentId);
}

// ── dead-config inputs, from member configs ──────────────────────────────────
//
// `members` is `[{ id, emits?, outcomes?, triggers? }]` (a team's role configs).
// These three helpers derive the declarative sets the metrics module diffs to
// find dead config; kept pure so they can be unit-tested off fixtures.

// Every label a team's roles declare they emit (flat `emits` + structured
// outcome `setLabel` actions).
function emitLabelsFromMembers(members) {
  const out = new Set();
  for (const m of Array.isArray(members) ? members : []) {
    for (const l of Array.isArray(m && m.emits) ? m.emits : []) if (l) out.add(l);
    const opts = m && m.outcomes && Array.isArray(m.outcomes.options) ? m.outcomes.options : [];
    for (const opt of opts) {
      for (const a of Array.isArray(opt && opt.actions) ? opt.actions : []) {
        if (a && a.type === 'setLabel' && a.label) out.add(a.label);
      }
    }
  }
  return [...out];
}

// Every label some trigger listens for (`labelFilter`), across all members.
function consumedLabelsFromMembers(members) {
  const out = new Set();
  for (const m of Array.isArray(members) ? members : []) {
    for (const t of Array.isArray(m && m.triggers) ? m.triggers : []) {
      if (t && t.labelFilter) out.add(t.labelFilter);
    }
  }
  return [...out];
}

// The flat list of declared triggers (zero-fire base). Beyond `{agentId,
// triggerId}` each entry carries what a human needs to recognise the trigger in
// a card title (#2710) — the member's display name, the trigger type, its
// events and labelFilter — plus `since`, the trigger's activation stamp (the
// same `activatedAt → createdAt` precedence as the poller's history horizon), so
// a trigger younger than the measurement window is not reported as dead.
// An unstamped trigger falls back to the creation time encoded in a
// console-generated id (`t<epoch-ms>`, optionally + a short random suffix), so
// a young cron/loop/agent-authored trigger is not mistaken for legacy (#2710).
const ID_EPOCH_RE = /^t(\d{13})\d{0,3}$/;
function sinceFromTriggerId(id) {
  const m = typeof id === 'string' ? ID_EPOCH_RE.exec(id) : null;
  if (!m) return null;
  const ms = Number(m[1]);
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function triggerDefsFromMembers(members) {
  const out = [];
  for (const m of Array.isArray(members) ? members : []) {
    for (const t of Array.isArray(m && m.triggers) ? m.triggers : []) {
      if (!t || !t.id) continue;
      const since = t.activatedAt || t.createdAt || sinceFromTriggerId(t.id);
      out.push({
        agentId: m.id,
        triggerId: t.id,
        ...(m.displayName ? { agentName: m.displayName } : {}),
        ...(t.type ? { type: t.type } : {}),
        ...(Array.isArray(t.events) && t.events.length ? { events: t.events.filter((e) => typeof e === 'string') } : {}),
        ...(t.labelFilter ? { labelFilter: t.labelFilter } : {}),
        ...(since ? { since } : {}),
      });
    }
  }
  return out;
}

// The trigger ids whose wake is a rework cycle — a listener on any of
// `reworkLabels` (default: the `revisions-required` convention). Used to flag
// rework runs for the rework-ratio metric.
function reworkTriggerIds(members, reworkLabels = ['revisions-required']) {
  const rework = new Set(reworkLabels);
  const out = new Set();
  for (const m of Array.isArray(members) ? members : []) {
    for (const t of Array.isArray(m && m.triggers) ? m.triggers : []) {
      if (t && t.id && t.labelFilter && rework.has(t.labelFilter)) out.add(t.id);
    }
  }
  return out;
}

// ── waste signals from the event-transparency log ────────────────────────────
//
// Count throttle drops and digest folds in the window from the github-event-log
// entries (each carries an `outcomes[]` with per-subscriber `status`). When
// `teamAgentIds` (a Set) is given, only outcomes for those agents are counted —
// the event log is global, so this scopes waste to one team. Pure.
function wasteSignalsFromEventLog(entries, fromMs, toBound, teamAgentIds) {
  const scope = teamAgentIds instanceof Set ? teamAgentIds : null;
  let throttleDrops = 0;
  let digestFolds = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    const t = e && e.ts ? Date.parse(e.ts) : NaN;
    if (!Number.isFinite(t) || t < fromMs || (toBound != null && t > toBound)) continue;
    for (const o of Array.isArray(e && e.outcomes) ? e.outcomes : []) {
      if (scope && !(o && scope.has(o.agentId))) continue;
      if (o && o.status === 'dropped') throttleDrops += 1;
      // #2693: the poller records a folded burst as `delivered` + `digest: true`;
      // a literal `status: 'digest'` stays accepted.
      else if (o && (o.status === 'digest' || (o.status === 'delivered' && o.digest === true))) digestFolds += 1;
    }
  }
  return { throttleDrops, digestFolds };
}

module.exports = {
  runsFromSessionEvents,
  usageByCorrelation,
  configBoundariesFromHistory,
  configBoundariesFromAudit,
  configBoundariesForAgent,
  emitLabelsFromMembers,
  consumedLabelsFromMembers,
  triggerDefsFromMembers,
  reworkTriggerIds,
  wasteSignalsFromEventLog,
};
