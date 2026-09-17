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
//   - global→global / agent→agent are edit / author, not a transfer;
//   - *→agent is activation / seed, a different path.
// agent→global (#2180) was "deliberately retired, go via the team tier" until
// the #2180 design decision explicitly re-enabled it as an offered option
// alongside the staged agent→team→global path — a direct publish of an
// agent's edited copy of a skill (incl. an edited copy of a granted/seeded
// global skill) straight into the global pool.
const COPY_ACTION = {
  'agent>team': 'lifted',
  'team>team': 'shared',
  'team>global': 'promoted',
  'agent>global': 'promoted',
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
// for team targets; System Admin for any `move` out of global/agent (deleting
// those is a governance-level action). A move also needs authority over the
// source it retires (team source → Team Admin of that team).
//
// Global targets (#2180 governance change): publishing into global no longer
// requires System Admin outright — a Team Admin of the CONTENT'S OWN team may
// publish too, not only into their team pool. For a team-tier source that team
// is `from.teamId`, known here and folded straight into `orTeamAdminOf`. For an
// agent-tier source this module (pure, fs-free) cannot resolve which team owns
// the agent, so the safe default is `needsSystemAdmin: true`; the caller
// resolves the agent's REAL owning team server-side (never client-supplied —
// a self-asserted team id here would be a privilege escalation) and relaxes
// this permission itself before calling `permitTransfer`, the same way the
// endpoint already recomputes other business rules the pure planner can't see.
//
// Returns { needsSystemAdmin, teamAdminOf: [], orTeamAdminOf: [] } — the first
// two are AND'd (every named team's admin, or System Admin); `orTeamAdminOf` is
// OR'd (System Admin, or Team Admin of ANY one of these).
function requiredPermission(from, to, mode) {
  const teamAdminOf = new Set();
  const orTeamAdminOf = new Set();
  let needsSystemAdmin = false;
  // Target side.
  if (to.tier === 'global') {
    if (from.tier === 'team') orTeamAdminOf.add(from.teamId);
    else needsSystemAdmin = true; // agent source: caller relaxes after resolving the real team.
  } else if (to.tier === 'team') teamAdminOf.add(to.teamId);
  // Move retires the source — require authority over it too.
  if (mode === 'move') {
    if (from.tier === 'global') needsSystemAdmin = true; // move OUT of global
    else if (from.tier === 'team') teamAdminOf.add(from.teamId);
    else if (from.tier === 'agent') needsSystemAdmin = true;
  }
  return { needsSystemAdmin, teamAdminOf: [...teamAdminOf], orTeamAdminOf: [...orTeamAdminOf] };
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
// { systemAdmin: bool, isTeamAdmin: (teamId) => bool, isTeamAdminOfAny?: () =>
// bool } — kept abstract so this module never imports scope.js. `action` names
// the act being refused (default 'transfer') so a caller reusing this checker
// for a different act (e.g. import, #2307) gets a message that names THAT act,
// never a hardcoded "transfer" the user never asked for. Returns { ok } or
// { ok: false, error }.
function permitTransfer(permission, caps = {}, action = 'transfer') {
  const p = permission && typeof permission === 'object' ? permission : {};
  const systemAdmin = !!caps.systemAdmin;
  const isTeamAdmin = typeof caps.isTeamAdmin === 'function' ? caps.isTeamAdmin : () => false;
  const isTeamAdminOfAny = typeof caps.isTeamAdminOfAny === 'function' ? caps.isTeamAdminOfAny : () => false;
  if (p.needsSystemAdmin && !systemAdmin) {
    return { ok: false, error: `forbidden: this ${action} requires System Admin` };
  }
  for (const teamId of p.teamAdminOf || []) {
    if (!systemAdmin && !isTeamAdmin(teamId)) {
      return { ok: false, error: `forbidden: requires Team Admin of '${teamId}'` };
    }
  }
  // #2180: an OR-set of alternative teams — System Admin, or Team Admin of ANY
  // one of them (a global publish's "the content's own team" rule).
  if (Array.isArray(p.orTeamAdminOf) && p.orTeamAdminOf.length > 0) {
    if (!systemAdmin && !p.orTeamAdminOf.some((teamId) => isTeamAdmin(teamId))) {
      return { ok: false, error: `forbidden: requires System Admin or Team Admin of ${p.orTeamAdminOf.map((t) => `'${t}'`).join(' / ')}` };
    }
  }
  // #2307: the unnamed-team floor for writing into the global pool — System
  // Admin, or Team Admin of ANY team (no single team is "the content's own").
  if (p.anyTeamAdmin && !systemAdmin && !isTeamAdminOfAny()) {
    return { ok: false, error: `forbidden: this ${action} requires System Admin or Team Admin of a team` };
  }
  return { ok: true };
}

// The permission required to WRITE into a pool tier directly — not a transfer,
// but the SAME governance rule this ticket (#2307) makes into one rule for
// every path that enters a tier: Team Admin of that team for a team-tier write
// (create / edit); System Admin OR Team Admin of ANY team for a global-tier
// write (entering the global pool is a Team-Admin act, #2178/#2180 — not
// System-Admin-only, and unlike promote/transfer there is no "content's own
// team" to name here). Returns the same { needsSystemAdmin, teamAdminOf,
// anyTeamAdmin } shape `permitTransfer` reads, so create/edit reuse it too.
function requiredPoolWritePermission(tier, teamId) {
  if (tier === 'team') return { needsSystemAdmin: false, teamAdminOf: [teamId] };
  return { needsSystemAdmin: false, teamAdminOf: [], anyTeamAdmin: true };
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

// Pure collision decision for the shared skill-file-write core (#639). Every
// endpoint that lands a skill on disk (transfer, promote/lift, share, extend)
// funnels its "does the destination already exist and may I write it" question
// through here, so the reject/overwrite semantics live in one tested place while
// the caller does the fs work. `allowExisting` is the extend case: the target is
// SUPPOSED to already exist and is written in place (never a collision). Returns
// { ok: true, overwrite } to proceed (overwrite=true means rm the dir first) or
// { ok: false, conflict: true } to signal the caller should 409.
function planSkillWrite({ onCollision = 'reject', exists = false, allowExisting = false } = {}) {
  if (allowExisting) return { ok: true, overwrite: false };
  if (!exists) return { ok: true, overwrite: false };
  if (onCollision === 'overwrite') return { ok: true, overwrite: true };
  return { ok: false, conflict: true };
}

// Pure decision for how a transfer stamps the destination's manifest (#2315,
// concept §3.6). A `copy` that OVERWRITES a destination which already carries
// its OWN version chain must CONTINUE that chain (prev+1) — the same way a plain
// edit does — never reset to v1, and must snapshot the pre-overwrite state to the
// archive first (recoverable). A fresh landing, a rename, a reject-to-new-dir, or
// a destination whose skill.json is corrupt/unreadable all stay on the historic
// fresh-v1 path. `destExists` = the destination already has content on disk;
// `destManifestReadable` = its skill.json parsed into a manifest the caller can
// continue. Returns { archive, continueChain }:
//   - archive:       snapshot the destination before it is overwritten.
//   - continueChain: stamp by continuing the destination's own chain (else v1).
// A corrupt-manifest overwrite still archives (the content is recoverable) but
// falls back to a fresh v1, exactly as stampManifest already does for a null
// existing manifest — the transfer never fails on an unparseable destination.
function planTransferStamp({ onCollision = 'reject', destExists = false, destManifestReadable = false } = {}) {
  const overwriting = onCollision === 'overwrite' && !!destExists;
  if (!overwriting) return { archive: false, continueChain: false };
  return { archive: true, continueChain: !!destManifestReadable };
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
  requiredPoolWritePermission,
  planTransfer,
  permitTransfer,
  buildTransferOrigin,
  resolveCollisionName,
  planSkillWrite,
  planTransferStamp,
};
