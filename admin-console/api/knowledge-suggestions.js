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

// Pure sibling (same service, no IO): the import-side frontmatter parser is the
// contract every promoted draft must satisfy (#921 — promoted ≡ imported).
const { parseSkillMeta } = require('./skill-import');

// ---------------------------------------------------------------------------
// SKILL.md frontmatter (#921) — every draft this module produces must carry a
// valid YAML frontmatter block with a non-empty `name` + one-line `description`,
// so a promoted skill passes the same skill-import.js validateSkillMd contract
// an imported archive does. These helpers MIRROR orchestrator/knowledge-curator.js
// (#805) rather than importing them: the two services never require each other's
// code (same discipline as the draft/provenance builders themselves).
// ---------------------------------------------------------------------------

const MAX_DESCRIPTION_LEN = 200; // keep the CLAUDE.md Skills list readable

// Collapse any whitespace run (incl. newlines) to a single space and trim.
function collapseLine(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// Truncate an already-collapsed line to one readable sentence-length line, cutting
// on a word boundary and appending an ellipsis.
function truncateLine(line, max = MAX_DESCRIPTION_LEN) {
  const s = String(line == null ? '' : line);
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  const head = sp > max * 0.6 ? cut.slice(0, sp) : cut;
  return `${head.replace(/[\s.,;:!?/–—-]+$/, '')}…`;
}

// Render one YAML scalar the fail-soft parseFrontmatterField reader accepts.
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
  const d = truncateLine(collapseLine(description)) || 'Team knowledge skill.';
  return ['---', `name: ${fmScalar(n)}`, `description: ${fmScalar(d)}`, '---'].join('\n');
}

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Guarantee `skillMd` begins with exactly one valid YAML frontmatter block that
 * carries a non-empty `name` and `description` (#921 AC1/AC2).
 *
 * - No block yet → prepend one built from the supplied fallback name/description.
 * - A block already present → inject only the MISSING key(s); a present, non-empty
 *   `name`/`description` is preserved verbatim (never overwrite a stronger
 *   authored value, and never double-wrap an already-frontmattered LLM body).
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
    const meta = parseSkillMeta(md);
    const inject = [];
    if (!meta.name) inject.push(`name: ${fmScalar(fName || 'team-skill')}`);
    if (!meta.description) inject.push(`description: ${fmScalar(fDesc || 'Team knowledge skill.')}`);
    if (inject.length === 0) return md; // already complete
    const newBody = inject.concat(body ? [body] : []).join('\n');
    return `---\n${newBody}\n---\n${rest}`;
  }
  return `${renderSkillFrontmatter({ name: fName, description: fDesc })}\n\n${md.replace(/^\n+/, '')}`;
}

