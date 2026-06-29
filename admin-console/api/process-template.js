'use strict';

// ─── process-template bundle (Process Canvas, #334) ──────────────────────────
//
// A *process template* is a portable, git-committable JSON description of a
// modeled orchestration: the roles (each with its persona prompt and triggers,
// including the declarative `emits`), plus the human gates and the label
// registry. It is the export format of the Process Canvas and the import format
// for materialising a real team. Pure transforms only — no I/O here.
//
// Shape (processTemplateVersion 1):
//   {
//     processTemplateVersion: 1,
//     name, level,                       // level: 'live' | 'template' (informational)
//     roles: [ { id, displayName, role, sessionPolicy, systemPrompt,
//                triggers: [ { id, type, events, labelFilter, from, cron, at,
//                              emits, description, prompt } ] } ],
//     gates:  [ { label } ],
//     labels: [ { name, humanGate, brake } ],
//   }

const VERSION = 1;

// Strip a leading `<teamId>-` so an exported member id becomes a reusable role
// key (e.g. `acme-developer` → `developer`). Idempotent for ids without it.
function roleKeyOf(id, teamId) {
  if (teamId && id.startsWith(teamId + '-')) return id.slice(teamId.length + 1);
  return id;
}

// Slim a trigger for the bundle: keep what defines the wiring + behaviour, drop
// team-specific/runtime cruft (repo is re-applied at materialise time; secrets
// never live on triggers).
function bundleTrigger(t) {
  const out = { id: t.id, type: t.type, enabled: t.enabled !== false };
  if (t.type === 'github-event') {
    out.events = Array.isArray(t.events) ? t.events : [];
    if (t.from) out.from = t.from;
    if (t.labelFilter) out.labelFilter = t.labelFilter;
  } else if (t.type === 'cron') {
    out.cron = t.cron || null;
  } else if (t.type === 'once') {
    out.at = t.at || null;
  }
  if (Array.isArray(t.emits) && t.emits.length) out.emits = t.emits.slice();
  if (t.description) out.description = t.description;
  if (t.prompt) out.prompt = t.prompt;
  if (t.preCheckScript) out.preCheckScript = t.preCheckScript;
  if (t.preCheckEnv && typeof t.preCheckEnv === 'object') out.preCheckEnv = { ...t.preCheckEnv };
  return out;
}

/**
 * Assemble a process-template bundle.
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.level - 'live' | 'template'
 * @param {string} [opts.teamId] - when exporting a team, used to derive role keys
 * @param {Array} opts.roles - [{ id, displayName, role, sessionPolicy, systemPrompt, triggers }]
 * @param {Array} [opts.gates]
 * @param {Array} [opts.labels]
 */
function buildProcessTemplate({ name, level, teamId, roles, gates, labels }) {
  return {
    processTemplateVersion: VERSION,
    name: name || 'process-template',
    level: level || 'template',
    roles: (roles || []).map(r => ({
      id: roleKeyOf(r.id, teamId),
      displayName: r.displayName || r.id,
      role: r.role || 'team-member',
      sessionPolicy: r.sessionPolicy || 'persistent',
      systemPrompt: r.systemPrompt || '',
      triggers: (r.triggers || []).map(bundleTrigger),
    })),
    gates: (gates || []).map(g => ({ label: g.label })),
    labels: (labels || []).map(l => ({ name: l.name, humanGate: !!l.humanGate, brake: !!l.brake })),
  };
}

// Basic shape validation for a bundle. Returns { ok, error }.
// `allowEmptyRoles` is for in-progress drafts (#344) — materialisation still
// requires a non-empty role set, so the default stays strict.
function validateProcessTemplate(b, { allowEmptyRoles = false } = {}) {
  if (!b || typeof b !== 'object') return { ok: false, error: 'not an object' };
  if (b.processTemplateVersion !== VERSION) {
    return { ok: false, error: `unsupported processTemplateVersion (expected ${VERSION})` };
  }
  if (!Array.isArray(b.roles)) return { ok: false, error: 'roles must be an array' };
  if (!allowEmptyRoles && b.roles.length === 0) return { ok: false, error: 'roles must be a non-empty array' };
  for (const r of b.roles) {
    if (!r || typeof r.id !== 'string' || !r.id) return { ok: false, error: 'each role needs a string id' };
    if (r.triggers && !Array.isArray(r.triggers)) return { ok: false, error: `role ${r.id}: triggers must be an array` };
  }
  if (b.gates && !Array.isArray(b.gates)) return { ok: false, error: 'gates must be an array' };
  if (b.labels && !Array.isArray(b.labels)) return { ok: false, error: 'labels must be an array' };
  return { ok: true };
}

// An empty draft skeleton (#344).
function emptyDraftBundle(name) {
  return {
    processTemplateVersion: VERSION,
    name: name || 'Untitled process',
    level: 'template',
    roles: [],
    gates: [],
    labels: [],
  };
}

// Transform a bundle's roles into the `customRoles` shape consumed by
// POST /api/teams — pseudo-templates the existing materialisation loop renders
// exactly like catalog templates (var substitution over prompt + triggers).
function templateToCustomRoles(bundle) {
  return (bundle.roles || []).map(r => ({
    id: r.id,
    displayName: r.displayName || r.id,
    sessionPolicy: r.sessionPolicy === 'per-invocation' ? 'per-invocation' : undefined,
    promptTemplate: r.systemPrompt || '',
    triggers: (r.triggers || []).map(t => ({
      id: t.id,
      type: t.type,
      enabled: t.enabled !== false,
      events: t.events,
      labelFilter: t.labelFilter,
      from: t.from,
      cron: t.cron,
      at: t.at,
      emits: t.emits,
      description: t.description,
      promptTemplate: t.prompt || '',
      preCheckScript: t.preCheckScript,
      preCheckEnv: t.preCheckEnv,
    })),
  }));
}

module.exports = { buildProcessTemplate, validateProcessTemplate, templateToCustomRoles, emptyDraftBundle, roleKeyOf, VERSION };
