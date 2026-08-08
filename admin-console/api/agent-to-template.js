'use strict';

// ─── Extract a reusable Agent Template from a live agent (#1509) ─────────────
//
// Pure mapping: a running agent's resolved configuration → a *team-neutral*
// Agent Template object, ready to persist through the existing template
// create/validation path (`agent-templates-store.js` + POST /api/agent-templates).
// No filesystem side effects — the endpoint in api.js reads the live config,
// resolves the effective prompt / skills / sessionPolicy / triggers, and feeds
// them here; the result is validated + collision-checked + written by the caller.
//
// The template is built by CONSTRUCTION (an allowlist of known template fields),
// never by stripping fields off the agent config. That guarantees AC7 — no
// runtime/identity field (userId/token/environmentId/teamId/enabled/role) and no
// team-specific composition metadata (stage/port/label-suffix/role-in-team) can
// ever leak into the extracted template, even as the agent config grows new
// fields in the future.

// Same slug shape the template store enforces on ids.
const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// The template `category` vocabulary (mirrors RoleTemplates.jsx + seeds).
const CATEGORIES = ['chat', 'reactive', 'pattern'];
// Catalog-v2 pattern roles (mirrors agent-templates-store.js PATTERN_ROLES).
const PATTERN_ROLES = ['scout', 'author', 'companion', 'intake', 'standalone'];

