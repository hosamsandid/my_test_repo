'use strict';

// ─── Outcome suggestion for the Routing tab (#828, agent-outcomes concept §5.2) ─
//
// The Routing tab's "suggest outcomes…" action proposes a structured `outcomes`
// port for an agent/role from its name + system prompt. One stateless LLM call
// when a generation target resolves, a deterministic keyword heuristic as the
// offline fallback — the exact shape of /api/agent-ports/suggest (#423) and
// /api/agent-prompt/generate. Suggestions are NEVER applied silently: the tab
// renders them unconfirmed-highlighted and persists nothing until the operator
// confirms (concept decision 5).
//
// The output is an `outcomes` port `{ mode, options:[{ id, title?, when?,
// actions:[{ type, label? }] }] }` — validated + normalized through the pure
// data-model module (outcomes.js) so a suggestion can never carry a forbidden
// gate/brake label or a malformed option.

const {
  validateOutcomes, normalizeOutcomes, slugifyOutcome, forbiddenOutcomeLabel,
} = require('./outcomes');

// Keyword → role-shape classifier, mirroring port-suggestion.js. Reviewer-like
// roles get a real two-way switch; router/dispatcher-like roles get a route/hold
// switch; everything else gets a single "completed" any-of outcome (a safe,
// editable starting point rather than an empty guess).
const KEYWORDS = {
  reviewer: ['review', 'reviewer', 'approve', 'approval', 'accept', 'reject', 'revision', 'revisions', 'qa', 'quality', 'audit', 'verify', 'sign off', 'sign-off'],
  dispatcher: ['dispatch', 'dispatcher', 'route', 'routing', 'triage', 'assign', 'assignment', 'delegate', 'distribute'],
};

function scoreShape(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const scores = {};
  for (const [shape, words] of Object.entries(KEYWORDS)) {
    scores[shape] = words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
  }
  // Reviewer wins ties over dispatcher — "review and route feedback" is a review.
  if (scores.reviewer > 0 && scores.reviewer >= scores.dispatcher) return 'reviewer';
  if (scores.dispatcher > 0) return 'dispatcher';
  return 'generic';
}

// Pull backtick-quoted label-ish tokens out of the prompt (e.g. "apply the
// `ready-to-merge` label"). Kebab/colon label tokens only, capped, human-gate
// labels dropped — pure documentation harvesting, never evaluated. Gate-ness
// comes from the optional `sources` registry (#928), never from the token's name.
function harvestLabels(text, sources) {
  const out = [];
  const seen = new Set();
  const re = /`([a-z0-9][a-z0-9:_-]*)`/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const l = m[1].trim();
    if (!l || seen.has(l) || forbiddenOutcomeLabel(l, sources)) continue;
    seen.add(l);
    out.push(l);
    if (out.length >= 6) break;
  }
  return out;
}

function option(id, title, when, label) {
  return {
    id,
    ...(title ? { title } : {}),
    ...(when ? { when } : {}),
    actions: label ? [{ type: 'setLabel', label }] : [{ type: 'none' }],
  };
}

/**
 * Deterministic offline suggestion from a role's name + prompt.
 * @param {object} arg - { roleName, prompt, labels? } — `labels` is the optional
 *   gate/brake registry (#928) whose `humanGate` entries are never suggested.
 * @returns {{ mode, options }} a valid, normalized outcomes port.
 */
function heuristicOutcomeSuggestion({ roleName, prompt, labels }) {
  const text = `${roleName || ''}\n${prompt || ''}`;
  const shape = scoreShape(text);
  const sources = { labels };
  const harvested = harvestLabels(prompt, sources).filter(l => !forbiddenOutcomeLabel(l, sources));

  let port;
  if (shape === 'reviewer') {
    const approve = harvested.find(l => /(ready|approv|accept|merge)/i.test(l)) || 'ready-to-merge';
    const reject = harvested.find(l => /(revis|reject|change|rework)/i.test(l)) || 'revisions-required';
    port = {
      mode: 'exactlyOne',
      options: [
        option('accepted', 'Accepted', 'The change meets the bar', approve),
        option('revisions-required', 'Revisions required', 'The change needs rework before it can proceed', reject),
      ],
    };
  } else if (shape === 'dispatcher') {
    const route = harvested[0] || 'ready';
    port = {
      mode: 'exactlyOne',
      options: [
        option('route', 'Route onward', 'The task is clear and ready to be picked up', route),
        option('hold', 'Hold for clarification', 'The task is ambiguous — human input needed', null),
      ],
    };
  } else if (harvested.length) {
    // Labels found but no strong role shape → any-of over the harvested labels.
    port = {
      mode: 'anyOf',
      options: harvested.map(l => option(slugifyOutcome(l), l, '', l)),
    };
  } else {
    port = {
      mode: 'anyOf',
      options: [option('completed', 'Completed', 'The work is done', null)],
    };
  }
  // Normalize so the offline path returns exactly the persisted shape.
  return normalizeOutcomes(port);
}

// The peer roles a suggested `wakeAgent` may name (#2032). A direct hand-off
// addresses a role by id, so the model can only propose one when it is told
// which ids exist — and `validateOutcomes` (with these same entries as its
// `agents` source) rejects the port outright if it invents one, which is why
// the caller must thread the SAME list into `parseOutcomeSuggestion`.
//
// Filtered on `(p.kind || 'agent') === 'agent'`: on a live team the peer list
// is the graph's node list, which also carries the actor pseudo-nodes
// (`@github`/`@external`/`@timer`, `kind: 'actor'`) and named human roles —
// none of which has a pending queue. Draft roles carry no `kind`, so the
// default keeps them eligible.
function wakePeerList(peers, roleId) {
  const self = typeof roleId === 'string' ? roleId.trim() : '';
  const seen = new Set();
  const out = [];
  for (const p of (Array.isArray(peers) ? peers : [])) {
    if (!p || typeof p !== 'object') continue;
    if ((p.kind || 'agent') !== 'agent') continue;
    const id = typeof p.id === 'string' ? p.id.trim() : '';
    if (!id || id === self || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: typeof p.displayName === 'string' && p.displayName.trim() ? p.displayName.trim() : id });
  }
  return out;
}

