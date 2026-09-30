'use strict';

// One-time consolidation migration (skill-aggregation Phase 3, #781, §4).
//
// Teams that ran under the old one-candidate-per-cluster pipeline own dozens of
// micro-skills (verbatim lesson wrappers with lesson-slug names). Phases 1–2 fix the
// INFLOW; nothing consolidates the existing stock. This migration turns that stock
// into a handful of domain playbooks with full lineage:
//
//   1. Domain bootstrap over the full corpus (existing skills + open candidates +
//      lessons) — reuses the Phase-2 bootstrap; the operator confirms the set.
//   2. Per domain: assign the member micro-skills + candidates, then LLM-synthesise
//      ONE playbook from all of them — the existing skill-merge machinery
//      (admin-console/api/skill-merge.js planMerge) already accepts > 2 inputs, unions
//      provenance (mergeProvenance) and chains lineage (mergedFrom).
//   3. The operator reviews each playbook; on accept the member micro-skills are
//      ARCHIVED with lineage and the team grant is SWAPPED ATOMICALLY — the existing
//      merge commit does exactly this: migrateGrantsForMerge activates the target
//      skill BEFORE deactivating each source, so no agent loses access in between.
//   4. Remaining open candidates are routed through the Phase-2 classifier
//      (knowledge-routing.planDomainRouting) — most resolve to digest-only or
//      amendments, so the suggestion inbox shrinks.
//
// The whole flow is RESUMABLE (AC5): per-domain progress is persisted, so an
// interruption re-enters at the first still-pending domain. Every step emits a feed
// event.
//
// Deliberately PURE — no fs, no network, an injected `now`. The IO (persisting the
// progress doc, running the LLM merge through the existing endpoints, the archive +
// atomic grant swap) lives in orchestrator.js / admin-console api.js. This module
// owns: the resumable STATE MACHINE, the member-assignment PLANNER, and the
// merge-input BUILDER.

const { classifyCandidateToDomain } = require('./knowledge-routing');
const { domainSkillName } = require('./knowledge-domains');

const MIGRATION_DOC_VERSION = 1;

// Lifecycle of the whole migration and of each per-domain step.
const MIGRATION_STATUSES = Object.freeze(['bootstrap', 'synthesis', 'routing', 'complete']);
const DOMAIN_STEP_STATUSES = Object.freeze(['pending', 'accepted', 'skipped']);

// ---------------------------------------------------------------------------
// Member assignment planner
// ---------------------------------------------------------------------------

// Treat an existing micro-skill like a candidate for classification: its name tokens
// carry the topic, its provenance entryIds carry the lineage.
function _skillAsCandidate(skill) {
  const s = skill && typeof skill === 'object' ? skill : {};
  return {
    id: s.name,
    text: [s.name, s.title].filter(Boolean).join(' '),
    entryIds: Array.isArray(s.entryIds) ? s.entryIds : [],
  };
}

/**
 * Assign each existing micro-skill + open candidate to its best-matching confirmed
 * domain (reusing the Phase-2 lexical/lineage classifier). Pure: no IO.
 *
 * @param {object[]} domains     the team's confirmed domain list
 * @param {object[]} skills      [{ name, tier, entryIds?, title? }] existing team skills
 * @param {object[]} candidates  [{ id, text, entryIds?, status }] open candidate rows
 * @param {object} opts { skillEntryIdsByDomain, tagsByEntryId, floor=1 }
 * @returns {{ domains: object[], unassignedSkills: string[], unassignedCandidates: string[] }}
 *   domains: [{ domainId, name, skill, scope, roles, memberSkills:[name], candidateIds:[id] }]
 *            — deterministic (domain list order); a domain with no members is still
 *            listed (an operator may synthesise defaults into it).
 */
