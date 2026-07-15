'use strict';

// ─── Role-template store — validation + two-tier overlay helpers (#587) ──────
//
// Role templates ship as repo-seeded JSON under the pool volume
// (AGENT_TEMPLATES_DIR), wiped and re-copied on every `make seed-templates`.
// UI create/edit/delete persist to a SEPARATE user store on the durable
// workspace volume (USER_AGENT_TEMPLATES_DIR) which the re-seed never touches;
// the user store SHADOWS the defaults (user wins), so a UI edit survives a
// re-seed and a seeded built-in can be reset to default by removing its overlay
// entry. This module is pure (no filesystem side effects beyond the
// traversal-safe path resolution in `safeTemplateFile`) so it is unit-testable
// without a running stack — the IO lives in api.js.

const path = require('path');

// Same slug shape the read loaders already enforce on template filenames:
// lowercase letters / digits / hyphens, not starting with a hyphen.
const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// Trigger types the runtime understands (see CLAUDE.md → Autonomous Triggers).
const TRIGGER_TYPES = new Set(['cron', 'once', 'http', 'github-event']);

// Catalog-v2 pattern roles (mirrors catalog-ports.js).
const PATTERN_ROLES = ['scout', 'author', 'companion', 'intake', 'standalone'];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// A template is usable only if it carries prompt text in one of the two
// accepted fields (`prompt` for a literal, `promptTemplate` for one with
// `{{var}}` placeholders resolved per-member at materialise time).
function hasPrompt(t) {
  return isNonEmptyString(t.prompt) || isNonEmptyString(t.promptTemplate);
}

// Validate the optional `triggers` array. Kept intentionally lenient about the
// per-type detail fields (cron string, events, …) — the goal is to reject
// clearly malformed input (AC-6), not to re-implement the scheduler's parser.
function validateTriggers(triggers) {
  const errors = [];
  if (triggers === undefined) return errors;
  if (!Array.isArray(triggers)) {
    errors.push('triggers must be an array');
    return errors;
  }
  triggers.forEach((tr, i) => {
    if (!tr || typeof tr !== 'object' || Array.isArray(tr)) {
      errors.push(`triggers[${i}] must be an object`);
      return;
    }
    if (!isNonEmptyString(tr.id)) errors.push(`triggers[${i}].id is required`);
    if (!TRIGGER_TYPES.has(tr.type)) {
      errors.push(`triggers[${i}].type must be one of ${[...TRIGGER_TYPES].join(', ')}`);
    }
    if (tr.events !== undefined &&
        !(Array.isArray(tr.events) && tr.events.every(e => typeof e === 'string'))) {
      errors.push(`triggers[${i}].events must be an array of strings`);
    }
    if (tr.emits !== undefined &&
        !(Array.isArray(tr.emits) && tr.emits.every(e => typeof e === 'string'))) {
      errors.push(`triggers[${i}].emits must be an array of strings`);
    }
  });
  return errors;
}

// Validate the optional catalog-v2 composition surface + github flags.
function validatePorts(t) {
  const errors = [];
  if (t.patternRole !== undefined && !PATTERN_ROLES.includes(t.patternRole)) {
    errors.push(`patternRole must be one of ${PATTERN_ROLES.join(', ')}`);
  }
  if (t.stageAffinity !== undefined &&
      !(Array.isArray(t.stageAffinity) && t.stageAffinity.every(s => typeof s === 'string'))) {
    errors.push('stageAffinity must be an array of strings');
  }
  if (t.github !== undefined &&
      (typeof t.github !== 'object' || t.github === null || Array.isArray(t.github))) {
    errors.push('github must be an object');
  }
  if (t.ports !== undefined) {
    const p = t.ports;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      errors.push('ports must be an object');
    } else {
      if (p.consumes !== undefined) {
        if (!Array.isArray(p.consumes)) {
          errors.push('ports.consumes must be an array');
        } else {
          p.consumes.forEach((c, i) => {
            if (!c || typeof c !== 'object' || Array.isArray(c)) {
              errors.push(`ports.consumes[${i}] must be an object`);
            } else if (c.artifact !== 'pr' && c.artifact !== 'issue') {
              errors.push(`ports.consumes[${i}].artifact must be 'pr' or 'issue'`);
            }
          });
        }
      }
      if (p.produces !== undefined &&
          (typeof p.produces !== 'object' || p.produces === null || Array.isArray(p.produces))) {
        errors.push('ports.produces must be an object');
      }
    }
  }
  return errors;
}

/**
 * Validate a create/update payload. Pure; never throws.
 *
 * @param {object} body - the raw request body
 * @param {object} [opts]
 * @param {boolean} [opts.requireId] - POST: id must be present + slug-valid
 * @param {string}  [opts.expectId]  - PUT: if body carries an id it must equal this
 * @returns {{ valid: boolean, errors: string[], value: object|null }}
 */
function validateTemplate(body, opts = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['template body must be an object'], value: null };
  }
  const errors = [];
  const t = { ...body };
  const id = t.id;

  if (id !== undefined && (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id))) {
    errors.push('id must be a slug: lowercase letters, digits and hyphens, not starting with a hyphen');
  }
  if (opts.requireId && !isNonEmptyString(id)) {
    errors.push('id is required');
  }
  if (opts.expectId !== undefined && id !== undefined && id !== opts.expectId) {
    errors.push('id in body does not match id in path');
  }
  if (!isNonEmptyString(t.displayName)) errors.push('displayName is required');
  if (!hasPrompt(t)) errors.push('a non-empty prompt or promptTemplate is required');

  errors.push(...validateTriggers(t.triggers));
  errors.push(...validatePorts(t));

  return { valid: errors.length === 0, errors, value: errors.length === 0 ? t : null };
}

/**
 * Traversal-safe resolution of `<baseDir>/<id>.json`. Returns null on an
 * invalid id or any path escaping baseDir (the path.resolve + path.relative
 * pattern is what CodeQL's path-injection query recognises in-flow).
 */
function safeTemplateFile(baseDir, id) {
  if (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id)) return null;
  const base = path.resolve(baseDir);
  const file = path.resolve(base, id + '.json');
  const rel = path.relative(base, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return file;
}

/**
 * The effective origin of a merged template id:
 *   - 'override' — a user file shadows a seeded default (reset-to-default resets it)
 *   - 'user'     — user-only template (delete removes it entirely)
 *   - 'default'  — seeded built-in with no overlay (read-only)
 */
function templateOrigin(hasDefault, hasUser) {
  if (hasUser && hasDefault) return 'override';
  if (hasUser) return 'user';
  return 'default';
}

module.exports = {
  TEMPLATE_ID_RE,
  TRIGGER_TYPES,
  PATTERN_ROLES,
  hasPrompt,
  validateTriggers,
  validatePorts,
  validateTemplate,
  safeTemplateFile,
  templateOrigin,
};
