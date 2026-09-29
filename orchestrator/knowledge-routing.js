'use strict';

// Cluster → domain routing / classification (skill-aggregation Phase 2, #780, §3.2).
//
// Phase 1 (#779) split the converged clusters into digest-only (suppressed) and
// candidate. This module takes the CANDIDATE clusters and, instead of raising one
// new-skill card per cluster, ROUTES each against the team's persistent domains
// (knowledge-domains.js):
//
//   - fits a domain      → an AMENDMENT to that domain's living skill
//                          ("Add to Dev workflow"), auto-extended at level 3 or a
//                          review card otherwise.
//   - fits no domain     → parked in the UNROUTED pool.
//   - unrouted mass      → only when enough distinct lessons/sub-topics/agents
//                          accumulate does the collector PROPOSE a new domain, and
//                          always as a review card (taxonomy is a human decision).
//
// Two-stage classification, exactly as §3.2 prescribes: a cheap deterministic first
// pass (extend the matchExistingSkill token/lineage heuristic with the domain's
// vocabulary + entry tags), then an optional batched LLM pass over whatever the
// heuristic left unrouted (one call per collector pass, heuristic result kept on
// failure). Deliberately PURE — the LLM transport lives in the caller.

const { domainSkillName } = require('./knowledge-domains');

// ---------------------------------------------------------------------------
// Tokenisation (shared shape with knowledge-convergence.topicTokens)
// ---------------------------------------------------------------------------

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
}

// Generic words that appear in many domain names but say nothing about a lesson's
// topic ("Team practice", "General workflow notes"). They never count as a match.
const GENERIC_VOCAB = new Set([
  'team', 'teams', 'general', 'misc', 'other', 'others', 'common', 'shared', 'stuff',
  'things', 'practice', 'practices', 'knowledge', 'lesson', 'lessons', 'notes',
  'with', 'from', 'that', 'this', 'into', 'when', 'your', 'their', 'about',
]);

// The vocabulary of a domain: the meaningful tokens of its NAME only. #2592 (G4):
// scope ("team"/"global") and role words ("developer", "reviewer") used to be part
// of the vocabulary, so any lesson that merely mentioned a role — most of them —
// routed to whichever domain listed that role first. Name tokens minus generic
// words are the topic signal; everything else is left to the batched LLM pass.
function domainVocabulary(domain) {
  const d = domain && typeof domain === 'object' ? domain : {};
  return new Set(tokens(d.name).filter((t) => !GENERIC_VOCAB.has(t)));
}

// ---------------------------------------------------------------------------
// Heuristic classification (cheap first pass)
// ---------------------------------------------------------------------------

// Score a candidate against ONE domain. Signals, strongest first (same spirit as
// curator matchExistingSkill's idOverlap*100 + nameOverlap):
//   - lineage:  overlap between the candidate's KB entry ids and the domain's
//               living skill's provenance entryIds  → 100 / id.
//   - vocab:    candidate text tokens ∩ domain vocabulary                → 2 / token.
//   - tags:     the entry tags[] ∩ domain vocabulary                     → 3 / tag.
// `skillEntryIds` is the domain's living skill's provenance entryIds (from
// existingSkills); empty when the domain has no skill yet (vocab/tags still route).
function scoreCandidateToDomain(candidate, domain, { skillEntryIds, tags } = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const vocab = domainVocabulary(domain);
  const entryIds = new Set(Array.isArray(c.entryIds) ? c.entryIds : []);
  let idOverlap = 0;
  for (const id of Array.isArray(skillEntryIds) ? skillEntryIds : []) {
    if (entryIds.has(id)) idOverlap += 1;
  }
  const textTokens = new Set(tokens(c.text));
  let vocabOverlap = 0;
  for (const t of textTokens) if (vocab.has(t)) vocabOverlap += 1;
  let tagOverlap = 0;
  for (const t of Array.isArray(tags) ? tags : []) {
    for (const tk of tokens(t)) if (vocab.has(tk)) { tagOverlap += 1; break; }
  }
  const score = idOverlap * 100 + vocabOverlap * 2 + tagOverlap * 3;
  return { score, idOverlap, vocabOverlap, tagOverlap };
}

