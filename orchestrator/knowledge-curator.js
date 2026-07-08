'use strict';

// Curation / full-autonomy pure core (Shared Agent Learning & Knowledge Flow,
// Phase 4 — autonomy level 3, "Auto-curate"). This is the level-3 sibling of
// knowledge-convergence.js's planNewSuggestions: given the already-clustered
// canonical projection, the team's candidate store, and the resolved gate policy,
// it decides which clusters the curator may AUTO-PROMOTE (to a team skill) versus
// DEFER to an operator review card. It also builds the heuristic SKILL.md draft
// and the mandatory provenance for an auto-promotion (promotedBy: "curator").
//
// Deliberately PURE — no fs, no network, an injected `now` — so it is
// unit-testable without booting the orchestrator (repo convention: test pure
// helper cores only). The IO (writing the skill dir + provenance.json, updating
// the candidate store, committing the canonical stamp, the daily backstop timer)
// lives in orchestrator.js. See docs/knowledge-curation.md §2–§3.
//
// The heuristic draft + provenance builders deliberately MIRROR the admin-console
// ones (buildHeuristicSkillDraft / buildSkillProvenance in
// admin-console/api/knowledge-suggestions.js) rather than importing them: the two
// services never require each other's code (same discipline as the two-runtime
// harvest hint). A golden-shape test on each side keeps the provenance compatible
// with the graph builder's skillEntryIds(), so the T1→T2 `promoted` edge renders
// for a curator promotion exactly as for an operator one.

const { crossesConvergence, toCandidate } = require('./knowledge-convergence');

// Mirror the admin-console SKILL_NAME_RE so a generated name is always writable.
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+([.:][a-zA-Z0-9_-]+)*$/;

// ---------------------------------------------------------------------------
// Skill name + heuristic draft (kept shape-compatible with knowledge-suggestions)
// ---------------------------------------------------------------------------

function slugifySkillName(text, kind = 'fact') {
  const base = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-');
  const slug = base && SKILL_NAME_RE.test(base) ? base : '';
  return slug || `${kind}-skill`;
}

// A templated SKILL.md built from the cluster alone — cheap, dependency-free, no
// secrets. The curator uses this deterministic draft (no LLM on the hot path);
// operator-initiated "Draft with AI" polish stays a level-2 concern.
function curatorSkillDraft(cluster) {
  const c = cluster && typeof cluster === 'object' ? cluster : {};
  const name = slugifySkillName(c.text, c.kind);
  const title = (c.text || 'Team knowledge').trim();
  const members = Array.isArray(c.members) ? c.members : [];
  const convergence = Array.isArray(c.convergence) ? c.convergence : [];

  const statements = [];
  const seen = new Set();
  for (const m of members) {
    const t = (m && typeof m.text === 'string' ? m.text.trim() : '');
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      statements.push(t);
    }
  }
  if (statements.length === 0 && c.text) statements.push(String(c.text).trim());

  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push('## What');
  lines.push('');
  for (const s of statements) lines.push(`- ${s}`);
  lines.push('');
  lines.push('## Why this is a skill');
  lines.push('');
  lines.push(
    `${convergence.length} agent(s) recorded this independently ` +
    `(${convergence.join(', ') || 'n/a'}), so it is durable, team-useful knowledge worth reusing.`,
  );
  lines.push('');
  lines.push('## Provenance');
  lines.push('');
  lines.push('Auto-promoted from the team Knowledge Base by the curator. Traces back to:');
  for (const m of members) {
    const who = (m && m.originAgent) || 'unknown';
    const when = (m && m.createdAt) || '';
    lines.push(`- \`${(m && m.id) || '?'}\` — ${who}${when ? ` (${when})` : ''}`);
  }
  lines.push('');

  return { name, skillMd: lines.join('\n'), llmDrafted: false };
}

