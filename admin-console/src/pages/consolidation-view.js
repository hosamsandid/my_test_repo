// React-free view helpers for the consolidation-migration flow (#842) — the
// operator surface that drives the one-time-per-team migration collapsing a
// team's accumulated micro-skills + open candidates into a few domain
// playbooks (§4 of docs/skill-aggregation-concept.md). The panel
// (ConsolidationPanel in KnowledgeFlow.jsx) is a thin shell over these, so the
// state-machine bookkeeping is unit-testable under `node --test` without a DOM.
//
// The shapes mirror the server contract in orchestrator/knowledge-consolidation.js:
//   plan   = { domains:[{ domainId, name, skill, scope, roles, memberSkills:[name], candidateIds:[id] }],
//              unassignedSkills:[name], unassignedCandidates:[id] }
//   merges = [{ domainId, skill, merge:{ sources, target, retireSources } | null }]
//   state  = { version, teamId, status:'bootstrap'|'synthesis'|'routing'|'complete',
//              domains:[{ domainId, skill, name, status:'pending'|'accepted'|'skipped',
//                         memberSkills:[], candidateIds:[], acceptedAt? }],
//              unassignedCandidates:[], routedRemaining, startedAt, updatedAt }

// Human-readable labels for the migration phases (state.status), in order.
export const PHASE_LABELS = {
  bootstrap: 'Confirm domains',
  synthesis: 'Review playbooks',
  routing: 'Route remainder',
  complete: 'Complete',
};

// Human label + tone for a `consolidation` feed action (started | accepted |
// skipped | routed | completed). Used to surface the live-feed events (AC4).
export const CONSOLIDATION_ACTION_LABELS = {
  started: 'Consolidation started',
  accepted: 'Playbook accepted',
  skipped: 'Domain skipped',
  routed: 'Remainder routed',
  completed: 'Consolidation complete',
};

export function consolidationActionLabel(action) {
  return CONSOLIDATION_ACTION_LABELS[action] || 'Consolidation update';
}

// The first domain still awaiting an operator decision — where a resumed run
// picks up. Null when every domain is decided (or there are none). Mirrors the
// server's nextPendingDomain.
export function nextPendingDomain(state) {
  const list = state && Array.isArray(state.domains) ? state.domains : [];
  return list.find((d) => d && d.status === 'pending') || null;
}

// Client mirror of the server's migrationSummary — a compact progress readout.
// Safe on null/partial state (returns an idle summary) so the panel can render
// before any migration exists.
export function migrationProgress(state) {
  const s = state && typeof state === 'object' ? state : null;
  const domains = s && Array.isArray(s.domains) ? s.domains : [];
  const total = domains.length;
  const accepted = domains.filter((d) => d && d.status === 'accepted').length;
  const skipped = domains.filter((d) => d && d.status === 'skipped').length;
  const pending = domains.filter((d) => !d || d.status === 'pending').length;
  const routedRemaining = !!(s && s.routedRemaining === true);
  const allDecided = total === 0 || pending === 0;
  return {
    status: s ? (s.status || 'synthesis') : 'idle',
    total,
    accepted,
    skipped,
    pending,
    decided: accepted + skipped,
    routedRemaining,
    complete: !!s && routedRemaining && allDecided,
  };
}

// True when there is a persisted, still-in-progress migration to resume (AC2 —
// reopening reads the state and continues rather than restarting).
export function isResumable(state) {
  if (!state || typeof state !== 'object') return false;
  return !migrationProgress(state).complete;
}

// The merge input for one domain, or null when the domain has fewer than two
// member skills (nothing to merge — an accept then only records the decision).
// Tolerates both the `{ domainId, merge }` wrapper the endpoint returns and a
// bare merge object.
export function mergeForDomain(merges, domainId) {
  const list = Array.isArray(merges) ? merges : [];
  const hit = list.find((m) => m && m.domainId === domainId);
  if (!hit) return null;
  const merge = hit.merge || hit;
  // A one-member domain folds its only skill into the domain skill (#2592).
  const min = merge && merge.fold === true ? 1 : 2;
  if (!merge || !Array.isArray(merge.sources) || merge.sources.length < min) return null;
  return merge;
}

// Annotate every plan domain with display counts + whether it will drive a
// skill-merge (≥2 members, or a one-member fold into the domain skill — #2592) or
// is a record-only accept (no member skill to move). Deterministic
// (plan order preserved).
export function planDomainRows(plan, merges) {
  const domains = plan && Array.isArray(plan.domains) ? plan.domains : [];
  return domains.map((d) => {
    const memberSkills = Array.isArray(d.memberSkills) ? d.memberSkills : [];
    const candidateIds = Array.isArray(d.candidateIds) ? d.candidateIds : [];
    return {
      domainId: d.domainId,
      name: d.name || d.domainId,
      skill: d.skill,
      memberSkills,
      candidateIds,
      memberCount: memberSkills.length,
      candidateCount: candidateIds.length,
      mergeable: !!mergeForDomain(merges, d.domainId),
      fold: !!(mergeForDomain(merges, d.domainId) || {}).fold,
    };
  });
}

// Whether the "Start migration" button may begin the migration, and — when it may
// not — a plain-language reason to show inline (#871, AC1/AC2/AC4/AC7/AC8).
//
// The gate is deliberately consistent with the panel's own summary line: there is
// something to consolidate whenever any skill OR candidate is assigned to a
// confirmed domain (`fold.skills + fold.candidates > 0`). A ≥2-skill domain is NOT
// required — 0/1-skill domains are handled downstream as record-only decisions and
// the leftover candidates are routed in the final step. Unassigned-only content
// (nothing mapped to a confirmed domain) is NOT startable (AC8): routing loose
// candidates on its own is not a valid reason to start.
//
// `busy` (a consolidation request in flight) always disables the button (AC7); the
// structural "nothing to consolidate" reason takes precedence in the message since
// it is the persistent cause, whereas busy is transient.
export function consolidationStartGate(fold, { busy = false } = {}) {
  const assigned = fold ? (fold.skills || 0) + (fold.candidates || 0) : 0;
  const hasWork = assigned > 0;
  let reason = '';
  if (!hasWork) {
    reason = 'Nothing to consolidate yet — no existing skills or candidates map to the confirmed domains.';
  } else if (busy) {
    reason = 'A consolidation request is in flight — please wait.';
  }
  return { enabled: hasWork && !busy, hasWork, reason };
}

// Total number of source micro-skills the plan would fold across all domains —
// the headline "collapse" number shown in the preview.
export function planFoldTotals(plan) {
  const rows = planDomainRows(plan, []);
  return {
    domains: rows.length,
    skills: rows.reduce((n, r) => n + r.memberCount, 0),
    candidates: rows.reduce((n, r) => n + r.candidateCount, 0),
    unassignedSkills: plan && Array.isArray(plan.unassignedSkills) ? plan.unassignedSkills.length : 0,
    unassignedCandidates: plan && Array.isArray(plan.unassignedCandidates) ? plan.unassignedCandidates.length : 0,
  };
}