// Classify one candidate against the domain list. Returns the best-matching
// { domainId, skill, score, via } or null when no domain fires a signal (≥ floor).
// `skillEntryIdsByDomain` maps a domainId → its living skill's provenance entryIds;
// `tagsByEntryId` maps a KB entry id → its tags[] (read by nothing today — #780
// puts them to work). `via` records which signal dominated (for the review card).
function classifyCandidateToDomain(candidate, domains, {
  skillEntryIdsByDomain, tagsByEntryId, floor = 1,
} = {}) {
  const list = Array.isArray(domains) ? domains : [];
  if (list.length === 0) return null;
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const tags = [];
  const byId = tagsByEntryId && typeof tagsByEntryId === 'object' ? tagsByEntryId : {};
  for (const id of Array.isArray(c.entryIds) ? c.entryIds : []) {
    const t = byId[id];
    if (Array.isArray(t)) tags.push(...t);
  }
  let best = null;
  let tied = false;
  const skillMap = skillEntryIdsByDomain && typeof skillEntryIdsByDomain === 'object' ? skillEntryIdsByDomain : {};
  for (const domain of list) {
    if (!domain || typeof domain.id !== 'string') continue;
    const s = scoreCandidateToDomain(c, domain, { skillEntryIds: skillMap[domain.id], tags });
    if (s.score < floor) continue;
    if (best && s.score === best.score) { tied = true; continue; }
    if (!best || s.score > best.score) {
      const via = s.idOverlap > 0 ? 'lineage' : (s.tagOverlap > 0 && s.vocabOverlap === 0 ? 'tag' : 'vocab');
      best = { domainId: domain.id, skill: domainSkillName(domain), score: s.score, via };
      tied = false;
    }
  }
  // #2592 (G4): a tie between two domains is not a decision — it used to go to
  // whichever domain was listed first. Leave the lesson unrouted instead.
  return tied ? null : best;
}

// ---------------------------------------------------------------------------
// New-domain mass threshold (§3.2 — well above today's "2 agents, 1 lesson")
// ---------------------------------------------------------------------------

// Distinct topic buckets in the unrouted pool: cluster canonicalIds grouped by
// their leading topic token, a coarse proxy for "distinct sub-topics".
function _subTopics(pool) {
  const topics = new Set();
  for (const c of Array.isArray(pool) ? pool : []) {
    const t = tokens(c && c.text)[0] || (c && c.canonicalId) || '';
    if (t) topics.add(t);
  }
  return topics.size;
}

// Does the accumulated unrouted pool justify PROPOSING a new domain? Requires mass
// on three axes (all defaults well above the single-cluster candidate floor):
// ≥ minLessons distinct lessons, across ≥ minSubTopics sub-topics, from ≥ minAgents
// distinct agents. Never fires on a single recurring lesson.
function newDomainQualifies(pool, { minLessons = 5, minSubTopics = 3, minAgents = 2 } = {}) {
  const list = Array.isArray(pool) ? pool : [];
  const lessons = new Set();
  const agents = new Set();
  for (const c of list) {
    for (const id of Array.isArray(c.entryIds) ? c.entryIds : []) lessons.add(id);
    for (const a of Array.isArray(c.convergence) ? c.convergence : []) agents.add(a);
  }
  return lessons.size >= minLessons && _subTopics(list) >= minSubTopics && agents.size >= minAgents;
}

// ---------------------------------------------------------------------------
// The routing planner
// ---------------------------------------------------------------------------

/**
 * Route the candidate clusters against the team's domains (§3.2). Pure: no IO.
 *
 * @param {object[]} candidates  candidate rows (toCandidate) for the eligible clusters
 * @param {object[]} domains     the team's confirmed domain list
 * @param {object} opts
 *   - skillEntryIdsByDomain: { domainId: string[] }  living skills' provenance ids
 *   - tagsByEntryId:         { entryId: string[] }    KB entry tags
 *   - floor:                 heuristic match floor (default 1)
 *   - budgetOver:            true ⇒ over the skill budget (§3.5)
 *   - mass:                  { minLessons, minSubTopics, minAgents }
 *   - teamId, now
 * @returns {{ amendments, unrouted, newDomainProposal, batch }}
 *   amendments:        [{ candidate, domainId, skill, target, via }] — route to a skill
 *   unrouted:          [{ candidate }]-style candidate rows the heuristic couldn't place
 *   newDomainProposal: null | { unrouted, budgetBlocked, reason } — a REVIEW card only
 *   batch:             a `domain-routing` feed event (null when nothing to report)
 */
