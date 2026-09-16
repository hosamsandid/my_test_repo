'use strict';

// ─── Flow Copilot backend (#1068, spec #1047) ────────────────────────────────
//
// Turns a natural-language flow description (or a follow-up instruction against
// an existing bundle) into a strict-valid, linted `processTemplateVersion: 1`
// process-template bundle — the artifact the Flow Editor's drafts already use.
//
// The server is STATELESS: the client resends the full conversation and the
// current bundle each turn (mirrors agent-ports/suggest). Transport is owned by
// the route in api.js (resolveAssistTarget + httpPostJson), which hands
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

// Whole bundles with many role prompts are large — generous output budget.
// No `temperature`: newer models (e.g. claude-opus-4-8) reject the param as
// deprecated, and the Model Provider Selector can route this call to any
// provider — so we rely on the model default, matching every other assist
// call site (port-suggestion, hill-climb-analyst, …).
const MAX_TOKENS = 16000;

// Output budget for ONE part of a generate-in-parts run (#2131). A whole flow
// asked for in a single call has to emit every role AND all of its wiring in one
// reply, which is what pushes a slow model past the upstream gateway ceiling.
// Split in two, neither part carries the other's bulk: part 1 emits the roles
// and their prompts, part 2 emits only an op list that wires them, so a lower
// per-call ceiling is a real bound on the critical call rather than a guess.
const MAX_TOKENS_PART = 10000;

// Character limit for the composed system prompt (bundle JSON + format doc +
// conventions addendum) before the copilot call is attempted (#1404). The
// guard fires as a plain 400 so the caller receives an actionable error rather
// than a 504 timeout. ~50 000 tokens at the common 4-chars/token heuristic.
const SYSTEM_PROMPT_CHAR_LIMIT = 200_000;

// ── sanitize ─────────────────────────────────────────────────────────────────
// Untrusted model output must not smuggle extra fields toward the import path
// (a draft bundle is materialised wholesale). Whitelists mirror the documented
// schema (docs/process-template-format.md + validateProcessTemplate);
// `description` rides along because shipped bundles (core-sdlc) carry it.

