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
// Aggregated candidates (source "related" — the collector's thematic grouping —
// or "manual" — an operator's multi-select combine) get a synthesis-flavoured
// rationale instead of the same-lesson-N-times one.
function buildHeuristicSkillDraft(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const name = slugifySkillName(c.text, c.kind);
  const title = (c.text || 'Team knowledge').trim();
  const members = Array.isArray(c.members) ? c.members : [];
  const convergence = Array.isArray(c.convergence) ? c.convergence : [];
  const aggregated = c.source === 'related' || c.source === 'manual';

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
  if (aggregated) {
    const n = c.lessonCount || statements.length;
    lines.push(
      `Combines ${n} related lesson(s) about one topic, recorded by ` +
      `${convergence.length} agent(s) (${convergence.join(', ') || 'n/a'}) — together they form ` +
      'coherent, reusable knowledge.',
    );
  } else {
    lines.push(
      `${convergence.length} agent(s) recorded this independently ` +
      `(${convergence.join(', ') || 'n/a'}), so it is durable, team-useful knowledge worth reusing.`,
    );
  }
  lines.push('');
  lines.push('## Provenance');
  lines.push('');
  lines.push(
    c.source === 'manual'
      ? 'Combined by the operator from the team Knowledge Base. Traces back to:'
      : 'Promoted from the team Knowledge Base. Traces back to:',
  );
  for (const m of members) {
    const who = (m && m.originAgent) || 'unknown';
    const when = (m && m.createdAt) || '';
    lines.push(`- \`${(m && m.id) || '?'}\` — ${who}${when ? ` (${when})` : ''}`);
  }
  lines.push('');

  return { name, skillMd: lines.join('\n'), llmDrafted: false };
}

