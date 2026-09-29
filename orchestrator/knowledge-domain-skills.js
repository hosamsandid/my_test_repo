'use strict';

// Domain → skill pipeline (#2592): every domain grows into exactly ONE living skill.
//
// knowledge-routing.js decides WHICH domain a converged lesson belongs to. This
// module decides what happens next, per domain rather than per lesson:
//
//   - routed lessons are parked as `domain-queued` rows (never an open card of
//     their own), tagged with their domainId + the routing method;
//   - per domain, the queued lessons become ONE unit of work:
//       · extend — the domain skill already exists → fold them in;
//       · create — no skill yet, and the queue meets the first-skill threshold
//                  (default ≥3 lessons from ≥2 distinct agents) → write it;
//       · wait   — no skill yet and below the threshold → stay queued;
//   - level 3 + an `auto` team>team gate applies the work directly (within the
//     shared per-pass cap; the rest waits for the next pass). Otherwise the work
//     becomes ONE open card per domain ("Create / update skill <Domain>") that
//     lists every pending lesson;
//   - a queued lesson is only settled (`promoted`) once its entry ids are in the
//     provenance of the skill it went into — never on the strength of a name match.
//
// Pure: no IO. The orchestrator collector owns the reads/writes and the LLM seam.

const { domainSkillName } = require('./knowledge-domains');
const { curatorThemeSkillDraft, curatorThemeSkillProvenance } = require('./knowledge-curator');
const { DEFAULT_DOMAIN_SKILL_THRESHOLD, normalizeDomainSkillThreshold } = require('./knowledge-store');

const DOMAIN_CARD_SOURCE = 'domain-skill';
const QUEUED_STATUS = 'domain-queued';

// Statuses that mean "this cluster is already decided — don't classify it again".
const SETTLED_STATUSES = new Set(['promoted', 'dismissed', 'digest-only', 'superseded']);

function _str(v) { return typeof v === 'string' && v.trim() ? v.trim() : ''; }
function _ts(now) { return _str(now) || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function _ids(arr) { return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : []; }

// The stable id of a domain's single card. Keyed by domain id, so a renamed domain
// keeps its card and a lesson joining the domain upserts the same card.
function domainCardId(domainId) {
  return `ds-${_str(domainId) || 'domain'}`;
}

function isDomainCard(row) {
  return !!row && row.source === DOMAIN_CARD_SOURCE;
}

// ---------------------------------------------------------------------------
// Routing inputs
// ---------------------------------------------------------------------------

/**
 * Split this pass's candidates (toCandidate rows of CONVERGED clusters) into the
 * ones that still need classifying and the ones already decided.
 *
 *  - promoted / dismissed / digest-only / superseded rows: decided, left alone;
 *  - `domain-queued` rows whose domain still exists: decided;
 *  - `domain-queued` rows whose domain was removed: re-classified;
 *  - `unrouted` rows classified against the CURRENT domain list (`domainsVersion`,
 *    the domains doc's updatedAt): decided — so an unrouted lesson doesn't cost an
 *    LLM call on every pass, only after the taxonomy changes;
 *  - legacy per-lesson amendment cards (open, extendMode, domainId): folded into
 *    the domain queue (`migrate`) so the domain ends up with one card;
 *  - any other open card (a pre-#2592 lesson card): left as it is.
 *
 * @returns {{ toClassify: object[], migrate: object[], claimedCanonicalIds: Set<string> }}
 */
function planRoutingInputs(candidates, rows, { domainIds, domainsVersion } = {}) {
  const byId = new Map((Array.isArray(rows) ? rows : []).filter((r) => r && r.id).map((r) => [r.id, r]));
  const live = domainIds instanceof Set ? domainIds : new Set(_ids(domainIds));
  const toClassify = [];
  const migrate = [];
  const claimed = new Set();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || !c.id) continue;
    if (c.canonicalId) claimed.add(c.canonicalId);
    const row = byId.get(c.id);
    if (!row) { toClassify.push(c); continue; }
    if (SETTLED_STATUSES.has(row.status)) continue;
    if (row.status === QUEUED_STATUS) {
      if (!live.has(row.domainId)) toClassify.push(c);
      continue;
    }
    if (row.status === 'unrouted') {
      if (!_str(domainsVersion) || row.routedAgainst !== domainsVersion) toClassify.push(c);
      continue;
    }
    if (row.status === 'open' && row.extendMode === true && _str(row.domainId) && live.has(row.domainId)) {
      migrate.push(row);
      continue;
    }
    // Some other tracked card (open/stale lesson card from before #2592) — leave it.
  }
  return { toClassify, migrate, claimedCanonicalIds: claimed };
}

// Shape a routed lesson into its parked row.
function queuedRow(candidate, { domainId, via, now } = {}) {
  const { matchedSkill: _m, extendMode: _e, autoDrafted: _a, gateReason: _g, ...rest } = candidate || {};
  return {
    ...rest,
    status: QUEUED_STATUS,
    domainId,
    routedVia: _str(via) || 'heuristic',
    routedAt: _ts(now),
  };
}

