'use strict';

// Persistent skill domains (skill-aggregation Phase 2, #780). A team carries a
// short, human-confirmed list of DOMAINS — { id, name, scope, roles[] } — each the
// routing target and NAME source for at most one living team skill. Domains are
// the durable version of the ephemeral per-pass themes (groupRelatedClusters in
// knowledge-convergence.js): a stable taxonomy the collector classifies converged
// clusters against, instead of spawning one micro-skill per lesson.
//
// Deliberately PURE — no fs, no network, an injected `now` — so it is unit-testable
// without booting the orchestrator (repo convention: test pure helper cores only).
// The IO (read/write the per-team domains document, the one-time LLM bootstrap
// call) lives in orchestrator.js / admin-console api.js.
//
// Domain creation / merge / rename / split is ALWAYS a human decision, at every
// autonomy level (§3.1 + §6 of docs/skill-aggregation-concept.md): nothing here
// auto-mutates a confirmed list; the collector only PROPOSES a new domain as a
// review card (see knowledge-routing.js planDomainRouting). The operator CRUD
// helpers below are the seam the admin-console domain endpoints call.

// Mirror the admin-console/curator SKILL_NAME_RE so a domain id is always usable
// as a writable skill directory name (domain-based naming, AC4).
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+([.:][a-zA-Z0-9_-]+)*$/;

// A domain's audience scope. `team` = whole-team practice; `role` = one role's
// specialism; `cross-role` = a flow spanning several roles (explicitly first-class
// per the concept — "how we do development" spans developer/reworker/reviewer).
const SCOPES = Object.freeze(['team', 'role', 'cross-role']);

// Soft skill budget: the default per-team cap (~5–15) above which new-domain
// proposals are pushed into the merge/override flow rather than freely accepted
// (§3.5). Configurable per team via knowledgeCuration.skillBudget.
const DEFAULT_SKILL_BUDGET = 12;

const DOMAIN_DOC_VERSION = 1;

// ---------------------------------------------------------------------------
// Naming (AC4)
// ---------------------------------------------------------------------------

// Slugify a human domain NAME into a stable, skill-writable id. Unlike the retired
// slugifySkillName-from-lesson-text (which took the first six words of a lesson),
// this operates on a short, meaningful domain name — so ids read as "dev-workflow",
// "ci-build", not "enqueuepending-in-orchestrator-js-stamps-a".
function slugifyDomainId(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
    .join('-');
  return slug && SKILL_NAME_RE.test(slug) ? slug : 'domain';
}

// The skill name a domain maps to (AC4: new skills are named after their domain).
// A domain may carry an explicit `skill` (e.g. after an operator renamed the
// underlying skill dir); otherwise the id — already a clean slug — is the name.
function domainSkillName(domain) {
  const d = domain && typeof domain === 'object' ? domain : {};
  if (typeof d.skill === 'string' && SKILL_NAME_RE.test(d.skill)) return d.skill;
  if (typeof d.id === 'string' && SKILL_NAME_RE.test(d.id)) return d.id;
  return slugifyDomainId(d.name);
}

// ---------------------------------------------------------------------------
// Domain + document construction
// ---------------------------------------------------------------------------

function normRoles(roles) {
  return [...new Set(
    (Array.isArray(roles) ? roles : [])
      .map((r) => (typeof r === 'string' ? r.trim() : ''))
      .filter(Boolean),
  )];
}

// Build a single domain record. `name` is required (a domain with no name is
// dropped by validateDomains). Deterministic: id derives from name unless given.
function makeDomain({ id, name, scope, roles, skill, now } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString();
  const nm = typeof name === 'string' ? name.trim() : '';
  const domId = (typeof id === 'string' && SKILL_NAME_RE.test(id)) ? id : slugifyDomainId(nm);
  const out = {
    id: domId,
    name: nm || domId,
    scope: SCOPES.includes(scope) ? scope : 'team',
    roles: normRoles(roles),
    createdAt: ts,
  };
  if (typeof skill === 'string' && SKILL_NAME_RE.test(skill)) out.skill = skill;
  return out;
}

