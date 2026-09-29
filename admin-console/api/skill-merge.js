'use strict';

// ---------------------------------------------------------------------------
// Skill merge — pure validator + planner (#631, concept docs/skill-lifecycle-
// concept.md §3.4).
//
// Merge folds N existing skills (skill + skill → skill) into ONE target skill:
// the operator drafts a combined SKILL.md (LLM-synthesised with a deterministic
// concat fallback), the target's provenance UNIONS every source's entryIds so
// the knowledge lineage survives, extra files are carried over (collisions
// namespaced under `files/<source-name>/…`), and every grant naming a retired
// source is migrated to the target so no member silently loses knowledge.
//
// This module is **pure** (no fs, no network, no clock beyond an injected
// `now`): it validates a merge request, states the target-tier permission the
// caller must hold, and computes the grant-migration / file-collision /
// provenance-union plans. The api.js endpoints do the file work (draft, write
// target, carry files, retire sources via the uniform delete path) and the
// orchestrator owns the workspace sync. Same "pure core + IO caller" discipline
// as skill-transfer.js / skill-deletion.js.
// ---------------------------------------------------------------------------

// #2307: the write-into-a-pool-tier rule is shared with skill-transfer.js
// (import/create/edit reuse it too) so it cannot drift between paths again —
// see requiredPermission below.
const { requiredPoolWritePermission } = require('./skill-transfer');

const SOURCE_TIERS = ['agent', 'team', 'global'];
const TARGET_TIERS = ['team', 'global'];

// Mirror the api.js regexes so a validated request is always writable there.
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+([.:][a-zA-Z0-9_-]+)*$/;
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;
const POOL_TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Sidecars/dirs that are never carried over as "extra files": SKILL.md is the
// merged draft, skill.json/provenance.json are regenerated for the target, and
// _archive holds deletion snapshots.
const CARRY_EXCLUDED_BASENAMES = new Set(['SKILL.md', 'skill.json', 'provenance.json']);
const CARRY_EXCLUDED_DIRS = new Set(['_archive']);

// Validate one source ref. Returns { ok, ref } or { ok:false, error }.
function validateSourceRef(raw, i, res) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const tier = typeof r.tier === 'string' ? r.tier.trim() : '';
  if (!SOURCE_TIERS.includes(tier)) return { ok: false, error: `source ${i}: tier must be one of ${SOURCE_TIERS.join('|')}` };
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name || !res.skillNameRe.test(name)) return { ok: false, error: `source ${i}: invalid skill name` };
  const ref = { tier, name };
  if (tier === 'team') {
    const teamId = typeof r.teamId === 'string' ? r.teamId.trim() : '';
    if (!res.teamIdRe.test(teamId)) return { ok: false, error: `source ${i}: teamId required for a team tier` };
    ref.teamId = teamId;
  } else if (tier === 'agent') {
    const agentId = typeof r.agentId === 'string' ? r.agentId.trim() : '';
    if (!res.agentIdRe.test(agentId)) return { ok: false, error: `source ${i}: agentId required for an agent tier` };
    ref.agentId = agentId;
  }
  return { ok: true, ref };
}

// A stable identity for a source/target ref so we can dedup and compare (two
// sources that resolve to the same on-disk skill are a bad request).
function refKey(ref) {
  if (ref.tier === 'team') return `team:${ref.teamId}:${ref.name}`;
  if (ref.tier === 'agent') return `agent:${ref.agentId}:${ref.name}`;
  return `global:${ref.name}`;
}

