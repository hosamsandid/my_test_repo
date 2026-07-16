'use strict';

// ---------------------------------------------------------------------------
// Unified skill tier-transfer engine — pure validator + planner (#626,
// concept docs/skill-lifecycle-concept.md §3.1–§3.2).
//
// One engine for every cell of the tier-transition matrix (adopt / lift /
// share / promote, in copy or move flavour). This module is **pure** (no fs,
// no network): it validates a transfer request, resolves the collision name,
// decides the manifest action + origin to stamp, and states the permission
// the caller must hold. The api.js endpoint does the file work (copy dir,
// carry provenance.json, stamp skill.json, delete source on move, activate).
// Same "pure core + IO caller" discipline as knowledge-suggestions.js.
// ---------------------------------------------------------------------------

const TIERS = ['agent', 'team', 'global'];
const MODES = ['copy', 'move'];
const COLLISIONS = ['reject', 'overwrite', 'rename'];

// Mirror the api.js regexes so a validated request is always writable there.
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+([.:][a-zA-Z0-9_-]+)*$/;
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;
const POOL_TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The transition matrix (concept §3.1): the semantic COPY action per
// (from → to) cell. A cell absent from this map is not a valid transfer:
//   - agent→global is deliberately retired (go via the team tier);
//   - global→global / agent→agent are edit / author, not a transfer;
//   - *→agent is activation / seed, a different path.
const COPY_ACTION = {
  'agent>team': 'lifted',
  'team>team': 'shared',
  'team>global': 'promoted',
  'global>team': 'adopted',
};

function cellKey(fromTier, toTier) {
  return `${fromTier}>${toTier}`;
}

// The action stamped on the target's skill.json. A `move` is stamped `moved`
// regardless of the cell (the concept lists `moved` as its own action beside
// the copy verbs); a `copy` carries the cell's semantic verb.
function transferAction(fromTier, toTier, mode) {
  const semantic = COPY_ACTION[cellKey(fromTier, toTier)];
  if (!semantic) return null;
  return mode === 'move' ? 'moved' : semantic;
}

// Normalize + validate a { tier, teamId?, agentId? } endpoint reference.
function normTierRef(ref, { agentIdRe, teamIdRe }) {
  const r = ref && typeof ref === 'object' ? ref : {};
  const tier = typeof r.tier === 'string' ? r.tier.trim() : '';
  if (!TIERS.includes(tier)) return { error: `tier must be one of ${TIERS.join('|')}` };
  const out = { tier };
  if (tier === 'team') {
    const teamId = typeof r.teamId === 'string' ? r.teamId.trim() : '';
    if (!teamIdRe.test(teamId)) return { error: 'teamId required for a team tier' };
    out.teamId = teamId;
  } else if (tier === 'agent') {
    const agentId = typeof r.agentId === 'string' ? r.agentId.trim() : '';
    if (!agentIdRe.test(agentId)) return { error: 'agentId required for an agent tier' };
    out.agentId = agentId;
  }
  return out;
}

// The permission the caller must hold for a transfer (concept §3.2): Team Admin
// for team targets; System Admin for global targets and for any `move` out of
// global. A move also needs authority over the source it retires (team source →
// Team Admin of that team; global/agent source → System Admin — deleting those
// is a governance-level action). Returns { needsSystemAdmin, teamAdminOf: [] }.
function requiredPermission(from, to, mode) {
  const teamAdminOf = new Set();
  let needsSystemAdmin = false;
  // Target side.
  if (to.tier === 'global') needsSystemAdmin = true;
  else if (to.tier === 'team') teamAdminOf.add(to.teamId);
  // Move retires the source — require authority over it too.
  if (mode === 'move') {
    if (from.tier === 'global') needsSystemAdmin = true; // move OUT of global
    else if (from.tier === 'team') teamAdminOf.add(from.teamId);
    else if (from.tier === 'agent') needsSystemAdmin = true;
  }
  return { needsSystemAdmin, teamAdminOf: [...teamAdminOf] };
}

