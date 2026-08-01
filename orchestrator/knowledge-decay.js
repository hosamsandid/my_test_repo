'use strict';

// Automated-forgetting pure core (#919, Gap 5 of the KM future-proofing epic
// #914).
//
// Two pieces, both driven by the nightly curator backstop:
//
// 1. The DECAY SWEEP turns "not retrieved for a long time" (the #915 read-side
//    aggregate) into `source:"decay"` RETIRE-SUGGESTION cards in the existing
//    per-team candidate store. The doctrine from docs/knowledge-curation.md
//    evolves from "fully-automatic staleness archiving stays out" to
//    "automatic *proposals*, human-gated archive": this module only ever
//    PROPOSES — confirming a card runs the exact same non-destructive archive
//    overlay as the manual Retire button, even at autonomy level 3
//    (retirement destroys context; level-3 promotion only adds).
//
// 2. The CURATION-HEALTH counter aggregates the last 30 days of the candidate
//    store + live feed into a small per-team health record, so a silently-dead
//    convergence pipeline (pushes happening, nothing ever converging — the
//    Gap-3 failure signature) shows up as a monitored amber state instead of
//    being discovered by accident.
//
// Deliberately PURE — no fs, no network, no clock beyond an injected `now` —
// so it is unit-testable without booting the orchestrator (repo convention:
// test pure helper cores only). The IO (reading the canonical clone, the #915
// aggregate, the candidate store; writing candidates + the health file) lives
// in orchestrator.js.

const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const HEALTH_WINDOW_DAYS = 30;

// Mirrors knowledge-convergence.stableSuggestionId's shape contract: one decay
// proposal per entry id, stable across nightly runs — the idempotency the
// candidate store's known-id machinery needs (dismissed stays dismissed).
function decaySuggestionId(entryId) {
  return crypto.createHash('sha1').update(`decay:${entryId}`).digest('hex').slice(0, 12);
}

function _ms(iso) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
}

// The freshest retrieval of one #915 aggregate row across every source —
// including the future `scoped` (#917) — so a new source can never re-mark
// used knowledge as dead.
function _lastRetrievalMs(row) {
  const r = row && typeof row === 'object' ? row : {};
  let max = null;
  for (const [k, v] of Object.entries(r)) {
    if (!/^last[A-Z]/.test(k) || typeof v !== 'string') continue;
    const t = _ms(v);
    if (t !== null && (max === null || t > max)) max = t;
  }
  return max;
}

/**
 * Plan the decay retire-suggestions for one team.
 *
 * @param {object} args
 * @param {object[]} args.entries     post-fold visible canonical entries (the
 *                                    caller applies foldVisibleEntries with the
 *                                    wall clock, so merged/archived/pending/
 *                                    rejected/expired are already gone)
 * @param {object}  args.retrieval    the #915 aggregate { since, entries }
 * @param {string[]} args.includedIds the current digest's includedIds — the
 *                                    team lives off these (evergreen exemption,
 *                                    belt-and-suspenders beside the digest
 *                                    retrieval signal itself)
 * @param {object[]} args.candidates  the existing candidate store rows
 * @param {number}  args.horizonDays  resolved decayHorizonDays (0 = off)
 * @param {string}  args.now          injected clock (ISO)
 * @returns {{ raise: object[], batch: object|null, skipped: string|null }}
 */
