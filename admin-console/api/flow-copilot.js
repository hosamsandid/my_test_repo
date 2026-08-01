'use strict';

// ─── Flow Copilot backend (#1068, spec #1047) ────────────────────────────────
//
// Turns a natural-language flow description (or a follow-up instruction against
// an existing bundle) into a strict-valid, linted `processTemplateVersion: 1`
// process-template bundle — the artifact the Flow Editor's drafts already use.
//
// The server is STATELESS: the client resends the full conversation and the
// current bundle each turn (mirrors agent-ports/suggest). Transport is owned by
// the route in api.js (resolveGenerationTarget + httpPostJson), which hands
// this module a `callLlm(payload) → Promise<string>` — everything here (prompt
// composition, tolerant parsing, sanitize → STRICT validate → lint, the repair
// loop) is deterministic and unit-testable with a mocked callLlm.
//
// Grounding is repo-owned, two layers (#1047 decision 2): the format doc
// docs/process-template-format.md is embedded at request time (format evolution
// reaches the generator automatically) plus the curated conventions addendum
// flow-copilot-prompt.md. Prompt drift is a quality issue, never a correctness
// issue — the sanitize/validate/lint gate below, not prompt fidelity,
// guarantees schema conformance.

const fs = require('fs');
const path = require('path');

const {
  validateProcessTemplate,
  liftTriggerEmits,
  normalizeLegacyReview,
  emptyDraftBundle,
} = require('./process-template');
const { processTemplateToUnified, buildUnifiedGraph } = require('./unified-graph');

// ≤ 3 LLM calls per turn: one generation + at most two repairs (#1047 decision 3).
const MAX_REPAIR_ITERATIONS = 2;

// Whole bundles with many role prompts are large — generous output budget,
// low temperature for schema discipline.
const MAX_TOKENS = 16000;
const TEMPERATURE = 0.2;

// ── sanitize ─────────────────────────────────────────────────────────────────
// Untrusted model output must not smuggle extra fields toward the import path
// (a draft bundle is materialised wholesale). Whitelists mirror the documented
// schema (docs/process-template-format.md + validateProcessTemplate);
// `description` rides along because shipped bundles (core-sdlc) carry it.

const BUNDLE_KEYS = ['processTemplateVersion', 'name', 'description', 'level', 'roles', 'gates', 'labels', 'stages', 'humans'];
const ROLE_KEYS = ['id', 'displayName', 'role', 'sessionPolicy', 'systemPrompt', 'outcomes', 'github', 'channels', 'triggers', 'inputs', 'outputs', 'dependsOn', 'stage', 'parent', 'emits'];

