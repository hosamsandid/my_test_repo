'use strict';

// Hill-climbing loop Phase 2 (#1224): improvement-card schema, validator,
// deterministic heuristic findings, budget/dedup merge, and the secret-free
// analyst digest builder.
//
// Concept `docs/hill-climbing-agent-concept.md` §3.2/§5/§7. This is the pure,
// fs-free core in the discipline of `process-template.js` / `hill-climb-metrics.js`:
// no I/O, no LLM, golden-fixture testable. The orchestrator (`runHillClimbPass`)
// reads the metrics snapshot and calls into here; the admin console runs the
// server-side one-shot analyst (`resolveAssistTarget`) over the digest this
// module emits and hands the parsed cards back to the orchestrator merge
// endpoint, which re-validates every one through `validateCard` before it
// touches `cards.json`.
//
// Cards are **proposals only** — nothing in this module (or this ticket) mutates
// any agent config. Each card names the metric it expects to move (schema-
// enforced) and cites its evidence, so the loop stays closed and honest.

const crypto = require('crypto');

// The five improvement-card classes (concept §5). Each maps to an existing
// audited apply path (§3.3) — recorded on the card for the Phase-2b applier
// (#1225); nothing here applies anything.
const CARD_CLASSES = [
  'prompt-improvement',
  'flow-wiring',
  'threshold-tuning',
  'trigger-hygiene',
  'knowledge-handoff',
];

// Card lifecycle statuses (concept §7). `open` is the only re-detectable state
// (a fresh finding bumps the open card's evidence rather than duplicating); the
// terminal states are carried as the change-log ledger.
const CARD_STATUSES = [
  'open', 'applied', 'validated', 'neutral', 'regressed', 'rolled-back', 'dismissed', 'superseded',
];

const RISK_CLASSES = ['low', 'medium', 'high'];

const DEFAULT_MAX_CARDS_PER_PASS = 5;

// In-source composite-key delimiter. NUL as a source escape (never a literal
// 0x00 — that flags the file binary in git); runtime byte-identical.
const SEP = '\u0000';

// Per-class defaults: the apply path (existing audited console endpoint, §3.3 —
// informational in this ticket) and a baseline risk class. A card may override
// riskClass; the apply path is always derived so it can never drift from §3.3.
const CLASS_DEFAULTS = {
  'prompt-improvement': { risk: 'high', apply: { via: 'prompt-choke-points', undo: 'prompt-history' } },
  'flow-wiring': { risk: 'medium', apply: { via: 'PUT /api/agents/:id (ports)', undo: 'port-edit' } },
  'threshold-tuning': { risk: 'low', apply: { via: 'PUT /api/agents/:teamId (anomalyThresholds/hillClimb)', undo: 'previous-value' } },
  'trigger-hygiene': { risk: 'low', apply: { via: 'DELETE /api/agents/:id/triggers/:tid', undo: 'card-retains-trigger' } },
  'knowledge-handoff': { risk: 'low', apply: { via: 'curator candidate store', undo: 'curator-review' } },
};

// The apply path a card class declares — a pure lookup so a card's route can
// never contradict the concept table.
function defaultApplyPath(cardClass) {
  const d = CLASS_DEFAULTS[cardClass];
  return d ? { ...d.apply } : null;
}

// Stable composite object key for dedup — `<kind>\0<id>`. The invariant "one
// open card per (object, class)" hangs off `<class>\0<objectKey>`.
function objectKey(object) {
  if (!object || typeof object !== 'object') return '';
  return `${object.kind || ''}${SEP}${object.id || ''}`;
}

// Deterministic card id from (teamId, class, object) so a re-detected finding
// maps to the SAME card across passes (the merge then bumps it). Content-blind
// — the id keys the object, not the evidence, so evidence can grow in place.
function cardId(teamId, cardClass, object) {
  const h = crypto.createHash('sha1');
  h.update(`${teamId || ''}${SEP}${cardClass || ''}${SEP}${objectKey(object)}`);
  return `hc_${h.digest('hex').slice(0, 12)}`;
}

