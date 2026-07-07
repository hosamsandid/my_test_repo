'use strict';

// ─── Catalog v2 — typed integration ports on role templates (#420) ──────────
//
// Agent templates historically hard-wire concrete triggers (e.g. the dispatcher
// pattern's `labelFilter: "assigned:{{agentId}}"`), which makes them usable only
// inside that one wiring. Catalog v2 lets a template declare *abstract* ports;
// the Flow-Weaver (#421) binds them at composition time and generates the
// concrete, team-scoped triggers and labels (`<stagePrefix>:author-go`, …).
// Everything here is additive and backwards-compatible: templates without the
// new fields normalise to `standalone` with empty ports, and the legacy
// Team-Setup path keeps using the raw template verbatim.
//
// Template-level additions:
//   patternRole:   'scout' | 'author' | 'companion' | 'intake' | 'standalone'
//                  — the role's place in the per-stage pattern
//                    Scout (gap+evidence) → Author → Companion (review+feedback+escalation).
//   stageAffinity: string[] — grouping hint for the wizard's stage picker.
//   ports: {
//     consumes: [{ artifact: 'pr'|'issue', fromSlot: 'stage-entry'|'stage-author' }],
//     produces: { pr?: true, issue?: true },   // defaults from template.github
//   }
//
// Trigger-level addition:
//   intrinsic: true — this trigger is part of the role's essence (issue-triage's
//   `issues.opened`, self-curation crons, …) and is KEPT when the weaver
//   composes the role. Triggers without the flag are wiring-specific (the
//   dispatcher's `assigned:{{agentId}}` path) and are dropped by the weaver;
//   the legacy wizard path is unaffected and always uses all triggers.

const PATTERN_ROLES = ['scout', 'author', 'companion', 'intake', 'standalone'];
const PORT_SLOTS = ['stage-entry', 'stage-author'];

function normalizePatternRole(v) {
  return PATTERN_ROLES.includes(v) ? v : 'standalone';
}

function normalizeConsumes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const artifact = c.artifact === 'issue' ? 'issue' : c.artifact === 'pr' ? 'pr' : null;
    if (!artifact || !PORT_SLOTS.includes(c.fromSlot)) continue;
    out.push({ artifact, fromSlot: c.fromSlot });
  }
  return out;
}

/**
 * Normalise a template's catalog-v2 surface. Pure; never throws on odd input.
 * @param {object} t - a raw agent template (or anything template-shaped)
 * @returns {{ patternRole, stageAffinity, ports: { consumes, produces } }}
 */
function normalizeTemplatePorts(t) {
  const tpl = t && typeof t === 'object' ? t : {};
  const rawPorts = tpl.ports && typeof tpl.ports === 'object' ? tpl.ports : {};
  const rawProduces = rawPorts.produces && typeof rawPorts.produces === 'object' ? rawPorts.produces : null;
  // produces defaults from the existing `github` flags so already-tagged
  // producers (developer, documentation-sync, business-analyst) need no
  // duplicate declaration.
  const produces = {
    pr: rawProduces ? !!rawProduces.pr : !!(tpl.github && tpl.github.producesPr),
    issue: rawProduces ? !!rawProduces.issue : !!(tpl.github && tpl.github.producesIssue),
  };
  return {
    patternRole: normalizePatternRole(tpl.patternRole),
    stageAffinity: Array.isArray(tpl.stageAffinity)
      ? tpl.stageAffinity.filter(s => typeof s === 'string' && s)
      : [],
    ports: { consumes: normalizeConsumes(rawPorts.consumes), produces },
  };
}

// The triggers the weaver keeps when composing this role: those marked
// `intrinsic: true`. Everything else on the template is wiring for a specific
// pattern (dispatcher et al.) and is replaced by weaver-generated wiring.
function intrinsicTriggers(t) {
  return (t && Array.isArray(t.triggers) ? t.triggers : []).filter(tr => tr && tr.intrinsic === true);
}

module.exports = { normalizeTemplatePorts, intrinsicTriggers, PATTERN_ROLES, PORT_SLOTS };
