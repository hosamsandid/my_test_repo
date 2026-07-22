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
const { domainSkillName } = require('./knowledge-domains');
// Reuse the #617 consumer parser (pure sibling, no orchestrator boot) so the
// frontmatter the curator writes is guaranteed to read back through the exact same
// code path that composes it into an agent's CLAUDE.md (#805 AC4/AC8).
const { parseSkillDescription } = require('./skill-source');

// Mirror the admin-console SKILL_NAME_RE so a generated name is always writable.
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+([.:][a-zA-Z0-9_-]+)*$/;

// ---------------------------------------------------------------------------
// SKILL.md frontmatter (#805) — every curator-generated SKILL.md must carry a
// valid YAML frontmatter block with a non-empty `name` + one-line `description`,
// so the #617 consumer advertises it in CLAUDE.md instead of listing it name-only.
// ---------------------------------------------------------------------------

const MAX_DESCRIPTION_LEN = 200; // keep the CLAUDE.md Skills list readable (E3)

// Collapse any whitespace run (incl. newlines) to a single space and trim (AC8/E3).
function collapseLine(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// Truncate an already-collapsed line to one readable sentence-length line, cutting
// on a word boundary and appending an ellipsis (E3).
function truncateLine(line, max = MAX_DESCRIPTION_LEN) {
  const s = String(line == null ? '' : line);
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  const head = sp > max * 0.6 ? cut.slice(0, sp) : cut;
  return `${head.replace(/[\s.,;:!?/–—-]+$/, '')}…`;
}

// Render one YAML scalar the fail-soft parseSkillDescription reader accepts (E4).
// Backslashes are dropped and inner double-quotes folded to single-quotes so a
// double-quoted scalar never needs escaping (the reader strips outer quotes but
// does not un-escape). A value with no YAML-significant punctuation stays plain.
function fmScalar(value) {
  const s = collapseLine(value).replace(/\\/g, '').replace(/"/g, "'");
  if (!s) return '""';
  const plainSafe = /^[A-Za-z0-9][A-Za-z0-9 _.()/-]*$/.test(s);
  return plainSafe ? s : `"${s}"`;
}

// Build a fresh frontmatter block: `---` / name / description / `---`.
function renderSkillFrontmatter({ name, description } = {}) {
  const n = collapseLine(name) || 'team-skill';
  const d = truncateLine(collapseLine(description)) || 'Team-curated knowledge skill.';
  return ['---', `name: ${fmScalar(n)}`, `description: ${fmScalar(d)}`, '---'].join('\n');
}

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Guarantee `skillMd` begins with exactly one valid YAML frontmatter block that
 * carries a non-empty `name` and `description` (#805 AC1-AC4).
 *
 * - No block yet → prepend one built from the supplied fallback name/description.
 * - A block already present → inject only the MISSING key(s); a present, non-empty
 *   `name`/`description` is preserved verbatim (E5 — never overwrite a stronger
 *   authored value, and E1 — never double-wrap an already-frontmattered LLM body).
 * Pure (string in, string out).
 */
function ensureSkillFrontmatter(skillMd, { name, description } = {}) {
  let md = String(skillMd == null ? '' : skillMd).replace(/^﻿/, '');
  md = md.replace(/^\s+(?=---[ \t]*\r?\n)/, ''); // tolerate a stray blank before a block
  const fName = collapseLine(name);
  const fDesc = truncateLine(collapseLine(description));
  const m = FRONTMATTER_RE.exec(md);
  if (m) {
    const body = m[1];
    const rest = md.slice(m[0].length);
    const hasName = /^name[ \t]*:[ \t]*\S/m.test(body);
    const hasDesc = !!parseSkillDescription(md);
    const inject = [];
    if (!hasName) inject.push(`name: ${fmScalar(fName || 'team-skill')}`);
    if (!hasDesc) inject.push(`description: ${fmScalar(fDesc || 'Team-curated knowledge skill.')}`);
    if (inject.length === 0) return md; // already complete
    const newBody = inject.concat(body ? [body] : []).join('\n');
    return `---\n${newBody}\n---\n${rest}`;
  }
  return `${renderSkillFrontmatter({ name: fName, description: fDesc })}\n\n${md.replace(/^\n+/, '')}`;
}

// Derive a deterministic one-line "when to reach for this" description from a
// cluster/theme candidate (+ optional routed domain). No LLM on the hot path, no
// secrets/URLs (only the domain/lesson title + role audience) — mirrors the
// no-secrets constraint the drafts already honour (#805 AC6, open-question 1).
function deriveSkillDescription(source, { domain } = {}) {
  const s = source && typeof source === 'object' ? source : {};
  if (domain && domain.name) {
    const roles = Array.isArray(domain.roles) && domain.roles.length ? domain.roles.join(', ') : '';
    return truncateLine(collapseLine(
      `${domain.name} — team-curated playbook${roles ? ` for ${roles}` : ''}. ` +
      'Reach for this when a task falls in this domain.',
    ));
  }
  const title = collapseLine(s.text) || 'team knowledge';
  const topic = title.replace(/[.:;!?]+$/, '');
  return truncateLine(collapseLine(
    `Team-curated guidance: ${title}. Reach for this when a task involves ${topic.toLowerCase()}.`,
  ));
}

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
function curatorSkillDraft(cluster, { domain } = {}) {
  const c = cluster && typeof cluster === 'object' ? cluster : {};
  // Domain-based naming (#780 AC4): when the cluster routes to a domain, the skill
  // is named after the domain, not the first six words of a lesson. Falls back to
  // the legacy lesson-slug only when no domain is supplied (last-resort).
  const name = domain ? domainSkillName(domain) : slugifySkillName(c.text, c.kind);
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

  // #805: prepend YAML frontmatter (name + one-line description) so the #617
  // consumer advertises this skill in CLAUDE.md instead of listing it name-only.
  const description = deriveSkillDescription(c, { domain });
  const skillMd = ensureSkillFrontmatter(lines.join('\n'), { name, description });
  return { name, description, skillMd, llmDrafted: false };
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
function curatorThemeSkillDraft(candidate, { domain } = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const name = domain ? domainSkillName(domain) : slugifySkillName(c.text, c.kind);
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

  // #805: prepend YAML frontmatter (name + one-line description).
  const description = deriveSkillDescription(c, { domain });
  const skillMd = ensureSkillFrontmatter(lines.join('\n'), { name, description });
  return { name, description, skillMd, llmDrafted: false };
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
  minLessons = 2, minAgents = 2, strongLessons = 3, teamId, now, resolveDomain,
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
    // #780 AC4: name an auto-promoted theme after its best-matching domain (the
    // caller supplies the resolver — this module stays fs-/routing-free); the
    // lesson-slug name in curatorThemeSkillDraft is a last-resort fallback only.
    const domain = typeof resolveDomain === 'function' ? resolveDomain(candidate) : null;
    const draft = curatorThemeSkillDraft(candidate, { domain });
    promote.push({ candidate, transition, name: draft.name, draft });
  }
  return { promote, defer };
}

// ---------------------------------------------------------------------------
// Curator auto-extend (#779, skill-aggregation Phase 1)
// ---------------------------------------------------------------------------
//
// Today the curator can only ever CREATE a new sibling skill; related knowledge
// accretes as micro-skills instead of maturing one document. This adds the
// level-3 curator's auto-extend path: when a converged cluster clearly matches an
// existing team skill, fold it in via the existing extend machinery rather than
// spawning a new skill. As with the draft/provenance builders above, these MIRROR
// the admin-console originals (matchExistingSkill / buildHeuristicSkillExtension /
// extendSkillProvenance in admin-console/api/knowledge-suggestions.js) instead of
// importing them — the two services never require each other's code. Keep in sync.

/**
 * Auto-match a converged candidate to an existing skill (mirrors admin-console
 * knowledge-suggestions.matchExistingSkill). Given the candidate and a list of
 * eligible skills ({ name, tier, entryIds? }), return the best match or null.
 * Signals, strongest first: (1) any overlap between the candidate's KB entry ids
 * and a skill's provenance entryIds (a direct lineage hit, weighted 100/id); (2)
 * token overlap between the candidate text and the skill name (1/token). A skill
 * is only proposed when a signal fires — the default stays "create new".
 */
function matchExistingSkill(candidate, existingSkills) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const skills = Array.isArray(existingSkills) ? existingSkills : [];
  if (skills.length === 0) return null;
  const entryIds = new Set(Array.isArray(c.entryIds) ? c.entryIds : []);
  const textTokens = new Set(
    String(c.text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  );

  let best = null;
  let bestScore = 0;
  for (const s of skills) {
    if (!s || typeof s.name !== 'string' || !s.name) continue;
    let idOverlap = 0;
    for (const id of Array.isArray(s.entryIds) ? s.entryIds : []) {
      if (entryIds.has(id)) idOverlap += 1;
    }
    const nameTokens = s.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    let nameOverlap = 0;
    for (const t of nameTokens) if (textTokens.has(t)) nameOverlap += 1;
    const score = idOverlap * 100 + nameOverlap;
    if (score > bestScore) {
      bestScore = score;
      best = { name: s.name, tier: s.tier || null, score, idOverlap, nameOverlap };
    }
  }
  return bestScore > 0 ? best : null;
}

// Heuristic re-synthesis fallback for an auto-extension (mirrors admin-console
// buildHeuristicSkillExtension): keep the existing SKILL.md verbatim and append the
// new, not-yet-present lessons under an "## Added knowledge" section, deduplicated
// (case-insensitive substring) against the existing text so a re-run is close to a
// no-op. The heuristic is the FAILURE fallback for the LLM extension draft, so it is
// marked `llmDrafted:false` / `synthesised:false` — the caller records that the
// added content is un-synthesised. `added` is the count of genuinely new lines so
// the caller can reject an empty (no-op) extension.
function curatorSkillExtension(existingSkillMd, candidate, { name, domain } = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const prior = (typeof existingSkillMd === 'string' ? existingSkillMd : '').replace(/\s+$/, '');
  const priorLc = prior.toLowerCase();
  const members = Array.isArray(c.members) ? c.members : [];
  const statements = [];
  const seen = new Set();
  for (const m of members) {
    const t = (m && typeof m.text === 'string' ? m.text.trim() : '');
    if (!t) continue;
    const lc = t.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    if (priorLc.includes(lc)) continue; // already covered by the existing doc
    statements.push(t);
  }
  // #805: the update must never drop or blank the frontmatter (AC3). ensureSkillFrontmatter
  // preserves an existing name/description (E5) and only fills a missing one — so a legacy
  // skill written before #805 gains a valid block on its first extension, while a skill that
  // already had a description keeps it.
  const skillName = collapseLine(name) || (domain ? domainSkillName(domain) : slugifySkillName(c.text, c.kind));
  const description = deriveSkillDescription(c, { domain });
  const fm = (md) => ensureSkillFrontmatter(md, { name: skillName, description });
  if (statements.length === 0) {
    return { skillMd: fm(prior), description, llmDrafted: false, synthesised: false, added: 0 };
  }
  const lines = [prior, '', '## Added knowledge', ''];
  for (const s of statements) lines.push(`- ${s}`);
  lines.push('');
  return { skillMd: fm(lines.join('\n')), description, llmDrafted: false, synthesised: false, added: statements.length };
}

// Union the new provenance onto an existing skill's record (mirrors admin-console
// extendSkillProvenance) with `extendedBy` fixed to "curator". Existing entryIds,
// originAgents, convergence and the original promotion metadata are preserved; the
// new ids/agents are merged in and a dated extension entry appended to extensions[].
function curatorExtendProvenance({ existingProv, from = 'team', to = 'team', teamId, entryIds, candidate, now } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString();
  const prev = existingProv && typeof existingProv === 'object' ? existingProv : {};
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const members = Array.isArray(c.members) ? c.members : [];

  const prevIds = Array.isArray(prev.entryIds) ? prev.entryIds : [];
  const addedIds = (Array.isArray(entryIds) ? entryIds : []).filter((id) => !prevIds.includes(id));
  const mergedIds = [...prevIds, ...addedIds];

  const newAgents = [...new Set(
    members.map((m) => m && m.originAgent).filter((x) => typeof x === 'string' && x.trim()),
  )];
  const prevAgents = Array.isArray(prev.originAgents) ? prev.originAgents : [];
  const mergedAgents = [...new Set([...prevAgents, ...newAgents])];

  const prevConvergence = Array.isArray(prev.convergence) ? prev.convergence : [];
  const newConvergence = Array.isArray(c.convergence) ? c.convergence : newAgents;
  const mergedConvergence = [...new Set([...prevConvergence, ...newConvergence])];

  const sourceRefs = Array.isArray(prev.sourceRefs) ? prev.sourceRefs.slice() : [];
  const sessions = Array.isArray(prev.sessions) ? prev.sessions.slice() : [];
  for (const m of members) {
    if (m && m.correlationId) sessions.push({ agentId: m.originAgent || null, correlationId: m.correlationId });
    if (m && Array.isArray(m.sourceRefs)) {
      for (const r of m.sourceRefs) if (r && r.kind && r.ref) sourceRefs.push({ kind: r.kind, ref: r.ref });
    }
  }

  const extensions = Array.isArray(prev.extensions) ? prev.extensions.slice() : [];
  extensions.push({
    entryIds: addedIds.slice(),
    addedAgents: newAgents,
    extendedBy: 'curator',
    extendedAt: ts,
  });

  // #781: every amendment bumps the distillation counter so a grown skill becomes
  // due for a whole-document re-synthesis after X amendments (knowledge-distillation
  // reads/resets amendmentsSinceDistillation). A legacy record with no counter reads
  // as 0, so the first extension after the upgrade correctly counts as 1.
  const prevAmendments = Number.isInteger(prev.amendmentsSinceDistillation) && prev.amendmentsSinceDistillation >= 0
    ? prev.amendmentsSinceDistillation : 0;

  return {
    ...prev,
    fromTier: prev.fromTier || from,
    toTier: to || prev.toTier,
    teamId: teamId || prev.teamId || c.teamId || 'default',
    entryIds: mergedIds,
    canonicalId: prev.canonicalId || mergedIds[0] || null,
    originAgents: mergedAgents,
    convergence: mergedConvergence,
    sourceRefs,
    sessions,
    originTeamId: prev.originTeamId || teamId || c.teamId || 'default',
    extensions,
    lastExtendedAt: ts,
    lastExtendedBy: 'curator',
    amendmentsSinceDistillation: prevAmendments + 1,
  };
}

/**
 * Decide which converged clusters the level-3 curator may AUTO-EXTEND into an
 * existing team skill versus defer to a review card that pre-selects extend mode
 * (#779). Pure: no IO. Runs BEFORE planAutoPromotions — a cluster matched here is
 * claimed (returned in `consumedCanonicalIds`) so it does not also spawn a new
 * skill. Shares the per-pass promotion cap with the caller via `cap` (an already-
 * reduced remaining budget).
 *
 * @param {object[]} clusters       from buildCanonicalProjection (deterministic order)
 * @param {object[]} candidates     the team's current candidate store rows
 * @param {object[]} existingSkills  [{ name, tier:'team', entryIds? }] — TEAM-tier only
 * @param {object} gates            resolvePromotionGates(env) output
 * @param {{ threshold?: number, cap?: number, confidenceFloor?: number,
 *           teamId?: string, now?: string }} opts
 * @returns {{ extend: object[], reviewExtend: object[], consumedCanonicalIds: Set }}
 *   extend:       [{ cluster, candidate, transition, target, matchScore }] — gate=auto,
 *                 score >= confidenceFloor, within cap; the curator writes these.
 *   reviewExtend: [{ cluster, candidate, target, reason }] — a review card in extend
 *                 mode (reason: gated | below-confidence | over-cap).
 *   consumedCanonicalIds: every cluster this planner claimed (extend + reviewExtend),
 *                 so the caller excludes them from the create-new auto-promotion path.
 */
function planAutoExtensions(clusters, candidates, existingSkills, gates, {
  threshold = 2, cap = 3, confidenceFloor = 100, teamId, now,
} = {}) {
  const byId = new Map(
    (Array.isArray(candidates) ? candidates : [])
      .filter((c) => c && typeof c.id === 'string')
      .map((c) => [c.id, c]),
  );
  const skills = Array.isArray(existingSkills) ? existingSkills : [];
  const capN = Number.isInteger(cap) && cap >= 0 ? cap : 3;
  const floor = Number.isFinite(confidenceFloor) && confidenceFloor >= 1 ? confidenceFloor : 100;
  const g = gates && typeof gates === 'object' ? gates : {};
  const extend = [];
  const reviewExtend = [];
  const consumedCanonicalIds = new Set();
  if (skills.length === 0) return { extend, reviewExtend, consumedCanonicalIds };

  for (const cluster of Array.isArray(clusters) ? clusters : []) {
    if (!crossesConvergence(cluster, threshold)) continue;
    const candidate = toCandidate(cluster, { teamId, source: 'convergence', now });
    const existing = byId.get(candidate.id);
    // Respect the operator + idempotency: a dismissed/already-promoted cluster is
    // never auto-extended.
    if (existing && (existing.status === 'promoted' || existing.status === 'dismissed')) continue;
    const match = matchExistingSkill(candidate, skills);
    if (!match) continue; // no signal ⇒ leave for the create-new auto-promotion path
    const transition = targetTransitionFor(cluster); // 'team>team'
    const claim = () => consumedCanonicalIds.add(cluster.canonicalId);
    // team>global / agent>team are never auto-extended: only a team>team auto gate
    // opens the auto-extend path; anything else becomes a review card.
    if (g[transition] !== 'auto') {
      reviewExtend.push({ cluster, candidate, target: match, reason: 'gated' });
      claim();
      continue;
    }
    if (match.score < floor) {
      reviewExtend.push({ cluster, candidate, target: match, reason: 'below-confidence' });
      claim();
      continue;
    }
    if (extend.length >= capN) {
      reviewExtend.push({ cluster, candidate, target: match, reason: 'over-cap' });
      claim();
      continue;
    }
    extend.push({ cluster, candidate, transition, target: match, matchScore: match.score });
    claim();
  }
  return { extend, reviewExtend, consumedCanonicalIds };
}

// ---------------------------------------------------------------------------
// Default LLM synthesis (#780, skill-aggregation Phase 2, §3.3)
// ---------------------------------------------------------------------------
//
// Every path that writes a SKILL.md should run the LLM draft with a sharpened
// contract — abstract the practice into a sectioned PLAYBOOK, not a verbatim lesson
// dump. These builders MIRROR the admin-console buildSkillDraftRequest transport
// shape ({ max_tokens, messages }); the orchestrator supplies the model + transport
// (a guarded, best-effort call — see orchestrator.js). On LLM failure the heuristic
// draft (curatorSkillDraft / curatorSkillExtension) is kept but VISIBLY MARKED
// un-synthesised and queued for re-synthesis (synthesisFallback below).

// The target playbook shape (§2 of docs/skill-aggregation-concept.md).
const PLAYBOOK_SECTIONS = Object.freeze([
  'When to use', 'The flow', 'Rules & conventions', 'Gotchas & edge cases', 'Examples & snippets',
]);

function _statementLines(members, fallbackText) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(members) ? members : []) {
    const t = (m && typeof m.text === 'string' ? m.text.trim() : '');
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(`- ${t}`); }
  }
  if (out.length === 0 && fallbackText) out.push(`- ${String(fallbackText).trim()}`);
  return out.join('\n');
}