// An empty (unconfirmed) domain document — the fallback shape a team starts with
// before it is seeded or bootstrapped.
function emptyDomainDoc(now) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString();
  return { version: DOMAIN_DOC_VERSION, confirmed: false, domains: [], updatedAt: ts };
}

// Normalise a persisted (possibly legacy / partial) domain document into the
// canonical shape. Tolerant: a bare array of domains is accepted (treated as an
// unconfirmed list), invalid domains are dropped, ids de-duplicated.
function normalizeDomainDoc(raw, now) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString();
  let domainsIn = [];
  let confirmed = false;
  let updatedAt = ts;
  if (Array.isArray(raw)) {
    domainsIn = raw;
  } else if (raw && typeof raw === 'object') {
    domainsIn = Array.isArray(raw.domains) ? raw.domains : [];
    confirmed = raw.confirmed === true;
    if (typeof raw.updatedAt === 'string' && raw.updatedAt.trim()) updatedAt = raw.updatedAt.trim();
  }
  return {
    version: DOMAIN_DOC_VERSION,
    confirmed,
    domains: validateDomains(domainsIn, { now: ts }),
    updatedAt,
  };
}

// Filter/repair a list of domain records: keep only well-formed ones, dedupe by
// id (first wins). Pure — never throws.
function validateDomains(list, { now } = {}) {
  const seen = new Set();
  const out = [];
  for (const d of Array.isArray(list) ? list : []) {
    if (!d || typeof d !== 'object') continue;
    const name = typeof d.name === 'string' ? d.name.trim() : '';
    const hasExplicitId = typeof d.id === 'string' && SKILL_NAME_RE.test(d.id);
    // Need a real name OR an explicitly-provided id — an empty record is dropped
    // (a blank name alone would otherwise slug to the generic "domain").
    if (!name && !hasExplicitId) continue;
    const id = hasExplicitId ? d.id : slugifyDomainId(name);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(makeDomain({ id, name: name || id, scope: d.scope, roles: d.roles, skill: d.skill, now: d.createdAt || now }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seeding from role templates (§3.1)
// ---------------------------------------------------------------------------

// The default domain catalog for a software-delivery team. Base domains apply to
// any repo-backed team; role-gated ones are added when a matching role is present.
// `match` tests the set of lowercased role tokens (role ids AND their word-parts).
const SEED_CATALOG = [
  { name: 'Dev workflow', scope: 'cross-role', roles: ['developer', 'reworker'], match: null },
  { name: 'CI & build', scope: 'team', roles: [], match: null },
  { name: 'Repo conventions', scope: 'team', roles: [], match: null },
  { name: 'Review practice', scope: 'role', roles: ['code-reviewer'],
    match: (t) => t.has('review') || t.has('reviewer') || t.has('code-reviewer') || t.has('reworker') },
  { name: 'Requirements & refinement', scope: 'role', roles: ['business-analyst'],
    match: (t) => t.has('analyst') || t.has('business-analyst') || t.has('triage') || t.has('ba') },
];

// Seed a team's initial domain list from its role ids (a dev team starts with
// Dev workflow / CI & build / Repo conventions / Review practice, etc.). Base
// domains are always present; role-specific ones only when a matching role exists.
// Deterministic (catalog order). Returns domain records (not a doc).
function seedDomainsFromRoles(roles, { now } = {}) {
  const tokens = new Set();
  for (const r of normRoles(roles)) {
    const lc = r.toLowerCase();
    tokens.add(lc);
    for (const part of lc.split(/[^a-z0-9]+/).filter(Boolean)) tokens.add(part);
  }
  const out = [];
  for (const spec of SEED_CATALOG) {
    if (typeof spec.match === 'function' && !spec.match(tokens)) continue;
    out.push(makeDomain({ name: spec.name, scope: spec.scope, roles: spec.roles, now }));
  }
  return validateDomains(out, { now });
}

// ---------------------------------------------------------------------------
// Operator CRUD (pure planners; the admin-console endpoints do the IO)
// ---------------------------------------------------------------------------
//
// Each returns { ok, doc?, event?, error? }. On success `doc` is the new document
// and `event` the feed event to append. On a validation failure `ok:false` +
// `error` and the input doc is left untouched.

function _doc(docIn, now) {
  return normalizeDomainDoc(docIn, now);
}

function _touch(doc, domains, now, { confirmed } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString();
  return {
    version: DOMAIN_DOC_VERSION,
    confirmed: typeof confirmed === 'boolean' ? confirmed : doc.confirmed,
    domains,
    updatedAt: ts,
  };
}

function domainEvent(action, { teamId, now, domain, ids, name } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString();
  const ev = { type: 'domain', action, ts, teamId: typeof teamId === 'string' ? teamId : null };
  if (domain) ev.domain = { id: domain.id, name: domain.name };
  if (Array.isArray(ids)) ev.ids = ids.slice();
  if (typeof name === 'string') ev.name = name;
  return ev;
}

// Add a new operator-authored domain. Rejects a duplicate id.
function addDomain(docIn, input, { teamId, now } = {}) {
  const doc = _doc(docIn, now);
  const inName = input && typeof input.name === 'string' ? input.name.trim() : '';
  if (!inName) return { ok: false, error: 'name-required' };
  const domain = makeDomain({ ...input, now });
  if (doc.domains.some((d) => d.id === domain.id)) return { ok: false, error: 'duplicate-id' };
  const domains = [...doc.domains, domain];
  return { ok: true, doc: _touch(doc, domains, now), event: domainEvent('added', { teamId, now, domain }) };
}

// Rename a domain (its human name; the id / skill mapping are stable so the living
// skill dir is not moved).
function renameDomain(docIn, id, newName, { teamId, now } = {}) {
  const doc = _doc(docIn, now);
  const nm = typeof newName === 'string' ? newName.trim() : '';
  if (!nm) return { ok: false, error: 'name-required' };
  const idx = doc.domains.findIndex((d) => d.id === id);
  if (idx < 0) return { ok: false, error: 'not-found' };
  const domains = doc.domains.slice();
  const updated = { ...domains[idx], name: nm };
  domains[idx] = updated;
  return { ok: true, doc: _touch(doc, domains, now), event: domainEvent('renamed', { teamId, now, domain: updated, name: nm }) };
}

// Remove a domain from the taxonomy (does not delete its living skill — that is a
// separate operator action).
function removeDomain(docIn, id, { teamId, now } = {}) {
  const doc = _doc(docIn, now);
  const domain = doc.domains.find((d) => d.id === id);
  if (!domain) return { ok: false, error: 'not-found' };
  const domains = doc.domains.filter((d) => d.id !== id);
  return { ok: true, doc: _touch(doc, domains, now), event: domainEvent('removed', { teamId, now, domain }) };
}

// Merge ≥2 domains into one. The surviving domain keeps the first id (so its skill
// mapping is stable) unless a new name is given; roles are unioned.
function mergeDomains(docIn, ids, { name, scope, teamId, now } = {}) {
  const doc = _doc(docIn, now);
  const uniqIds = [...new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [])];
  if (uniqIds.length < 2) return { ok: false, error: 'need-two' };
  const targets = uniqIds.map((id) => doc.domains.find((d) => d.id === id)).filter(Boolean);
  if (targets.length !== uniqIds.length) return { ok: false, error: 'not-found' };
  const roles = normRoles(targets.flatMap((d) => d.roles));
  const mergedName = (typeof name === 'string' && name.trim()) ? name.trim() : targets[0].name;
  // Keep the first target's id + skill mapping so an existing living skill survives
  // the merge (the operator can rename separately).
  const merged = makeDomain({
    id: targets[0].id, name: mergedName, scope: scope || targets[0].scope,
    roles, skill: targets[0].skill, now: targets[0].createdAt,
  });
  const rest = doc.domains.filter((d) => !uniqIds.includes(d.id));
  const domains = [merged, ...rest];
  return { ok: true, doc: _touch(doc, domains, now), event: domainEvent('merged', { teamId, now, domain: merged, ids: uniqIds }) };
}

// Split one domain into ≥2 new domains (the original is replaced).
function splitDomain(docIn, id, parts, { teamId, now } = {}) {
  const doc = _doc(docIn, now);
  const idx = doc.domains.findIndex((d) => d.id === id);
  if (idx < 0) return { ok: false, error: 'not-found' };
  const newDomains = validateDomains(
    (Array.isArray(parts) ? parts : []).map((p) => makeDomain({ ...p, now })), { now },
  );
  if (newDomains.length < 2) return { ok: false, error: 'need-two' };
  const rest = doc.domains.filter((d) => d.id !== id);
  // A split part may collide with an existing (kept) domain id — drop such a part.
  const keptIds = new Set(rest.map((d) => d.id));
  const additions = newDomains.filter((d) => !keptIds.has(d.id));
  if (additions.length < 2) return { ok: false, error: 'id-collision' };
  const domains = [...rest, ...additions];
  return {
    ok: true, doc: _touch(doc, domains, now),
    event: domainEvent('split', { teamId, now, domain: doc.domains[idx], ids: additions.map((d) => d.id) }),
  };
}

// Confirm the domain list (seeded lists are confirmed by construction; a
// bootstrapped one waits for the operator to confirm). Optionally replaces the
// domains with the confirmed set.
function confirmDomains(docIn, { domains, teamId, now } = {}) {
  const doc = _doc(docIn, now);
  const next = domains !== undefined ? validateDomains(domains, { now }) : doc.domains;
  return {
    ok: true,
    doc: _touch(doc, next, now, { confirmed: true }),
    event: domainEvent('confirmed', { teamId, now }),
  };
}

// ---------------------------------------------------------------------------
// LLM bootstrap (§3.1 — one-time, operator-confirmed)
// ---------------------------------------------------------------------------

// Meta-prompt: propose 5–8 domains covering the team's existing lessons. Pure —
// the caller (api.js) supplies the model + transport (resolveAssistTarget +
// httpPostJson), exactly like buildSkillDraftRequest. The response is parsed by
// parseBootstrapResponse and ALWAYS operator-confirmed before it becomes the
// taxonomy — never auto-applied.
function buildBootstrapRequest(lessons, { min = 5, max = 8, roles } = {}) {
  const list = (Array.isArray(lessons) ? lessons : [])
    .map((l) => (typeof l === 'string' ? l : (l && l.text) || ''))
    .filter(Boolean)
    .slice(0, 200)
    .map((t, i) => `${i + 1}. ${t}`)
    .join('\n');
  const roleLine = normRoles(roles).length
    ? `The team's roles: ${normRoles(roles).join(', ')}.`
    : '';
  const instruction = [
    'You organise a team of AI software-delivery agents into skill DOMAINS.',
    'A domain is a durable practice ("Dev workflow", "CI & build", "Review practice") —',
    'the abstracted knowledge of a practice, NOT a single lesson.',
    roleLine,
    `Propose between ${min} and ${max} domains that together cover the lessons below.`,
    '',
    'Recorded lessons:',
    list || '(none yet — propose sensible defaults for a software-delivery team)',
    '',
    'Requirements:',
    '- Each domain: a short human name, a scope ("team" | "role" | "cross-role"), and the roles[] it serves.',
    '- Cover the material broadly; do NOT create one domain per lesson.',
    `- Output ONLY a JSON array of ${min}–${max} objects: [{"name": "...", "scope": "...", "roles": ["..."]}]`,
    '- No preamble, no code fences — just the JSON array.',
  ].filter((l) => l !== '').join('\n');
  return { max_tokens: 1024, messages: [{ role: 'user', content: instruction }] };
}

// Parse the bootstrap LLM response into domain inputs. Tolerant: extracts the first
// JSON array, ignores malformed entries. Returns [] on any failure so the caller
// falls back to seedDomainsFromRoles.
function parseBootstrapResponse(text, { now } = {}) {
  let arr = null;
  try {
    const s = typeof text === 'string' ? text : '';
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start >= 0 && end > start) arr = JSON.parse(s.slice(start, end + 1));
  } catch { arr = null; }
  if (!Array.isArray(arr)) return [];
  return validateDomains(arr.map((d) => makeDomain({
    name: d && d.name, scope: d && d.scope, roles: d && d.roles, now,
  })), { now });
}

// ---------------------------------------------------------------------------
// Skill budget (§3.5, AC5)
// ---------------------------------------------------------------------------

// The soft budget state for a team: how many living team skills exist vs the cap.
// `over` gates new-domain proposals into the merge/override flow (planDomainRouting).
function skillBudgetState(skillNames, { cap = DEFAULT_SKILL_BUDGET } = {}) {
  const capN = Number.isInteger(cap) && cap >= 1 ? cap : DEFAULT_SKILL_BUDGET;
  const used = Array.isArray(skillNames)
    ? new Set(skillNames.filter((n) => typeof n === 'string' && n)).size
    : (Number.isInteger(skillNames) ? Math.max(0, skillNames) : 0);
  return { cap: capN, used, remaining: Math.max(0, capN - used), over: used >= capN };
}

// How many domains an operator op would ADD (#2592, AC10): add → 1, split → the
// extra parts, confirm → the growth of the list. Rename/merge/remove never add.
function domainsAddedByOp(doc, op, payload = {}) {
  const current = doc && Array.isArray(doc.domains) ? doc.domains.length : 0;
  const p = payload && typeof payload === 'object' ? payload : {};
  if (op === 'add') return 1;
  if (op === 'split') {
    const parts = Array.isArray(p.parts) ? p.parts.filter((x) => x && typeof x.name === 'string' && x.name.trim()).length : 0;
    return Math.max(0, parts - 1);
  }
  if (op === 'confirm') {
    const next = Array.isArray(p.domains) ? p.domains.length : 0;
    return Math.max(0, next - current);
  }
  return 0;
}

// Every domain grows into exactly one skill, so a new domain is a future skill.
// Growing the taxonomy needs an explicit confirmation when the team is already at
// (or would go over) its soft skill budget — counting both living skills and
// domains that will become one. Declining changes nothing.
function domainGrowthNeedsConfirmation(doc, op, payload, budget) {
  const added = domainsAddedByOp(doc, op, payload);
  if (added <= 0 || !budget || !Number.isInteger(budget.cap)) return { needed: false, added };
  const domainCount = doc && Array.isArray(doc.domains) ? doc.domains.length : 0;
  const needed = !!budget.over || Math.max(budget.used || 0, domainCount) + added > budget.cap;
  return { needed, added };
}

module.exports = {
  SKILL_NAME_RE,
  SCOPES,
  DEFAULT_SKILL_BUDGET,
  DOMAIN_DOC_VERSION,
  slugifyDomainId,
  domainSkillName,
  makeDomain,
  emptyDomainDoc,
  normalizeDomainDoc,
  validateDomains,
  seedDomainsFromRoles,
  domainEvent,
  addDomain,
  renameDomain,
  removeDomain,
  mergeDomains,
  splitDomain,
  confirmDomains,
  buildBootstrapRequest,
  parseBootstrapResponse,
  skillBudgetState,
  domainsAddedByOp,
  domainGrowthNeedsConfirmation,
};
