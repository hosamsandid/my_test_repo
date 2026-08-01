'use strict';

// ---------------------------------------------------------------------------
// Uniform guarded skill deletion — pure validator + planner (#627,
// concept docs/skill-lifecycle-concept.md §3.3).
//
// One rule on all three tiers, replacing today's mix (guarded global / blind
// team / 403 agent): a delete is GUARDED (refuse while a grant resolves to
// this tier, unless `cascade` deactivates first), produces a restorable
// ARCHIVE SNAPSHOT, and the archive is PRUNED after a retention window.
//
// This module is **pure** (no fs, no network): it validates a delete request,
// states the permission the caller must hold, and computes archive-name /
// retention-prune plans. The api.js endpoint does the file work (guard scan,
// cascade deactivate, snapshot copy, remove) and the orchestrator owns the
// workspace sync. Same "pure core + IO caller" discipline as skill-transfer.js.
// ---------------------------------------------------------------------------

const TIERS = ['agent', 'team', 'global'];

// Mirror the api.js regexes so a validated request is always writable there.
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+([.:][a-zA-Z0-9_-]+)*$/;
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;
const POOL_TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const DEFAULT_RETENTION_DAYS = 90;

// Filesystem-safe segment for the tier a snapshot came from — mirrors the
// segment skill-transfer.js's archiveSkillDir already writes, so deletion
// snapshots and move snapshots share one archive layout.
function tierSegment(ref) {
  if (ref.tier === 'team') return `team-${ref.teamId}`;
  if (ref.tier === 'agent') return `agent-${ref.agentId}`;
  return 'global';
}

// Validate a delete request and produce a plan. `input` is the merged
// query+body of the DELETE endpoint: { source|tier, name, teamId?, agentId?,
// cascade? }. Returns { ok: false, error } or { ok: true, tier, name, teamId?,
// agentId?, cascade, permission }. Regexes are injectable so the endpoint can
// pass its own (kept in sync with the mirrored defaults above).
function planDeletion(input, opts = {}) {
  const skillNameRe = opts.skillNameRe || SKILL_NAME_RE;
  const agentIdRe = opts.agentIdRe || AGENT_ID_RE;
  const teamIdRe = opts.teamIdRe || POOL_TEAM_ID_RE;
  const b = input && typeof input === 'object' ? input : {};

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || !skillNameRe.test(name)) return { ok: false, error: 'invalid skill name' };

  // `source` is the endpoint's historic query param; treat absent as global.
  // `GET /api/skills` tags global (pool-tier) skills with `source: 'pool'`, so
  // accept 'pool' as an alias for 'global' — otherwise every global-skill delete
  // from the Skills Registry UI fails the TIERS check (#1044).
  const raw = typeof b.tier === 'string' ? b.tier : b.source;
  const aliased = raw === 'pool' ? 'global' : raw;
  const tier = aliased == null || aliased === '' ? 'global' : String(aliased).trim();
  if (!TIERS.includes(tier)) return { ok: false, error: `tier must be one of ${TIERS.join('|')}` };

  const out = { ok: true, tier, name, cascade: b.cascade === true || b.cascade === 'true' };

  if (tier === 'team') {
    const teamId = typeof b.teamId === 'string' ? b.teamId.trim() : '';
    if (!teamIdRe.test(teamId)) return { ok: false, error: 'teamId required for a team tier' };
    out.teamId = teamId;
  } else if (tier === 'agent') {
    const agentId = typeof b.agentId === 'string' ? b.agentId.trim() : '';
    if (!agentIdRe.test(agentId)) return { ok: false, error: 'agentId required for an agent tier' };
    out.agentId = agentId;
  }

  out.permission = requiredPermission(out);
  return out;
}