// Derive a deterministic one-line "Use this when …" description from a candidate
// (#921 — the description is what auto-triggers the skill, so it must say when to
// load it, and it is always auto-filled: the dialog preview is the human
// checkpoint, never a TODO placeholder). No LLM, no secrets — only the lesson
// title + lesson count the KB already exposes.
function deriveSkillDescription(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const title = collapseLine(c.text) || 'this team knowledge';
  const topic = title.replace(/[.:;!?]+$/, '');
  const aggregated = c.source === 'related' || c.source === 'manual';
  const n = c.lessonCount || (Array.isArray(c.members) ? c.members.length : 0) || 1;
  if (aggregated && n > 1) {
    return truncateLine(collapseLine(
      `Use this when a task touches the topic of these ${n} related team lessons: ${topic}.`,
    ));
  }
  return truncateLine(collapseLine(
    `Use this when a task involves ${topic} — team-recorded guidance worth applying.`,
  ));
}

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
const KIND_HEADINGS = { fact: 'Facts', convention: 'Conventions', entity: 'Entities' };
function buildHeuristicSkillDraft(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  // #2592: a domain card drafts THE domain's skill — named after the domain, never
  // after the card's "Create skill X — N pending lessons" line.
  const domainTarget = domainCardTarget(c);
  const name = domainTarget || slugifySkillName(c.text, c.kind);
  const title = (domainTarget ? (c.domainName || domainTarget) : (c.text || 'Team knowledge')).trim();
  const members = Array.isArray(c.members) ? c.members : [];
  const convergence = Array.isArray(c.convergence) ? c.convergence : [];
  const aggregated = c.source === 'related' || c.source === 'manual' || !!domainTarget;

  // Deduplicate statements, remembering each one's kind so an aggregated draft
  // can be lightly grouped (the best a dependency-free, no-LLM path can do —
  // true theme/pattern detection is LLM-only; see issue #686 Q1).
  const statements = [];
  const seen = new Set();
  for (const m of members) {
    const t = (m && typeof m.text === 'string' ? m.text.trim() : '');
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      statements.push({ text: t, kind: (m && m.kind) || c.kind || 'fact' });
    }
  }
  if (statements.length === 0 && c.text) statements.push({ text: String(c.text).trim(), kind: c.kind || 'fact' });

  const distinctKinds = [...new Set(statements.map((s) => s.kind))];
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  // An aggregated draft is an UN-SYNTHESISED starting point: the statements are
  // grouped, not woven into themes. Say so, so the operator (or "Draft with AI")
  // knows to synthesise it.
  if (aggregated && statements.length > 1) {
    lines.push(
      `*Un-synthesised draft — ${statements.length} related lesson(s) grouped below. ` +
      'Use "Draft with AI" to synthesise them into pattern-based thematic sections.*',
    );
    lines.push('');
  }
  lines.push('## What');
  lines.push('');
  if (aggregated && distinctKinds.length > 1) {
    // Light grouping by kind (proportional: only when the set actually spans
    // more than one kind — a single-kind or tiny set stays a flat list, AC8).
    for (const k of distinctKinds) {
      lines.push(`### ${KIND_HEADINGS[k] || k}`);
      lines.push('');
      for (const s of statements) if (s.kind === k) lines.push(`- ${s.text}`);
      lines.push('');
    }
  } else {
    for (const s of statements) lines.push(`- ${s.text}`);
    lines.push('');
  }
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

  // #921: prepend YAML frontmatter (name + "Use this when …" description) so the
  // promoted skill satisfies the same skill-import.js contract an imported one does.
  const description = deriveSkillDescription(c);
  const skillMd = ensureSkillFrontmatter(lines.join('\n'), { name, description });
  return { name, description, skillMd, llmDrafted: false };
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
      kind: e.kind || 'fact',
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
// LLM draft request (reuses api.js resolveAssistTarget + httpPostJson)
// ---------------------------------------------------------------------------

// Output budget for an aggregated draft SCALES with the number of combined
// lessons (issue #686): a 100+-lesson combine must be able to render several
// thematic sections without being truncated mid-document, while a 2–3-lesson
// combine must not be padded into many near-empty sections. Discrete tiers
// (issue Q3 — simplest to reason about) drive both the target word range and
// `max_tokens`. The non-aggregated single-lesson draft keeps the original small
// budget.
function draftBudget(lessonCount, aggregated) {
  if (!aggregated) return { wordRange: '80–200', maxTokens: 1024, sections: 'short sections' };
  const n = Math.max(1, Number(lessonCount) || 1);
  if (n <= 3) return { wordRange: '120–250', maxTokens: 1024, sections: 'a single coherent section, or at most two short ones — do NOT pad a small set into many near-empty sections' };
  if (n <= 10) return { wordRange: '250–550', maxTokens: 1536, sections: 'a few (about 2–4) thematic sections' };
  if (n <= 30) return { wordRange: '450–950', maxTokens: 3072, sections: 'a handful (about 3–6) thematic sections' };
  if (n <= 60) return { wordRange: '700–1500', maxTokens: 4096, sections: 'about 4–7 thematic sections' };
  return { wordRange: '1100–2400', maxTokens: 6144, sections: 'about 5–8 thematic sections' };
}