function planDomainRouting(candidates, domains, {
  skillEntryIdsByDomain, tagsByEntryId, floor = 1, budgetOver = false, mass, teamId, now,
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const doms = Array.isArray(domains) ? domains : [];
  const amendments = [];
  const unrouted = [];
  for (const candidate of list) {
    const match = doms.length
      ? classifyCandidateToDomain(candidate, doms, { skillEntryIdsByDomain, tagsByEntryId, floor })
      : null;
    if (match) {
      amendments.push({ candidate, domainId: match.domainId, skill: match.skill, target: match.skill, via: match.via });
    } else {
      unrouted.push(candidate);
    }
  }

  let newDomainProposal = null;
  if (unrouted.length && newDomainQualifies(unrouted, mass)) {
    // Above the skill budget the proposal is BLOCKED into the merge/override flow
    // (§3.5): it is still surfaced, but flagged so the UI forces a merge/override
    // decision rather than freely accepting another skill.
    newDomainProposal = {
      unrouted: unrouted.slice(),
      budgetBlocked: !!budgetOver,
      reason: budgetOver ? 'over-budget' : 'mass-threshold',
    };
  }

  let batch = null;
  if (amendments.length || newDomainProposal) {
    const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    batch = {
      type: 'domain-routing',
      ts,
      teamId: typeof teamId === 'string' ? teamId : null,
      amendmentCount: amendments.length,
      unroutedCount: unrouted.length,
      newDomainProposed: !!newDomainProposal,
      budgetBlocked: newDomainProposal ? newDomainProposal.budgetBlocked : false,
      samples: amendments.slice(0, 5).map((a) => ({
        id: a.candidate.id, skill: a.skill, via: a.via, text: a.candidate.text,
      })),
    };
  }
  return { amendments, unrouted, newDomainProposal, batch };
}

// ---------------------------------------------------------------------------
// Batched LLM classification (§3.2 — one call per pass, heuristic fallback)
// ---------------------------------------------------------------------------

// Build ONE request classifying every still-unrouted candidate against the domains.
// Pure — the caller supplies the transport. Domains and lessons are numbered so the
// response is a compact index map.
function buildBatchClassificationRequest(unrouted, domains) {
  const doms = (Array.isArray(domains) ? domains : []).filter((d) => d && d.id);
  const lessons = Array.isArray(unrouted) ? unrouted : [];
  const domainLines = doms
    .map((d, i) => `${i + 1}. id="${d.id}" — ${d.name}${d.scope ? ` (${d.scope})` : ''}`)
    .join('\n');
  const lessonLines = lessons
    .map((c, i) => `${i + 1}. ${(c && c.text) || ''}`)
    .join('\n');
  const instruction = [
    'You route team lessons into skill DOMAINS.',
    'Domains:',
    domainLines || '(none)',
    '',
    'Lessons to classify:',
    lessonLines || '(none)',
    '',
    'For each lesson, pick the single best-fitting domain id, or null if none fits well.',
    'Output ONLY a JSON array, one object per lesson in order:',
    '[{"lesson": 1, "domain": "<domain-id>"|null}, ...]',
    'No preamble, no code fences.',
  ].join('\n');
  // ~24 output tokens per lesson; a fixed 1024 overflowed at ~60 lessons and fell
  // back to the heuristic for the whole backlog (review S2).
  const maxTokens = Math.min(16384, Math.max(1024, 128 + 24 * lessons.length));
  return { max_tokens: maxTokens, messages: [{ role: 'user', content: instruction }] };
}

/**
 * Apply a batched-classification LLM response to the still-unrouted candidates.
 * Tolerant JSON parse. Returns null when the response is unusable — the caller then
 * keeps the heuristic result (leaves them unrouted). On success, returns the newly
 * routed amendments + the remainder.
 *
 * @returns {null | { amendments: object[], stillUnrouted: object[] }}
 */
function applyBatchClassification(text, unrouted, domains) {
  const lessons = Array.isArray(unrouted) ? unrouted : [];
  const validIds = new Set((Array.isArray(domains) ? domains : []).map((d) => d && d.id).filter(Boolean));
  const domById = new Map((Array.isArray(domains) ? domains : []).filter((d) => d && d.id).map((d) => [d.id, d]));
  let arr = null;
  try {
    const s = typeof text === 'string' ? text : '';
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start >= 0 && end > start) arr = JSON.parse(s.slice(start, end + 1));
  } catch { arr = null; }
  if (!Array.isArray(arr)) return null;

  const byLesson = new Map();
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const n = Number(row.lesson);
    if (!Number.isInteger(n) || n < 1 || n > lessons.length) continue;
    const dom = typeof row.domain === 'string' ? row.domain : null;
    byLesson.set(n - 1, dom && validIds.has(dom) ? dom : null);
  }

  const amendments = [];
  const stillUnrouted = [];
  lessons.forEach((candidate, i) => {
    const domainId = byLesson.has(i) ? byLesson.get(i) : null;
    if (domainId) {
      const skill = domainSkillName(domById.get(domainId));
      amendments.push({ candidate, domainId, skill, target: skill, via: 'llm' });
    } else {
      stillUnrouted.push(candidate);
    }
  });
  return { amendments, stillUnrouted };
}