// Meta-prompt turning a converged cluster (or a theme candidate) into a sectioned
// domain playbook. `domain` (optional) supplies the human title + audience roles.
function buildSkillSynthesisRequest(candidate, { domain } = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const title = domain && domain.name ? domain.name : (c.text || 'Team knowledge');
  const roles = domain && Array.isArray(domain.roles) && domain.roles.length
    ? domain.roles.join(', ') : '';
  const facts = _statementLines(c.members, c.text);
  const instruction = [
    'You curate reusable skills for a team of AI software-delivery agents.',
    'Turn the recorded lessons below into ONE coherent SKILL.md that reads as a',
    'DOMAIN PLAYBOOK — the abstracted practice, its flow, rules, gotchas and examples —',
    'NOT a flat verbatim bullet dump of the individual statements.',
    '',
    `Domain: ${title}${roles ? ` (for: ${roles})` : ''}`,
    'The recorded lessons:',
    facts,
    '',
    'Structure the document as:',
    '---',
    `name: ${domain && domain.id ? domain.id : slugifySkillName(title)}`,
    'description: <one line: when to reach for this skill>',
    '---',
    `# ${title}`,
    ...PLAYBOOK_SECTIONS.map((s) => `## ${s}`),
    '',
    'How to synthesise:',
    '- Begin with the YAML frontmatter block above: a non-empty `name` and a single-line',
    '  `description` (a concise "when to reach for this" summary, no colons-in-value issues).',
    '- Generalise beyond the incident: express the PROCESS, not the occurrence.',
    '- File each lesson into the right section (a hard rule vs. a gotcha vs. an example).',
    '- Keep concrete snippets, but mark them clearly as examples of the abstract rule.',
    '- Never drop evidence: every distinct lesson must remain represented somewhere.',
    '- Omit a section that has no material rather than padding it.',
    '- Do NOT invent tool names, repo names, file paths or credentials that were not stated.',
    '- Output ONLY the Markdown of the SKILL.md — no preamble, no surrounding code fences.',
  ].join('\n');
  return { max_tokens: 2048, messages: [{ role: 'user', content: instruction }] };
}