// Meta-prompt: turn a converged cluster into a clean, reusable SKILL.md. Pure —
// api.js supplies the model + transport, exactly like buildAgentPromptGenerationRequest.
// For an AGGREGATED combine the prompt drives a pattern-based, categorised
// synthesis (thematic H2 sections, overarching patterns written up explicitly)
// rather than a flat verbatim list, and the budget scales with lesson count.
function buildSkillDraftRequest(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const members = Array.isArray(c.members) ? c.members : [];
  const facts = members.map((m) => `- ${(m && m.text) || ''}`).join('\n') || `- ${c.text || ''}`;
  const aggregated = c.source === 'related' || c.source === 'manual';
  const lessonCount = c.lessonCount || members.length || 1;
  const budget = draftBudget(lessonCount, aggregated);
  const kinds = Array.isArray(c.kinds) && c.kinds.length ? c.kinds.join(', ') : (c.kind || 'fact');
  // #921: the draft must open with the same frontmatter contract skill-import.js
  // validates — name is fixed (the heuristic slug), the description is the model's
  // to write in the auto-trigger "Use this when …" style.
  const frontmatterInstruction = [
    '- Start the document with EXACTLY this YAML frontmatter block, then the content. Keep the',
    '  `name` line verbatim; replace the description placeholder with ONE line in the style',
    '  "Use this when …" that tells an agent when to load this skill:',
    '  ---',
    `  name: ${slugifySkillName(c.text, c.kind)}`,
    '  description: >-',
    '    Use this when <complete this sentence>.',
    '  ---',
  ].join('\n');

  const instruction = aggregated
    ? [
        'You curate reusable skills for a team of AI software-delivery agents.',
        `The team knowledge base holds ${lessonCount} DISTINCT but RELATED lessons about one topic.`,
        'Synthesise them into ONE coherent, reusable SKILL.md that reads as documentation ABOUT a',
        'topic — NOT a flat bullet dump of the individual statements.',
        '',
        `Kinds present: ${kinds}`,
        'The recorded lessons:',
        facts,
        '',
        'How to synthesise:',
        '- Identify the overarching patterns/themes running across these lessons and write those patterns up EXPLICITLY.',
        `- Organise the document into ${budget.sections}, each a "## " H2 sub-heading; sort every lesson under the theme it belongs to. Group by THEME, not by kind (fact/convention/entity).`,
        '- Fold the individual lessons under the relevant section; generalise and deduplicate related lessons into the pattern rather than restating each one.',
        '- Do NOT output one long verbatim or near-verbatim enumeration of the input statements.',
        '- PRESERVE the substance: every distinct fact must remain represented somewhere (generalised into a pattern where appropriate) — do not silently drop knowledge.',
        '',
        'Requirements for the SKILL.md you produce:',
        frontmatterInstruction,
        '- After the frontmatter, a single H1 title line, then the thematic H2 sections described above.',
        '- Capture the durable, reusable knowledge — no PR/issue-specific or run-specific detail.',
        `- Practical and readable (roughly ${budget.wordRange} words) — scale the depth to the material, do not pad.`,
        '- Do NOT invent tool names, repo names, file paths or credentials that were not stated.',
        '- Output ONLY the Markdown of the SKILL.md — no preamble, no surrounding code fences.',
      ].join('\n')
    : [
        'You curate reusable skills for a team of AI software-delivery agents.',
        'Several agents independently recorded the same durable lesson in the team knowledge base.',
        'Turn it into a concise, reusable SKILL.md.',
        '',
        `Kind: ${c.kind || 'fact'}`,
        'The recorded statements (deduplicate and generalise them):',
        facts,
        '',
        'Requirements for the SKILL.md you produce:',
        frontmatterInstruction,
        '- After the frontmatter, a single H1 title line, then short sections.',
        '- Capture the durable, reusable knowledge — no PR/issue-specific or run-specific detail.',
        `- Practical and concise (roughly ${budget.wordRange} words).`,
        '- Do NOT invent tool names, repo names, file paths or credentials that were not stated.',
        '- Output ONLY the Markdown of the SKILL.md — no preamble, no surrounding code fences.',
      ].join('\n');
  return { max_tokens: budget.maxTokens, messages: [{ role: 'user', content: instruction }] };
}