// ---------------------------------------------------------------------------
// One-pass classification: lineage → one batched LLM call → heuristic fallback
// ---------------------------------------------------------------------------

/**
 * Classify this pass's candidates against the team's domains (#2592, AC6). The
 * transport is injected, so this stays free of IO:
 *
 *   1. Lineage first — a lesson whose entry ids already sit in a domain skill's
 *      provenance goes back to that domain without asking anyone.
 *   2. Everything else goes into ONE batched LLM request (`classify(request)` →
 *      response text, or null). A usable answer routes each lesson (`via:'llm'`);
 *      a lesson the model placed nowhere stays unrouted (`via:'llm'`).
 *   3. When there is no transport, the call throws, or the answer can't be parsed,
 *      the whole remainder falls back to the keyword heuristic (`via` =
 *      tag/vocab, unrouted `via:'heuristic'`).
 *
 * Every candidate comes back exactly once, in `routed` or `unrouted`, with the
 * method that decided it — the caller persists it per cluster.
 *
 * @returns {Promise<{ routed: object[], unrouted: object[], method: string, llmCalls: number }>}
 *   routed:   [{ candidate, domainId, skill, via }]
 *   unrouted: [{ candidate, via }]
 *   method:   'none' | 'lineage' | 'llm' | 'heuristic' (how the non-lineage rest was decided)
 */
async function classifyClustersToDomains(candidates, domains, {
  classify, skillEntryIdsByDomain, tagsByEntryId, floor = 1,
} = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c && typeof c === 'object');
  const doms = (Array.isArray(domains) ? domains : []).filter((d) => d && typeof d.id === 'string');
  const routed = [];
  const unrouted = [];
  if (list.length === 0) return { routed, unrouted, method: 'none', llmCalls: 0 };
  if (doms.length === 0) {
    for (const candidate of list) unrouted.push({ candidate, via: 'none' });
    return { routed, unrouted, method: 'none', llmCalls: 0 };
  }

  const skillMap = skillEntryIdsByDomain && typeof skillEntryIdsByDomain === 'object' ? skillEntryIdsByDomain : {};
  const rest = [];
  for (const candidate of list) {
    let best = null;
    for (const d of doms) {
      const { idOverlap } = scoreCandidateToDomain(candidate, d, { skillEntryIds: skillMap[d.id] });
      if (idOverlap > 0 && (!best || idOverlap > best.n)) best = { d, n: idOverlap };
    }
    if (best) routed.push({ candidate, domainId: best.d.id, skill: domainSkillName(best.d), via: 'lineage' });
    else rest.push(candidate);
  }
  if (rest.length === 0) return { routed, unrouted, method: 'lineage', llmCalls: 0 };

  let parsed = null;
  let llmCalls = 0;
  if (typeof classify === 'function') {
    llmCalls = 1;
    let text = null;
    try { text = await classify(buildBatchClassificationRequest(rest, doms)); } catch { text = null; }
    parsed = text ? applyBatchClassification(text, rest, doms) : null;
  }
  if (parsed) {
    for (const a of parsed.amendments) routed.push({ candidate: a.candidate, domainId: a.domainId, skill: a.skill, via: 'llm' });
    for (const candidate of parsed.stillUnrouted) unrouted.push({ candidate, via: 'llm' });
    return { routed, unrouted, method: 'llm', llmCalls };
  }
  for (const candidate of rest) {
    const m = classifyCandidateToDomain(candidate, doms, { skillEntryIdsByDomain: skillMap, tagsByEntryId, floor });
    if (m) routed.push({ candidate, domainId: m.domainId, skill: m.skill, via: m.via });
    else unrouted.push({ candidate, via: 'heuristic' });
  }
  return { routed, unrouted, method: 'heuristic', llmCalls };
}