// Meta-prompt re-synthesising an EXISTING playbook with new lessons folded in — the
// synthesis-default sibling of curatorSkillExtension's heuristic append.
function buildSkillExtensionSynthesisRequest(existingSkillMd, candidate, { domain } = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const prior = typeof existingSkillMd === 'string' ? existingSkillMd : '';
  const title = domain && domain.name ? domain.name : (c.text || 'Team knowledge');
  const facts = _statementLines(c.members, c.text);
  const instruction = [
    'You maintain a reusable domain playbook (SKILL.md) for a team of AI agents.',
    `Domain: ${title}`,
    'The existing playbook:',
    '---',
    prior,
    '---',
    'Fold these NEW lessons into it, re-synthesising rather than appending a raw list:',
    facts,
    '',
    'Requirements:',
    '- Keep (or add, if missing) the leading YAML frontmatter block with a non-empty',
    '  `name` and single-line `description`; never blank or drop it.',
    '- Preserve everything already in the playbook; integrate the new lessons into the',
    `  right sections (${PLAYBOOK_SECTIONS.join(' / ')}).`,
    '- Generalise + deduplicate; do not restate a lesson already covered.',
    '- Keep the sectioned playbook shape; do not invent unstated specifics.',
    '- Output ONLY the Markdown of the full updated SKILL.md — no preamble, no code fences.',
  ].join('\n');
  return { max_tokens: 3072, messages: [{ role: 'user', content: instruction }] };
}

