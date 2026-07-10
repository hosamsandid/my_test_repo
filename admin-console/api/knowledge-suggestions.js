'use strict';

// Promotion-suggestion pure core (Shared Agent Learning & Knowledge Flow,
// Phase 3). This is the admin-console side: it turns a converged KB cluster (a
// candidate raised by the orchestrator collector, see
// docs/knowledge-convergence.md) into a reviewable promotion card — a heuristic
// SKILL.md draft the operator edits, the tier-transition rules, and the
// mandatory provenance record that lets any promoted skill be traced back to the
// agent/session/PR that learned it.
//
// Deliberately PURE — no fs, no network, no clock beyond an injected `now`. The
// IO (reading the candidate store, the optional LLM polish, writing the skill +
// provenance.json) lives in api.js. Clustering + similarity live on the
// orchestrator side (knowledge-convergence.js) and are never duplicated here —
// candidates arrive pre-clustered.

const TIERS = ['agent', 'team', 'global'];
// A promotion either turns a converged TEAM-KB cluster into a skill (`from:"team"`
// — the KB tier — `to` = "team" (the normal home) or "global" (== the existing
// promote-to-global)), OR lifts an existing private AGENT skill up to the team
// pool (`agent→team`, Phase 4). In both cases provenance (`entryIds`) is
// mandatory: a KB promotion supplies the cluster's entry ids; an agent→team lift
// carries them forward from the source skill's provenance.json.
const ALLOWED_TRANSITIONS = new Set(['team>team', 'team>global', 'agent>team']);

// Mirror the api.js SKILL_NAME_RE so a generated name is always writable.
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+([.:][a-zA-Z0-9_-]+)*$/;

// ---------------------------------------------------------------------------
// Skill name
// ---------------------------------------------------------------------------

// Derive a safe skill slug from free text (the cluster's representative fact),
// falling back to the kind so we never produce an empty/invalid name.
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

// ---------------------------------------------------------------------------
// Heuristic SKILL.md draft (always present; LLM polish is optional + on-demand)
// ---------------------------------------------------------------------------

// A templated SKILL.md built from the cluster alone — cheap, dependency-free,
// no secrets (only the durable statements + who converged, which the KB already
// exposes). The operator edits it; "Draft with AI" can replace the body later.
function buildHeuristicSkillDraft(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
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
  lines.push('Promoted from the team Knowledge Base. Traces back to:');
  for (const m of members) {
    const who = (m && m.originAgent) || 'unknown';
    const when = (m && m.createdAt) || '';
    lines.push(`- \`${(m && m.id) || '?'}\` — ${who}${when ? ` (${when})` : ''}`);
  }
  lines.push('');

  return { name, skillMd: lines.join('\n'), llmDrafted: false };
}

// ---------------------------------------------------------------------------
// LLM draft request (reuses api.js resolveGenerationTarget + httpPostJson)
// ---------------------------------------------------------------------------

// Meta-prompt: turn a converged cluster into a clean, reusable SKILL.md. Pure —
// api.js supplies the model + transport, exactly like buildAgentPromptGenerationRequest.
function buildSkillDraftRequest(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const members = Array.isArray(c.members) ? c.members : [];
  const facts = members.map((m) => `- ${(m && m.text) || ''}`).join('\n') || `- ${c.text || ''}`;
  const instruction = [
    'You curate reusable skills for a team of AI software-delivery agents.',
    'Several agents independently recorded the same durable lesson in the team knowledge base.',
    'Turn it into a concise, reusable SKILL.md.',
    '',
    `Kind: ${c.kind || 'fact'}`,
    'The recorded statements (deduplicate and generalise them):',
    facts,
    '',
    'Requirements for the SKILL.md you produce:',
    '- Start with a single H1 title line, then short sections.',
    '- Capture the durable, reusable knowledge — no PR/issue-specific or run-specific detail.',
    '- Practical and concise (roughly 80–200 words).',
    '- Do NOT invent tool names, repo names, file paths or credentials that were not stated.',
    '- Output ONLY the Markdown of the SKILL.md — no preamble, no surrounding code fences.',
  ].join('\n');
  return { max_tokens: 1024, messages: [{ role: 'user', content: instruction }] };
}

// ---------------------------------------------------------------------------
// Promotion validation + provenance (decision d — provenance MANDATORY)
// ---------------------------------------------------------------------------