function isPlainObject(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

// Whitelist top-level bundle keys and known role keys. Returns null when the
// input is not an object at all (nothing to sanitize).
function sanitizeBundle(raw) {
  if (!isPlainObject(raw)) return null;
  const out = pick(raw, BUNDLE_KEYS);
  if (Array.isArray(out.roles)) {
    out.roles = out.roles.map(r => (isPlainObject(r) ? pick(r, ROLE_KEYS) : r));
  }
  return out;
}

// ── tolerant response parsing ────────────────────────────────────────────────
// Same posture as parsePortSuggestion: the model is told to answer with one
// bare JSON object, but fenced / prose-wrapped replies are tolerated.

function extractJsonObject(text) {
  const candidates = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (isPlainObject(obj)) return obj;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Parse the model's `{ "summary", "bundle" }` reply. Tolerates a bare bundle
 * with no envelope (recognised by its `processTemplateVersion`). Returns
 * { summary, bundle } or null when no JSON object can be recovered.
 */
function parseCopilotResponse(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const obj = extractJsonObject(text);
  if (!obj) return null;
  const bundle = isPlainObject(obj.bundle)
    ? obj.bundle
    : (obj.processTemplateVersion !== undefined ? obj : null);
  if (!bundle) return null;
  return { summary: typeof obj.summary === 'string' ? obj.summary.trim() : '', bundle };
}

// ── evaluate: sanitize → STRICT validate → lint ──────────────────────────────

/**
 * Run a proposed bundle through the acceptance gate, in order (#1047):
 * sanitize, `validateProcessTemplate` in STRICT mode (not the draft mode —
 * a later materialise must never fail on a Copilot bundle), then the same graph
 * internals as POST /api/flows/graph for the authoritative lint set.
 * Returns { bundle, lints }; a strict-validation failure surfaces as a single
 * error-severity `invalid-bundle` lint (the graph is skipped — its builders
 * assume a validated shape).
 */
function evaluateBundle(rawBundle) {
  const bundle = sanitizeBundle(rawBundle);
  if (!bundle) {
    return { bundle: null, lints: [{ code: 'invalid-bundle', severity: 'error', message: 'the proposed bundle is not a JSON object' }] };
  }
  const v = validateProcessTemplate(bundle);
  if (!v.ok) {
    return { bundle, lints: [{ code: 'invalid-bundle', severity: 'error', message: v.error }] };
  }
  const lifted = liftTriggerEmits(normalizeLegacyReview(bundle));
  const flow = processTemplateToUnified(lifted);
  const humans = Array.isArray(lifted.humans) ? lifted.humans : [];
  const g = buildUnifiedGraph(flow.nodes, flow.edges, { labels: flow.labels, humans });
  return { bundle, lints: Array.isArray(g.lints) ? g.lints : [] };
}

function errorLints(lints) {
  return lints.filter(l => l && l.severity === 'error');
}

// ── change list ──────────────────────────────────────────────────────────────
// Coarse per-entity diff for the proposal card: which roles / labels / gates /
// stages / humans were added, removed or modified. Compared with a
// key-order-insensitive stringify — the model reproducing a role with its keys
// reordered is not a modification.

function stableStringify(x) {
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(',')}]`;
  if (isPlainObject(x)) {
    return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${stableStringify(x[k])}`).join(',')}}`;
  }
  return JSON.stringify(x);
}

function diffKeyed(kind, before, after, keyOf, changes) {
  const b = new Map();
  for (const x of (Array.isArray(before) ? before : [])) {
    const k = keyOf(x);
    if (typeof k === 'string' && k) b.set(k, x);
  }
  const seen = new Set();
  for (const x of (Array.isArray(after) ? after : [])) {
    const k = keyOf(x);
    if (typeof k !== 'string' || !k || seen.has(k)) continue;
    seen.add(k);
    if (!b.has(k)) changes.push({ kind: `${kind}-added`, id: k });
    else if (stableStringify(b.get(k)) !== stableStringify(x)) changes.push({ kind: `${kind}-modified`, id: k });
  }
  for (const k of b.keys()) {
    if (!seen.has(k)) changes.push({ kind: `${kind}-removed`, id: k });
  }
}

function computeChanges(before, after) {
  const b = isPlainObject(before) ? before : {};
  const a = isPlainObject(after) ? after : {};
  const changes = [];
  if (typeof a.name === 'string' && a.name && a.name !== b.name) {
    changes.push({ kind: 'name-changed', id: a.name });
  }
  diffKeyed('role', b.roles, a.roles, r => r && r.id, changes);
  diffKeyed('label', b.labels, a.labels, l => l && l.name, changes);
  diffKeyed('gate', b.gates, a.gates, g => g && g.label, changes);
  diffKeyed('stage', b.stages, a.stages, s => (typeof s === 'string' ? s : ''), changes);
  diffKeyed('human', b.humans, a.humans, h => h && h.id, changes);
  return changes;
}

// ── grounding docs ───────────────────────────────────────────────────────────

/**
 * The bundle-format reference, read at request time so format evolution reaches
 * the generator automatically. Source of truth is docs/process-template-format.md
 * at the repo root (dev checkout / tests); the runtime image's build context is
 * admin-console/, so a vendored copy sits next to this module — a parity test
 * keeps the two byte-identical (change both in one commit).
 */
function readFormatDoc() {
  const candidates = [
    path.join(__dirname, '..', '..', 'docs', 'process-template-format.md'),
    path.join(__dirname, 'process-template-format.md'),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf8'); } catch { /* try the next */ }
  }
  return '';
}

function readPromptAddendum() {
  try { return fs.readFileSync(path.join(__dirname, 'flow-copilot-prompt.md'), 'utf8'); } catch { return ''; }
}

// ── prompt composition ───────────────────────────────────────────────────────

function buildCopilotSystem({ formatDoc, addendum, bundle }) {
  return [
    [
      'You are the Flow Copilot of the Agent Studio Flow Editor. You turn natural-language',
      'descriptions into a `processTemplateVersion: 1` process-template bundle — a team of AI',
      'agent roles wired together by labels, GitHub channels, data-flow ports and human gates —',
      'and you revise an existing bundle on follow-up instructions.',
      '',
      'Output contract:',
      '- Respond with ONLY one JSON object: {"summary": "…", "bundle": { … }}. No prose outside it.',
      '- `summary`: 1–3 sentences describing what you created or changed, in the language the user wrote in.',
      '- `bundle`: the COMPLETE bundle, never a fragment or a diff. When revising, regenerate the',
      '  whole bundle and reproduce every part you were not asked to change verbatim — unrelated',
      '  roles, prompts, triggers, labels, stages and humans must survive untouched.',
      '- Write a real `systemPrompt` for every role (second person, identity + responsibilities +',
      '  hand-offs + quality bar) — never leave prompts blank.',
      '- Never include repository URLs, branch names, tokens, credentials, environment ids or',
      '  Matrix identities: infrastructure is bound later by a human, outside this bundle.',
    ].join('\n'),
    `## Bundle format reference\n\n${formatDoc || '(format reference unavailable)'}`,
    `## Studio wiring conventions\n\n${addendum || '(conventions addendum unavailable)'}`,
    `## Current bundle\n\nThe bundle as it exists right now (the user's instructions apply to it):\n\n\`\`\`json\n${JSON.stringify(bundle, null, 2)}\n\`\`\``,
  ].join('\n\n');
}