function planDecaySuggestions({ entries, retrieval, includedIds, candidates, horizonDays, now } = {}) {
  const nowMs = _ms(now);
  if (!Number.isInteger(horizonDays) || horizonDays <= 0) {
    return { raise: [], batch: null, skipped: 'disabled' };
  }
  if (nowMs === null) return { raise: [], batch: null, skipped: 'no-clock' };
  const horizonMs = horizonDays * DAY_MS;

  // Cold-start gate: before the telemetry baseline is one full horizon old,
  // EVERY entry looks unused — proposing would be noise, so the team is
  // skipped entirely (same grace-window reasoning as the poller's horizon).
  const sinceMs = _ms(retrieval && retrieval.since);
  if (sinceMs === null || nowMs - sinceMs < horizonMs) {
    return { raise: [], batch: null, skipped: 'cold-start' };
  }

  const cutoffMs = nowMs - horizonMs;
  const included = new Set(Array.isArray(includedIds) ? includedIds : []);
  const rows = retrieval && retrieval.entries && typeof retrieval.entries === 'object'
    ? retrieval.entries
    : {};

  // Idempotency: one stable id per entry; an id already open/dismissed/promoted
  // (or stale) is never re-raised — dismissed stays dismissed (AC1).
  const known = new Set(
    (Array.isArray(candidates) ? candidates : [])
      .filter((c) => c && typeof c.id === 'string')
      .map((c) => c.id),
  );

  const ts = typeof now === 'string' ? now : '';
  const raise = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.id !== 'string' || !e.id) continue;
    if (e.status === 'promoted') continue;          // backs a skill — archive is refused anyway
    if (included.has(e.id)) continue;               // evergreen: the digest inlines it
    // Too young to judge: an entry must have existed a full horizon before
    // "no retrievals within the horizon" means anything.
    const createdMs = _ms(e.createdAt);
    if (createdMs === null || createdMs > cutoffMs) continue;
    const lastMs = _lastRetrievalMs(rows[e.id]);
    if (lastMs !== null && lastMs >= cutoffMs) continue; // used within the horizon
    const id = decaySuggestionId(e.id);
    if (known.has(id)) continue;

    const row = rows[e.id] && typeof rows[e.id] === 'object' ? rows[e.id] : {};
    const unusedDays = Math.floor((nowMs - (lastMs !== null ? lastMs : createdMs)) / DAY_MS);
    raise.push({
      id,
      teamId: typeof e.teamId === 'string' ? e.teamId : 'default',
      kind: e.kind,
      canonicalId: e.id,
      entryIds: [e.id],
      convergence: Array.isArray(e.convergence) ? e.convergence.slice() : [],
      convergenceCount: Array.isArray(e.convergence) ? e.convergence.length : 1,
      text: typeof e.text === 'string' ? e.text : '',
      members: [{
        id: e.id,
        originAgent: e.originAgent,
        text: e.text,
        createdAt: e.createdAt,
        correlationId: e.correlationId || null,
        sessionId: e.sessionId || null,
      }],
      source: 'decay',
      status: 'open',
      raisedAt: ts,
      // The inline evidence the card renders ("not used in 74 days · 0 searches
      // · never in a digest") and the audit trail for the decision.
      evidence: {
        unusedDays,
        horizonDays,
        searchHits: Number.isInteger(row.searchHits) ? row.searchHits : 0,
        digestCount: Number.isInteger(row.digestCount) ? row.digestCount : 0,
        lastSearchAt: typeof row.lastSearchAt === 'string' ? row.lastSearchAt : null,
        lastDigestAt: typeof row.lastDigestAt === 'string' ? row.lastDigestAt : null,
      },
    });
  }

  if (raise.length === 0) return { raise: [], batch: null, skipped: null };
  const batch = {
    type: 'suggestion',
    ts,
    teamId: raise[0].teamId,
    source: 'decay',
    count: raise.length,
    samples: raise.slice(0, 5).map((c) => ({ id: c.id, canonicalId: c.canonicalId, text: c.text, unusedDays: c.evidence.unusedDays })),
  };
  return { raise, batch, skipped: null };
}

// ---------------------------------------------------------------------------
// Curation health (the Gap-3 silent-convergence monitor)
// ---------------------------------------------------------------------------

/**
 * Aggregate the trailing window into the per-team health record.
 *
 * @param {object[]} args.candidates the candidate store rows
 * @param {object[]} args.events     parsed live-feed events (any teams — filtered here)
 * @param {string}  args.teamId
 * @param {string}  args.now         injected clock (ISO)
 * @param {number}  args.windowDays  default 30
 * @returns {{ windowDays, since, suggestionsRaised, promoted, dismissed,
 *             pushesSeen, status: 'ok'|'silent', generatedAt }}
 */
function computeCurationHealth({ candidates, events, teamId, now, windowDays = HEALTH_WINDOW_DAYS } = {}) {
  const nowMs = _ms(now) ?? 0;
  const cutoffMs = nowMs - windowDays * DAY_MS;
  const inWindow = (iso) => {
    const t = _ms(iso);
    return t !== null && t >= cutoffMs && t <= nowMs;
  };

  let suggestionsRaised = 0;
  let promoted = 0;
  let dismissed = 0;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || typeof c !== 'object') continue;
    if (inWindow(c.raisedAt)) suggestionsRaised += 1;
    if (c.status === 'promoted' && inWindow(c.promotedAt || c.raisedAt)) promoted += 1;
    if (c.status === 'dismissed' && inWindow(c.dismissedAt || c.raisedAt)) dismissed += 1;
  }

  let pushesSeen = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type !== 'harvest') continue;
    if (teamId && ev.teamId !== teamId) continue;
    if (inWindow(ev.ts)) pushesSeen += 1;
  }

  // The Gap-3 failure signature: knowledge keeps arriving but the pipeline
  // raises nothing and promotes nothing over the whole window.
  const silent = pushesSeen > 0 && suggestionsRaised === 0 && promoted === 0;
  return {
    windowDays,
    since: new Date(cutoffMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    suggestionsRaised,
    promoted,
    dismissed,
    pushesSeen,
    status: silent ? 'silent' : 'ok',
    generatedAt: typeof now === 'string' ? now : '',
  };
}

// One `curation-health` feed event per STATE TRANSITION (never per run — the
// strip is the ambient surface; the feed only records changes). Returns null
// when the status is unchanged.
function planHealthTransition(prevHealth, nextHealth, { teamId, now } = {}) {
  const prev = prevHealth && typeof prevHealth === 'object' ? prevHealth.status : null;
  const next = nextHealth && typeof nextHealth === 'object' ? nextHealth.status : null;
  if (!next || prev === next) return null;
  return {
    type: 'curation-health',
    ts: typeof now === 'string' ? now : '',
    teamId: typeof teamId === 'string' ? teamId : null,
    status: next,
    previous: prev,
  };
}

module.exports = {
  DAY_MS,
  HEALTH_WINDOW_DAYS,
  decaySuggestionId,
  planDecaySuggestions,
  computeCurationHealth,
  planHealthTransition,
};