// Build a candidate-shaped record straight from raw KB entries — the ad-hoc
// sibling of the orchestrator's toCandidate, used when the OPERATOR selects
// entries to combine (no pre-clustered candidate exists). Same shape the draft/
// provenance builders and the promotion dialog consume.
function candidateFromEntries(entries, { teamId, source = 'manual', now } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const list = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.text === 'string',
  );
  const members = [];
  const seen = new Set();
  for (const e of list) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    members.push({
      id: e.id,
      originAgent: e.originAgent,
      text: e.text,
      createdAt: e.createdAt,
      correlationId: e.correlationId || null,
      sessionId: e.sessionId || null,
      ...(Array.isArray(e.sourceRefs) && e.sourceRefs.length ? { sourceRefs: e.sourceRefs } : {}),
    });
  }
  const agents = new Set();
  for (const e of list) {
    if (typeof e.originAgent === 'string' && e.originAgent.trim()) agents.add(e.originAgent.trim());
    for (const a of Array.isArray(e.convergence) ? e.convergence : []) {
      if (typeof a === 'string' && a.trim()) agents.add(a.trim());
    }
  }
  const kindCounts = new Map();
  for (const m of list) kindCounts.set(m.kind || 'fact', (kindCounts.get(m.kind || 'fact') || 0) + 1);
  let kind = 'fact';
  let bestN = -1;
  for (const [k, n] of [...kindCounts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    if (n > bestN) { kind = k; bestN = n; }
  }
  const lead = members[0] || {};
  return {
    id: null, // ad-hoc: not a stored candidate
    teamId: teamId || (list[0] && list[0].teamId) || 'default',
    kind,
    kinds: [...new Set(list.map((e) => e.kind || 'fact'))].sort(),
    canonicalId: lead.id || null,
    entryIds: members.map((m) => m.id),
    convergence: [...agents].sort(),
    convergenceCount: agents.size,
    lessonCount: members.length,
    text: lead.text || '',
    members,
    source,
    status: 'open',
    raisedAt: ts,
  };
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
  const aggregated = c.source === 'related' || c.source === 'manual';
  const framing = aggregated
    ? [
        'The team knowledge base holds several DISTINCT but RELATED lessons about one topic.',
        'Synthesise them into ONE coherent, reusable SKILL.md — organise, deduplicate and',
        'generalise; do not just list the statements verbatim.',
      ]
    : [
        'Several agents independently recorded the same durable lesson in the team knowledge base.',
        'Turn it into a concise, reusable SKILL.md.',
      ];
  const instruction = [
    'You curate reusable skills for a team of AI software-delivery agents.',
    ...framing,
    '',
    `Kind: ${c.kind || 'fact'}`,
    aggregated ? 'The recorded lessons:' : 'The recorded statements (deduplicate and generalise them):',
    facts,
    '',
    'Requirements for the SKILL.md you produce:',
    '- Start with a single H1 title line, then short sections.',
    '- Capture the durable, reusable knowledge — no PR/issue-specific or run-specific detail.',
    `- Practical and concise (roughly ${aggregated ? '120–300' : '80–200'} words).`,
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
// Extend an EXISTING skill from converged knowledge (issue #553)
// ---------------------------------------------------------------------------
//
// The promotion above always CREATES a new skill. Extending instead folds a
// converged cluster (or an operator's manual combine) into a skill that already
// lives in the target tier's pool: the SKILL.md is re-synthesised from the prior
// content + the new knowledge, and the provenance UNIONS the new entry ids onto
// the existing record (existing ids/origin preserved). Tier is symmetric to the
// promotion target — team skills for a team-tier extend, global for a global one
// — so the same two KB transitions apply; agent→team lifts stay create-only.

const EXTEND_TRANSITIONS = new Set(['team>team', 'team>global']);

// Validate an extend(from→to, into targetName) request. Same provenance +
// tier-transition contract as validatePromotion, but the skill name identifies an
// EXISTING skill (existence is checked in api.js against the pool) and skillMd is
// the re-synthesised document. Returns { ok, error?, from, to, targetName,
// entryIds, skillMd }.
function validateExtension(input) {
  const b = input && typeof input === 'object' ? input : {};
  const from = typeof b.from === 'string' ? b.from.trim() : '';
  const to = typeof b.to === 'string' ? b.to.trim() : '';
  if (!TIERS.includes(from)) return { ok: false, error: `from must be one of ${TIERS.join('|')}` };
  if (!TIERS.includes(to)) return { ok: false, error: `to must be one of ${TIERS.join('|')}` };
  if (!EXTEND_TRANSITIONS.has(`${from}>${to}`)) {
    return { ok: false, error: `unsupported extend ${from}→${to} (allowed: team→team, team→global)` };
  }
  const targetName = typeof b.targetName === 'string' ? b.targetName.trim() : '';
  if (!targetName || !SKILL_NAME_RE.test(targetName)) return { ok: false, error: 'invalid target skill name' };
  const entryIds = Array.isArray(b.entryIds)
    ? [...new Set(b.entryIds.filter((x) => typeof x === 'string' && /^[0-9a-f]{12}$/.test(x)))]
    : [];
  if (entryIds.length === 0) {
    return { ok: false, error: 'entryIds is required (provenance): an extension must trace to >=1 KB entry' };
  }
  const skillMd = typeof b.skillMd === 'string' ? b.skillMd : '';
  if (skillMd.trim() === '') return { ok: false, error: 'skillMd must be non-empty' };
  return { ok: true, from, to, targetName, entryIds, skillMd };
}

// Meta-prompt to RE-SYNTHESISE an existing SKILL.md together with new knowledge
// into one coherent document (AC5). Pure — api.js supplies model + transport.
// The prior content is authoritative and must be preserved (nothing dropped);
// the new lessons are merged, deduplicated and generalised into the whole.
function buildSkillExtensionRequest(existingSkillMd, candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const members = Array.isArray(c.members) ? c.members : [];
  const facts = members.map((m) => `- ${(m && m.text) || ''}`).join('\n') || `- ${c.text || ''}`;
  const prior = typeof existingSkillMd === 'string' ? existingSkillMd : '';
  const instruction = [
    'You curate reusable skills for a team of AI software-delivery agents.',
    'An existing skill document already captures durable team knowledge. New,',
    'independently-recorded lessons about the same area have converged and should',
    'be folded into it. Produce ONE coherent, updated SKILL.md that MERGES the new',
    'lessons into the existing document — reorganise, deduplicate and generalise as',
    'needed. Preserve all durable knowledge already in the existing document; never',
    'drop information just because it was not repeated in the new lessons.',
    '',
    'EXISTING SKILL.md (authoritative — keep its knowledge):',
    prior,
    '',
    `New lessons to fold in (kind: ${c.kind || 'fact'}):`,
    facts,
    '',
    'Requirements for the SKILL.md you produce:',
    '- Keep a single H1 title line, then short sections.',
    '- Integrate the new lessons; do not just append them as a separate list.',
    '- Capture durable, reusable knowledge — no PR/issue-specific or run-specific detail.',
    '- Do NOT invent tool names, repo names, file paths or credentials that were not stated.',
    '- Output ONLY the Markdown of the SKILL.md — no preamble, no surrounding code fences.',
  ].join('\n');
  return { max_tokens: 1024, messages: [{ role: 'user', content: instruction }] };
}

// Heuristic re-synthesis fallback (dependency-free, mirrors the create-path
// draft's role): keep the existing document verbatim and append the new, not-yet-
// present lessons under an "## Added knowledge" section. Deduplicates against the
// existing text (case-insensitive substring) so re-running is close to a no-op
// (E3/E5). Returns { skillMd, llmDrafted:false, added } — `added` is the count of
// genuinely new lines so the caller can reject an empty/no-op extend.
function buildHeuristicSkillExtension(existingSkillMd, candidate) {
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
    if (priorLc.includes(lc)) continue; // already covered by the existing doc (E3)
    statements.push(t);
  }
  if (statements.length === 0) {
    return { skillMd: prior, llmDrafted: false, added: 0 };
  }
  const lines = [prior, '', '## Added knowledge', ''];
  for (const s of statements) lines.push(`- ${s}`);
  lines.push('');
  return { skillMd: lines.join('\n'), llmDrafted: false, added: statements.length };
}

// Union the new provenance onto the existing record (AC6). Existing entryIds,
// originAgents, convergence and the original promotion metadata are preserved; the
// new entry ids/agents are merged in, and a dated extension entry (actor + which
// ids were added) is appended to `extensions[]`. Returns the merged provenance.
function extendSkillProvenance({ existingProv, from, to, teamId, entryIds, candidate, extendedBy, now } = {}) {
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
    extendedBy: typeof extendedBy === 'string' && extendedBy.trim() ? extendedBy.trim() : 'operator',
    extendedAt: ts,
  });

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
    lastExtendedBy: typeof extendedBy === 'string' && extendedBy.trim() ? extendedBy.trim() : 'operator',
  };
}

