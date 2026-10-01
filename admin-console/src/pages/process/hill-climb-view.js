// Pure view helpers for the Improvements panel (hill-climbing loop Phase 1,
// #1223). Dependency-free so it unit-tests under `node --test` (the JSX panel
// cannot be imported there) — mirrors `flow-anomalies-view.js`.
//
// The metrics collector (`orchestrator/hill-climb-metrics.js`, #1222) persists
// one day-keyed snapshot per Agent Team; `GET /api/teams/:id/hill-climb/metrics`
// returns `{ teamId, snapshot }` (snapshot null when none exists yet), and
// `POST .../hill-climb/run` returns `{ teamId, maintenance, snapshot }`. The
// snapshot's `metrics` object is the §4 catalog:
//   { insufficientData, runSuccessRate, reworkRatio,
//     timeToDone:{p50Ms,p90Ms}|null, anomalyRecurrence,
//     waste:{wasteRuns,failedRunTokens,throttleDrops,digestFolds},
//     deadConfig:{zeroFireTriggers:[],unconsumedEmits:[]} }
//
// This module turns that into render-ready metric tiles. The honesty rule from
// the concept (§4): below `minRunsPerWindow` the ratio metrics (success rate,
// rework ratio, time-to-done) are nulled and MUST render an explicit
// `insufficient` state — never a misleading zero. The counting metrics
// (anomaly recurrence, waste, dead config) stay meaningful on a thin sample.

// A snapshot is present iff the response carried a non-null `snapshot` object.
// Distinguishes "team has never run a pass" (empty state + Run now) from a real
// snapshot that happens to be all-zero.
function hasSnapshot(resp) {
  return !!(resp && resp.snapshot && typeof resp.snapshot === 'object');
}

// A `POST run` answered during maintenance mode returns `{ maintenance:true,
// snapshot:null }` — surfaced as a distinct notice rather than a plain empty.
function isMaintenance(resp) {
  return !!(resp && resp.maintenance === true);
}

// x in 0..1 → "87%"; null/undefined → null (caller renders the empty state).
function formatPercent(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  return `${Math.round(x * 100)}%`;
}

// Whole-number formatting with thousands separators; non-numbers → "0".
function formatInt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