// The permission the caller must hold to delete at a tier (concept §3.3 / issue
// item 5): Team Admin for a team skill, System Admin for a global skill, and
// System Admin (operator) for an agent-tier skill — an agent's private pool is
// otherwise unreachable via the API, so only an operator prunes it. Returns
// { needsSystemAdmin, teamAdminOf: [] } — the same shape skill-transfer uses,
// so the endpoint reuses one permit helper.
function requiredPermission(plan) {
  if (plan.tier === 'team') return { needsSystemAdmin: false, teamAdminOf: [plan.teamId] };
  return { needsSystemAdmin: true, teamAdminOf: [] };
}

// Check a plan's permission against the caller's capabilities. `caps` is
// { systemAdmin: bool, isTeamAdmin: (teamId) => bool } — kept abstract so this
// module never imports scope.js. Returns { ok } or { ok: false, error }.
function permitDeletion(permission, caps = {}) {
  const p = permission && typeof permission === 'object' ? permission : {};
  const systemAdmin = !!caps.systemAdmin;
  const isTeamAdmin = typeof caps.isTeamAdmin === 'function' ? caps.isTeamAdmin : () => false;
  if (p.needsSystemAdmin && !systemAdmin) {
    return { ok: false, error: 'forbidden: this deletion requires System Admin' };
  }
  for (const teamId of p.teamAdminOf || []) {
    if (!systemAdmin && !isTeamAdmin(teamId)) {
      return { ok: false, error: `forbidden: requires Team Admin of '${teamId}'` };
    }
  }
  return { ok: true };
}

// Build the on-disk archive stamp for a deletion snapshot. Kept identical in
// shape to skill-transfer.js's move archive (`<name>-<hash>-<ts>`) so the two
// share one layout and one listing/prune path. Returns { seg, stamp, id } —
// `id` is the archive-relative path used by the restore + prune endpoints.
function archiveStamp(ref, name, hash, now = Date.now()) {
  const seg = tierSegment(ref);
  const stamp = `${name}-${hash || 'nohash'}-${now}`;
  return { seg, stamp, id: `${seg}/${stamp}` };
}

// Parse an archive id (`<seg>/<name>-<hash>-<ts>`) back into its parts. Returns
// null when it is not a safe two-segment id or the stamp is unparseable. Used
// to validate a restore/prune id and to reconstruct metadata for archive
// entries that predate the archive-meta.json sidecar (e.g. move snapshots).
function parseArchiveId(id) {
  if (typeof id !== 'string' || !id) return null;
  const parts = id.split('/');
  if (parts.length !== 2) return null;
  const [seg, stamp] = parts;
  if (!seg || !stamp || seg.includes('..') || stamp.includes('..')) return null;
  // <name>-<hash>-<ts> — split from the right so a hyphenated name survives.
  const m = /^(.*)-([0-9a-f]+|nohash)-(\d+)$/.exec(stamp);
  if (!m) return { seg, stamp, name: stamp, hash: null, ts: null };
  return { seg, stamp, name: m[1], hash: m[2] === 'nohash' ? null : m[2], ts: Number(m[3]) };
}

// Retention prune plan (AC3): given archive entries (each { id, deletedAt })
// return the ids whose age exceeds the retention window. Pure — the caller
// supplies `now` and the entries it read off disk. An entry with no usable
// timestamp is kept (never pruned on a guess).
function planArchivePrune(entries, { now = Date.now(), retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  const cutoff = now - Math.max(0, retentionDays) * 24 * 60 * 60 * 1000;
  const remove = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.id !== 'string') continue;
    const t = typeof e.deletedAt === 'number' ? e.deletedAt
      : typeof e.deletedAt === 'string' ? Date.parse(e.deletedAt) : NaN;
    if (Number.isFinite(t) && t < cutoff) remove.push(e.id);
  }
  return remove;
}

module.exports = {
  TIERS,
  SKILL_NAME_RE,
  AGENT_ID_RE,
  POOL_TEAM_ID_RE,
  DEFAULT_RETENTION_DAYS,
  tierSegment,
  planDeletion,
  requiredPermission,
  permitDeletion,
  archiveStamp,
  parseArchiveId,
  planArchivePrune,
};