function planConsolidation(domains, skills, candidates, {
  skillEntryIdsByDomain, tagsByEntryId, floor = 1,
} = {}) {
  const doms = Array.isArray(domains) ? domains.filter((d) => d && typeof d.id === 'string') : [];
  const byId = new Map(doms.map((d) => [d.id, {
    domainId: d.id,
    name: d.name || d.id,
    skill: domainSkillName(d),
    scope: d.scope || 'team',
    roles: Array.isArray(d.roles) ? d.roles.slice() : [],
    memberSkills: [],
    candidateIds: [],
  }]));
  const opts = { skillEntryIdsByDomain, tagsByEntryId, floor };
  const unassignedSkills = [];
  const unassignedCandidates = [];

  // A domain's own skill always belongs to that domain (#2592) — so a domain whose
  // skill already exists folds its other members INTO it (never a 1-source fold onto
  // an existing target), whatever the lexical classifier would say.
  const domainBySkill = new Map([...byId.values()].map((d) => [d.skill, d]));
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill || typeof skill.name !== 'string' || !skill.name) continue;
    if (domainBySkill.has(skill.name)) { domainBySkill.get(skill.name).memberSkills.push(skill.name); continue; }
    const match = doms.length ? classifyCandidateToDomain(_skillAsCandidate(skill), doms, opts) : null;
    if (match && byId.has(match.domainId)) byId.get(match.domainId).memberSkills.push(skill.name);
    else unassignedSkills.push(skill.name);
  }
  for (const cand of Array.isArray(candidates) ? candidates : []) {
    if (!cand || typeof cand.id !== 'string') continue;
    const match = doms.length ? classifyCandidateToDomain(cand, doms, opts) : null;
    if (match && byId.has(match.domainId)) byId.get(match.domainId).candidateIds.push(cand.id);
    else unassignedCandidates.push(cand.id);
  }
  return { domains: [...byId.values()], unassignedSkills, unassignedCandidates };
}

// ---------------------------------------------------------------------------
// Merge-input builder (feeds the existing skill-merge machinery, > 2 inputs)
// ---------------------------------------------------------------------------

/**
 * Build the { sources, target, retireSources } input for skill-merge.planMerge that
 * synthesises one domain playbook from all member micro-skills. Pure. The member
 * skills are TEAM-tier (a consolidation runs within one team); the target is the
 * domain-named team skill. retireSources:true so the accept archives + grant-swaps.
 * A domain with ONE member skill named differently from the domain skill becomes a
 * single-source `fold: true` merge (#2592) — so the domain still ends up with exactly
 * one skill. Returns null when there is nothing to merge: no members, or the only
 * member already IS the domain skill.
 */
function buildConsolidationMerge(domainStep, { teamId } = {}) {
  const step = domainStep && typeof domainStep === 'object' ? domainStep : {};
  const members = Array.isArray(step.memberSkills) ? step.memberSkills.filter(Boolean) : [];
  const target = domainSkillName({ id: step.domainId, skill: step.skill, name: step.name });
  if (members.length === 0) return null;
  if (members.length === 1 && members[0] === target) return null;
  const merge = {
    sources: members.map((name) => ({ tier: 'team', teamId, name })),
    target: { tier: 'team', teamId, name: target },
    retireSources: true,
  };
  if (members.length === 1) merge.fold = true;
  return merge;
}

// ---------------------------------------------------------------------------
// Resumable progress state (AC5)
// ---------------------------------------------------------------------------

function _ts(now) {
  return typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString();
}

// Build a fresh migration document from a plan (planConsolidation output). Every
// domain starts `pending`; the doc starts in the `synthesis` phase (bootstrap already
// produced the confirmed domain list the plan was built from).
function makeMigrationState(plan, { teamId, now } = {}) {
  const ts = _ts(now);
  const domains = (plan && Array.isArray(plan.domains) ? plan.domains : []).map((d) => ({
    domainId: d.domainId,
    skill: d.skill,
    name: d.name || d.domainId,
    status: 'pending',
    memberSkills: Array.isArray(d.memberSkills) ? d.memberSkills.slice() : [],
    candidateIds: Array.isArray(d.candidateIds) ? d.candidateIds.slice() : [],
  }));
  return {
    version: MIGRATION_DOC_VERSION,
    teamId: typeof teamId === 'string' ? teamId : null,
    status: 'synthesis',
    domains,
    unassignedCandidates: plan && Array.isArray(plan.unassignedCandidates)
      ? plan.unassignedCandidates.slice() : [],
    routedRemaining: false,
    startedAt: ts,
    updatedAt: ts,
  };
}

// Normalise a persisted (possibly legacy/partial) migration doc into the canonical
// shape. Tolerant — never throws; unknown statuses fall back to safe defaults so a
// resumed run is well-formed.
function normalizeMigrationState(raw, { now } = {}) {
  const ts = _ts(now);
  const r = raw && typeof raw === 'object' ? raw : {};
  const domains = (Array.isArray(r.domains) ? r.domains : []).map((d) => {
    const dd = d && typeof d === 'object' ? d : {};
    return {
      domainId: typeof dd.domainId === 'string' ? dd.domainId : '',
      skill: typeof dd.skill === 'string' ? dd.skill : (typeof dd.domainId === 'string' ? dd.domainId : ''),
      name: typeof dd.name === 'string' ? dd.name : (typeof dd.domainId === 'string' ? dd.domainId : ''),
      status: DOMAIN_STEP_STATUSES.includes(dd.status) ? dd.status : 'pending',
      memberSkills: Array.isArray(dd.memberSkills) ? dd.memberSkills.filter((x) => typeof x === 'string') : [],
      candidateIds: Array.isArray(dd.candidateIds) ? dd.candidateIds.filter((x) => typeof x === 'string') : [],
      acceptedAt: typeof dd.acceptedAt === 'string' ? dd.acceptedAt : undefined,
    };
  }).filter((d) => d.domainId);
  return {
    version: MIGRATION_DOC_VERSION,
    teamId: typeof r.teamId === 'string' ? r.teamId : null,
    status: MIGRATION_STATUSES.includes(r.status) ? r.status : 'synthesis',
    domains,
    unassignedCandidates: Array.isArray(r.unassignedCandidates)
      ? r.unassignedCandidates.filter((x) => typeof x === 'string') : [],
    routedRemaining: r.routedRemaining === true,
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : ts,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : ts,
  };
}