// Shape a lesson no domain fits into its parked row (D5: digest only, counts toward
// a new-domain proposal, never its own skill).
function unroutedRow(candidate, { via, domainsVersion, now } = {}) {
  return {
    ...(candidate || {}),
    status: 'unrouted',
    routedVia: _str(via) || 'heuristic',
    routedAgainst: _str(domainsVersion) || null,
    routedAt: _ts(now),
  };
}

// ---------------------------------------------------------------------------
// Bundling + planning
// ---------------------------------------------------------------------------

// Distinct agents behind a set of lesson rows (convergence ∪ member origin agents).
function lessonAgents(rows) {
  const agents = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    for (const a of _ids(r && r.convergence)) agents.add(a);
    for (const m of Array.isArray(r && r.members) ? r.members : []) {
      if (m && _str(m.originAgent)) agents.add(m.originAgent);
    }
  }
  return [...agents];
}

/**
 * Bundle a domain's queued lesson rows into ONE candidate-shaped object the curator
 * draft/provenance builders accept: union of entry ids, members (by id), agents and
 * kinds, plus the list of row ids it stands for.
 */
function bundleLessons(domain, rows, { teamId } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const entryIds = [];
  const seenIds = new Set();
  const members = [];
  const seenMembers = new Set();
  const kinds = [];
  for (const r of list) {
    for (const id of _ids(r.entryIds)) if (!seenIds.has(id)) { seenIds.add(id); entryIds.push(id); }
    for (const m of Array.isArray(r.members) ? r.members : []) {
      const key = (m && m.id) || JSON.stringify(m);
      if (!m || seenMembers.has(key)) continue;
      seenMembers.add(key);
      members.push(m);
    }
    if (_str(r.kind) && !kinds.includes(r.kind)) kinds.push(r.kind);
  }
  const agents = lessonAgents(list);
  const d = domain && typeof domain === 'object' ? domain : {};
  return {
    teamId: _str(teamId) || (list[0] && list[0].teamId) || null,
    kind: kinds[0] || 'convention',
    kinds,
    canonicalId: (list[0] && list[0].canonicalId) || entryIds[0] || null,
    entryIds,
    members,
    convergence: agents,
    convergenceCount: agents.length,
    lessonCount: list.length,
    lessonIds: list.map((r) => r.id).filter(Boolean),
    domainId: d.id || null,
    text: _str(d.name) || _str(d.id) || 'Team knowledge',
  };
}

/**
 * Decide the per-domain work for this pass. Pure.
 *
 * @param {object[]} queuedRows   the team's `domain-queued` rows
 * @param {object[]} domains      the team's domain list
 * @param {object} opts
 *   - existingSkillNames: Set|string[] of team skills that exist on disk
 *   - threshold:          { minLessons, minAgents } for a domain's FIRST skill
 *   - autoApply:          level 3 + team>team gate `auto`
 *   - cap:                how many domains may be applied this pass (shared cap)
 * @returns {{ apply: object[], cards: object[], waiting: object[] }}
 *   each item: { domain, skillName, mode:'create'|'extend', rows, bundle }
 *   waiting items carry `reason`: 'below-threshold' | 'over-cap'
 */
function planDomainSkillWork(queuedRows, domains, {
  existingSkillNames, threshold, autoApply = false, cap = 3,
} = {}) {
  const exists = existingSkillNames instanceof Set ? existingSkillNames : new Set(_ids(existingSkillNames));
  const t = normalizeDomainSkillThreshold(threshold);
  const capN = Number.isInteger(cap) && cap >= 0 ? cap : 3;
  const byDomain = new Map();
  for (const r of Array.isArray(queuedRows) ? queuedRows : []) {
    if (!r || r.status !== QUEUED_STATUS || !_str(r.domainId)) continue;
    if (!byDomain.has(r.domainId)) byDomain.set(r.domainId, []);
    byDomain.get(r.domainId).push(r);
  }
  const apply = [];
  const cards = [];
  const waiting = [];
  for (const domain of Array.isArray(domains) ? domains : []) {
    if (!domain || !byDomain.has(domain.id)) continue;
    const rows = byDomain.get(domain.id);
    const skillName = domainSkillName(domain);
    const mode = exists.has(skillName) ? 'extend' : 'create';
    const bundle = bundleLessons(domain, rows);
    const item = { domain, skillName, mode, rows, bundle };
    if (mode === 'create' && (bundle.lessonCount < t.minLessons || bundle.convergence.length < t.minAgents)) {
      waiting.push({ ...item, reason: 'below-threshold' });
      continue;
    }
    if (!autoApply) { cards.push(item); continue; }
    if (apply.length >= capN) { waiting.push({ ...item, reason: 'over-cap' }); continue; }
    apply.push(item);
  }
  return { apply, cards, waiting };
}

// ---------------------------------------------------------------------------
// The per-domain card
// ---------------------------------------------------------------------------

/**
 * Build (or refresh) a domain's single open card from its planned work item.
 * A card the operator dismissed, or that went stale, stays that way until a NEW
 * lesson joins the domain; then it re-opens with the full pending list.
 */