// Inject a visible "un-synthesised" marker into a heuristic draft: a blockquote
// right after the first H1 (or at the top when there is none). Idempotent — a
// re-mark of an already-marked doc is a no-op.
const UNSYNTHESISED_MARKER =
  '> ⚠️ **Un-synthesised draft** — raw lessons pending AI synthesis into the ' +
  'domain-playbook shape (When to use / The flow / Rules / Gotchas / Examples). ' +
  'Queued for re-synthesis.';

function markUnsynthesised(skillMd) {
  const md = typeof skillMd === 'string' ? skillMd : '';
  if (md.includes('Un-synthesised draft')) return md; // already marked (idempotent)
  const lines = md.split('\n');
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  if (h1 >= 0) {
    lines.splice(h1 + 1, 0, '', UNSYNTHESISED_MARKER);
    return lines.join('\n');
  }
  return `${UNSYNTHESISED_MARKER}\n\n${md}`;
}

/**
 * Resolve a SKILL.md write to either the LLM-synthesised playbook or the marked
 * heuristic fallback (§3.3, AC3). Pure — the caller runs the LLM (or not) and hands
 * the result in via `llmText`.
 *
 * @param {{ heuristic: {name, skillMd}, llmText?: string|null }} args
 * @returns {{ name, skillMd, synthesised:boolean, needsResynthesis:boolean, llmDrafted:boolean }}
 *   synthesised:true when the LLM produced usable Markdown; otherwise the heuristic
 *   draft is returned with a visible marker and needsResynthesis:true (re-queued).
 */
