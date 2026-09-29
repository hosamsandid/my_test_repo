// Suggestion auto-hygiene (skill-UX Phase 3, #776 §4).
//
// A promotion candidate that keeps collecting no new evidence sits in the inbox
// forever — the backlog only ever grows. This pure planner decides, on every
// convergence-collector run, which `open` candidates have gone quiet long enough
// to move to a `stale` state (out of the default inbox, into the "Stale" filter,
// feed-logged) and which `stale` candidates just saw fresh evidence and should be
// revived to `open`. It is deliberately I/O-free: the collector supplies the
// candidate list + the set of candidate ids whose underlying cluster was observed
// this run, and gets back the transitions to persist and the rewritten list.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Evidence-recency decay half-life — kept in sync with the client-side
// evidenceScore in admin-console/src/pages/skill-inbox-view.js (RECENCY_HALFLIFE_DAYS).
// The two are a documented mirror (client is ESM, this is CJS); change both together.
const RECENCY_HALFLIFE_DAYS = 14;
// Default ceiling on open (rendered) suggestion cards per team — a hard backstop so a
// fast-moving team's inbox can't balloon into the thousands. Overridable per-process via
// KNOWLEDGE_MAX_OPEN_SUGGESTIONS. The domain-proposal singleton and amendment cards are
// never evicted (see planOpenCap).
const DEFAULT_MAX_OPEN_SUGGESTIONS = 40;

// Most-recent evidence timestamp for a candidate, in epoch ms. The candidate
// carries `raisedAt` (when the card first appeared) and per-member `createdAt`
// (when each backing lesson was learned); a revived candidate also carries a
// `lastEvidenceAt` bump. We take the max of all of them so a candidate whose
// members are old but was re-raised recently isn't wrongly aged out.
function lastEvidenceMs(cand) {
  if (!cand || typeof cand !== 'object') return 0;
  let best = 0;
  const consider = (v) => {
    if (typeof v !== 'string' || !v) return;
    const t = Date.parse(v);
    if (!Number.isNaN(t) && t > best) best = t;
  };
  consider(cand.raisedAt);
  consider(cand.lastEvidenceAt);
  for (const m of Array.isArray(cand.members) ? cand.members : []) {
    if (m) consider(m.createdAt);
  }
  return best;
}

/**
 * Plan the open→stale / stale→open transitions for a team's candidate store.
 *
 * @param {object[]} candidates  the team's candidate store rows
 * @param {object}   opts
 * @param {string|number} opts.now       reference time (ISO string or epoch ms)
 * @param {number}   [opts.maxWeeks=4]   weeks of quiet before an open card goes stale
 * @param {Set<string>|string[]} [opts.observedIds]  candidate ids whose cluster
 *        was observed this run (fresh evidence) — revives a stale card, protects
 *        an open one from being aged out.
 * @returns {{ stale: object[], revive: object[], next: object[], changed: boolean }}
 *   stale/revive: the candidate rows that transitioned (for feed events);
 *   next: the rewritten candidate list; changed: whether anything moved.
 */
function planStaleTransitions(candidates, { now, maxWeeks = 4, observedIds } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const nowMs = typeof now === 'number' ? now : Date.parse(now || '') || Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const observed = observedIds instanceof Set
    ? observedIds
    : new Set(Array.isArray(observedIds) ? observedIds : []);
  const weeks = Number.isFinite(maxWeeks) && maxWeeks > 0 ? maxWeeks : 4;
  const cutoffMs = weeks * WEEK_MS;

  const stale = [];
  const revive = [];
  const next = list.map((cand) => {
    if (!cand || typeof cand !== 'object' || typeof cand.id !== 'string') return cand;
    const seen = observed.has(cand.id);

    if (cand.status === 'stale') {
      // Fresh evidence on a stale card brings it back to the inbox (#776 AC4).
      if (seen) {
        const { staleAt: _s, ...rest } = cand;
        const revived = { ...rest, status: 'open', lastEvidenceAt: nowIso };
        revive.push(revived);
        return revived;
      }
      return cand;
    }

    if (cand.status === 'open') {
      // Observed this run → evidence is current; keep it live and stamp the bump
      // so a later quiet spell is measured from now, not the original raise.
      if (seen) {
        if (cand.lastEvidenceAt === nowIso) return cand;
        return { ...cand, lastEvidenceAt: nowIso };
      }
      const ageMs = nowMs - lastEvidenceMs(cand);
      if (ageMs > cutoffMs) {
        const staled = { ...cand, status: 'stale', staleAt: nowIso };
        stale.push(staled);
        return staled;
      }
    }
    return cand;
  });

  return { stale, revive, next, changed: stale.length > 0 || revive.length > 0 };
}

// Server-side mirror of admin-console/src/pages/skill-inbox-view.js:evidenceScore —
// "involved agents × lesson count × recency". Recency is an exponential decay so a
// fresh two-agent cluster can out-rank a stale many-agent one, never nullifying to
// zero. Used to pick the lowest-value cards to evict when over the open-card cap.
function evidenceScore(cand, now) {
  const c = cand && typeof cand === 'object' ? cand : {};
  const nowMs = typeof now === 'number' ? now : Date.parse(now || '') || Date.now();
  const agents = Math.max(1, Number(c.convergenceCount)
    || (Array.isArray(c.convergence) ? c.convergence.length : 0) || 1);
  const lessons = Math.max(1, Number(c.lessonCount)
    || (Array.isArray(c.members) ? c.members.length : 0) || 1);
  const ts = lastEvidenceMs(c);
  const recency = ts > 0
    ? 0.5 ** (Math.max(0, (nowMs - ts) / DAY_MS) / RECENCY_HALFLIFE_DAYS)
    : 0.5;
  return agents * lessons * recency;
}