// Compact large counts (token sums): 12345 → "12.3k", 1234567 → "1.2M".
function formatCompact(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

// Human duration from ms: sub-minute → "45s"; minutes → "3m"; hours → "2h 3m";
// days → "1d 4h". null/negative → null.
function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM ? `${h}h ${remM}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}

// Snapshot header data: the measurement window, when it was generated, the run
// count and the floor below which ratios are suppressed.
function snapshotMeta(snapshot) {
  const s = snapshot || {};
  const win = s.window || {};
  return {
    totalRuns: typeof s.totalRuns === 'number' ? s.totalRuns : 0,
    minRuns: typeof s.minRunsPerWindow === 'number' ? s.minRunsPerWindow : 0,
    windowDays: typeof s.windowDays === 'number' ? s.windowDays : null,
    insufficientData: !!s.insufficientData,
    from: win.from || null,
    to: win.to || null,
    generatedAt: s.generatedAt || null,
  };
}

// Build the ordered §4 metric-catalog tiles from a snapshot.
//
// Each tile: { key, label, value, sub, note, state, help }.
//   state: 'ok'          — a real value to show
//          'insufficient'— below the run floor; ratio suppressed (explicit)
//          'none'        — metric legitimately undefined (no merged PRs, no
//                          completed runs) — an honest dash, not a zero
// `value` is null only for non-'ok' states; the panel renders the state label.
function metricTiles(snapshot) {
  const s = snapshot || {};
  const m = s.metrics || {};
  const insufficient = !!m.insufficientData;
  const waste = m.waste || {};
  const dead = m.deadConfig || {};
  const zeroFire = Array.isArray(dead.zeroFireTriggers) ? dead.zeroFireTriggers.length : 0;
  const unconsumed = Array.isArray(dead.unconsumedEmits) ? dead.unconsumedEmits.length : 0;

  // ── Ratio metrics — suppressed below the run floor (explicit insufficient) ──
  const successRate = ratioTile({
    key: 'success-rate',
    label: 'Run success rate',
    help: 'Successful runs as a share of gradable runs ([PASS] replies excluded).',
    insufficient,
    value: formatPercent(m.runSuccessRate),
    noneNote: 'No gradable runs in the window.',
  });

  const reworkRatio = ratioTile({
    key: 'rework-ratio',
    label: 'Rework ratio',
    help: 'revisions-required cycles per merged PR — how often work bounces back.',
    insufficient,
    value: typeof m.reworkRatio === 'number' && Number.isFinite(m.reworkRatio)
      ? `${m.reworkRatio.toFixed(2)} / PR` : null,
    noneNote: 'No merged PRs in the window.',
  });

  const tt = m.timeToDone;
  const timeToDone = ratioTile({
    key: 'time-to-done',
    label: 'Time to done',
    help: 'Wake → done latency for successful runs (median, with p90).',
    insufficient,
    value: tt && typeof tt.p50Ms === 'number' ? formatDuration(tt.p50Ms) : null,
    sub: tt && typeof tt.p90Ms === 'number' ? `p90 ${formatDuration(tt.p90Ms)}` : null,
    noneNote: 'No completed runs in the window.',
  });

  // ── Counting metrics — meaningful even on a thin sample (never insufficient) ─
  const anomalyRecurrence = {
    key: 'anomaly-recurrence',
    label: 'Anomaly recurrence',
    help: 'Stall identities seen in ≥2 anomaly sweeps in the window.',
    value: formatInt(m.anomalyRecurrence),
    sub: null,
    note: null,
    state: 'ok',
  };

  const wasteTile = {
    key: 'waste',
    label: 'Waste',
    help: 'Runs that produced nothing (failed / aborted / [PASS]) plus their token cost, throttle drops and burst-digest folds.',
    value: `${formatInt(waste.wasteRuns)} runs`,
    sub: `${formatCompact(waste.failedRunTokens)} tokens`,
    note: `${formatInt(waste.throttleDrops)} throttled · ${formatInt(waste.digestFolds)} folded`,
    state: 'ok',
  };

  const deadConfig = {
    key: 'dead-config',
    label: 'Dead config',
    help: 'Triggers that never fired and emitted labels no trigger consumes — safe pruning candidates.',
    value: formatInt(zeroFire + unconsumed),
    sub: null,
    note: `${formatInt(zeroFire)} zero-fire trigger(s) · ${formatInt(unconsumed)} unconsumed label(s)`,
    state: 'ok',
  };

  return [successRate, reworkRatio, timeToDone, anomalyRecurrence, wasteTile, deadConfig];
}

// A ratio tile: 'insufficient' below the floor, 'none' when the value is legit
// undefined (no denominator), else 'ok'.
function ratioTile({ key, label, help, insufficient, value, sub = null, noneNote }) {
  if (insufficient) {
    return { key, label, help, value: null, sub: null, note: null, state: 'insufficient' };
  }
  if (value == null) {
    return { key, label, help, value: null, sub: null, note: noneNote || null, state: 'none' };
  }
  return { key, label, help, value, sub: sub || null, note: null, state: 'ok' };
}

// ── improvement cards (#1224 store / #1225 applier / #1226 verdicts) ─────────
//
// `GET /api/teams/:id/hill-climb/cards` returns `{ teamId, autonomy, cards }`;
// each card is a full `hill-climb-cards.js` record across its lifecycle
// (open → applied → validated/neutral/regressed → rolled-back, or dismissed).
// These helpers turn that into the panel's two sections: the ACTIONABLE list
// (open cards awaiting Apply/Dismiss + regressed cards offering a rollback)
// and the closed-card LEDGER that doubles as the loop's change log.

const CARD_CLASS_LABELS = {
  'prompt-improvement': 'Prompt improvement',
  'flow-wiring': 'Flow wiring',
  'threshold-tuning': 'Threshold tuning',
  'trigger-hygiene': 'Trigger hygiene',
  'knowledge-handoff': 'Knowledge hand-off',
};

// Mirror of the server-side wiring (`hill-climb-apply-guard.js` / the rollback
// route): only these classes/plan kinds execute in this release. The server is
// the authority and re-checks every gate — this set only decides whether the
// button is live or explains why it is not wired yet.
const EXECUTABLE_CARD_CLASSES = ['trigger-hygiene'];
const EXECUTABLE_ROLLBACK_KINDS = ['restore-trigger'];

// Card lifecycle → badge label + tone ('ok' | 'info' | 'warn' | 'error' | 'muted').
const CARD_STATUS_BADGES = {
  open: { label: 'Open', tone: 'info' },
  applied: { label: 'Applied — measuring', tone: 'info' },
  validated: { label: 'Validated', tone: 'ok' },
  neutral: { label: 'Neutral', tone: 'muted' },
  regressed: { label: 'Regressed', tone: 'error' },
  'rolled-back': { label: 'Rolled back', tone: 'warn' },
  dismissed: { label: 'Dismissed', tone: 'muted' },
  superseded: { label: 'Superseded', tone: 'muted' },
};

function cardClassLabel(cardClass) {
  return CARD_CLASS_LABELS[cardClass] || String(cardClass || 'card');
}

function cardStatusBadge(status) {
  return CARD_STATUS_BADGES[status] || { label: String(status || 'unknown'), tone: 'muted' };
}

// Normalize the cards API envelope. `autonomy` is null when absent so the
// caller can distinguish "unknown" from a real 0.
function cardsFromResponse(resp) {
  return {
    autonomy: resp && typeof resp.autonomy === 'number' ? resp.autonomy : null,
    cards: resp && Array.isArray(resp.cards) ? resp.cards : [],
  };
}

// Split the store into the actionable list and the ledger. Regressed cards
// lead (a live regression with a rollback waiting on a human beats a fresh
// proposal), then open cards in store order (already priority-sorted by the
// merge). The ledger is everything terminal plus `applied` (still measuring),
// newest update first.
function splitCards(cards) {
  const list = Array.isArray(cards) ? cards.filter((c) => c && c.id) : [];
  const actionable = [
    ...list.filter((c) => c.status === 'regressed'),
    ...list.filter((c) => c.status === 'open'),
  ];
  const ledger = list
    .filter((c) => c.status !== 'open' && c.status !== 'regressed')
    .sort((a, b) => (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0));
  return { actionable, ledger };
}

// The one action a card offers right now (Apply for open, Roll back for
// regressed), with the autonomy/wiring gate pre-resolved so the panel renders
// a disabled button with an honest hint instead of a doomed request. The
// server re-enforces every gate — this never grants anything.
function cardAction(card, autonomy) {
  if (!card) return { kind: null, enabled: false, hint: null };
  if (card.status === 'open') {
    if (!(autonomy >= 2)) {
      return { kind: 'apply', enabled: false, hint: 'One-click Apply needs autonomy level 2 for this team.' };
    }
    if (!EXECUTABLE_CARD_CLASSES.includes(card.class)) {
      return { kind: 'apply', enabled: false, hint: `Apply for ${cardClassLabel(card.class)} cards is not wired yet — apply it by hand and dismiss the card.` };
    }
    return { kind: 'apply', enabled: true, hint: null };
  }
  if (card.status === 'regressed') {
    const planKind = card.rollback && card.rollback.plan ? card.rollback.plan.kind : null;
    if (!(autonomy >= 2)) {
      return { kind: 'rollback', enabled: false, hint: 'Rolling back needs autonomy level 2 for this team.' };
    }
    if (!EXECUTABLE_ROLLBACK_KINDS.includes(planKind)) {
      return { kind: 'rollback', enabled: false, hint: `Automated rollback for '${planKind || 'this change'}' is not wired yet — revert it by hand and dismiss the card.` };
    }
    return { kind: 'rollback', enabled: true, hint: null };
  }
  return { kind: null, enabled: false, hint: null };
}

// "trigger · reviewer/on-pr-opened" — the object a card is about.
function cardObjectLabel(card) {
  const o = card && card.object;
  if (!o || !o.kind) return null;
  return `${o.kind} · ${o.id}`;
}

// Compact metric value for verdict lines: numbers trimmed to ≤3 decimals,
// everything else stringified.
function formatMetricValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)));
  }
  return v == null ? '—' : String(v);
}

// One-line before/after summary of a card's recorded verdict (#1226), e.g.
// "waste.wasteRuns 6 → 9". Null when the card has no decided measurement.
function verdictLine(card) {
  const v = card && card.verdict;
  if (!v || !v.targetMetric) return null;
  if (v.before == null && v.after == null) return null;
  return `${v.targetMetric} ${formatMetricValue(v.before)} → ${formatMetricValue(v.after)}`;
}

// Render-ready evidence lines: "metric · metrics.deadConfig.zeroFireTriggers · a/t".
function evidenceLines(card) {
  const ev = card && Array.isArray(card.evidence) ? card.evidence : [];
  return ev
    .filter((e) => e && typeof e === 'object')
    .map((e) => [e.type, e.ref, e.value != null ? String(e.value) : null].filter(Boolean).join(' · '));
}

// The panel notice after a card action (apply / rollback / dismiss). `err` is
// the apiCall error, or null on success. When the server reports the change
// WAS made but the card could not be marked (#2709: 502 applied-not-recorded
// with applied:true, rolled-back-not-recorded with rolledBack:true), say so —
// "Could not apply" would invite a second, stale apply of a change that is
// already live.
function cardActionNotice(action, err) {
  if (!err) {
    const done = action === 'apply' ? 'applied — its effect is measured over the next window'
      : action === 'rollback' ? 'rolled back — the change was reverted'
      : 'dismissed — it will not be raised again';
    return { tone: 'info', text: `Card ${done}.` };
  }
  if (action === 'apply' && err.code === 'applied-not-recorded' && err.applied === true) {
    return {
      tone: 'error',
      text: 'Card applied, but not recorded: the change WAS made (the trigger is deleted), '
        + 'but the card could not be marked applied, so it stays Open and has no undo record. '
        + 'Do not apply it again.',
    };
  }
  if (action === 'rollback' && err.code === 'rolled-back-not-recorded' && err.rolledBack === true) {
    return {
      tone: 'error',
      text: 'Card rolled back, but not recorded: the change WAS reverted, '
        + 'but the card could not be marked rolled back. Do not roll it back again.',
    };
  }
  return { tone: 'error', text: `Could not ${action} the card: ${err.message}` };
}

export {
  hasSnapshot,
  isMaintenance,
  formatPercent,
  formatInt,
  formatCompact,
  formatDuration,
  snapshotMeta,
  metricTiles,
  cardClassLabel,
  cardStatusBadge,
  cardsFromResponse,
  splitCards,
  cardAction,
  cardObjectLabel,
  formatMetricValue,
  verdictLine,
  evidenceLines,
  cardActionNotice,
};