// Auto-match a converged candidate to an existing skill (AC4). Given the
// candidate and a list of eligible skills ({ name, tier, entryIds? }), return the
// best match or null. Signals, strongest first: (1) any overlap between the
// candidate's KB entry ids and a skill's provenance entryIds — a direct lineage
// hit; (2) token overlap between the candidate text and the skill name. A skill is
// only proposed when a signal actually fires — the default stays "create new".
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
    // Weight id-lineage far above name similarity so a shared entry always wins.
    const score = idOverlap * 100 + nameOverlap;
    if (score > bestScore) {
      bestScore = score;
      best = { name: s.name, tier: s.tier || null, score, idOverlap, nameOverlap };
    }
  }
  return bestScore > 0 ? best : null;
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
    kinds: Array.isArray(c.kinds) && c.kinds.length ? c.kinds : [c.kind].filter(Boolean),
    canonicalId: c.canonicalId,
    entryIds: Array.isArray(c.entryIds) ? c.entryIds : [],
    convergence: Array.isArray(c.convergence) ? c.convergence : [],
    convergenceCount: c.convergenceCount || (Array.isArray(c.convergence) ? c.convergence.length : 0),
    lessonCount: Number.isInteger(c.lessonCount) ? c.lessonCount : null,
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
  candidateFromEntries,
  buildSkillDraftRequest,
  validatePromotion,
  buildSkillProvenance,
  EXTEND_TRANSITIONS,
  validateExtension,
  buildSkillExtensionRequest,
  buildHeuristicSkillExtension,
  extendSkillProvenance,
  matchExistingSkill,
  SHARE_SOURCES,
  validateShareToTeam,
  buildShareProvenance,
  resolvePromotionGates,
  promotionSuggestionView,
};