function synthesisFallback({ heuristic, llmText, frontmatter } = {}) {
  const h = heuristic && typeof heuristic === 'object' ? heuristic : { name: null, skillMd: '' };
  const text = typeof llmText === 'string' ? llmText.trim() : '';
  // #805 AC2/E1/E2: when a deterministic frontmatter fallback is supplied, guarantee
  // the written doc begins with a valid frontmatter block — keeping any frontmatter
  // the LLM produced itself (E1), else injecting the deterministic one. When no
  // fallback is given (legacy callers) the text is returned untouched.
  const guarantee = (md) => (frontmatter ? ensureSkillFrontmatter(md, frontmatter) : md);
  // A usable synthesis is non-trivial Markdown with at least a heading — anything
  // shorter is treated as a failed call and falls back.
  if (text && text.length >= 40 && /(^|\n)#\s/.test(`\n${text}`)) {
    return { name: h.name, skillMd: guarantee(text), synthesised: true, needsResynthesis: false, llmDrafted: true };
  }
  return {
    name: h.name,
    skillMd: guarantee(markUnsynthesised(h.skillMd)),
    synthesised: false,
    needsResynthesis: true,
    llmDrafted: false,
  };
}

module.exports = {
  SKILL_NAME_RE,
  PLAYBOOK_SECTIONS,
  UNSYNTHESISED_MARKER,
  MAX_DESCRIPTION_LEN,
  ensureSkillFrontmatter,
  renderSkillFrontmatter,
  deriveSkillDescription,
  buildSkillSynthesisRequest,
  buildSkillExtensionSynthesisRequest,
  markUnsynthesised,
  synthesisFallback,
  slugifySkillName,
  curatorSkillDraft,
  curatorSkillProvenance,
  curatorThemeSkillDraft,
  curatorThemeSkillProvenance,
  targetTransitionFor,
  planAutoPromotions,
  planAutoPromoteThemes,
  matchExistingSkill,
  curatorSkillExtension,
  curatorExtendProvenance,
  planAutoExtensions,
};