// Validate a merge request and produce a plan. `input` is the endpoint body:
// { sources: [{tier, teamId?, agentId?, name}, …], target: {tier, teamId?, name},
// draft?, retireSources? }. `requireDraft` is false for the /merge-draft preview
// (nothing is written) and true for the committing /merge endpoint. Returns
// { ok:false, error } or { ok:true, sources, target, draft, retireSources,
// permission }. Regexes are injectable so the endpoint passes its own.
function planMerge(input, opts = {}) {
  const res = {
    skillNameRe: opts.skillNameRe || SKILL_NAME_RE,
    agentIdRe: opts.agentIdRe || AGENT_ID_RE,
    teamIdRe: opts.teamIdRe || POOL_TEAM_ID_RE,
  };
  const requireDraft = opts.requireDraft === true;
  const b = input && typeof input === 'object' ? input : {};

  const rawSources = Array.isArray(b.sources) ? b.sources : [];
  // A single-source "fold" (#2592) moves one skill into a DIFFERENT target — the
  // Consolidate step that folds a domain's only member skill into the domain skill.
  // Opt-in only; an ordinary merge still needs two or more sources.
  const fold = b.fold === true;
  if (rawSources.length < (fold ? 1 : 2)) return { ok: false, error: 'merge requires at least two sources' };

  const sources = [];
  const seen = new Set();
  for (let i = 0; i < rawSources.length; i += 1) {
    const v = validateSourceRef(rawSources[i], i, res);
    if (!v.ok) return { ok: false, error: v.error };
    const key = refKey(v.ref);
    if (seen.has(key)) return { ok: false, error: `duplicate source: ${v.ref.name}` };
    seen.add(key);
    sources.push(v.ref);
  }

  const t = b.target && typeof b.target === 'object' ? b.target : {};
  const targetTier = typeof t.tier === 'string' ? t.tier.trim() : '';
  if (!TARGET_TIERS.includes(targetTier)) {
    return { ok: false, error: `target tier must be one of ${TARGET_TIERS.join('|')}` };
  }
  const targetName = typeof t.name === 'string' ? t.name.trim() : '';
  if (!targetName || !res.skillNameRe.test(targetName)) return { ok: false, error: 'invalid target skill name' };
  const target = { tier: targetTier, name: targetName };
  if (targetTier === 'team') {
    const teamId = typeof t.teamId === 'string' ? t.teamId.trim() : '';
    if (!res.teamIdRe.test(teamId)) return { ok: false, error: 'teamId required for a team target' };
    target.teamId = teamId;
  }

  if (fold && sources.length === 1 && refKey(sources[0]) === refKey(target)) {
    return { ok: false, error: 'a fold needs a target different from its source' };
  }

  const draft = typeof b.draft === 'string' ? b.draft : '';
  if (requireDraft && draft.trim() === '') return { ok: false, error: 'draft must be non-empty' };

  // retireSources defaults ON (the dialog's default) — knowledge lineage is
  // preserved by the provenance union + the archive snapshot, so retiring the
  // near-duplicate sources is the intended outcome.
  const retireSources = b.retireSources === undefined ? true
    : (b.retireSources === true || b.retireSources === 'true');

  return {
    ok: true,
    sources,
    target,
    draft,
    retireSources,
    permission: requiredPermission(target),
  };
}

// The permission the caller must hold — the TARGET tier's (concept §3.4:
// "cross-tier merges allowed with target-tier permissions"), now the one
// global-entry rule (#2307): Team Admin for a team target, System Admin OR
// Team Admin of ANY team for a global target (entering global is a Team-Admin
// act, not System-Admin-only — #2178/#2180). Same shape skill-transfer's
// permitTransfer reads, so the endpoint reuses one permit helper.
function requiredPermission(target) {
  return requiredPoolWritePermission(target.tier, target.teamId);
}

// Check a plan's permission against the caller's capabilities. `caps` is
// { systemAdmin: bool, isTeamAdmin: (teamId) => bool, isTeamAdminOfAny?: () =>
// bool }. Returns { ok } or { ok:false, error }.
function permitMerge(permission, caps = {}) {
  const p = permission && typeof permission === 'object' ? permission : {};
  const systemAdmin = !!caps.systemAdmin;
  const isTeamAdmin = typeof caps.isTeamAdmin === 'function' ? caps.isTeamAdmin : () => false;
  const isTeamAdminOfAny = typeof caps.isTeamAdminOfAny === 'function' ? caps.isTeamAdminOfAny : () => false;
  if (p.needsSystemAdmin && !systemAdmin) {
    return { ok: false, error: 'forbidden: this merge requires System Admin' };
  }
  for (const teamId of p.teamAdminOf || []) {
    if (!systemAdmin && !isTeamAdmin(teamId)) {
      return { ok: false, error: `forbidden: requires Team Admin of '${teamId}'` };
    }
  }
  // #2307: the unnamed-team floor for a global target — System Admin, or Team
  // Admin of ANY team (no single team is "the content's own" for a merge).
  if (p.anyTeamAdmin && !systemAdmin && !isTeamAdminOfAny()) {
    return { ok: false, error: 'forbidden: this merge requires System Admin or Team Admin of a team' };
  }
  return { ok: true };
}