// ── validation (concept §3.2: the schema enforces the closed loop) ───────────
//
// A card MUST cite evidence and name the metric it expects to move; a card
// missing either is rejected. Returns { ok:true } or { ok:false, error }.
function validateCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return { ok: false, error: 'card must be an object' };
  }
  if (!CARD_CLASSES.includes(card.class)) {
    return { ok: false, error: `class must be one of ${CARD_CLASSES.join(', ')}` };
  }
  const obj = card.object;
  if (!obj || typeof obj !== 'object' || typeof obj.kind !== 'string' || !obj.kind.trim()
      || typeof obj.id !== 'string' || !obj.id.trim()) {
    return { ok: false, error: 'object must be { kind, id } with non-empty strings' };
  }
  if (typeof card.title !== 'string' || !card.title.trim()) {
    return { ok: false, error: 'title is required' };
  }
  // Mandatory declared target metric — the closed-loop invariant (AC).
  if (typeof card.targetMetric !== 'string' || !card.targetMetric.trim()) {
    return { ok: false, error: 'targetMetric is required (a card must name the metric it expects to move)' };
  }
  // Mandatory, non-empty evidence, each entry citing a source (AC).
  if (!Array.isArray(card.evidence) || card.evidence.length === 0) {
    return { ok: false, error: 'evidence must be a non-empty array' };
  }
  for (const e of card.evidence) {
    if (!e || typeof e !== 'object' || typeof e.type !== 'string' || !e.type.trim()) {
      return { ok: false, error: 'each evidence entry needs a non-empty type' };
    }
    if (e.ref === undefined && e.value === undefined) {
      return { ok: false, error: 'each evidence entry needs a ref or a value' };
    }
  }
  if (card.riskClass !== undefined && !RISK_CLASSES.includes(card.riskClass)) {
    return { ok: false, error: `riskClass must be one of ${RISK_CLASSES.join(', ')}` };
  }
  if (card.status !== undefined && !CARD_STATUSES.includes(card.status)) {
    return { ok: false, error: `status must be one of ${CARD_STATUSES.join(', ')}` };
  }
  return { ok: true };
}

// Coerce a raw finding / analyst card into a full card record with defaults, then
// validate. Returns { ok:true, card } or { ok:false, error }. `source` is
// 'heuristic' | 'analyst'. Never mutates the input.
function normalizeCard(raw, { teamId = '', now = Date.now(), source = 'heuristic', passId = null } = {}) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'card must be an object' };
  const cardClass = raw.class;
  const object = raw.object && typeof raw.object === 'object'
    ? { kind: String(raw.object.kind || '').trim(), id: String(raw.object.id || '').trim() }
    : null;
  const nowIso = new Date(now).toISOString();
  const riskClass = RISK_CLASSES.includes(raw.riskClass)
    ? raw.riskClass
    : (CLASS_DEFAULTS[cardClass] ? CLASS_DEFAULTS[cardClass].risk : 'medium');
  const card = {
    id: cardId(teamId, cardClass, object),
    teamId: String(teamId || ''),
    class: cardClass,
    object,
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    detail: typeof raw.detail === 'string' ? raw.detail.trim() : '',
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    proposedChange: raw.proposedChange !== undefined ? raw.proposedChange : null,
    targetMetric: typeof raw.targetMetric === 'string' ? raw.targetMetric.trim() : '',
    applyPath: defaultApplyPath(cardClass),
    riskClass,
    status: 'open',
    source: source === 'analyst' ? 'analyst' : 'heuristic',
    seen: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    passId: passId || null,
    cooldownUntil: null,
  };
  const v = validateCard(card);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, card };
}

// Human-readable name for a zero-fire trigger: the agent, the event and the
// label it listens for (#2710) — never just the raw trigger id, which means
// nothing to the person reading the card.
function describeTrigger(t) {
  const who = t.agentName || t.agentId || 'agent';
  const events = Array.isArray(t.events) && t.events.length ? t.events.join(', ') : '';
  if (t.labelFilter) return `${who}'s listener for '${t.labelFilter}'${events ? ` (${events})` : ''}`;
  if (events) return `${who}'s ${events} trigger`;
  if (t.type === 'cron') return `${who}'s scheduled trigger`;
  if (t.type) return `${who}'s ${t.type} trigger`;
  return `${who}'s trigger '${t.triggerId}'`;
}