const BUNDLE_KEYS = ['processTemplateVersion', 'name', 'description', 'level', 'roles', 'gates', 'labels', 'stages', 'humans', 'wipLimit'];
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
 * Parse the model's reply: `{ "summary", "bundle" }` (whole-bundle contract),
 * `{ "summary", "ops" }` (patch contract on revision turns, #1071), or a bare
 * bundle with no envelope (recognised by its `processTemplateVersion`). A
 * bundle wins over ops when both appear — it is the complete state. Returns
 * { summary, bundle } | { summary, ops } or null when nothing usable exists.
 */
function parseCopilotResponse(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const obj = extractJsonObject(text);
  if (!obj) return null;
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (isPlainObject(obj.bundle)) return { summary, bundle: obj.bundle };
  if (Array.isArray(obj.ops)) return { summary, ops: obj.ops };
  if (obj.processTemplateVersion !== undefined) return { summary, bundle: obj };
  return null;
}

// ── patch-based incremental edits (#1071 item 3) ─────────────────────────────
// On revision turns the model answers with a constrained operation list instead
// of regenerating the whole bundle — smaller outputs, structural preservation
// of untouched parts. The vocabulary mirrors the editing surface makeDraftOps
// exposes (roles / labels / stages / gates / humans / name). Application is
// pure and fail-fast; the result runs through the SAME sanitize → STRICT
// validate → lint gate as a whole-bundle reply, and a whole-bundle reply stays
// accepted at any point as the fallback path.

function applyCopilotOps(base, ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('ops must be a non-empty array');
  const b = JSON.parse(JSON.stringify(sanitizeBundle(base) || {}));
  if (b.processTemplateVersion === undefined) b.processTemplateVersion = 1;
  b.roles = Array.isArray(b.roles) ? b.roles : [];
  ops.forEach((op, i) => {
    const fail = (msg) => {
      throw new Error(`op ${i + 1} (${isPlainObject(op) && typeof op.op === 'string' ? op.op : '?'}): ${msg}`);
    };
    if (!isPlainObject(op) || typeof op.op !== 'string') fail('not an operation object with a string `op`');
    switch (op.op) {
      case 'addRole': {
        const role = isPlainObject(op.role) ? pick(op.role, ROLE_KEYS) : null;
        if (!role || typeof role.id !== 'string' || !role.id) fail('needs `role` with a string id');
        if (b.roles.some(r => r && r.id === role.id)) fail(`role '${role.id}' already exists`);
        b.roles.push(role);
        break;
      }
      case 'patchRole': {
        const r = b.roles.find(x => x && x.id === op.id);
        if (!r) fail(`role '${op.id}' not found`);
        const patch = isPlainObject(op.patch) ? pick(op.patch, ROLE_KEYS) : {};
        if (!Object.keys(patch).length) fail('needs `patch` with at least one known role key');
        if ('id' in patch) fail('a role id cannot be changed by patch (remove and re-add instead)');
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete r[k];
          else r[k] = v;
        }
        break;
      }
      case 'removeRole': {
        const before = b.roles.length;
        b.roles = b.roles.filter(x => !(x && x.id === op.id));
        if (b.roles.length === before) fail(`role '${op.id}' not found`);
        break;
      }
      case 'setName':
        if (typeof op.name !== 'string' || !op.name.trim()) fail('needs a non-empty string `name`');
        b.name = op.name.trim();
        break;
      case 'setDescription':
        if (typeof op.description !== 'string') fail('needs a string `description`');
        b.description = op.description;
        break;
      case 'setStages':
        if (!Array.isArray(op.stages) || op.stages.some(s => typeof s !== 'string')) fail('needs `stages` as an array of strings');
        b.stages = op.stages;
        break;
      case 'setGates':
        if (!Array.isArray(op.gates)) fail('needs `gates` as an array');
        b.gates = op.gates;
        break;
      case 'upsertLabel': {
        const label = isPlainObject(op.label) && typeof op.label.name === 'string' && op.label.name ? op.label : null;
        if (!label) fail('needs `label` with a string name');
        b.labels = Array.isArray(b.labels) ? b.labels : [];
        const at = b.labels.findIndex(x => x && x.name === label.name);
        if (at >= 0) b.labels[at] = label; else b.labels.push(label);
        break;
      }
      case 'removeLabel': {
        const list = Array.isArray(b.labels) ? b.labels : [];
        b.labels = list.filter(x => !(x && x.name === op.name));
        if (b.labels.length === list.length) fail(`label '${op.name}' not found`);
        break;
      }
      case 'upsertHuman': {
        const human = isPlainObject(op.human) && typeof op.human.id === 'string' && op.human.id ? op.human : null;
        if (!human) fail('needs `human` with a string id');
        b.humans = Array.isArray(b.humans) ? b.humans : [];
        const at = b.humans.findIndex(x => x && x.id === human.id);
        if (at >= 0) b.humans[at] = human; else b.humans.push(human);
        break;
      }
      case 'removeHuman': {
        const list = Array.isArray(b.humans) ? b.humans : [];
        b.humans = list.filter(x => !(x && x.id === op.id));
        if (b.humans.length === list.length) fail(`human '${op.id}' not found`);
        break;
      }
      default:
        fail('unknown operation');
    }
  });
  return b;
}

// ── chat-history persistence (#1071 item 1) ──────────────────────────────────
// The draft file may carry `copilot: { messages: [] }` — pure storage metadata
// like `id`/`createdAt`, never part of the portable bundle (sanitizeBundle and
// the export/materialise paths strip it). The draft PUT normalizes it through
// this helper: whitelisted fields only, capped length, and any still-'proposed'
// entry demoted to 'superseded' — the proposal's bundle is deliberately not
// persisted (it would bloat the file; the user regenerates after a reload).

const COPILOT_HISTORY_CAP = 20;
const HISTORY_ENTRY_KEYS = ['role', 'content', 'summary', 'changes', 'lints', 'ok', 'status'];