/**
 * The Anthropic Messages payload (minus `model`, added by the route) for one
 * generation turn. The current bundle lives in the system prompt so the
 * client-held conversation passes through unmodified.
 */
function buildCopilotRequest({ bundle, messages, formatDoc, addendum }) {
  return {
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: buildCopilotSystem({ formatDoc, addendum, bundle }),
    messages: messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content ?? ''),
    })),
  };
}

// The findings fed back on a repair iteration. Error-level only — warnings and
// infos are advisory everywhere in the editor and must not burn repair budget.
function buildRepairMessage(findings) {
  const lines = findings.map(l => `- [${l.code}] ${l.message}`).join('\n');
  return [
    'The proposed bundle was rejected by the Studio\'s validator. Fix these errors:',
    '',
    lines,
    '',
    'Return the corrected COMPLETE bundle as {"summary": "…", "bundle": { … }} — JSON only,',
    'changing nothing beyond what the errors require.',
  ].join('\n');
}

// ── the generate → validate → repair loop ────────────────────────────────────

/**
 * One Copilot turn. `callLlm(payload) → Promise<string>` is the only I/O.
 *
 * Repair loop (#1047 decision 3): on strict-validation errors, error-level
 * lints, or an unparseable reply, the findings go back to the model — at most
 * MAX_REPAIR_ITERATIONS times. Errors remaining afterwards → `ok: false` with
 * the best-effort bundle + findings (never a throw for "model couldn't get
 * lint-clean"). Throws only when transport fails before any bundle exists, or
 * when no iteration produced a parseable bundle at all — the route maps that
 * to a 502.
 *
 * @returns {{ ok, bundle, summary, changes, lints, repairIterations }}
 */
async function runCopilot({
  bundle,
  messages,
  callLlm,
  formatDoc = readFormatDoc(),
  addendum = readPromptAddendum(),
  maxRepairIterations = MAX_REPAIR_ITERATIONS,
}) {
  const baseBundle = isPlainObject(bundle) ? bundle : emptyDraftBundle();
  let request = buildCopilotRequest({ bundle: baseBundle, messages, formatDoc, addendum });

  let best = null; // { bundle, summary, lints } from the last parseable iteration
  let repairIterations = 0;

  for (let attempt = 0; attempt <= maxRepairIterations; attempt++) {
    let text;
    try {
      text = await callLlm(request);
    } catch (err) {
      if (!best) throw err; // nothing to fall back to — surface the transport error
      break;                // best-effort with the previous iteration's bundle
    }

    const parsed = parseCopilotResponse(text);
    let findings;
    if (!parsed) {
      findings = [{ code: 'unparseable-output', severity: 'error', message: 'the reply was not a parseable {"summary", "bundle"} JSON object' }];
    } else {
      const ev = evaluateBundle(parsed.bundle);
      best = { bundle: ev.bundle, summary: parsed.summary, lints: ev.lints };
      findings = errorLints(ev.lints);
    }

    if (!findings.length || attempt === maxRepairIterations) break;
    repairIterations++;
    request = {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: typeof text === 'string' ? text : '' },
        { role: 'user', content: buildRepairMessage(findings) },
      ],
    };
  }

  if (!best) {
    throw new Error('LLM returned no parseable bundle');
  }
  return {
    ok: errorLints(best.lints).length === 0,
    bundle: best.bundle,
    summary: best.summary,
    // Diff against the sanitized baseline so the change list reflects real
    // edits, not fields the sanitizer would strip from both sides anyway.
    changes: computeChanges(sanitizeBundle(baseBundle) || baseBundle, best.bundle),
    lints: best.lints,
    repairIterations,
  };
}

module.exports = {
  MAX_REPAIR_ITERATIONS,
  sanitizeBundle,
  parseCopilotResponse,
  evaluateBundle,
  computeChanges,
  readFormatDoc,
  readPromptAddendum,
  buildCopilotRequest,
  buildRepairMessage,
  runCopilot,
};