// ── deterministic heuristic findings (concept §3.2 honest fallback) ──────────
//
// With no reachable analyst provider the pass still ships its mechanically
// derivable findings as cards: zero-fire triggers, emitted-but-unconsumed
// labels, and recurring anomalies. Pure over the metrics snapshot; `opts.now` /
// `opts.passId` stamp the cards, and `opts.anomalyHistory` (raw #1221 rows, when
// available) lets recurrence findings name the specific stalled object.
function heuristicFindings(snapshot, opts = {}) {
  const teamId = (snapshot && snapshot.teamId) || opts.teamId || '';
  const now = opts.now || Date.now();
  const passId = opts.passId || null;
  const metrics = (snapshot && snapshot.metrics) || {};
  const dead = metrics.deadConfig || {};
  const cards = [];
  const push = (raw) => {
    const n = normalizeCard(raw, { teamId, now, source: 'heuristic', passId });
    if (n.ok) cards.push(n.card);
  };

  // 1) Zero-fire triggers → trigger-hygiene (burning nothing but review noise).
  //    Below the run floor a quiet trigger is no evidence of a dead one — a new
  //    team simply has not run yet — so no deletion card is raised (#2710).
  const zeroFire = snapshot && snapshot.insufficientData ? [] : dead.zeroFireTriggers;
  for (const t of Array.isArray(zeroFire) ? zeroFire : []) {
    if (!t || !t.triggerId) continue;
    const ref = `${t.agentId || '?'}/${t.triggerId}`;
    const label = describeTrigger(t);
    push({
      class: 'trigger-hygiene',
      object: { kind: 'trigger', id: ref },
      title: `${label} has not fired this window`,
      detail: `${label} (trigger id '${t.triggerId}') recorded zero fires over the measurement window. Consider deleting it, re-scoping its events, or tightening its labelFilter.`,
      evidence: [{ type: 'metric', ref: 'metrics.deadConfig.zeroFireTriggers', value: ref }],
      proposedChange: { action: 'delete-or-rescope', agentId: t.agentId || null, triggerId: t.triggerId },
      targetMetric: 'waste.wasteRuns',
    });
  }

  // 2) Emitted-but-unconsumed labels → flow-wiring (a dead-end hand-off).
  for (const label of Array.isArray(dead.unconsumedEmits) ? dead.unconsumedEmits : []) {
    if (!label) continue;
    push({
      class: 'flow-wiring',
      object: { kind: 'label', id: String(label) },
      title: `Label '${label}' is emitted but nobody listens for it`,
      detail: `A role emits '${label}' but no trigger consumes it, so that hand-off is a dead end. Wire a listener or remove the emit.`,
      evidence: [{ type: 'metric', ref: 'metrics.deadConfig.unconsumedEmits', value: String(label) }],
      proposedChange: { action: 'wire-or-remove-emit', label: String(label) },
      targetMetric: 'metrics.deadConfig.unconsumedEmits',
    });
  }

  // 3) Recurring anomalies → flow-wiring, keyed to the specific object when the
  //    raw #1221 history is available (≥2 sweeps in-window = a recurrence).
  const recurring = recurringAnomalyIdentities(opts.anomalyHistory,
    snapshot && snapshot.window ? snapshot.window.fromMs : null,
    snapshot && snapshot.window ? snapshot.window.toMs : null);
  for (const r of recurring) {
    push({
      class: 'flow-wiring',
      object: { kind: 'anomaly', id: `${r.class}:${r.objectId}` },
      title: `Recurring anomaly '${r.class}' on ${r.objectId}`,
      detail: `The '${r.class}' anomaly on ${r.objectId} was observed in ${r.sightings} sweeps this window — a topological cause, not a one-off. Fix the wiring rather than the symptom.`,
      evidence: [{ type: 'anomaly-history', ref: `${r.class}:${r.objectId}`, value: `${r.sightings} sightings` }],
      proposedChange: { action: 'review-wiring', anomalyClass: r.class, objectId: r.objectId },
      targetMetric: 'metrics.anomalyRecurrence',
    });
  }

  // 3b) No per-object detail but the aggregate recurrence count is non-zero:
  //     raise a single team-level flow-wiring card so the signal is not lost.
  if (!recurring.length && Number.isFinite(metrics.anomalyRecurrence) && metrics.anomalyRecurrence > 0) {
    push({
      class: 'flow-wiring',
      object: { kind: 'team', id: teamId || 'team' },
      title: `${metrics.anomalyRecurrence} anomaly identit${metrics.anomalyRecurrence === 1 ? 'y' : 'ies'} recurred this window`,
      detail: 'One or more flow anomalies were seen in at least two sweeps this window. Open the Anomalies panel to identify the topological cause.',
      evidence: [{ type: 'metric', ref: 'metrics.anomalyRecurrence', value: metrics.anomalyRecurrence }],
      proposedChange: { action: 'review-wiring' },
      targetMetric: 'metrics.anomalyRecurrence',
    });
  }

  return cards;
}