// ---------------------------------------------------------------------------
// New-domain proposal singleton (FIX-A)
// ---------------------------------------------------------------------------

// The stable, per-team id of the single "unrouted mass may warrant a new domain"
// card. Historically the id hashed the exact unrouted-canonicalId set, so every pass
// the set shifted minted a brand-new card and the store filled with hundreds of
// near-identical proposals. One canonical id, upserted in place, fixes that.
function domainProposalId(teamSegment) {
  const seg = typeof teamSegment === 'string' && teamSegment.trim() ? teamSegment.trim() : 'team';
  return `dp-${seg}`;
}

/**
 * Reconcile the new-domain proposal card in a team's candidate rows so that AT MOST
 * ONE open `domain-proposal` row survives. Pure — returns a NEW rows array; the input
 * is not mutated. Non-proposal rows pass through untouched.
 *
 *  - A dismissed singleton is respected: nothing new is raised while it stands, and
 *    the rest of the proposal pile is dropped.
 *  - Given a fresh `proposal` (and no dismissal), the singleton is UPSERTED: fields
 *    refreshed, `raisedAt` bumped so hygiene measures quiet time from the latest
 *    evidence, prior fields preserved.
 *  - With no proposal this pass, any lingering open `dp-*` rows collapse to the
 *    newest one — so a store still holding the historical hashed pile self-heals on
 *    the first pass after deploy.
 *
 * @param {object[]} rows current candidate store rows
 * @param {object} opts
 *   - proposal: null | { unrouted: [{ canonicalId, entryIds }], budgetBlocked, reason }
 *   - teamId, teamSegment, now
 */
function reconcileDomainProposal(rows, { proposal, teamId, teamSegment, now } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const stableId = domainProposalId(teamSegment);
  const proposals = list.filter((r) => r && r.source === 'domain-proposal');
  const nonProposals = list.filter((r) => !(r && r.source === 'domain-proposal'));

  const dismissed = proposals.find((r) => r.id === stableId && r.status === 'dismissed');
  if (dismissed) return [...nonProposals, dismissed];

  if (proposal && Array.isArray(proposal.unrouted) && proposal.unrouted.length) {
    const prior = proposals.find((r) => r.id === stableId) || {};
    const ids = proposal.unrouted.map((c) => c && c.canonicalId).filter(Boolean).sort();
    const singleton = {
      ...(prior && typeof prior === 'object' ? prior : {}),
      id: stableId,
      teamId: typeof teamId === 'string' ? teamId : (prior.teamId || null),
      source: 'domain-proposal',
      status: 'open',
      budgetBlocked: !!proposal.budgetBlocked,
      reason: proposal.reason,
      entryIds: proposal.unrouted.flatMap((c) => (c && c.entryIds) || []),
      unroutedIds: ids,
      text: `${proposal.unrouted.length} unrouted lesson(s) may warrant a new domain`,
      raisedAt: typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString(),
    };
    return [...nonProposals, singleton];
  }

  const open = proposals.filter((r) => r.status === 'open');
  const nonOpen = proposals.filter((r) => r.status !== 'open');
  if (open.length <= 1) return [...nonProposals, ...proposals];
  open.sort((a, b) => String(b.raisedAt || '').localeCompare(String(a.raisedAt || ''))
    || String(a.id).localeCompare(String(b.id)));
  return [...nonProposals, ...nonOpen, open[0]];
}

module.exports = {
  domainVocabulary,
  scoreCandidateToDomain,
  classifyCandidateToDomain,
  newDomainQualifies,
  planDomainRouting,
  domainProposalId,
  reconcileDomainProposal,
  buildBatchClassificationRequest,
  applyBatchClassification,
  classifyClustersToDomains,
  GENERIC_VOCAB,
};