// Validate a transfer request and produce a plan. Returns { ok: false, error }
// or { ok: true, name, from, to, mode, onCollision, action, semanticAction,
// retireSource, activate, permission }. Regexes are injectable so the api.js
// endpoint can pass its own (kept in sync with the mirrored defaults above).
function planTransfer(input, opts = {}) {
  const skillNameRe = opts.skillNameRe || SKILL_NAME_RE;
  const agentIdRe = opts.agentIdRe || AGENT_ID_RE;
  const teamIdRe = opts.teamIdRe || POOL_TEAM_ID_RE;
  const b = input && typeof input === 'object' ? input : {};

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || !skillNameRe.test(name)) return { ok: false, error: 'invalid skill name' };

  const from = normTierRef(b.from, { agentIdRe, teamIdRe });
  if (from.error) return { ok: false, error: `from: ${from.error}` };
  const to = normTierRef(b.to, { agentIdRe, teamIdRe });
  if (to.error) return { ok: false, error: `to: ${to.error}` };

  // A transfer target is always a pool tier (team or global); agent is never a
  // transfer target (that is activation / seed, a separate path).
  if (to.tier !== 'team' && to.tier !== 'global') {
    return { ok: false, error: 'to.tier must be team or global' };
  }

  const mode = b.mode == null ? 'copy' : b.mode;
  if (!MODES.includes(mode)) return { ok: false, error: `mode must be one of ${MODES.join('|')}` };

  const onCollision = b.onCollision == null ? 'reject' : b.onCollision;
  if (!COLLISIONS.includes(onCollision)) {
    return { ok: false, error: `onCollision must be one of ${COLLISIONS.join('|')}` };
  }

  const action = transferAction(from.tier, to.tier, mode);
  if (!action) return { ok: false, error: `transfer ${from.tier}→${to.tier} is not a valid tier transition` };

  // No-op guard: a team→team share to the same team, or any transfer whose
  // source and destination resolve to the identical location.
  if (from.tier === 'team' && to.tier === 'team' && from.teamId === to.teamId) {
    return { ok: false, error: 'source and target team are the same' };
  }

  // activate default: true when landing on a team tier so a transfer never ends
  // in the historic "promoted-but-invisible" dead-end (concept §3.2). A global
  // target has no team to sync into, so it never activates.
  let activate;
  if (b.activate == null) activate = to.tier === 'team';
  else activate = !!b.activate;
  if (to.tier !== 'team') activate = false;

  return {
    ok: true,
    name,
    from,
    to,
    mode,
    onCollision,
    action,
    semanticAction: COPY_ACTION[cellKey(from.tier, to.tier)],
    retireSource: mode === 'move',
    activate,
    permission: requiredPermission(from, to, mode),
  };
}

// Check a plan's permission against the caller's capabilities. `caps` is
// { systemAdmin: bool, isTeamAdmin: (teamId) => bool } — kept abstract so this
// module never imports scope.js. Returns { ok } or { ok: false, error }.
function permitTransfer(permission, caps = {}) {
  const p = permission && typeof permission === 'object' ? permission : {};
  const systemAdmin = !!caps.systemAdmin;
  const isTeamAdmin = typeof caps.isTeamAdmin === 'function' ? caps.isTeamAdmin : () => false;
  if (p.needsSystemAdmin && !systemAdmin) {
    return { ok: false, error: 'forbidden: this transfer requires System Admin' };
  }
  for (const teamId of p.teamAdminOf || []) {
    if (!systemAdmin && !isTeamAdmin(teamId)) {
      return { ok: false, error: `forbidden: requires Team Admin of '${teamId}'` };
    }
  }
  return { ok: true };
}

// Build the `origin` object recorded on the target's skill.json (concept §2.2):
// where THIS copy came from. sourceVersion / sourceHash are read from the source
// manifest by the caller at transfer time; absent fields are dropped.
function buildTransferOrigin(from, { sourceVersion, sourceHash } = {}) {
  const o = { tier: from.tier };
  if (from.tier === 'team') o.teamId = from.teamId;
  if (from.tier === 'agent') o.agentId = from.agentId;
  if (sourceVersion !== undefined && sourceVersion !== null) o.sourceVersion = sourceVersion;
  if (sourceHash !== undefined && sourceHash !== null) o.sourceHash = sourceHash;
  return o;
}

// Deterministic collision rename: <name>-2, <name>-3, … `existsFn(candidate)`
// reports whether a name is already taken at the destination. Returns the first
// free name (the base itself when free). Pure — the caller supplies existence.
function resolveCollisionName(name, existsFn) {
  if (typeof existsFn !== 'function' || !existsFn(name)) return name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name}-${n}`;
    if (!existsFn(candidate)) return candidate;
  }
  return `${name}-${Date.now()}`;
}

module.exports = {
  TIERS,
  MODES,
  COLLISIONS,
  SKILL_NAME_RE,
  AGENT_ID_RE,
  POOL_TEAM_ID_RE,
  COPY_ACTION,
  transferAction,
  requiredPermission,
  planTransfer,
  permitTransfer,
  buildTransferOrigin,
  resolveCollisionName,
};