// Anomaly identities seen in ≥2 in-window sweeps of the raw #1221 history.
// Mirrors hill-climb-metrics.countAnomalyRecurrence but returns the identities
// (so a card can name the object), deterministically ordered.
function recurringAnomalyIdentities(anomalyHistory, fromMs, toBound) {
  const perId = new Map();
  const from = Number.isFinite(fromMs) ? fromMs : -Infinity;
  const to = Number.isFinite(toBound) ? toBound : Infinity;
  for (const sweep of Array.isArray(anomalyHistory) ? anomalyHistory : []) {
    const t = sweep && sweep.ts != null ? Date.parse(sweep.ts) : NaN;
    const ms = Number.isFinite(t) ? t : (typeof (sweep && sweep.ts) === 'number' ? sweep.ts : NaN);
    if (!Number.isFinite(ms) || ms < from || ms > to) continue;
    for (const a of Array.isArray(sweep && sweep.anomalies) ? sweep.anomalies : []) {
      if (!a || a.class == null || a.objectId == null) continue;
      const id = `${a.class}${SEP}${a.objectId}`;
      if (!perId.has(id)) perId.set(id, { class: a.class, objectId: a.objectId, ts: new Set() });
      perId.get(id).ts.add(ms);
    }
  }
  const out = [];
  for (const rec of perId.values()) {
    if (rec.ts.size >= 2) out.push({ class: rec.class, objectId: rec.objectId, sightings: rec.ts.size });
  }
  out.sort((a, b) => `${a.class}:${a.objectId}`.localeCompare(`${b.class}:${b.objectId}`));
  return out;
}

// ── budget & dedup merge (concept §3.3 curator discipline) ───────────────────
//
// Fold this pass's incoming (already normalized+valid) cards into the persisted
// store, enforcing:
//   - at most `maxCardsPerPass` NEW open cards per pass; the rest are deferred.
//   - one OPEN card per (object, class): a re-detected finding bumps the open
//     card's evidence/seen instead of duplicating.
//   - a cooldown of one full window after an APPLIED change on the same object:
//     a re-detection during the cooldown is deferred, never re-raised.
//   - a DISMISSED card suppresses re-raising the same finding.
// Terminal cards (validated/neutral/regressed/dismissed/superseded/applied) are
// carried through untouched. Returns { cards, added, bumped, deferred, deferredCooldown }.
function mergeCards(existingCards, incomingCards, opts = {}) {
  const now = opts.now || Date.now();
  const maxCards = Number.isFinite(opts.maxCardsPerPass) && opts.maxCardsPerPass >= 0
    ? opts.maxCardsPerPass : DEFAULT_MAX_CARDS_PER_PASS;
  const existing = (Array.isArray(existingCards) ? existingCards : []).map((c) => ({ ...c }));
  const incoming = Array.isArray(incomingCards) ? incomingCards : [];

  // Latest card per key (a key can accumulate an applied + later open history —
  // we index the most recently updated one to decide what a re-detection does).
  const keyOf = (c) => `${c.class}${SEP}${objectKey(c.object)}`;
  const latestByKey = new Map();
  for (const c of existing) {
    const k = keyOf(c);
    const prev = latestByKey.get(k);
    if (!prev || Date.parse(c.updatedAt || 0) >= Date.parse(prev.updatedAt || 0)) latestByKey.set(k, c);
  }

  let bumped = 0;
  let deferredCooldown = 0;
  const candidates = [];
  for (const inc of incoming) {
    const k = keyOf(inc);
    const latest = latestByKey.get(k);
    if (latest) {
      if (latest.status === 'open') {
        // Bump the open card's evidence (dedupe by JSON identity), never duplicate.
        latest.evidence = mergeEvidence(latest.evidence, inc.evidence);
        latest.seen = (Number.isFinite(latest.seen) ? latest.seen : 1) + 1;
        latest.title = inc.title || latest.title;
        latest.detail = inc.detail || latest.detail;
        latest.proposedChange = inc.proposedChange != null ? inc.proposedChange : latest.proposedChange;
        latest.updatedAt = new Date(now).toISOString();
        latest.passId = inc.passId || latest.passId;
        bumped += 1;
        continue;
      }
      if (latest.status === 'applied' && latest.cooldownUntil && Date.parse(latest.cooldownUntil) > now) {
        // Cooldown after an applied change on this object: defer, don't re-raise.
        deferredCooldown += 1;
        continue;
      }
      if (latest.status === 'dismissed') {
        // A human dismissed this finding; respect it — do not re-raise.
        deferredCooldown += 1;
        continue;
      }
      if (latest.status === 'regressed') {
        // A verdict flipped this into a rollback card (#1226) — the human still
        // has a rollback to click; don't duplicate the finding as a new card.
        deferredCooldown += 1;
        continue;
      }
      if (latest.status === 'rolled-back' && latest.cooldownUntil && Date.parse(latest.cooldownUntil) > now) {
        // A rolled-back object re-enters detection only after a fresh window
        // (#1226 cooldown interplay) — defer until the rollback's cooldown ends.
        deferredCooldown += 1;
        continue;
      }
      // Otherwise (validated/neutral/superseded, applied past its cooldown, or a
      // rolled-back object past its fresh window): the loop may raise a fresh
      // open card. Falls through to budget.
    }
    candidates.push(inc);
  }

  // Budget: keep the highest-priority NEW cards, defer the rest deterministically.
  candidates.sort(cardPriority);
  const taken = candidates.slice(0, maxCards);
  const deferredBudget = candidates.length - taken.length;

  const cards = existing.concat(taken);
  cards.sort(cardPriority);
  return {
    cards,
    added: taken.length,
    bumped,
    deferred: deferredBudget + deferredCooldown,
    deferredCooldown,
    deferredBudget,
  };
}