function _entryIdSet(cand) {
  return new Set(Array.isArray(cand && cand.entryIds) ? cand.entryIds : []);
}

// True iff `a` is a STRICT superset of `b` (a covers every member of b and is larger).
function _isStrictSuperset(a, b) {
  if (a.size <= b.size) return false;
  for (const x of b) if (!a.has(x)) return false;
  return true;
}

/**
 * Retire `open` cards whose backing lesson set is fully subsumed by a larger `open`
 * card of the same kind+source. A cluster that gains a lesson gets a NEW stable id and
 * re-raises; without this the superseded original lingers until the multi-week stale
 * sweep, so a busy team's inbox fills with grown-cluster duplicates. Pure — returns a
 * NEW list; the subsumed card becomes `status:"superseded"` (auditable, distinct from
 * quiet-decay `stale`) with `supersededById`/`supersededAt`.
 *
 * Only same-source, same-kind sets are compared (a `related` theme legitimately
 * supersets its member `convergence` cards, but retiring across sources is out of
 * scope here). The domain-proposal singleton is excluded (its entryIds are the
 * unrouted pool, not a promotable member set). Strict-superset ⇒ a total order, so two
 * cards can never mutually supersede.
 */
function planSupersessions(candidates, { now } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const nowIso = new Date(typeof now === 'number' ? now : Date.parse(now || '') || Date.now()).toISOString();
  const open = list.filter((c) => c && c.status === 'open' && c.source !== 'domain-proposal'
    && c.source !== 'domain-skill' // #2592: one card per domain — never retired by another card
    && Array.isArray(c.entryIds) && c.entryIds.length > 0);
  const sets = new Map(open.map((c) => [c.id, _entryIdSet(c)]));
  const supersededBy = new Map(); // subsumed id -> superseder id
  for (const b of open) {
    const bset = sets.get(b.id);
    let best = null;
    for (const a of open) {
      if (a.id === b.id) continue;
      if (a.kind !== b.kind || a.source !== b.source) continue;
      if (!_isStrictSuperset(sets.get(a.id), bset)) continue;
      // Prefer the largest cover; tie-break on id for determinism (strict-superset
      // already rules out equal sizes, but the tie-break keeps re-runs stable).
      if (!best || sets.get(a.id).size > sets.get(best.id).size
        || (sets.get(a.id).size === sets.get(best.id).size && String(a.id) < String(best.id))) {
        best = a;
      }
    }
    if (best) supersededBy.set(b.id, best.id);
  }
  const superseded = [];
  const next = list.map((c) => {
    if (c && typeof c === 'object' && supersededBy.has(c.id)) {
      const s = { ...c, status: 'superseded', supersededById: supersededBy.get(c.id), supersededAt: nowIso };
      superseded.push(s);
      return s;
    }
    return c;
  });
  return { superseded, next, changed: superseded.length > 0 };
}

/**
 * Hard backstop: if the number of `open` cards exceeds `maxOpen`, evict the
 * lowest-evidence (then oldest, then id) cards to `stale` until at the cap. The
 * domain-proposal singleton, per-domain skill cards (#2592) and amendment
 * (`extendMode`) cards are never evicted — they are decidable, low-noise, and the
 * singleton is the whole point of FIX-A. Pure; deterministic; idempotent (a store already at/under the cap rewrites nothing).
 */
function planOpenCap(candidates, { now, maxOpen = DEFAULT_MAX_OPEN_SUGGESTIONS } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const cap = Number.isFinite(maxOpen) && maxOpen >= 1 ? Math.floor(maxOpen) : DEFAULT_MAX_OPEN_SUGGESTIONS;
  const nowIso = new Date(typeof now === 'number' ? now : Date.parse(now || '') || Date.now()).toISOString();
  const isProtected = (c) => c.source === 'domain-proposal' || c.source === 'domain-skill' || c.extendMode === true;
  const openCount = list.filter((c) => c && c.status === 'open').length;
  if (openCount <= cap) return { evicted: [], next: list, changed: false };
  const evictable = list.filter((c) => c && c.status === 'open' && !isProtected(c));
  const overBy = openCount - cap;
  if (overBy <= 0 || evictable.length === 0) return { evicted: [], next: list, changed: false };
  const ranked = evictable.slice().sort((a, b) => (evidenceScore(a, now) - evidenceScore(b, now))
    || (lastEvidenceMs(a) - lastEvidenceMs(b))
    || String(a.id).localeCompare(String(b.id)));
  const evictIds = new Set(ranked.slice(0, Math.min(overBy, ranked.length)).map((c) => c.id));
  const evicted = [];
  const next = list.map((c) => {
    if (c && typeof c === 'object' && evictIds.has(c.id)) {
      const s = { ...c, status: 'stale', staleAt: nowIso, cappedAt: nowIso };
      evicted.push(s);
      return s;
    }
    return c;
  });
  return { evicted, next, changed: evicted.length > 0 };
}

module.exports = {
  planStaleTransitions,
  planSupersessions,
  planOpenCap,
  evidenceScore,
  lastEvidenceMs,
  WEEK_MS,
  DAY_MS,
  RECENCY_HALFLIFE_DAYS,
  DEFAULT_MAX_OPEN_SUGGESTIONS,
};