// Validate a promote(from→to) request. Returns { ok, error?, name, from, to,
// entryIds }. Enforces: allowed tier transition, valid skill name, and a
// non-empty entryIds (the provenance link — a skill can never be promoted
// without tracing back to the KB entries that justify it).
function validatePromotion(input) {
  const b = input && typeof input === 'object' ? input : {};
  const from = typeof b.from === 'string' ? b.from.trim() : '';
  const to = typeof b.to === 'string' ? b.to.trim() : '';
  if (!TIERS.includes(from)) return { ok: false, error: `from must be one of ${TIERS.join('|')}` };
  if (!TIERS.includes(to)) return { ok: false, error: `to must be one of ${TIERS.join('|')}` };
  if (!ALLOWED_TRANSITIONS.has(`${from}>${to}`)) {
    return { ok: false, error: `unsupported promotion ${from}→${to} (allowed: team→team, team→global, agent→team)` };
  }
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || !SKILL_NAME_RE.test(name)) return { ok: false, error: 'invalid skill name' };
  const entryIds = Array.isArray(b.entryIds)
    ? [...new Set(b.entryIds.filter((x) => typeof x === 'string' && /^[0-9a-f]{12}$/.test(x)))]
    : [];
  if (entryIds.length === 0) {
    return { ok: false, error: 'entryIds is required (provenance): a promotion must trace to >=1 KB entry' };
  }
  const skillMd = typeof b.skillMd === 'string' ? b.skillMd : '';
  if (skillMd.trim() === '') return { ok: false, error: 'skillMd must be non-empty' };
  return { ok: true, from, to, name, entryIds, skillMd };
}

// Build the provenance record written beside SKILL.md. Carries every link the
// Knowledge Flow drill-down needs (entryIds → KB entry → originAgent → session →
// PR) plus originTeamId so the global lane shows the originating team. The
// graph builder's skillEntryIds() reads `entryIds`, drawing the T1→T2 edge.
function buildSkillProvenance({ from, to, teamId, entryIds, candidate, promotedBy, now } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString();
  const c = candidate && typeof candidate === 'object' ? candidate : {};
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
  const prov = {
    fromTier: from,
    toTier: to,
    teamId: teamId || c.teamId || 'default',
    entryIds: entryIds.slice(),
    canonicalId: c.canonicalId || entryIds[0] || null,
    originAgents,
    convergence: Array.isArray(c.convergence) ? c.convergence.slice() : originAgents,
    sourceRefs,
    sessions,
    originTeamId: teamId || c.teamId || 'default',
    promotedAt: ts,
    promotedBy: typeof promotedBy === 'string' && promotedBy.trim() ? promotedBy.trim() : 'operator',
  };
  return prov;
}

// ---------------------------------------------------------------------------
// Directed cross-team sharing (human-in-control lateral knowledge flow)
// ---------------------------------------------------------------------------

// Promotion moves knowledge UP the ladder (agent→team→global). Sharing moves it
// SIDEWAYS: a human copies an existing skill from one team's pool (or the global
// pool) into ANOTHER specific team's pool, so a lesson learned in one stage/team
// reaches another team directly instead of only via a broadcast-to-global. It is
// always operator-initiated (never automated) and provenance-preserving.
//
// Validate a share request. Returns { ok, error?, from, name, sourceTeamId?,
// targetTeamId }. `from` ∈ "team" (copy from sourceTeamId's pool) | "global"
// (copy from the global pool). The target must differ from the source team.
const SHARE_SOURCES = ['team', 'global'];
function validateShareToTeam(input, { teamIdRe = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/ } = {}) {
  const b = input && typeof input === 'object' ? input : {};
  const from = typeof b.from === 'string' ? b.from.trim() : '';
  if (!SHARE_SOURCES.includes(from)) return { ok: false, error: `from must be one of ${SHARE_SOURCES.join('|')}` };
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || !SKILL_NAME_RE.test(name)) return { ok: false, error: 'invalid skill name' };
  const targetTeamId = typeof b.targetTeamId === 'string' ? b.targetTeamId.trim() : '';
  if (!teamIdRe.test(targetTeamId)) return { ok: false, error: 'invalid targetTeamId' };
  let sourceTeamId = '';
  if (from === 'team') {
    sourceTeamId = typeof b.sourceTeamId === 'string' ? b.sourceTeamId.trim() : '';
    if (!teamIdRe.test(sourceTeamId)) return { ok: false, error: 'invalid sourceTeamId' };
    if (sourceTeamId === targetTeamId) return { ok: false, error: 'source and target team are the same' };
  }
  return { ok: true, from, name, sourceTeamId: sourceTeamId || null, targetTeamId };
}

