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

module.exports = { planStaleTransitions, lastEvidenceMs, WEEK_MS };