// Supersede open trigger cards whose trigger no longer exists (#2710). A card
// keyed to a deleted trigger can never be applied (the console answers 409
// stale-card), and since it is never re-detected it would otherwise stay open
// forever. `liveTriggerRefs` is every `"<agentId>/<triggerId>"` the team
// declares right now. Mutates and returns the count of superseded cards. Pure
// otherwise.
function supersedeVanishedTriggerCards(cards, liveTriggerRefs, opts = {}) {
  const live = liveTriggerRefs instanceof Set ? liveTriggerRefs : new Set(liveTriggerRefs || []);
  const nowIso = new Date(opts.now || Date.now()).toISOString();
  let superseded = 0;
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c || c.status !== 'open' || !c.object || c.object.kind !== 'trigger') continue;
    if (typeof c.object.id !== 'string' || live.has(c.object.id)) continue;
    c.status = 'superseded';
    c.supersededReason = 'trigger no longer exists';
    c.updatedAt = nowIso;
    superseded += 1;
  }
  return superseded;
}

// Union two evidence lists, de-duplicating by canonical JSON so a re-detection
// grows the citation set without piling up identical entries.
function mergeEvidence(a, b) {
  const seen = new Set();
  const out = [];
  for (const e of [].concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : [])) {
    if (!e || typeof e !== 'object') continue;
    const key = JSON.stringify([e.type, e.ref, e.value]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// Deterministic priority order: open before other statuses, then higher risk,
// then class order, then object key. Stable across runs (identical snapshots →
// identical stored order).
const RISK_RANK = { high: 0, medium: 1, low: 2 };
function cardPriority(a, b) {
  const sa = a.status === 'open' ? 0 : 1;
  const sb = b.status === 'open' ? 0 : 1;
  if (sa !== sb) return sa - sb;
  const ra = RISK_RANK[a.riskClass] != null ? RISK_RANK[a.riskClass] : 1;
  const rb = RISK_RANK[b.riskClass] != null ? RISK_RANK[b.riskClass] : 1;
  if (ra !== rb) return ra - rb;
  const ca = CARD_CLASSES.indexOf(a.class);
  const cb = CARD_CLASSES.indexOf(b.class);
  if (ca !== cb) return ca - cb;
  return `${a.class}${SEP}${objectKey(a.object)}`.localeCompare(`${b.class}${SEP}${objectKey(b.object)}`);
}

// ── secret-free analyst digest (concept §3.2: pre-digested, small, secret-free) ─
//
// Build the compact, redacted object handed to the server-side analyst: the §4
// aggregates plus the top-K deterministic findings' evidence, every string value
// scrubbed through `redactSecrets` as belt-and-braces. Char-capped (~4 chars ≈ 1
// token) so the input stays well under the ~10k-token budget. Pure.
function buildAnalystDigest(snapshot, opts = {}) {
  const maxTokens = Number.isFinite(opts.maxTokens) && opts.maxTokens > 0 ? opts.maxTokens : 10000;
  const maxChars = maxTokens * 4;
  const topK = Number.isFinite(opts.topK) && opts.topK > 0 ? opts.topK : 12;
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const m = s.metrics || {};

  const findings = (Array.isArray(opts.findings) ? opts.findings : [])
    .slice(0, topK)
    .map((c) => scrubValue({
      class: c.class,
      object: c.object,
      title: c.title,
      targetMetric: c.targetMetric,
      evidence: c.evidence,
    }));

  const excerpts = (Array.isArray(opts.evidenceExcerpts) ? opts.evidenceExcerpts : [])
    .slice(0, topK)
    .map((e) => scrubValue({ ref: e && e.ref, text: redactSecrets(String(e && e.text || '')) }));

  const digest = {
    teamId: s.teamId || opts.teamId || '',
    window: s.window ? { from: s.window.from, to: s.window.to, windowDays: s.windowDays } : null,
    totalRuns: s.totalRuns,
    insufficientData: !!s.insufficientData,
    minRunsPerWindow: s.minRunsPerWindow,
    metrics: scrubValue({
      runSuccessRate: m.runSuccessRate,
      reworkRatio: m.reworkRatio,
      timeToDone: m.timeToDone,
      anomalyRecurrence: m.anomalyRecurrence,
      waste: m.waste,
      deadConfig: m.deadConfig,
    }),
    findings,
    evidenceExcerpts: excerpts,
    cardClasses: CARD_CLASSES,
  };

  // Enforce the size cap: drop excerpts, then findings, until we fit.
  let json = JSON.stringify(digest);
  while (json.length > maxChars && digest.evidenceExcerpts.length) {
    digest.evidenceExcerpts.pop();
    json = JSON.stringify(digest);
  }
  while (json.length > maxChars && digest.findings.length) {
    digest.findings.pop();
    json = JSON.stringify(digest);
  }
  digest.truncated = json.length > maxChars;
  return digest;
}

// Recursively scrub every string in a JSON-ish value through redactSecrets.
function scrubValue(v) {
  if (typeof v === 'string') return redactSecrets(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = scrubValue(val);
    return out;
  }
  return v;
}

// Redact common secret shapes so nothing sensitive reaches the analyst. Belt-
// and-braces: the digest is aggregate-level already, but any excerpt that
// carried a token/key/PEM is scrubbed regardless of source. Conservative — it
// prefers a false redaction to a leaked credential.
const SECRET_PATTERNS = [
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, // PEM keys
  /ssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/=]+/g,                                // ssh public/priv material
  /gh[pousr]_[A-Za-z0-9]{20,}/g,                                               // GitHub PAT (classic)
  /github_pat_[A-Za-z0-9_]{20,}/g,                                             // GitHub fine-grained PAT
  /sk-ant-[A-Za-z0-9_-]{10,}/g,                                                // Anthropic key
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,                                             // Slack token
  /AKIA[0-9A-Z]{16}/g,                                                         // AWS access key id
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,            // JWT
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,                       // email address
];
// key=value style secrets (token/password/secret/api_key/authorization/bearer).
const SECRET_KV = /\b(authorization|bearer|token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"'&]+/gi;

function redactSecrets(input) {
  if (typeof input !== 'string' || !input) return input;
  let out = input;
  out = out.replace(SECRET_KV, (m) => {
    const idx = m.search(/[:=]/);
    return `${m.slice(0, idx + 1)} [REDACTED]`;
  });
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

module.exports = {
  CARD_CLASSES,
  CARD_STATUSES,
  RISK_CLASSES,
  DEFAULT_MAX_CARDS_PER_PASS,
  defaultApplyPath,
  objectKey,
  cardId,
  validateCard,
  normalizeCard,
  heuristicFindings,
  describeTrigger,
  supersedeVanishedTriggerCards,
  recurringAnomalyIdentities,
  mergeCards,
  mergeEvidence,
  buildAnalystDigest,
  redactSecrets,
};
