'use strict';

// Skill distillation pass (skill-aggregation Phase 3, #781, §3.4).
//
// Phases 1–2 grow a skill by AMENDMENTS: the heuristic extend appends verbatim
// under "## Added knowledge"; the LLM extend folds a couple of lessons into the
// document. Neither ever RE-STRUCTURES the whole skill, so repeated amendments
// duplicate, contradict and bloat. A distillation pass re-synthesises the ENTIRE
// skill from its current content + provenance — dedupe, restructure, re-abstract,
// enforce the size budget — while preserving every evidence link.
//
// Deliberately PURE — no fs, no network, an injected `now` — so it is unit-testable
// without booting the orchestrator (repo convention: test pure cores only). The IO
// (reading the skill dir, running the LLM through the `_synthesizeSkillMd` seam,
// writing SKILL.md, stamping the manifest, appending the feed event) lives in
// orchestrator.js.
//
// Two hard rules from the concept:
//   §3.4 / AC2 — NO heuristic fallback for distillation. A bad refactor is worse
//                than none, so on LLM failure the skill is left BYTE-IDENTICAL.
//   AC1        — provenance entryIds are IDENTICAL before/after. A distillation
//                re-shapes the prose, never drops evidence, so it preserves the
//                entryIds verbatim.

const { PLAYBOOK_SECTIONS } = require('./knowledge-curator');

// Default X: distil after this many amendments since the last distillation.
const DEFAULT_DISTILL_AFTER_AMENDMENTS = 5;

// ---------------------------------------------------------------------------
// Amendment accounting (lives on the skill's provenance.json)
// ---------------------------------------------------------------------------
//
//   amendmentsSinceDistillation : int (default 0) — bumped on every amendment/extend
//   distillations[]             : history — one entry per applied distillation
//   lastDistilledAt / lastDistilledBy
//
// noteAmendment increments the counter (called by the extend path); applyDistillation
// resets it to 0. Reading a legacy provenance with no counter treats it as 0.