function buildDomainCard(item, { teamId, now, prior, gateReason } = {}) {
  const ts = _ts(now);
  const b = item.bundle;
  const d = item.domain || {};
  const p = prior && typeof prior === 'object' ? prior : null;
  const priorLessons = new Set(_ids(p && p.lessonIds));
  const grew = b.lessonIds.some((id) => !priorLessons.has(id));
  const sameShape = p && !grew && p.mode === item.mode && p.domainName === (d.name || d.id);
  if (p && p.status !== 'open' && !grew) return p; // respect dismissed/stale until new evidence
  const card = {
    ...(p || {}),
    id: domainCardId(d.id),
    teamId: _str(teamId) || b.teamId || (p && p.teamId) || null,
    source: DOMAIN_CARD_SOURCE,
    status: 'open',
    kind: b.kind,
    kinds: b.kinds,
    canonicalId: b.canonicalId,
    entryIds: b.entryIds,
    members: b.members,
    convergence: b.convergence,
    convergenceCount: b.convergenceCount,
    lessonIds: b.lessonIds,
    lessonCount: b.lessonCount,
    domainId: d.id,
    domainName: d.name || d.id,
    domainSkill: item.skillName,
    mode: item.mode,
    extendMode: item.mode === 'extend',
    matchedSkill: item.mode === 'extend' ? { name: item.skillName, tier: 'team' } : null,
    autoDrafted: true,
    text: `${item.mode === 'extend' ? 'Update' : 'Create'} skill ${d.name || d.id} — ${b.lessonCount} pending ${b.lessonCount === 1 ? 'lesson' : 'lessons'}`,
    raisedAt: sameShape ? (p.raisedAt || ts) : ts,
  };
  if (_str(gateReason)) card.gateReason = gateReason;
  if (grew && p) { delete card.dismissReason; delete card.dismissedAt; delete card.staleAt; }
  return card;
}

/**
 * Reconcile the domain cards in the store with this pass's plan. Pure — returns a
 * new rows array. Cards for planned domains are upserted; an OPEN card whose domain
 * has no card-worthy work any more (applied, removed, or its lessons settled) is
 * retired as `superseded`. Non-card rows pass through untouched.
 */
function reconcileDomainCards(rows, items, { teamId, now, gateReason } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const want = new Map((Array.isArray(items) ? items : []).map((it) => [domainCardId(it.domain.id), it]));
  const out = [];
  const seen = new Set();
  for (const r of list) {
    if (!isDomainCard(r)) { out.push(r); continue; }
    const it = want.get(r.id);
    if (it) {
      out.push(buildDomainCard(it, { teamId, now, prior: r, gateReason }));
      seen.add(r.id);
    } else if (r.status === 'open') {
      out.push({ ...r, status: 'superseded', supersededAt: _ts(now) });
    } else {
      out.push(r);
    }
  }
  for (const [id, it] of want) {
    if (!seen.has(id)) out.push(buildDomainCard(it, { teamId, now, gateReason }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Skill drafts + settlement
// ---------------------------------------------------------------------------

// The heuristic SKILL.md for a domain's FIRST skill: named after the domain, one
// document bundling every pending lesson. (Synthesis, when on, rewrites the body.)
function domainSkillDraft(domain, bundle) {
  return curatorThemeSkillDraft(bundle, { domain });
}

// Provenance for a domain's first skill: every contributing entry id, the domain
// it belongs to, and the lesson rows it was built from.
function domainSkillProvenance({ teamId, domain, bundle, now } = {}) {
  const prov = curatorThemeSkillProvenance({ teamId, candidate: bundle, entryIds: bundle.entryIds, now });
  return { ...prov, domainId: domain && domain.id ? domain.id : null };
}

/**
 * Settle the lesson rows that went into a skill — but ONLY those whose entry ids
 * are all present in the skill's provenance (AC8). Anything not covered stays as it
 * was, so it is retried rather than silently marked done.
 *
 * @returns {{ rows: object[], settled: string[], uncovered: string[] }}
 */
function settleCoveredRows(rows, rowIds, provenanceEntryIds, patch = {}) {
  const want = new Set(_ids(rowIds));
  const covered = new Set(_ids(provenanceEntryIds));
  const settled = [];
  const uncovered = [];
  const next = (Array.isArray(rows) ? rows : []).map((r) => {
    if (!r || !want.has(r.id)) return r;
    const ids = _ids(r.entryIds);
    if (ids.length > 0 && ids.every((id) => covered.has(id))) {
      settled.push(r.id);
      return { ...r, ...patch, status: 'promoted' };
    }
    uncovered.push(r.id);
    return r;
  });
  return { rows: next, settled, uncovered };
}

module.exports = {
  DOMAIN_CARD_SOURCE,
  QUEUED_STATUS,
  DEFAULT_DOMAIN_SKILL_THRESHOLD,
  normalizeDomainSkillThreshold,
  domainCardId,
  isDomainCard,
  planRoutingInputs,
  queuedRow,
  unroutedRow,
  lessonAgents,
  bundleLessons,
  planDomainSkillWork,
  buildDomainCard,
  reconcileDomainCards,
  domainSkillDraft,
  domainSkillProvenance,
  settleCoveredRows,
};
