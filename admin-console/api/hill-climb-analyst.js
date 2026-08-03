'use strict';

// Hill-climbing loop Phase 2 (#1224): the server-side analyst request builder +
// response parser, in the discipline of `port-suggestion.js`.
//
// Concept `docs/hill-climbing-agent-concept.md` §3.2. The analyst is a
// stateless one-shot `/v1/messages` call (via `resolveAssistTarget` — prefers a
// Sonnet-class Model Provider, skips `oauth-token` providers), NOT a resident
// agent. This module is the pure edge of that call: it turns the orchestrator's
// already-redacted, aggregate digest into a messages payload, and parses the
// model's reply into raw improvement cards. It applies NO trust — the
// orchestrator re-validates every returned card through `hill-climb-cards.validateCard`
// before anything is persisted, and drops any that fail. With no reachable
// provider the api route falls back to the orchestrator's heuristic cards
// (concept's honest fallback), so this module is only exercised when a provider
// resolves.

const CARD_CLASSES = [
  'prompt-improvement', 'flow-wiring', 'threshold-tuning', 'trigger-hygiene', 'knowledge-handoff',
];

// Build the one-shot messages request from the (redacted, secret-free) digest.
// The analyst is told the closed-loop contract the schema enforces: every card
// MUST name the metric it expects to move and cite evidence, or it is dropped.
function buildHillClimbAnalystRequest(digest) {
  const payload = JSON.stringify(digest || {}, null, 2);
  const instruction = [
    'You are a loop-engineering analyst for an autonomous software-delivery team.',
    'You are given a deterministic, secret-free digest of one team\'s run metrics over a',
    'measurement window. Propose a SMALL number of concrete improvement cards that would',
    'move a named metric. You propose only — nothing you emit is applied automatically.',
    '',
    'Card classes (pick the most specific that fits the evidence):',
    '- "prompt-improvement": a wake/system-prompt the runs demonstrably misread (high rework, output-missing).',
    '- "flow-wiring": a topological cause — an emitted label nobody consumes, a recurring anomaly, a dead-end hand-off.',
    '- "threshold-tuning": a numeric config (anomaly thresholds, throttle/burst) mismatched to the observed distribution.',
    '- "trigger-hygiene": a never-fired, crash-looping, or always-[PASS] trigger.',
    '- "knowledge-handoff": a lesson recurring across members that belongs in the curator.',
    '',
    'Rules:',
    '- Every card MUST cite evidence drawn from the digest (metric values, refs) and name a targetMetric it expects to move. A card without either is invalid and will be discarded.',
    '- Do not invent objects or numbers absent from the digest. If the digest says insufficientData, say so and keep claims cautious.',
    '- Prefer fewer, well-evidenced cards over many speculative ones.',
    '',
    'DIGEST:',
    payload,
    '',
    'Answer with ONLY a JSON object (no fences, no prose):',
    '{"cards": [{',
    `  "class": "${CARD_CLASSES.join('|')}",`,
    '  "object": {"kind": "<trigger|label|agent|anomaly|team>", "id": "<stable id>"},',
    '  "title": "<one line>",',
    '  "detail": "<why, citing the evidence>",',
    '  "targetMetric": "<the metric this should move, e.g. metrics.runSuccessRate>",',
    '  "evidence": [{"type": "metric|session|event|anomaly-history", "ref": "<pointer>", "value": "<observed value>"}],',
    '  "proposedChange": {"action": "<what to change>"},',
    '  "riskClass": "low|medium|high"',
    '}]}',
  ].join('\n');
  return { max_tokens: 2048, messages: [{ role: 'user', content: instruction }] };
}

// Parse the analyst reply into an array of raw card objects. Tolerant: accepts a
// bare array, or a `{cards:[...]}` wrapper, embedded in surrounding prose/fences.
// Returns [] on any failure — the caller then relies on the heuristic cards the
// orchestrator already produced. Does NOT validate card shape (that is the
// orchestrator's authority); only extracts plausible card objects.
function parseHillClimbCards(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const obj = extractJson(text);
  if (!obj) return [];
  const arr = Array.isArray(obj) ? obj : (Array.isArray(obj.cards) ? obj.cards : null);
  if (!Array.isArray(arr)) return [];
  return arr.filter((c) => c && typeof c === 'object' && !Array.isArray(c));
}

// Pull the first JSON value (object or array) out of a possibly-fenced,
// possibly-prose-wrapped string. Tries a fenced block first, then the widest
// brace/bracket span.
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const spans = [];
  if (fenced) spans.push(fenced[1]);
  const list = text.match(/\[[\s\S]*\]/);
  if (list) spans.push(list[0]);
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) spans.push(obj[0]);
  const parsed = [];
  for (const s of spans) {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object') parsed.push(v);
    } catch { /* try the next candidate */ }
  }
  // Prefer the shape the parser actually needs: a bare array, then a
  // `{cards:[...]}` wrapper, then any object — so a card object embedded inside
  // an array is never mistaken for the whole reply.
  return parsed.find((v) => Array.isArray(v))
    || parsed.find((v) => v && Array.isArray(v.cards))
    || parsed[0]
    || null;
}

module.exports = {
  buildHillClimbAnalystRequest,
  parseHillClimbCards,
};