function sanitizeCopilotHistory(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.messages)) return undefined;
  const messages = raw.messages
    .filter(m => isPlainObject(m) && (m.role === 'user' || m.role === 'assistant'))
    .map(m => {
      const entry = pick(m, HISTORY_ENTRY_KEYS);
      if (entry.status === 'proposed') entry.status = 'superseded';
      return entry;
    })
    .slice(-COPILOT_HISTORY_CAP);
  return { messages };
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
  // Revision turns (the current bundle already has roles) use the patch
  // contract (#1071): a minimal op list instead of whole-bundle regeneration —
  // smaller outputs and structural preservation of untouched parts. The
  // whole-bundle reply stays the documented fallback.
  const revision = isPlainObject(bundle) && Array.isArray(bundle.roles) && bundle.roles.length > 0;
  const contract = revision
    ? [
      'Output contract (revision — the current bundle is below):',
      '- Respond with ONLY one JSON object: {"summary": "…", "ops": [ … ]}. No prose outside it.',
      '- `summary`: 1–3 sentences describing what you changed, in the language the user wrote in.',
      '- `ops`: the MINIMAL list of operations that applies the requested change to the current',
      '  bundle. Untouched parts are preserved structurally — never restate them. Vocabulary',
      '  (no other `op` values exist):',
      '  {"op":"addRole","role":{…}} — a full role object (same schema as bundle roles[]).',
      '  {"op":"patchRole","id":"<roleId>","patch":{…}} — shallow-merges the given role keys; a',
      '    null value deletes that key; the id itself cannot be changed.',
      '  {"op":"removeRole","id":"<roleId>"}',
      '  {"op":"setName","name":"…"} · {"op":"setDescription","description":"…"}',
      '  {"op":"setStages","stages":[…]} · {"op":"setGates","gates":[…]}',
      '  {"op":"upsertLabel","label":{"name":"…", …}} · {"op":"removeLabel","name":"…"}',
      '  {"op":"upsertHuman","human":{"id":"…", …}} · {"op":"removeHuman","id":"…"}',
      '- Only when the change cannot be expressed as ops (a full restructure), fall back to',
      '  {"summary": "…", "bundle": { … }} with the COMPLETE bundle — then',
      '  reproduce every part you were not asked to change verbatim.',
      '- Write a real `systemPrompt` for every role you add (second person, identity +',
      '  responsibilities + hand-offs + quality bar) — never leave prompts blank.',
      '- Never include repository URLs, branch names, tokens, credentials, environment ids or',
      '  Matrix identities: infrastructure is bound later by a human, outside this bundle.',
    ]
    : [
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
    ];
  return [
    [
      'You are the Flow Copilot of the Agent Studio Flow Editor. You turn natural-language',
      'descriptions into a `processTemplateVersion: 1` process-template bundle — a team of AI',
      'agent roles wired together by labels, GitHub channels, data-flow ports and human gates —',
      'and you revise an existing bundle on follow-up instructions.',
      '',
      ...contract,
    ].join('\n'),
    `## Bundle format reference\n\n${formatDoc || '(format reference unavailable)'}`,
    `## Studio wiring conventions\n\n${addendum || '(conventions addendum unavailable)'}`,
    `## Current bundle\n\nThe bundle as it exists right now (the user's instructions apply to it):\n\n\`\`\`json\n${JSON.stringify(bundle, null, 2)}\n\`\`\``,
  ].join('\n\n');
}

/**
 * Character count of the system prompt for a copilot call. The route uses
 * this to enforce SYSTEM_PROMPT_CHAR_LIMIT before the NDJSON stream starts,
 * returning a plain 400 instead of a 504 timeout on oversized bundles (#1404).
 */
function measureCopilotSystemPrompt({ formatDoc, addendum, bundle }) {
  return buildCopilotSystem({ formatDoc, addendum, bundle }).length;
}

/**
 * The Anthropic Messages payload (minus `model`, added by the route) for one
 * generation turn. The current bundle lives in the system prompt so the
 * client-held conversation passes through unmodified.
 */
function buildCopilotRequest({ bundle, messages, formatDoc, addendum }) {
  return {
    max_tokens: MAX_TOKENS,
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
    'The proposed change was rejected by the Studio\'s validator. Fix these errors:',
    '',
    lines,
    '',
    'Return the corrected reply — a corrected {"summary": "…", "ops": [ … ]} list when revising,',
    'or the corrected COMPLETE bundle as {"summary": "…", "bundle": { … }} — JSON only,',
    'changing nothing beyond what the errors require.',
  ].join('\n');
}

// ── generate in parts (large flows, #2131) ───────────────────────────────────
// A whole-flow generation is ONE call emitting up to MAX_TOKENS tokens, so its
// success depends entirely on that call finishing inside the upstream gateway's
// timeout — a slow model tips it over and the turn fails outright. Splitting the
// work into a bounded sequence of smaller calls removes that dependency.
//
// The split reuses the two contracts buildCopilotSystem already has, so no new
// prompt vocabulary enters the product: part 1 runs against the (role-less) base
// bundle and therefore gets the WHOLE-BUNDLE contract, part 2 runs against
// part 1's result and therefore gets the OPS contract — which is exactly the
// shape a wiring pass wants (patch each role, register the labels) and is
// applied by the same applyCopilotOps a revision turn uses. The merged bundle
// then goes through the identical sanitize → STRICT validate → lint → repair
// gate as a single-call reply, because the parts run only produces the reply
// text differently; nothing downstream of it knows or cares.
//
// It is a FALLBACK, not a heuristic: there is no reliable way to know a request
// is "large" before generating it (the prompt length says little about how many
// roles a model will invent), and a wrong guess would either split flows that
// did not need it or fail to split the ones that did. Running it only after a
// timeout-class failure of the single call means small and medium flows take a
// byte-identical path to before, and the second attempt costs nothing on a turn
// that would otherwise have ended in an error card.