// Build the provenance record written beside an auto-promoted SKILL.md. Same
// field set as admin-console buildSkillProvenance, sourced from the cluster's
// members, with promotedBy fixed to "curator" and the tier transition team→team.
function curatorSkillProvenance({ teamId, cluster, entryIds, now } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString();
  const c = cluster && typeof cluster === 'object' ? cluster : {};
  const members = Array.isArray(c.members) ? c.members : [];
  const originAgents = [...new Set(
    members.map((m) => m && m.originAgent).filter((x) => typeof x === 'string' && x.trim()),
  )];
  const sourceRefs = [];
  const sessions = [];
  for (const m of members) {
    if (m && m.correlationId) sessions.push({ agentId: m.originAgent || null, correlationId: m.correlationId });
    if (m && Array.isArray(m.sourceRefs)) {
      for (const r of m.sourceRefs) if (r && r.kind && r.ref) sourceRefs.push({ kind: r.kind, ref: r.ref });
    }
  }
  const ids = Array.isArray(entryIds) && entryIds.length
    ? [...new Set(entryIds.filter((x) => typeof x === 'string' && x.trim()))]
    : (Array.isArray(c.memberIds) ? c.memberIds.slice() : []);
  return {
    fromTier: 'team',
    toTier: 'team',
    teamId: teamId || c.teamId || 'default',
    entryIds: ids,
    canonicalId: c.canonicalId || ids[0] || null,
    originAgents,
    convergence: Array.isArray(c.convergence) ? c.convergence.slice() : originAgents,
    sourceRefs,
    sessions,
    originTeamId: teamId || c.teamId || 'default',
    promotedAt: ts,
    promotedBy: 'curator',
  };
}

// ---------------------------------------------------------------------------
// Auto-promotion planning
// ---------------------------------------------------------------------------

// Phase 4: a converged team-KB cluster always targets a TEAM skill. (agent→team
// and team→global are operator-gated in the admin-console, never curator-auto.)
function targetTransitionFor(/* cluster */) {
  return 'team>team';
}

/**
 * Decide which clusters the level-3 curator may auto-promote versus defer to a
 * review card. Pure: no IO. Deterministic (input cluster order is preserved).
 *
 * @param {object[]} clusters    from buildCanonicalProjection (deterministic order)
 * @param {object[]} candidates  the team's current candidate store rows
 * @param {object} gates         resolvePromotionGates(env) output
 * @param {{ threshold?: number, cap?: number, teamId?: string, now?: string }} opts
 * @returns {{ promote: object[], defer: object[] }}
 *   promote: [{ cluster, candidate, transition, name, draft }]  (gate=auto, within cap)
 *   defer:   [{ cluster, candidate, transition, reason }]       (reason: gated|over-cap)
 *   `candidate` is the stable-id candidate row (toCandidate), so the caller can
 *   dedup against / update the store; `reason:"gated"` and `"over-cap"` become
 *   review cards (lossless — nothing skipped is dropped).
 */
function planAutoPromotions(clusters, candidates, gates, { threshold = 2, cap = 3, teamId, now } = {}) {
  const byId = new Map(
    (Array.isArray(candidates) ? candidates : [])
      .filter((c) => c && typeof c.id === 'string')
      .map((c) => [c.id, c]),
  );
  const capN = Number.isInteger(cap) && cap >= 1 ? cap : 3;
  const g = gates && typeof gates === 'object' ? gates : {};
  const promote = [];
  const defer = [];
  for (const cluster of Array.isArray(clusters) ? clusters : []) {
    if (!crossesConvergence(cluster, threshold)) continue;
    const candidate = toCandidate(cluster, { teamId, source: 'convergence', now });
    const existing = byId.get(candidate.id);
    // Respect the operator: a dismissed card is never auto-promoted, and a cluster
    // already promoted never re-fires (idempotent).
    if (existing && (existing.status === 'promoted' || existing.status === 'dismissed')) continue;
    const transition = targetTransitionFor(cluster);
    if (g[transition] !== 'auto') {
      defer.push({ cluster, candidate, transition, reason: 'gated' });
      continue;
    }
    if (promote.length >= capN) {
      defer.push({ cluster, candidate, transition, reason: 'over-cap' });
      continue;
    }
    const draft = curatorSkillDraft(cluster);
    promote.push({ cluster, candidate, transition, name: draft.name, draft });
  }
  return { promote, defer };
}

module.exports = {
  SKILL_NAME_RE,
  slugifySkillName,
  curatorSkillDraft,
  curatorSkillProvenance,
  targetTransitionFor,
  planAutoPromotions,
};