function amendmentsSince(provenance) {
  const p = provenance && typeof provenance === 'object' ? provenance : {};
  const n = Number(p.amendmentsSinceDistillation);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

// Immutably bump the amendment counter on a provenance record. Pure — returns a new
// object, never mutates the input.
function noteAmendment(provenance, { count = 1 } = {}) {
  const p = provenance && typeof provenance === 'object' ? { ...provenance } : {};
  const inc = Number.isInteger(count) && count > 0 ? count : 1;
  p.amendmentsSinceDistillation = amendmentsSince(p) + inc;
  return p;
}

// True when the counter reached the configured threshold (X amendments).
function shouldDistill(provenance, { threshold = DEFAULT_DISTILL_AFTER_AMENDMENTS } = {}) {
  const t = Number.isInteger(threshold) && threshold >= 1 ? threshold : DEFAULT_DISTILL_AFTER_AMENDMENTS;
  return amendmentsSince(provenance) >= t;
}

// ---------------------------------------------------------------------------
// Apply-vs-review gating (§3.4 — reviewed diff)
// ---------------------------------------------------------------------------

// A due distillation may APPLY directly only at autonomy 3 with the team>team gate
// on `auto`; otherwise it lands as a REVIEW card showing old vs. new. Pure — mirrors
// the auto-promotion gate resolution. Creating a new domain is never auto (that is a
// taxonomy decision); a distillation of an existing skill is not a taxonomy change,
// so the auto path is permitted here under the same gate as auto-promotion.
function distillationMode(gates, { autonomyLevel } = {}) {
  const g = gates && typeof gates === 'object' ? gates : {};
  const level = Number(autonomyLevel);
  const auto = Number.isFinite(level) && level >= 3 && g['team>team'] === 'auto';
  return auto ? 'auto' : 'review';
}

// ---------------------------------------------------------------------------
// LLM request (whole-skill re-synthesis)
// ---------------------------------------------------------------------------

// Meta-prompt re-synthesising the WHOLE skill from its current content + provenance.
// Same transport shape as buildSkillSynthesisRequest ({ max_tokens, messages }); the
// caller supplies the model + transport.
function buildDistillationRequest(skillMd, provenance, { domain, sizeBudgetChars = 8000 } = {}) {
  const prior = typeof skillMd === 'string' ? skillMd : '';
  const p = provenance && typeof provenance === 'object' ? provenance : {};
  const title = domain && domain.name ? domain.name : '';
  const entryCount = Array.isArray(p.entryIds) ? p.entryIds.length : 0;
  const convergence = Array.isArray(p.convergence) ? p.convergence.filter(Boolean).join(', ') : '';
  const budget = Number.isInteger(sizeBudgetChars) && sizeBudgetChars >= 1000 ? sizeBudgetChars : 8000;
  const instruction = [
    'You maintain a reusable DOMAIN PLAYBOOK (SKILL.md) for a team of AI software-delivery agents.',
    'The playbook below has grown by repeated amendments and needs a DISTILLATION pass:',
    're-synthesise the WHOLE document from scratch — dedupe, restructure, re-abstract —',
    'so it reads as one coherent playbook rather than an accreted list.',
    title ? `Domain: ${title}` : '',
    'The current playbook:',
    '---',
    prior,
    '---',
    `It distils ${entryCount} recorded lesson(s)${convergence ? ` (contributors: ${convergence})` : ''}.`,
    '',
    'Requirements:',
    `- Keep the sectioned playbook shape (${PLAYBOOK_SECTIONS.join(' / ')}); drop an empty section rather than padding it.`,
    '- Merge duplicated or contradictory guidance into a single clear rule; prefer the most specific correct form.',
    '- Generalise beyond individual incidents; keep concrete snippets but mark them as examples of the abstract rule.',
    '- NEVER drop evidence: every distinct lesson currently represented must remain represented somewhere.',
    '- Do NOT invent tool names, repo names, file paths or credentials that were not already present.',
    `- Keep the result under about ${budget} characters.`,
    '- Output ONLY the Markdown of the full distilled SKILL.md — no preamble, no code fences.',
  ].filter((l) => l !== '').join('\n');
  return { max_tokens: 4096, messages: [{ role: 'user', content: instruction }] };
}

// ---------------------------------------------------------------------------
// Apply the distillation result (pure resolver)
// ---------------------------------------------------------------------------

// A usable distillation is non-trivial Markdown with at least a heading (same gate as
// synthesisFallback). Unlike synthesisFallback there is NO heuristic fallback: an
// unusable result leaves the skill byte-identical.
function _usable(text) {
  return typeof text === 'string' && text.trim().length >= 40 && /(^|\n)#\s/.test(`\n${text.trim()}`);
}

/**
 * Resolve a distillation. The caller runs the LLM and passes the result in via
 * `llmText`. Pure.
 *
 * @param {{ skillMd:string, provenance:object, llmText?:string|null, by?:string, now?:string }} args
 * @returns {{ changed:boolean, skillMd:string, provenance:object, reason:string }}
 *   changed:false + byte-identical skillMd/provenance on LLM failure (reason 'llm-failed').
 *   changed:false but counter reset when the LLM returns the identical document
 *     (reason 'identical' — it WAS reviewed, so the amendment counter is cleared).
 *   changed:true with the new skillMd, the provenance entryIds PRESERVED VERBATIM,
 *     the counter reset to 0 and a distillations[] history entry (reason 'distilled').
 */
function applyDistillation({ skillMd, provenance, llmText, by = 'curator', now } = {}) {
  const prior = typeof skillMd === 'string' ? skillMd : '';
  const prev = provenance && typeof provenance === 'object' ? provenance : {};
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString();
  if (!_usable(llmText)) {
    // §3.4 / AC2: no heuristic fallback — leave the skill untouched.
    return { changed: false, skillMd: prior, provenance: prev, reason: 'llm-failed' };
  }
  const text = String(llmText).trim();
  if (text === prior.trim()) {
    // A no-op distillation: reset the counter (the doc was reviewed and found good)
    // but do not rewrite the file / bump the version.
    return {
      changed: false,
      skillMd: prior,
      provenance: { ...prev, amendmentsSinceDistillation: 0, lastDistilledAt: ts },
      reason: 'identical',
    };
  }
  const entryIds = Array.isArray(prev.entryIds) ? prev.entryIds.slice() : []; // AC1: verbatim
  const distillations = Array.isArray(prev.distillations) ? prev.distillations.slice() : [];
  distillations.push({ at: ts, by, entryCount: entryIds.length });
  const next = {
    ...prev,
    entryIds,
    amendmentsSinceDistillation: 0,
    distillations,
    lastDistilledAt: ts,
    lastDistilledBy: by,
  };
  return { changed: true, skillMd: text, provenance: next, reason: 'distilled' };
}

// ---------------------------------------------------------------------------
// Feed event
// ---------------------------------------------------------------------------

// One `distillation` feed event (transparency). `applied` = the SKILL.md was rewritten
// (version bump); `review` = a diff card was raised for an operator. `auto` marks the
// autonomy-3 direct-apply path.
function buildDistillationEvent({ teamId, skill, mode, auto, entryCount, reason, ts } = {}) {
  return {
    type: 'distillation',
    ts: typeof ts === 'string' && ts.trim() ? ts.trim() : new Date().toISOString(),
    teamId: typeof teamId === 'string' ? teamId : null,
    skill: skill && typeof skill === 'object' ? { name: skill.name || null, tier: skill.tier || null } : null,
    mode: mode === 'review' ? 'review' : 'applied',
    auto: !!auto,
    entryCount: Number.isInteger(entryCount) && entryCount >= 0 ? entryCount : null,
    reason: typeof reason === 'string' ? reason : null,
  };
}

module.exports = {
  DEFAULT_DISTILL_AFTER_AMENDMENTS,
  amendmentsSince,
  noteAmendment,
  shouldDistill,
  distillationMode,
  buildDistillationRequest,
  applyDistillation,
  buildDistillationEvent,
};
