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

const {
  crossesConvergence,
  toCandidate,
  groupRelatedClusters,
  themeQualifies,
  themeToCandidate,
} = require('./knowledge-convergence');

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

// Shared provenance builder for a curator auto-promotion. Both the single-cluster
// (convergence) and the multi-cluster (theme, #604) promotions produce the SAME
// record shape as admin-console buildSkillProvenance — sourced from a set of KB
// member entries — with promotedBy fixed to "curator" and the tier transition
// team→team. The two public wrappers below only differ in how they source the
// members / ids (a single cluster vs. a theme candidate spanning several).
function buildCuratorProvenance({ teamId, fallbackTeamId, members, convergence, canonicalId, entryIds, now } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString();
  const mem = Array.isArray(members) ? members : [];
  const originAgents = [...new Set(
    mem.map((m) => m && m.originAgent).filter((x) => typeof x === 'string' && x.trim()),
  )];
  const sourceRefs = [];
  const sessions = [];
  for (const m of mem) {
    if (m && m.correlationId) sessions.push({ agentId: m.originAgent || null, correlationId: m.correlationId });
    if (m && Array.isArray(m.sourceRefs)) {
      for (const r of m.sourceRefs) if (r && r.kind && r.ref) sourceRefs.push({ kind: r.kind, ref: r.ref });
    }
  }
  const ids = Array.isArray(entryIds) ? entryIds.slice() : [];
  const team = teamId || fallbackTeamId || 'default';
  return {
    fromTier: 'team',
    toTier: 'team',
    teamId: team,
    entryIds: ids,
    canonicalId: canonicalId || ids[0] || null,
    originAgents,
    convergence: Array.isArray(convergence) ? convergence.slice() : originAgents,
    sourceRefs,
    sessions,
    originTeamId: team,
    promotedAt: ts,
    promotedBy: 'curator',
  };
}

// Build the provenance record written beside an auto-promoted SKILL.md, sourced
// from a single converged cluster's members.
function curatorSkillProvenance({ teamId, cluster, entryIds, now } = {}) {
  const c = cluster && typeof cluster === 'object' ? cluster : {};
  const ids = Array.isArray(entryIds) && entryIds.length
    ? [...new Set(entryIds.filter((x) => typeof x === 'string' && x.trim()))]
    : (Array.isArray(c.memberIds) ? c.memberIds.slice() : []);
  return buildCuratorProvenance({
    teamId,
    fallbackTeamId: c.teamId,
    members: c.members,
    convergence: c.convergence,
    canonicalId: c.canonicalId,
    entryIds: ids,
    now,
  });
}

// ---------------------------------------------------------------------------
// Theme (single-role accumulation) skill draft + provenance (#604)
// ---------------------------------------------------------------------------