// The set of source skill NAMES (a grant references a skill by name only). A
// merge of `jcl-tips` + `jcl-conversion` retires two names; the migration
// rewrites any grant naming either to the target name.
function sourceNames(sources) {
  return [...new Set((Array.isArray(sources) ? sources : []).map((s) => s && s.name).filter(Boolean))];
}

// Build the `mergedFrom` history payload (concept §3.4): one entry per source
// with its tier + content hash. `hashOf(ref)` supplies the on-disk hash (the
// api.js caller reads it from each source's manifest); a missing hash is
// recorded as null rather than dropped, so the lineage still names the source.
function buildMergedFrom(sources, hashOf) {
  const h = typeof hashOf === 'function' ? hashOf : () => null;
  return (Array.isArray(sources) ? sources : []).map((s) => {
    const entry = { name: s.name, tier: s.tier };
    if (s.tier === 'team') entry.teamId = s.teamId;
    if (s.tier === 'agent') entry.agentId = s.agentId;
    entry.hash = h(s) || null;
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Grant-migration plan
// ---------------------------------------------------------------------------

// Given every agent construct (plain config data) and the merge's source names +
// target name, decide which constructs must have their grant rewritten from a
// source to the target, and by which route:
//
//   team  — a `role:"team"` agent whose own skills[] grants a source; the
//           orchestrator's team route rewrites it and fans the workspace sync
//           out to every inheriting member.
//   agent — any other construct that grants a source via its OWN list
//           (standalone/orchestrator skills[], team-member skillsOverride); the
//           single-agent route rewrites just that construct's grant + workspace.
//
// An inheriting team-member carries no own grant, so it is NOT listed here — it
// follows its team's rewrite via the fan-out. `removes` is the subset of source
// names the construct actually grants (so the caller deactivates only those).
// Pure — the api.js caller executes the plan against the orchestrator endpoints.
function planGrantMigration(constructs, { sources, target } = {}) {
  const names = new Set(sourceNames(sources));
  const targetName = target && target.name;
  const teams = [];
  const agents = [];
  for (const c of Array.isArray(constructs) ? constructs : []) {
    if (!c || !c.id) continue;
    // The construct's OWN grant list: an override member's skillsOverride, else
    // the construct's own skills[]. A plain inheriting member has neither.
    const ownList = Array.isArray(c.skillsOverride) ? c.skillsOverride
      : Array.isArray(c.skills) ? c.skills
      : null;
    if (!ownList) continue;
    const removes = ownList.filter((n) => names.has(n));
    if (removes.length === 0) continue;
    const addTarget = !ownList.includes(targetName);
    const step = { id: c.id, removes, addTarget };
    if (c.role === 'team') teams.push(step);
    else agents.push(step);
  }
  return { teams, agents };
}

// ---------------------------------------------------------------------------
// File-collision namespacing
// ---------------------------------------------------------------------------

// Whether a source-relative path is a carried "extra file" (not a sidecar the
// target regenerates, not an archive snapshot). `relPath` is posix-relative.
function isCarriedFile(relPath) {
  const norm = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.includes('..')) return false;
  const segs = norm.split('/');
  if (CARRY_EXCLUDED_BASENAMES.has(segs[segs.length - 1]) && segs.length === 1) return false;
  if (segs.some((s) => CARRY_EXCLUDED_DIRS.has(s))) return false;
  // Top-level sidecars only (a nested file literally named SKILL.md is content).
  if (segs.length === 1 && CARRY_EXCLUDED_BASENAMES.has(segs[0])) return false;
  return true;
}

// Plan how each source's extra files land in the merged target. `sources` is
// [{ name, files: [relPath, …] }] — the api.js caller reads each source dir's
// files (excluding the regenerated sidecars). A path carried by exactly ONE
// source stays at its original location; a path carried by MORE THAN ONE source
// is a collision and EVERY copy is namespaced under `files/<source-name>/<path>`
// (deterministic, no arbitrary winner). Returns { copies: [{ sourceName, from,
// to }], collisions: [path, …] }. Pure.
function planFileMerge(sources) {
  const list = Array.isArray(sources) ? sources : [];
  // Count how many sources carry each path.
  const owners = new Map(); // path -> Set(sourceName)
  for (const s of list) {
    const name = s && s.name;
    const files = s && Array.isArray(s.files) ? s.files : [];
    for (const f of files) {
      if (!isCarriedFile(f)) continue;
      const rel = String(f).replace(/\\/g, '/').replace(/^\/+/, '');
      if (!owners.has(rel)) owners.set(rel, new Set());
      owners.get(rel).add(name);
    }
  }
  const collisions = [];
  for (const [rel, set] of owners) if (set.size > 1) collisions.push(rel);
  collisions.sort();

  const copies = [];
  const collisionSet = new Set(collisions);
  for (const s of list) {
    const name = s && s.name;
    const files = s && Array.isArray(s.files) ? s.files : [];
    const done = new Set();
    for (const f of files) {
      if (!isCarriedFile(f)) continue;
      const rel = String(f).replace(/\\/g, '/').replace(/^\/+/, '');
      if (done.has(rel)) continue;
      done.add(rel);
      const to = collisionSet.has(rel) ? `files/${name}/${rel}` : rel;
      copies.push({ sourceName: name, from: rel, to });
    }
  }
  return { copies, collisions };
}

// ---------------------------------------------------------------------------
// Provenance union
// ---------------------------------------------------------------------------

// Union the sources' provenance.json records into the merged target's record
// (concept §3.4 — "entryIds unioned across sources; the T1→T2 graph edges keep
// resolving"). entryIds/originAgents/convergence/sourceRefs/sessions are all
// unioned; `mergedFrom` records the source skills; tier/team come from the
// target. `sourceProvs` is the list of each source's provenance object (null
// when a source has none). Pure — the caller supplies `now` + `mergedBy`.
function mergeProvenance({ sourceProvs = [], target, mergedFrom = [], mergedBy, now } = {}) {
  const ts = typeof now === 'string' && now.trim() ? now.trim() : new Date().toISOString();
  const provs = (Array.isArray(sourceProvs) ? sourceProvs : []).filter((p) => p && typeof p === 'object');

  const entryIds = [];
  const originAgents = [];
  const convergence = [];
  const sourceRefs = [];
  const sessions = [];
  const seenRef = new Set();
  const seenSession = new Set();
  for (const p of provs) {
    for (const id of Array.isArray(p.entryIds) ? p.entryIds : []) {
      if (!entryIds.includes(id)) entryIds.push(id);
    }
    for (const a of Array.isArray(p.originAgents) ? p.originAgents : []) {
      if (a && !originAgents.includes(a)) originAgents.push(a);
    }
    for (const a of Array.isArray(p.convergence) ? p.convergence : []) {
      if (a && !convergence.includes(a)) convergence.push(a);
    }
    for (const r of Array.isArray(p.sourceRefs) ? p.sourceRefs : []) {
      if (!r || !r.kind || !r.ref) continue;
      const k = `${r.kind}:${r.ref}`;
      if (seenRef.has(k)) continue;
      seenRef.add(k);
      sourceRefs.push({ kind: r.kind, ref: r.ref });
    }
    for (const s of Array.isArray(p.sessions) ? p.sessions : []) {
      if (!s || !s.correlationId) continue;
      const k = `${s.agentId || ''}:${s.correlationId}`;
      if (seenSession.has(k)) continue;
      seenSession.add(k);
      sessions.push({ agentId: s.agentId || null, correlationId: s.correlationId });
    }
  }

  const teamId = (target && target.tier === 'team' && target.teamId)
    || provs.map((p) => p.originTeamId || p.teamId).find(Boolean)
    || 'default';
  const originTeamId = provs.map((p) => p.originTeamId).find(Boolean) || teamId;

  return {
    fromTier: 'merge',
    toTier: target ? target.tier : 'team',
    teamId,
    entryIds,
    canonicalId: entryIds[0] || null,
    originAgents,
    convergence: convergence.length ? convergence : originAgents,
    sourceRefs,
    sessions,
    originTeamId,
    mergedFrom,
    mergedAt: ts,
    mergedBy: typeof mergedBy === 'string' && mergedBy.trim() ? mergedBy.trim() : 'operator',
  };
}

module.exports = {
  SOURCE_TIERS,
  TARGET_TIERS,
  SKILL_NAME_RE,
  AGENT_ID_RE,
  POOL_TEAM_ID_RE,
  refKey,
  planMerge,
  requiredPermission,
  permitMerge,
  sourceNames,
  buildMergedFrom,
  planGrantMigration,
  isCarriedFile,
  planFileMerge,
  mergeProvenance,
};
