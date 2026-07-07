'use strict';

// ─── Port suggestion for custom roles (#423) ─────────────────────────────────
//
// A user-defined role enters the composer with just a name + free-text notes.
// To wire it, the Flow-Weaver (#421) needs the catalog-v2 surface (#420):
// patternRole, sessionPolicy and the produce flags. This module supplies a
// *suggestion* for those — one stateless LLM call when a generation target is
// available, with a deterministic keyword heuristic as offline fallback.
// Suggestions are NEVER silently applied: the dialog shows them as editable
// fields the user confirms (same philosophy as the #328 emit-suggestions).

const { PATTERN_ROLES } = require('./catalog-ports');

const KEYWORDS = {
  companion: ['review', 'reviewer', 'audit', 'auditor', 'quality', 'qa', 'approve', 'approval', 'gate', 'feedback', 'escalation', 'verify', 'verifier', 'inspect'],
  scout: ['scout', 'research', 'gather', 'evidence', 'investigate', 'readiness', 'gap', 'prepare', 'preparation', 'discovery', 'explore'],
  intake: ['triage', 'intake', 'analyst', 'requirement', 'requirements', 'refine', 'backlog', 'product owner', 'po '],
  author: ['implement', 'develop', 'developer', 'engineer', 'code', 'coder', 'build', 'builder', 'write', 'writer', 'author', 'design', 'designer', 'create', 'fix', 'migrate', 'migration', 'convert', 'translator'],
};

// Tie-break priority: a "Code Reviewer" hits both `code` (author) and
// `review` (companion) — the reviewing nature wins over the medium.
const PRIORITY = ['companion', 'scout', 'intake', 'author'];

function classifyPatternRole(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const scores = {};
  for (const [role, words] of Object.entries(KEYWORDS)) {
    scores[role] = words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
  }
  const best = Math.max(...Object.values(scores));
  if (best === 0) return 'standalone';
  return PRIORITY.find(r => scores[r] === best);
}

// The consume ports implied by a pattern role — kept server-side so the LLM
// only has to pick the role, not reproduce the slot vocabulary.
function portsForPatternRole(patternRole, produces) {
  const consumes = patternRole === 'companion'
    ? [{ artifact: 'pr', fromSlot: 'stage-author' }]
    : patternRole === 'scout'
      ? [{ artifact: 'issue', fromSlot: 'stage-entry' }]
      : [];
  return {
    consumes,
    produces: { pr: !!(produces && produces.pr), issue: !!(produces && produces.issue) },
  };
}

/**
 * Deterministic offline suggestion from role name + notes.
 * @returns {{ patternRole, sessionPolicy, ports: { consumes, produces } }}
 */
function heuristicPortSuggestion({ roleName, notes }) {
  const patternRole = classifyPatternRole(`${roleName || ''} ${notes || ''}`);
  const produces = {
    pr: patternRole === 'author',
    issue: patternRole === 'intake',
  };
  return {
    patternRole,
    // Intake roles talk to humans (persistent chat); companions keep stage
    // context across reviews; reactive workers start fresh per invocation.
    sessionPolicy: patternRole === 'intake' || patternRole === 'companion' ? 'persistent' : 'per-invocation',
    ports: portsForPatternRole(patternRole, produces),
  };
}

// Meta-prompt for the LLM path — asks for a single JSON object.
function buildPortSuggestionRequest(roleName, notes, stageName) {
  const instruction = [
    'You classify a role in an autonomous software-delivery team into a wiring pattern.',
    '',
    'The patterns:',
    '- "scout": prepares incoming work — readiness/gap check + evidence gathering, before the producer starts.',
    '- "author": produces the stage\'s work product (code, designs, documents) and opens pull requests.',
    '- "companion": reviews the author\'s PRs, routes human feedback, brokers escalations.',
    '- "intake": pipeline entry — turns human requests into refined, actionable issues.',
    '- "standalone": reacts to external events on its own (docs sync, release notes, reporting).',
    '',
    `Role name: "${roleName}"`,
    notes ? `Operator notes: ${notes}` : 'No operator notes.',
    stageName ? `It will work in the "${stageName}" stage.` : '',
    '',
    'Answer with ONLY a JSON object (no fences, no prose):',
    '{"patternRole": "scout|author|companion|intake|standalone", "sessionPolicy": "persistent|per-invocation", "produces": {"pr": true|false, "issue": true|false}}',
  ].filter(Boolean).join('\n');
  return { max_tokens: 256, messages: [{ role: 'user', content: instruction }] };
}

// Parse + validate the LLM answer. Returns the normalised suggestion or null
// (caller falls back to the heuristic). Tolerates fenced / prose-wrapped JSON.
function parsePortSuggestion(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!PATTERN_ROLES.includes(obj.patternRole)) return null;
  const sessionPolicy = obj.sessionPolicy === 'per-invocation' ? 'per-invocation' : 'persistent';
  const produces = {
    pr: !!(obj.produces && obj.produces.pr),
    issue: !!(obj.produces && obj.produces.issue),
  };
  return {
    patternRole: obj.patternRole,
    sessionPolicy,
    ports: portsForPatternRole(obj.patternRole, produces),
  };
}

module.exports = { heuristicPortSuggestion, buildPortSuggestionRequest, parsePortSuggestion, portsForPatternRole, classifyPatternRole };