// The first domain still awaiting an operator decision — where a resumed run picks
// up. Null when every domain is decided.
function nextPendingDomain(state) {
  const s = state && Array.isArray(state.domains) ? state.domains : [];
  return s.find((d) => d.status === 'pending') || null;
}

// Record an operator decision on one domain (accepted | skipped). Pure — returns a
// NEW state, never mutates. When every domain is decided the phase advances to
// `routing`; once step 4 has run (markRoutedRemaining) it becomes `complete`.
function advanceMigration(state, { domainId, status, now } = {}) {
  const ts = _ts(now);
  const base = normalizeMigrationState(state, { now: ts });
  const next = DOMAIN_STEP_STATUSES.includes(status) && status !== 'pending' ? status : 'accepted';
  let found = false;
  const domains = base.domains.map((d) => {
    if (d.domainId !== domainId) return d;
    found = true;
    return { ...d, status: next, acceptedAt: next === 'accepted' ? ts : d.acceptedAt };
  });
  const allDecided = domains.length > 0 && domains.every((d) => d.status !== 'pending');
  return {
    ...base,
    domains,
    // routing is only reachable once every domain is decided; otherwise stay in synthesis.
    status: base.routedRemaining ? 'complete' : (allDecided ? 'routing' : 'synthesis'),
    updatedAt: found ? ts : base.updatedAt,
  };
}

// Mark step 4 (routing the remaining candidates) done. Completes the migration when
// every domain is also decided.
function markRoutedRemaining(state, { now } = {}) {
  const ts = _ts(now);
  const base = normalizeMigrationState(state, { now: ts });
  const allDecided = base.domains.length === 0 || base.domains.every((d) => d.status !== 'pending');
  return {
    ...base,
    routedRemaining: true,
    status: allDecided ? 'complete' : base.status,
    updatedAt: ts,
  };
}

function isComplete(state) {
  const s = normalizeMigrationState(state, {});
  const allDecided = s.domains.length === 0 || s.domains.every((d) => d.status !== 'pending');
  return s.routedRemaining && allDecided;
}

// A compact progress summary for the UI / feed.
function migrationSummary(state) {
  const s = normalizeMigrationState(state, {});
  const total = s.domains.length;
  const accepted = s.domains.filter((d) => d.status === 'accepted').length;
  const skipped = s.domains.filter((d) => d.status === 'skipped').length;
  const pending = s.domains.filter((d) => d.status === 'pending').length;
  return {
    status: s.status,
    total,
    accepted,
    skipped,
    pending,
    routedRemaining: s.routedRemaining,
    complete: isComplete(s),
  };
}

// ---------------------------------------------------------------------------
// Feed events
// ---------------------------------------------------------------------------

// One `consolidation` feed event per migration step (transparency, §4). `action` is
// one of: started | synthesized | accepted | skipped | routed | completed.
function consolidationEvent(action, { teamId, domain, skill, count, summary, now } = {}) {
  const ev = {
    type: 'consolidation',
    action: typeof action === 'string' ? action : 'started',
    ts: _ts(now),
    teamId: typeof teamId === 'string' ? teamId : null,
  };
  if (domain && typeof domain === 'object') ev.domain = { id: domain.id || domain.domainId || null, name: domain.name || null };
  if (typeof skill === 'string') ev.skill = skill;
  if (Number.isInteger(count)) ev.count = count;
  if (summary && typeof summary === 'object') ev.summary = summary;
  return ev;
}

module.exports = {
  MIGRATION_DOC_VERSION,
  MIGRATION_STATUSES,
  DOMAIN_STEP_STATUSES,
  planConsolidation,
  buildConsolidationMerge,
  makeMigrationState,
  normalizeMigrationState,
  nextPendingDomain,
  advanceMigration,
  markRoutedRemaining,
  isComplete,
  migrationSummary,
  consolidationEvent,
};