const PART_ROLES_INSTRUCTION = [
  'Build this flow in two steps. This is STEP 1 of 2 — the ROLES only.',
  '',
  'Return the bundle with the flow `name`, `description`, `stages` and the complete',
  '`roles` array, where each role carries `id`, `displayName`, `role`, `sessionPolicy`',
  'and a real `systemPrompt`.',
  '',
  'Do NOT add `outcomes`, `triggers`, `channels`, `emits`, `github`, `inputs`, `outputs`,',
  '`labels`, `gates` or `humans` yet — step 2 wires all of that. Keep every systemPrompt',
  'focused so this reply stays comfortably inside the output limit.',
].join('\n');

const PART_WIRING_INSTRUCTION = [
  'This is STEP 2 of 2 — the WIRING. The roles from step 1 are already in the current',
  'bundle above.',
  '',
  'Return the ops that wire them together: the `labels` registry (including any human',
  'gates), `gates`, `humans`, and each role\'s `outcomes`, `triggers`, `channels`, `emits`,',
  '`github`, `inputs`, `outputs`, `dependsOn` and `parent` via `patchRole`.',
  '',
  'Do not re-add a role that already exists and do not restate a role\'s `systemPrompt` —',
  'patch only the wiring keys, so this reply stays small.',
].join('\n');

// The ordered parts of a generate-in-parts run. `contract` is not passed to the
// model — it records which of buildCopilotSystem's two contracts the part's own
// bundle state selects, so a test can assert the intended one is in force.
const GENERATION_PARTS = Object.freeze([
  Object.freeze({ id: 'roles', contract: 'bundle', instruction: PART_ROLES_INSTRUCTION }),
  Object.freeze({ id: 'wiring', contract: 'ops', instruction: PART_WIRING_INSTRUCTION }),
]);

/**
 * True when this turn is a fresh whole-bundle generation — the only kind that
 * can be split. A REVISION turn already answers with a small op list against an
 * existing bundle, so it neither needs nor can use a roles-then-wiring split
 * (there is nothing to generate a roles pass for).
 */
function canGenerateInParts(bundle) {
  return !(isPlainObject(bundle) && Array.isArray(bundle.roles) && bundle.roles.length > 0);
}

/** The payload for one part. `bundle` is the state that part builds on. */
function buildPartRequest({ part, bundle, messages, formatDoc, addendum }) {
  const request = buildCopilotRequest({
    bundle,
    messages: [...messages, { role: 'user', content: part.instruction }],
    formatDoc,
    addendum,
  });
  return { ...request, max_tokens: MAX_TOKENS_PART };
}

// A transport failure the generate-in-parts fallback can plausibly recover from,
// and the one class of failure whose guidance is "describe it in smaller parts /
// pick a faster model". Both halves of #2131 key on THIS predicate, so the card
// the user reads and the retry the server performs can never disagree about what
// counts as a timeout. `HTTP 502`/`HTTP 504` are folded in on purpose: an
// upstream gateway that gives up on a long request reports it as a bad gateway,
// not as a timeout, and the remedy is the same either way.
const TIMEOUT_FAILURE_RE = /timeout|timed out|deadline|ETIMEDOUT|ECONNRESET|socket hang up|HTTP 50[24]|Gateway Time-?out|Bad Gateway/i;

/** True for a timeout-class transport failure (see TIMEOUT_FAILURE_RE). */
function isTimeoutFailure(err) {
  const msg = err && typeof err.message === 'string' ? err.message : String(err || '');
  return TIMEOUT_FAILURE_RE.test(msg);
}

/**
 * Classify a failed turn for the NDJSON error event. The `code` is the stable
 * contract the client maps to plain-language guidance — it exists so the browser
 * does not have to re-derive the class by matching on a transport error string
 * (which would drift the moment a provider reworded one). The raw `detail` rides
 * along for debugging and is shown behind an expander, never as the headline.
 */