// Meta-prompt for the LLM path — asks for a single JSON object shaped like the
// `outcomes` port. Deliberately schematic: the model decides mode + options.
function buildOutcomeSuggestionRequest(roleName, prompt, labels, opts) {
  // Human-gate labels come from the flag registry (#928), not a name convention,
  // so the model is told the concrete forbidden names when we know them.
  const gateNames = (Array.isArray(labels) ? labels : [])
    .filter(l => l && l.humanGate && typeof l.name === 'string' && l.name.trim())
    .map(l => l.name.trim());
  const promptBlock = prompt
    ? `The role's current system prompt (routing intent lives in here as prose):\n"""\n${String(prompt).slice(0, 4000)}\n"""`
    : 'The role has no system prompt yet — infer sensible outcomes from the name alone.';
  // #2032: `wakeAgent` is offered only when the caller told us which roles
  // exist. Told nothing, the model would have to guess an id — and a guess is
  // rejected by `validateOutcomes`, which drops the WHOLE suggestion back to
  // the heuristic, so an unusable action type is worse than an absent one.
  const peers = wakePeerList(opts && opts.peers, opts && opts.roleId);
  const wakeAction = peers.length
    ? '{"type":"wakeAgent","to":"<roleId>","note":"<one sentence of context>"}, '
    : '';
  const wakeGuidance = peers.length
    ? [
      'A "wakeAgent" action is a DIRECT hand-off: it wakes another role inside the platform with no label and no issue/PR — use it for pure coordination that has no natural home on a work item, and prefer "setLabel" when a person should be able to see the state on the issue/PR.',
      `Its "to" MUST be one of these role ids exactly: ${peers.map(p => `"${p.id}"${p.name !== p.id ? ` (${p.name})` : ''}`).join(', ')}. Never invent one, never name this role itself.`,
      'Its "note" is optional but worth writing: it is the only context the woken role receives.',
    ]
    : null;
  const instruction = [
    'You model the OUTCOMES of an AI agent in an autonomous software-delivery team.',
    'An outcome is a way a run can end and the signal it sets. Examples:',
    '- a code reviewer ends "accepted" (label `ready-to-merge`) or "revisions required" (label `revisions-required`) — mutually exclusive.',
    '- a dispatcher routes each task to one of several developers via different labels — mutually exclusive.',
    '- a docs agent may set several labels in one run — not exclusive.',
    '',
    `Role name: "${roleName}"`,
    promptBlock,
    '',
    'Decide the outcome MODE:',
    '- "exactlyOne": the outcomes are a switch — exactly one is chosen per run.',
    '- "anyOf": zero or more outcomes may apply in one run.',
    '',
    'For each outcome give: a short stable "id" (kebab-case), a "title", a human-readable "when" condition, and "actions".',
    `Each action is one of: {"type":"setLabel","label":"<github-label>"}, {"type":"openPr"}, {"type":"openIssue"}, ${wakeAction}or {"type":"none"} (a terminal outcome with no signal).`,
    ...(wakeGuidance || []),
    gateNames.length
      ? `NEVER use these labels — they are human approval gates only a person applies: ${gateNames.map(n => `"${n}"`).join(', ')}.`
      : 'NEVER use a label that a human applies as an approval gate — an outcome is a signal the AGENT sets.',
    !peers.length ? 'Do NOT use a "wakeAgent" action: the roles it could name are not known here.' : null,
    '',
    'Answer with ONLY a JSON object (no fences, no prose):',
    '{"mode":"exactlyOne|anyOf","options":[{"id":"...","title":"...","when":"...","actions":[{"type":"setLabel","label":"..."}]}]}',
  ].filter(Boolean).join('\n');
  return { max_tokens: 1024, messages: [{ role: 'user', content: instruction }] };
}

// Parse + validate the LLM answer into a normalized outcomes port. Returns null
// (caller falls back to the heuristic) on any parse/shape/validation failure,
// including a forbidden gate/brake label — the data-model validator is the gate.
function parseOutcomeSuggestion(text, sources) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  // Coerce option ids the model may have omitted from title/label before validating.
  const mode = obj.mode === 'anyOf' ? 'anyOf' : (obj.mode === 'exactlyOne' ? 'exactlyOne' : null);
  if (!mode || !Array.isArray(obj.options)) return null;
  const seen = new Set();
  const options = obj.options.map((o, i) => {
    if (!o || typeof o !== 'object') return null;
    let id = (typeof o.id === 'string' && o.id.trim())
      ? slugifyOutcome(o.id)
      : slugifyOutcome(o.title || o.when || `outcome-${i + 1}`);
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const actions = Array.isArray(o.actions) && o.actions.length
      ? o.actions
      : [{ type: 'none' }];
    return {
      id,
      ...(typeof o.title === 'string' && o.title.trim() ? { title: o.title.trim() } : {}),
      ...(typeof o.when === 'string' && o.when.trim() ? { when: o.when.trim() } : {}),
      actions,
    };
  }).filter(Boolean);
  const port = { mode, options };
  const v = validateOutcomes(port, sources);
  if (!v.ok) return null;
  return normalizeOutcomes(port);
}

module.exports = {
  heuristicOutcomeSuggestion, buildOutcomeSuggestionRequest, parseOutcomeSuggestion,
  scoreShape, harvestLabels, wakePeerList,
};