// Trigger types a template may carry (agent-templates-store.js TRIGGER_TYPES).
// A live agent may also run `loop` triggers — those cannot be expressed in a
// template (the validator rejects the type), so they are dropped on extraction.
const TEMPLATE_TRIGGER_TYPES = new Set(['cron', 'once', 'http', 'github-event']);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// Turn an arbitrary agent id into a valid, non-empty template slug.
// Lowercases, collapses runs of non-slug chars to a single hyphen, trims the
// leading/trailing hyphens the id regex forbids. Falls back to `agent` when the
// source id slugifies to nothing (e.g. an all-symbol id).
function slugifyTemplateId(agentId) {
  const slug = String(agentId == null ? '' : agentId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return TEMPLATE_ID_RE.test(slug) ? slug : 'agent';
}

// A unique template id suggestion (AC2): the slugified agent id, de-duplicated
// against the taken set (across BOTH template tiers) with a `-2`, `-3`, … suffix
// — the same shape as the Clone dialog's `suggestCloneId`.
function suggestTemplateId(agentId, takenIds) {
  const taken = takenIds instanceof Set ? takenIds : new Set(takenIds || []);
  const base = slugifyTemplateId(agentId);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// Infer the template `category` from the source agent (AC2, editable default).
// A concrete value already on the config wins; otherwise a per-invocation agent
// reads as event-driven (`reactive`), a persistent one as an always-on `chat`
// companion — mirrors the RoleTemplates category help text.
function inferCategory(cfg) {
  const c = cfg || {};
  if (CATEGORIES.includes(c.category)) return c.category;
  return c.sessionPolicy === 'per-invocation' ? 'reactive' : 'chat';
}

// Infer the template `patternRole` from the source agent's role (AC2, editable).
// A concrete value already on the config wins; a standalone chat agent maps to
// `standalone`, a team member to `author` (a sensible working-role default).
function inferPatternRole(cfg) {
  const c = cfg || {};
  if (PATTERN_ROLES.includes(c.patternRole)) return c.patternRole;
  return c.role === 'team-member' ? 'author' : 'standalone';
}

// Resolve the sessionPolicy carried onto the template (AC5) — the two behaviour
// values the runtime understands, defaulting to `persistent` when unset.
function resolveSessionPolicy(cfg) {
  return (cfg && cfg.sessionPolicy === 'per-invocation') ? 'per-invocation' : 'persistent';
}

// Convert one live-agent trigger (triggers.json shape) into the template trigger
// shape `buildMemberFromTemplate` expects, so an extracted template round-trips
// (AC8). The inverse of process-template.js `buildMemberFromTemplate`:
//   - wake text lives under `prompt` at runtime → `promptTemplate` on a template
//   - per-agent runtime stamps (createdAt/activatedAt/repo) and the http
//     `secret` are dropped — they are re-injected/regenerated at materialise
// Returns null for a trigger type a template cannot express (e.g. `loop`).
function agentTriggerToTemplateTrigger(tr) {
  if (!tr || typeof tr !== 'object' || !TEMPLATE_TRIGGER_TYPES.has(tr.type)) return null;
  const out = {
    id: tr.id,
    type: tr.type,
    enabled: tr.enabled !== false,
  };
  if (isNonEmptyString(tr.description)) out.description = tr.description;
  // Runtime stores the wake instruction under `prompt`; a template stores it as
  // `promptTemplate` (buildMemberFromTemplate reads promptTemplate → member prompt).
  const wake = isNonEmptyString(tr.promptTemplate) ? tr.promptTemplate
    : (isNonEmptyString(tr.prompt) ? tr.prompt : '');
  if (wake) out.promptTemplate = wake;
  if (tr.intrinsic === true) out.intrinsic = true;
  if (tr.type === 'cron' && isNonEmptyString(tr.cron)) out.cron = tr.cron;
  if (tr.type === 'once' && isNonEmptyString(tr.at)) out.at = tr.at;
  if (tr.type === 'github-event') {
    out.events = Array.isArray(tr.events) ? tr.events.slice() : [];
    if (isNonEmptyString(tr.labelFilter)) out.labelFilter = tr.labelFilter;
    // A truthy `claim` is preserved so buildMemberFromTemplate re-derives it from
    // the concrete label; its absence (an opt-out) stays opted out.
    if (tr.claim) out.claim = tr.claim;
    if (tr.transport === 'internal') out.transport = 'internal';
    if (tr.dataFlow) out.dataFlow = true;
    if (tr.channel) out.channel = true;
    if (Array.isArray(tr.sources)) out.sources = tr.sources.slice();
  }
  if (isNonEmptyString(tr.preCheckScript)) out.preCheckScript = tr.preCheckScript;
  if (tr.preCheckEnv && typeof tr.preCheckEnv === 'object' && !Array.isArray(tr.preCheckEnv)) {
    out.preCheckEnv = { ...tr.preCheckEnv };
  }
  return out;
}

/**
 * Build a team-neutral Agent Template object from a live agent's resolved
 * configuration (#1509). Pure; never throws.
 *
 * @param {object} args
 * @param {string}   args.id              - the (unique) template id to write
 * @param {string}   args.displayName     - the template display name
 * @param {string}   [args.description]   - optional description
 * @param {string}   [args.category]      - one of CATEGORIES (else inferred)
 * @param {string}   [args.patternRole]   - one of PATTERN_ROLES (else inferred)
 * @param {object}   args.cfg             - the source agent config (for inference)
 * @param {string}   args.effectivePrompt - the resolved effective system prompt
 * @param {string[]} args.skills          - the source agent's effective skills
 * @param {string}   args.sessionPolicy   - resolved sessionPolicy
 * @param {Array}    [args.triggers]      - the source agent's triggers.json
 * @param {boolean}  [args.includeTriggers] - carry triggers as inline triggers[]
 * @returns {object} a template object ready for validateTemplate + persist
 */
function buildTemplateFromAgent(args = {}) {
  const {
    id,
    displayName,
    description,
    category,
    patternRole,
    cfg = {},
    effectivePrompt,
    skills,
    sessionPolicy,
    triggers,
    includeTriggers,
  } = args;

  const template = {
    templateSchemaVersion: 1,
    id,
    displayName,
    category: CATEGORIES.includes(category) ? category : inferCategory(cfg),
    patternRole: PATTERN_ROLES.includes(patternRole) ? patternRole : inferPatternRole(cfg),
    // The effective system prompt is stored under `promptTemplate` (verbatim —
    // not stripped) so that instantiating a new agent from this template through
    // buildMemberFromTemplate reproduces the source prompt (AC5, AC8).
    promptTemplate: typeof effectivePrompt === 'string' ? effectivePrompt : '',
    // Skills carried over as the template grant (AC5).
    skills: Array.isArray(skills) ? skills.slice() : [],
    // sessionPolicy carried explicitly so a persistent source stays persistent (AC5).
    sessionPolicy: sessionPolicy === 'per-invocation' ? 'per-invocation' : 'persistent',
  };

  if (isNonEmptyString(description)) template.description = description.trim();

  // Triggers only when opted in (AC6). Loop / unexpressible triggers drop out.
  if (includeTriggers && Array.isArray(triggers)) {
    const mapped = triggers.map(agentTriggerToTemplateTrigger).filter(Boolean);
    if (mapped.length) template.triggers = mapped;
  }

  return template;
}

module.exports = {
  TEMPLATE_ID_RE,
  CATEGORIES,
  PATTERN_ROLES,
  TEMPLATE_TRIGGER_TYPES,
  slugifyTemplateId,
  suggestTemplateId,
  inferCategory,
  inferPatternRole,
  resolveSessionPolicy,
  agentTriggerToTemplateTrigger,
  buildTemplateFromAgent,
};