// Stamp a shared skill's provenance so the lineage records that it arrived by a
// lateral share (who, from where, when) rather than an up-the-ladder promotion.
// Preserves the source skill's original provenance under `sharedFrom` so the
// trace back to the KB entries that first justified it survives the copy.
function buildShareProvenance({ from, sourceTeamId, targetTeamId, name, sourceProvenance, sharedBy, now } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString();
  const src = sourceProvenance && typeof sourceProvenance === 'object' ? sourceProvenance : {};
  return {
    ...src,
    teamId: targetTeamId,
    toTier: 'team',
    sharedFrom: { tier: from, teamId: sourceTeamId || null, name },
    sharedBy: typeof sharedBy === 'string' && sharedBy.trim() ? sharedBy.trim() : 'operator',
    sharedAt: ts,
    // entryIds/originTeamId/originAgents carry forward from src so the T1→T2 edge
    // + drill-down still resolve; originTeamId marks where the knowledge was born.
    originTeamId: src.originTeamId || sourceTeamId || null,
  };
}

// ---------------------------------------------------------------------------
// Promotion gate policy (Phase 4) — MIRRORS orchestrator/knowledge-store.js
// resolvePromotionGates. The two services never require each other's code, so the
// resolver + defaults are duplicated deliberately (same discipline as the two-
// runtime harvest hint); keep them in sync. The admin-console uses this only to
// DISPLAY the gate switches; the orchestrator's copy is what actually fires.
// ---------------------------------------------------------------------------

const PROMOTION_TRANSITIONS = ['team>team', 'team>global', 'agent>team'];
const GATE_MODES = ['auto', 'review'];
const DEFAULT_PROMOTION_GATES = { 'team>team': 'auto', 'team>global': 'review', 'agent>team': 'review' };

function resolvePromotionGates(env) {
  const raw = env && typeof env.knowledgePromotionGates === 'object' && env.knowledgePromotionGates
    ? env.knowledgePromotionGates
    : {};
  const out = {};
  for (const t of PROMOTION_TRANSITIONS) {
    if (!(t in raw)) { out[t] = DEFAULT_PROMOTION_GATES[t]; continue; }
    out[t] = GATE_MODES.includes(raw[t]) ? raw[t] : 'review';
  }
  out['team>global'] = 'review';
  return out;
}

// ---------------------------------------------------------------------------
// View assembly (candidate + draft → the /promotion-suggestions row the UI gets)
// ---------------------------------------------------------------------------

function promotionSuggestionView(candidate, draft) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const d = draft && typeof draft === 'object' ? draft : buildHeuristicSkillDraft(c);
  return {
    id: c.id,
    teamId: c.teamId,
    kind: c.kind,
    canonicalId: c.canonicalId,
    entryIds: Array.isArray(c.entryIds) ? c.entryIds : [],
    convergence: Array.isArray(c.convergence) ? c.convergence : [],
    convergenceCount: c.convergenceCount || (Array.isArray(c.convergence) ? c.convergence.length : 0),
    text: c.text,
    members: Array.isArray(c.members) ? c.members : [],
    source: c.source || 'convergence',
    note: c.note || null,
    status: c.status || 'open',
    raisedAt: c.raisedAt || null,
    draft: {
      name: d.name,
      skillMd: d.skillMd,
      llmDrafted: !!d.llmDrafted,
    },
  };
}

module.exports = {
  TIERS,
  ALLOWED_TRANSITIONS,
  SKILL_NAME_RE,
  PROMOTION_TRANSITIONS,
  GATE_MODES,
  DEFAULT_PROMOTION_GATES,
  slugifySkillName,
  buildHeuristicSkillDraft,
  buildSkillDraftRequest,
  validatePromotion,
  buildSkillProvenance,
  SHARE_SOURCES,
  validateShareToTeam,
  buildShareProvenance,
  resolvePromotionGates,
  promotionSuggestionView,
};