// ---------------------------------------------------------------------------
// Human-readable entry summary (overview table — #635)
// ---------------------------------------------------------------------------

// Deterministic, dependency-free fallback summary derived from the entry's
// agent-facing `text` alone — used when no LLM target exists or the call fails,
// so a row is NEVER blank (AC4, mirrors buildHeuristicSkillDraft's never-throw
// posture). Collapses whitespace and trims to a sentence-ish length; never throws.
function buildHeuristicSummary(text, { maxLen = 200 } = {}) {
  let s = '';
  try {
    s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  } catch {
    s = '';
  }
  if (s === '') return '';
  if (s.length <= maxLen) return s;
  // Cut at the last word boundary before the cap so we don't slice mid-word.
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// Meta-prompt: turn one KB entry's agent-facing `text` into a 1–2 sentence,
// plain-language summary for a human reading the overview table. Pure — api.js
// supplies the model + transport, exactly like buildSkillDraftRequest. The
// summary is DISTINCT from `text` (no jargon-dense restatement) and never
// invents facts not present in `text`.
function buildSummaryRequest(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const text = typeof e.text === 'string' ? e.text.trim() : '';
  const instruction = [
    'You help a human skim a team knowledge base.',
    'Rewrite the following recorded lesson as a short, plain-language summary a',
    'non-expert teammate can understand at a glance.',
    '',
    `Kind: ${e.kind || 'fact'}`,
    'The recorded lesson:',
    text,
    '',
    'Requirements for the summary you produce:',
    '- 1 to 2 plain sentences, no markdown, no code fences, no preamble.',
    '- Convey the gist in human terms; do not just repeat the technical wording.',
    '- Do NOT invent tool names, repo names, file paths or facts not stated above.',
    '- Output ONLY the summary sentence(s).',
  ].join('\n');
  return { max_tokens: 256, messages: [{ role: 'user', content: instruction }] };
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
  // #921: promoted ≡ imported — a body without parseable `name`+`description`
  // frontmatter can't round-trip through skill-import.js. Warning only, never a
  // rejection: existing promoted skills lack frontmatter, and a hard gate would
  // break re-promotion/extension of legacy content.
  const meta = parseSkillMeta(skillMd);
  const warnings = meta.name && meta.description ? [] : ['missing-frontmatter'];
  return { ok: true, from, to, name, entryIds, skillMd, warnings };
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

// ---------------------------------------------------------------------------
// Merge N existing skills into one (#631, concept §3.4)
// ---------------------------------------------------------------------------
//
// Promotion/extension fold KB knowledge into a skill. Merge is different: it
// synthesises N EXISTING SKILL.md documents (near-duplicate skills the operator
// wants to consolidate) into ONE combined document. The pure planner
// (skill-merge.js) validates the request + computes the grant/file/provenance
// plans; these two helpers produce the draft SKILL.md the operator then edits,
// mirroring the create-path draft's LLM-with-heuristic-fallback shape.

// Meta-prompt: synthesise several existing skill documents into one coherent
// SKILL.md. Pure — api.js supplies the model + transport. `sources` is
// [{ name, tier?, skillMd }]. All source knowledge must be preserved; the
// combined document reorganises, deduplicates and generalises across them.
function buildSkillMergeRequest(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const docs = list
    .map((s, i) => {
      const name = (s && s.name) || `source-${i + 1}`;
      const md = typeof (s && s.skillMd) === 'string' ? s.skillMd.trim() : '';
      return `--- SOURCE SKILL "${name}" ---\n${md}`;
    })
    .join('\n\n');
  const instruction = [
    'You curate reusable skills for a team of AI software-delivery agents.',
    `The team has ${list.length} overlapping skill documents about the same area.`,
    'Merge them into ONE coherent, reusable SKILL.md — reorganise, deduplicate and',
    'generalise across the sources. Preserve all durable knowledge from every',
    'source; never drop information just because another source did not repeat it.',
    '',
    'The source skill documents:',
    docs,
    '',
    'Requirements for the SKILL.md you produce:',
    '- Start with a single H1 title line, then short sections.',
    '- Integrate the sources; do not just concatenate them under separate headings.',
    '- Capture durable, reusable knowledge — no PR/issue-specific or run-specific detail.',
    '- Do NOT invent tool names, repo names, file paths or credentials that were not stated.',
    '- Output ONLY the Markdown of the SKILL.md — no preamble, no surrounding code fences.',
  ].join('\n');
  return { max_tokens: 1536, messages: [{ role: 'user', content: instruction }] };
}

// Deterministic concat fallback (AC4 — draft degrades gracefully without a model
// provider). Keeps every source document verbatim under its own H2 so nothing is
// lost, prefixed with a note that the operator should consolidate them. Mirrors
// buildHeuristicSkillDraft's never-throw posture. `sources` is
// [{ name, tier?, skillMd }]; `targetName` titles the combined document.
function buildHeuristicSkillMerge(sources, { targetName } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const title = (typeof targetName === 'string' && targetName.trim()) || 'Merged skill';
  const names = list.map((s) => (s && s.name) || '?');
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(
    `This skill was merged from ${list.length} source skill(s): ` +
    `${names.join(', ')}. Each source's content is preserved below — review and ` +
    'consolidate the sections into one coherent document.',
  );
  lines.push('');
  for (const s of list) {
    const name = (s && s.name) || '?';
    const md = typeof (s && s.skillMd) === 'string' ? s.skillMd.trim() : '';
    lines.push(`## From: ${name}`);
    lines.push('');
    if (md) lines.push(md);
    lines.push('');
  }
  return { name: title, skillMd: lines.join('\n').replace(/\s+$/, '') + '\n', llmDrafted: false };
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
// Auto-resync gate default (#629 AC5) — MIRRORS knowledge-store.DEFAULT_SKILL_RESYNC_MODE.
const DEFAULT_SKILL_RESYNC_MODE = 'review';
// Decay-sweep horizon default (#919) — MIRRORS knowledge-store.DEFAULT_DECAY_HORIZON_DAYS.
const DEFAULT_DECAY_HORIZON_DAYS = 60;

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

// Resolve the per-team skill auto-resync gate (#629 AC5) — MIRRORS
// knowledge-store.resolveSkillResyncMode. Fail-safe: an invalid/absent mode
// falls back to the conservative `review` default (edit flips copies to
// `outdated` and waits for a human), so existing teams are unchanged.
function resolveSkillResyncMode(env) {
  const raw = env && typeof env.skillResyncMode === 'string' ? env.skillResyncMode : null;
  return GATE_MODES.includes(raw) ? raw : DEFAULT_SKILL_RESYNC_MODE;
}

// Resolve the per-team decay horizon (#919) — MIRRORS
// knowledge-store.resolveDecayHorizonDays (the orchestrator's copy drives the
// sweep; this one only DISPLAYS the setting). 0 = off; invalid/absent → 60.
function resolveDecayHorizonDays(env) {
  const raw = env && env.decayHorizonDays;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_DECAY_HORIZON_DAYS;
  return n;
}

// #2592 (AC12): the first-skill threshold of the domain → skill pipeline — a
// domain's FIRST skill needs >= minLessons converged lessons from >= minAgents
// distinct agents. Mirror of the orchestrator's knowledge-store
// normalizeDomainSkillThreshold (+ the team override winning over the global knob).
const DEFAULT_DOMAIN_SKILL_THRESHOLD = Object.freeze({ minLessons: 3, minAgents: 2 });
function resolveDomainSkillThreshold(env) {
  const e = env && typeof env === 'object' ? env : {};
  const raw = (e.domainSkillThreshold && typeof e.domainSkillThreshold === 'object')
    ? e.domainSkillThreshold
    : ((e.knowledgeCuration && e.knowledgeCuration.domainSkillThreshold) || {});
  const lessons = Number(raw.minLessons);
  const agents = Number(raw.minAgents);
  return {
    minLessons: Number.isInteger(lessons) && lessons >= 1 && lessons <= 100 ? lessons : DEFAULT_DOMAIN_SKILL_THRESHOLD.minLessons,
    minAgents: Number.isInteger(agents) && agents >= 1 && agents <= 50 ? agents : DEFAULT_DOMAIN_SKILL_THRESHOLD.minAgents,
  };
}

// ---------------------------------------------------------------------------
// Per-team knowledge config overlay (#570)
// ---------------------------------------------------------------------------

// The four knowledge-config groups keyed PER TEAM (#570) instead of on the
// shared environment. Mirror of the orchestrator's knowledge-store.TEAM_KNOWLEDGE_KEYS
// (the two runtimes never cross-require, so the list is duplicated verbatim).
const TEAM_KNOWLEDGE_KEYS = ['knowledgeAutonomy', 'knowledgeReview', 'knowledgePromotionGates', 'knowledgeStore', 'skillResyncMode', 'decayHorizonDays', 'domainSkillThreshold'];

// Overlay a team's persisted knowledge-config overrides onto a base environment,
// producing the env-shaped object the pure readers (teamAutonomyLevel /
// knowledgeReviewOn / resolvePromotionGates / knowledgeStoreView) consume. A team
// with no override for a key falls back to the env's value, so a read immediately
// after the #570 upgrade is byte-identical to before (AC-2). Returns the base env
// unchanged (same reference) when there are no overrides, and never mutates it.
function mergeTeamKnowledgeConfig(baseEnv, overrides) {
  const ov = overrides && typeof overrides === 'object' ? overrides : {};
  const hasOverride = TEAM_KNOWLEDGE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(ov, k));
  if (!hasOverride) return baseEnv;
  const merged = baseEnv && typeof baseEnv === 'object' ? { ...baseEnv } : {};
  for (const k of TEAM_KNOWLEDGE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(ov, k)) merged[k] = ov[k];
  }
  return merged;
}

// Normalize the wizard's knowledge-*learning* config (autonomy / review / gates,
// #567) into a minimal per-team override patch keyed like TEAM_KNOWLEDGE_KEYS.
// Storage is out of scope here — the wizard never touches knowledgeStore.
//
// The patch carries ONLY keys that differ from the brand-new-team defaults, and
// the function returns `null` when nothing differs. That is what makes AC-4 hold:
// a wizard run left on the defaults writes no override file at all, so the team
// reads byte-identically to a team created before #567 existed.
function normalizeWizardKnowledgeConfig(input) {
  const src = input && typeof input === 'object' ? input : {};

  let autonomy = Number(src.autonomy);
  if (!Number.isInteger(autonomy)) autonomy = 1;
  autonomy = Math.max(0, Math.min(3, autonomy));

  const review = src.review === true || src.review === 'true' || src.review === '1';

  const rawGates = src.gates && typeof src.gates === 'object' ? src.gates : {};
  const gates = {};
  for (const t of PROMOTION_TRANSITIONS) {
    const m = rawGates[t];
    gates[t] = GATE_MODES.includes(m) ? m : DEFAULT_PROMOTION_GATES[t];
  }
  gates['team>global'] = 'review'; // always reviewed — can't be automated

  const patch = {};
  if (autonomy !== 1) patch.knowledgeAutonomy = autonomy;
  if (review !== false) patch.knowledgeReview = true;
  const gatesDiffer = PROMOTION_TRANSITIONS.some((t) => gates[t] !== DEFAULT_PROMOTION_GATES[t]);
  if (gatesDiffer) patch.knowledgePromotionGates = gates;

  return Object.keys(patch).length ? patch : null;
}

// ---------------------------------------------------------------------------
// View assembly (candidate + draft → the /promotion-suggestions row the UI gets)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Domain → skill cards (#2592)
// ---------------------------------------------------------------------------

// The orchestrator raises at most ONE open card per domain (source 'domain-skill',
// id `ds-<domainId>`). Mirror of orchestrator/knowledge-domain-skills.js
// DOMAIN_CARD_SOURCE (the two runtimes never cross-require).
const DOMAIN_CARD_SOURCE = 'domain-skill';

function isDomainCard(c) {
  return !!c && typeof c === 'object' && c.source === DOMAIN_CARD_SOURCE;
}

// The skill a domain card must land in (the domain skill's name), or null when the
// row is not a domain card / carries no usable name. Accepting a domain card may
// only create or extend THIS skill — never a lesson-named one.
function domainCardTarget(c) {
  if (!isDomainCard(c)) return null;
  const name = typeof c.domainSkill === 'string' ? c.domainSkill.trim() : '';
  return name && SKILL_NAME_RE.test(name) ? name : null;
}

/**
 * Guard an operator's accept of a domain card (#2592, AC3/AC5): the write must go
 * to the team-tier domain skill — create it when missing, extend it when present —
 * and nowhere else. Non-domain rows pass through unchecked.
 *
 * @param {object|null} card   the stored suggestion row (or null)
 * @param {{ name?: string, to?: string }} target  the requested skill name + tier
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function checkDomainCardTarget(card, { name, to } = {}) {
  if (!isDomainCard(card)) return { ok: true };
  const want = domainCardTarget(card);
  if (!want) return { ok: false, error: 'domain card has no domain skill' };
  if (to !== 'team') return { ok: false, error: 'a domain card promotes into the team-tier domain skill' };
  if (name !== want) return { ok: false, error: `a domain card may only create or extend the domain skill '${want}'` };
  return { ok: true };
}

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
    // #918: at least one member of this cluster was linked by embedding cosine
    // alone (not word overlap) — the card shows a sanity-check hint.
    ...(c.semanticMatch ? { semanticMatch: true } : {}),
    // #2592: domain routing. Every routed card names its domain; a domain card
    // also names the domain skill it creates/extends and the lessons it bundles.
    domainId: typeof c.domainId === 'string' && c.domainId ? c.domainId : null,
    domainName: typeof c.domainName === 'string' && c.domainName ? c.domainName : null,
    domainSkill: domainCardTarget(c),
    ...(isDomainCard(c) ? {
      mode: c.mode === 'extend' ? 'extend' : 'create',
      lessonIds: Array.isArray(c.lessonIds) ? c.lessonIds : [],
      routedVia: typeof c.routedVia === 'string' ? c.routedVia : null,
    } : {}),
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
  DEFAULT_SKILL_RESYNC_MODE,
  slugifySkillName,
  ensureSkillFrontmatter,
  deriveSkillDescription,
  buildHeuristicSkillDraft,
  candidateFromEntries,
  buildSkillDraftRequest,
  buildHeuristicSummary,
  buildSummaryRequest,
  validatePromotion,
  buildSkillProvenance,
  EXTEND_TRANSITIONS,
  validateExtension,
  buildSkillExtensionRequest,
  buildHeuristicSkillExtension,
  extendSkillProvenance,
  buildSkillMergeRequest,
  buildHeuristicSkillMerge,
  matchExistingSkill,
  SHARE_SOURCES,
  validateShareToTeam,
  buildShareProvenance,
  resolvePromotionGates,
  resolveSkillResyncMode,
  resolveDecayHorizonDays,
  resolveDomainSkillThreshold,
  DEFAULT_DOMAIN_SKILL_THRESHOLD,
  DEFAULT_DECAY_HORIZON_DAYS,
  promotionSuggestionView,
  DOMAIN_CARD_SOURCE,
  isDomainCard,
  domainCardTarget,
  checkDomainCardTarget,
  TEAM_KNOWLEDGE_KEYS,
  mergeTeamKnowledgeConfig,
  normalizeWizardKnowledgeConfig,
};