function classifyTurnFailure(err) {
  const detail = (err && typeof err.message === 'string' && err.message.trim())
    ? err.message.trim()
    : 'the Copilot turn failed';
  if (isTimeoutFailure(err)) return { status: 504, code: 'llm-timeout', detail };
  if (/no parseable bundle/i.test(detail)) return { status: 502, code: 'no-parseable-bundle', detail };
  return { status: 502, code: 'llm-failed', detail };
}

/**
 * Run the parts sequence and return the merged bundle as a whole-bundle reply
 * TEXT, so `runCopilot`'s loop can treat it exactly like a single-call reply.
 *
 * Fail-fast: a part that does not produce a usable result throws, and the caller
 * surfaces the original single-call failure instead — a half-generated flow is
 * worse than a clear error, since the user would apply a bundle with roles and
 * no wiring believing the Copilot had finished.
 */
async function generateBundleInParts({
  bundle, messages, callLlm, formatDoc, addendum, progress, signal,
}) {
  let current = bundle;
  let summary = '';
  for (let i = 0; i < GENERATION_PARTS.length; i++) {
    if (signal && signal.aborted) throw abortedError();
    const part = GENERATION_PARTS[i];
    progress({
      type: 'phase', phase: 'generating', part: i + 1, parts: GENERATION_PARTS.length, partId: part.id,
    });
    const text = await callLlm(buildPartRequest({ part, bundle: current, messages, formatDoc, addendum }));
    if (signal && signal.aborted) throw abortedError();
    const parsed = parseCopilotResponse(text);
    if (!parsed) throw new Error(`the ${part.id} step of the split generation returned no parseable reply`);
    if (parsed.bundle) {
      current = parsed.bundle;
    } else if (parsed.ops) {
      // A failed application is fatal here rather than repairable: the repair
      // loop needs one complete candidate, and re-asking a part is a third call
      // this turn has no budget for.
      current = applyCopilotOps(current, parsed.ops);
    } else {
      throw new Error(`the ${part.id} step of the split generation returned neither a bundle nor ops`);
    }
    if (parsed.summary) summary = parsed.summary;
  }
  return { text: JSON.stringify({ summary, bundle: current }), bundle: current };
}

// ── the generate → validate → repair loop ────────────────────────────────────

// A turn the caller stopped (#2087). Distinct from every transport failure so
// the route can end the stream silently instead of emitting an error event the
// client would render as a failed generation — the client asked for this.
const COPILOT_ABORTED = 'copilot-aborted';

function abortedError() {
  const err = new Error('the Copilot turn was stopped');
  err.code = COPILOT_ABORTED;
  return err;
}