// A theme bundles SEVERAL topically-related clusters (often one specialist role
// accumulating many lessons on a topic) into ONE reusable team skill. The draft
// is built from the theme candidate (themeToCandidate) — its members already
// span all the theme's clusters/kinds — so no LLM and no raw group needed. The
// "Why" framing differs from the convergence draft: a theme is accumulation, not
// necessarily N independent recordings, so it never claims cross-agent
// convergence it doesn't have.
function curatorThemeSkillDraft(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const name = slugifySkillName(c.text, c.kind);
  const title = (c.text || 'Team knowledge').trim();
  const members = Array.isArray(c.members) ? c.members : [];
  const agents = [...new Set(
    (Array.isArray(c.convergence) ? c.convergence : [])
      .concat(members.map((m) => m && m.originAgent))
      .filter((x) => typeof x === 'string' && x.trim()),
  )];
  const kinds = Array.isArray(c.kinds) && c.kinds.length
    ? c.kinds
    : (c.kind ? [c.kind] : []);
  const lessonCount = Number.isInteger(c.lessonCount) ? c.lessonCount : members.length;

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
    `${lessonCount} related lesson(s) accumulated by this team ` +
    `(${agents.join(', ') || 'n/a'})` +
    `${kinds.length ? `, spanning ${kinds.join(', ')}` : ''} — ` +
    'bundled into one reusable team skill.',
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

// Provenance for a theme auto-promotion — sourced from the theme candidate, whose
// entryIds/members span every bundled cluster, so the graph builder's
// skillEntryIds() renders the T1→T2 promoted edge exactly as for a convergence
// promotion.
function curatorThemeSkillProvenance({ teamId, candidate, entryIds, now } = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const ids = Array.isArray(entryIds) && entryIds.length
    ? [...new Set(entryIds.filter((x) => typeof x === 'string' && x.trim()))]
    : (Array.isArray(c.entryIds)
      ? [...new Set(c.entryIds.filter((x) => typeof x === 'string' && x.trim()))]
      : []);
  return buildCuratorProvenance({
    teamId,
    fallbackTeamId: c.teamId,
    members: c.members,
    convergence: c.convergence,
    canonicalId: c.canonicalId,
    entryIds: ids,
    now,
  });
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

/**
 * Decide which single-role/accumulation THEMES the level-3 curator may
 * auto-promote to a team skill versus defer to a review card (#604). Pure: no IO.
 *
 * Mirrors planAutoPromotions but for themes: it groups the (already
 * team-scoped, review-eligible) clusters exactly like planRelatedSuggestions
 * (groupRelatedClusters + themeQualifies), so the SAME themes that surface as
 * review cards at level 2 are the auto-promotion candidates here. A theme is
 * AUTO-promoted only when its `lessonCount >= autoThemeMinLessons` (default 4 —
 * strictly higher than the card floor strongLessons=3, so a weaker theme still
 * gets human review); a single-agent theme is explicitly allowed (that is the
 * whole point — single-role accumulation is the primary learning model). Gated
 * (transition not `auto`), too-weak, and over-cap themes are deferred so they can
 * be raised as review cards by the caller (raiseRelatedSuggestions).
 *
 * @param {object[]} clusters    from buildCanonicalProjection (deterministic order)
 * @param {object[]} candidates  the team's current candidate store rows
 * @param {object} gates         resolvePromotionGates(env) output
 * @param {{ autoThemeMinLessons?: number, cap?: number, relatedThreshold?: number,
 *           minLessons?: number, minAgents?: number, strongLessons?: number,
 *           teamId?: string, now?: string }} opts
 * @returns {{ promote: object[], defer: object[] }}
 *   promote: [{ candidate, transition, name, draft }]  (gate=auto, lessonCount>=min, within cap)
 *   defer:   [{ candidate, transition, reason }]        (reason: gated|below-threshold|over-cap)
 */
function planAutoPromoteThemes(clusters, candidates, gates, {
  autoThemeMinLessons = 4, cap = 3, relatedThreshold = 0.3,
  minLessons = 2, minAgents = 2, strongLessons = 3, teamId, now,
} = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const byId = new Map(
    rows.filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]),
  );
  // Exclude clusters whose knowledge already backs a promoted candidate — a
  // theme must never re-bundle already-promoted knowledge (mirrors the `eligible`
  // filter in planRelatedSuggestions).
  const promotedEntryIds = new Set();
  const promotedCanonicalIds = new Set();
  for (const c of rows) {
    if (!c || c.status !== 'promoted') continue;
    if (c.canonicalId) promotedCanonicalIds.add(c.canonicalId);
    for (const id of c.entryIds || []) promotedEntryIds.add(id);
  }
  const eligible = (Array.isArray(clusters) ? clusters : []).filter((c) => {
    if (!c) return false;
    if (promotedCanonicalIds.has(c.canonicalId)) return false;
    const ids = Array.isArray(c.memberIds) ? c.memberIds : [];
    if (ids.length > 0 && ids.every((id) => promotedEntryIds.has(id))) return false;
    return true;
  });

  const capN = Number.isInteger(cap) && cap >= 1 ? cap : 3;
  const autoMin = Number.isInteger(autoThemeMinLessons) && autoThemeMinLessons >= 1
    ? autoThemeMinLessons
    : 4;
  const g = gates && typeof gates === 'object' ? gates : {};
  const promote = [];
  const defer = [];
  for (const group of groupRelatedClusters(eligible, { relatedThreshold })) {
    if (!themeQualifies(group, { minLessons, minAgents, strongLessons })) continue;
    const candidate = themeToCandidate(group, { teamId, now });
    const existing = byId.get(candidate.id);
    // Respect the operator + idempotency: a dismissed theme is never
    // auto-promoted, and a theme already promoted never re-fires.
    if (existing && (existing.status === 'promoted' || existing.status === 'dismissed')) continue;
    const transition = targetTransitionFor();
    if (g[transition] !== 'auto') {
      defer.push({ candidate, transition, reason: 'gated' });
      continue;
    }
    if (!(Number.isInteger(candidate.lessonCount) && candidate.lessonCount >= autoMin)) {
      defer.push({ candidate, transition, reason: 'below-threshold' });
      continue;
    }
    if (promote.length >= capN) {
      defer.push({ candidate, transition, reason: 'over-cap' });
      continue;
    }
    const draft = curatorThemeSkillDraft(candidate);
    promote.push({ candidate, transition, name: draft.name, draft });
  }
  return { promote, defer };
}

module.exports = {
  SKILL_NAME_RE,
  slugifySkillName,
  curatorSkillDraft,
  curatorSkillProvenance,
  curatorThemeSkillDraft,
  curatorThemeSkillProvenance,
  targetTransitionFor,
  planAutoPromotions,
  planAutoPromoteThemes,
};