/** True for the error `runCopilot` throws when its signal was aborted. */
function isCopilotAborted(err) {
  return !!err && err.code === COPILOT_ABORTED;
}

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
 * `onProgress(ev)` (#1070, optional) is called with `{type:'phase', phase}`
 * events as the loop advances — `generating` before the first LLM call,
 * `repairing` (+ `iteration`, 1-based) before each repair call, `validating`
 * after each reply lands. The NDJSON route forwards them to the client;
 * omitting the hook keeps the loop's behaviour byte-identical.
 *
 * `signal` (#2087, optional AbortSignal) ends the turn's SERVER-side work:
 * checked at the top of every iteration, so an abort during iteration 1 issues
 * no iteration-2 request, and threaded on into `callLlm` by the route so the
 * call already in flight is destroyed rather than merely ignored. Aborting
 * throws a `COPILOT_ABORTED` error even when a best-effort bundle exists — a
 * stopped turn must leave no proposal (AC11), so returning the partial result
 * would be exactly wrong. Omitting the signal keeps the loop byte-identical.
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
  onProgress,
  signal,
}) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const baseBundle = isPlainObject(bundle) ? bundle : emptyDraftBundle();
  let request = buildCopilotRequest({ bundle: baseBundle, messages, formatDoc, addendum });

  let best = null; // { bundle, summary, lints } from the last parseable iteration
  let repairIterations = 0;
  let generatedInParts = false;
  // What to replay as the assistant turn on a repair. Normally the reply text
  // itself; after a parts run the merged bundle already sits in the rebuilt
  // request's system prompt, so echoing it a second time would double the
  // request for no gain.
  let echo = null;

  for (let attempt = 0; attempt <= maxRepairIterations; attempt++) {
    // AC9: no further LLM request is issued for a stopped turn. The check sits
    // BEFORE the phase event too, so a stopped turn does not announce a
    // repair iteration it will never run.
    if (signal && signal.aborted) throw abortedError();
    progress(attempt === 0
      ? { type: 'phase', phase: 'generating' }
      : { type: 'phase', phase: 'repairing', iteration: attempt });
    let text;
    try {
      text = await callLlm(request);
    } catch (err) {
      // An aborted call is not a transport failure to fall back from: a
      // stopped turn must leave no proposal (AC11), so it can never take the
      // best-effort `break` below.
      if (signal && signal.aborted) throw abortedError();
      // #2131: the single big generation timed out. Retry it as a bounded
      // sequence of smaller calls before giving up — only on the FIRST call
      // (a repair is already small, so a timeout there is not about size),
      // only once, and only for a fresh whole-bundle generation.
      if (attempt === 0 && !best && !generatedInParts
        && canGenerateInParts(baseBundle) && isTimeoutFailure(err)) {
        generatedInParts = true;
        let parts;
        try {
          parts = await generateBundleInParts({
            bundle: baseBundle, messages, callLlm, formatDoc, addendum, progress, signal,
          });
        } catch (partErr) {
          if (isCopilotAborted(partErr)) throw partErr;
          // Re-throw the ORIGINAL failure, with the fallback's own reason
          // appended. The turn began by timing out, so "describe it in smaller
          // parts / pick a faster model" stays the right guidance whatever went
          // wrong on the second attempt — while the detail keeps both reasons
          // for whoever reads the expander.
          err.message = `${err.message} (split generation also failed: ${partErr.message})`;
          throw err;
        }
        text = parts.text;
        // Repairs now go against the MERGED bundle, which puts them on the ops
        // contract — a fix is a small op list rather than a second full-size
        // regeneration, which is the very call that just timed out.
        request = buildCopilotRequest({ bundle: parts.bundle, messages, formatDoc, addendum });
        echo = '(the flow was generated in two steps; the merged bundle is in the current-bundle section above)';
      } else if (!best) {
        throw err; // nothing to fall back to — surface the transport error
      } else {
        break;     // best-effort with the previous iteration's bundle
      }
    }
    // The reply landed, but a stop may have won the race (edge case: "Stop
    // pressed in the same moment the result arrives"). Exactly one outcome
    // wins, and a stopped turn never applies anything.
    if (signal && signal.aborted) throw abortedError();
    progress({ type: 'phase', phase: 'validating' });

    const parsed = parseCopilotResponse(text);
    let findings;
    if (!parsed) {
      findings = [{ code: 'unparseable-output', severity: 'error', message: 'the reply was not a parseable {"summary", "bundle"} or {"summary", "ops"} JSON object' }];
    } else {
      // Patch contract (#1071): apply the op list to the CURRENT bundle; the
      // result runs through the same gate as a whole-bundle reply. A failed
      // application becomes a repairable finding, and the model may always
      // fall back to a whole bundle.
      let candidate = parsed.bundle || null;
      let opsError = null;
      if (!candidate && parsed.ops) {
        try { candidate = applyCopilotOps(baseBundle, parsed.ops); }
        catch (err) { opsError = err.message; }
      }
      if (!candidate) {
        findings = [{ code: 'invalid-ops', severity: 'error', message: opsError || 'the ops list could not be applied' }];
      } else {
        const ev = evaluateBundle(candidate);
        best = { bundle: ev.bundle, summary: parsed.summary, lints: ev.lints };
        findings = errorLints(ev.lints);
      }
    }

    if (!findings.length || attempt === maxRepairIterations) break;
    repairIterations++;
    request = {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: echo ?? (typeof text === 'string' ? text : '') },
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
    generatedInParts,
  };
}

module.exports = {
  MAX_REPAIR_ITERATIONS,
  MAX_TOKENS_PART,
  GENERATION_PARTS,
  COPILOT_HISTORY_CAP,
  SYSTEM_PROMPT_CHAR_LIMIT,
  COPILOT_ABORTED,
  isCopilotAborted,
  canGenerateInParts,
  buildPartRequest,
  isTimeoutFailure,
  classifyTurnFailure,
  generateBundleInParts,
  sanitizeBundle,
  parseCopilotResponse,
  applyCopilotOps,
  sanitizeCopilotHistory,
  evaluateBundle,
  computeChanges,
  readFormatDoc,
  readPromptAddendum,
  buildCopilotRequest,
  buildRepairMessage,
  measureCopilotSystemPrompt,
  runCopilot,
};
