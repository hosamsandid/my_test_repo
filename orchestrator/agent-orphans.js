'use strict';

// Pure orphan detection for the one-off cleanup (#1960).
//
// An **orphan** is a `team-member` agent whose parent team cannot be resolved.
// The cascade in `agent-delete-plan.js` is what stops new ones being created;
// this module is the other half of that ticket — the scan an operator runs once
// on an installation that already has some, from before the cascade covered
// every case (or after a hand-edited config).
//
// Deliberately narrow: only `role: "team-member"` is classified. Standalone
// agents have no parent, a `team` agent *is* the parent, and orchestrator /
// bp-instance residue belongs to the separate BriefingPack removal — a broader
// rule here would delete agents this ticket never promised to touch.
//
// The three reasons are kept apart because they are three different mistakes
// and an operator reading a dry run deserves to know which one they are looking
// at (a `parent-not-a-team` is a typo; a `parent-missing` is a delete that did
// not finish).
const ORPHAN_REASONS = Object.freeze({
  NO_PARENT_ID: 'no-parent-id',
  PARENT_MISSING: 'parent-missing',
  PARENT_NOT_A_TEAM: 'parent-not-a-team',
});

// Human-readable one-liner per reason — used verbatim in the dry-run listing
// and the orchestrator log, so the report reads the same wherever it surfaces.
function describeOrphanReason(reason, parentTeamId) {
  switch (reason) {
    case ORPHAN_REASONS.NO_PARENT_ID:
      return 'team member with no parentTeamId — it can never resolve a team';
    case ORPHAN_REASONS.PARENT_MISSING:
      return `parent team '${parentTeamId}' does not exist`;
    case ORPHAN_REASONS.PARENT_NOT_A_TEAM:
      return `parent '${parentTeamId}' exists but is not a team agent`;
    default:
      return 'parent team cannot be resolved';
  }
}

// Classify ONE agent. `byId` maps every agent id on disk to its config (a null
// config = a config-less residue dir, which is not a resolvable parent either).
// Returns an orphan record or null.
function classifyOrphan(id, cfg, byId) {
  if (!id || !cfg || cfg.role !== 'team-member') return null;
  const parentTeamId =
    typeof cfg.parentTeamId === 'string' && cfg.parentTeamId.trim()
      ? cfg.parentTeamId
      : null;

  let reason = null;
  if (!parentTeamId) {
    reason = ORPHAN_REASONS.NO_PARENT_ID;
  } else {
    // `has` rather than a truthy lookup: an id present with a null config is a
    // residue dir, i.e. NOT a live parent.
    const parentCfg = byId && Object.prototype.hasOwnProperty.call(byId, parentTeamId)
      ? byId[parentTeamId]
      : undefined;
    if (!parentCfg) reason = ORPHAN_REASONS.PARENT_MISSING;
    else if (parentCfg.role !== 'team') reason = ORPHAN_REASONS.PARENT_NOT_A_TEAM;
  }
  if (!reason) return null;

  return {
    id,
    role: cfg.role,
    displayName: typeof cfg.displayName === 'string' ? cfg.displayName : null,
    parentTeamId,
    // A materialized member carries a Matrix token; a stub (#1955) does not.
    // Reported, never the token itself — the operator needs to know whether the
    // cleanup will also have to deactivate a Matrix user.
    materialized: !!(cfg && cfg.token),
    teamId: typeof cfg.teamId === 'string' ? cfg.teamId : null,
    reason,
    detail: describeOrphanReason(reason, parentTeamId),
    // Whether the cleanup may delete it, or only report it.
    //
    // `parent-not-a-team` is reported and LEFT ALONE: the named parent still
    // exists as a live agent, so the config is a typo to correct rather than an
    // agent to reap, and quietly deleting a member whose parent someone can
    // still point at is a decision a human should make. The other two reasons
    // name a parent that is genuinely gone (or was never named), which is the
    // state this ticket promises to leave none of.
    removable: reason !== ORPHAN_REASONS.PARENT_NOT_A_TEAM,
  };
}

// The dry-run plan: every orphan on the installation, sorted by id so two runs
// over an unchanged workspace produce byte-identical output.
//
// `configs` is an iterable of `{ id, cfg }` — the same shape `cascadeChildIds`
// takes, so the delete route and the scan read the workspace one way.
function planOrphanCleanup(configs) {
  const list = [];
  const byId = Object.create(null);
  for (const entry of configs || []) {
    if (!entry || !entry.id) continue;
    byId[entry.id] = entry.cfg || null;
    list.push(entry);
  }
  const orphans = [];
  for (const { id, cfg } of list) {
    const orphan = classifyOrphan(id, cfg, byId);
    if (orphan) orphans.push(orphan);
  }
  orphans.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // `removable` is split out rather than left for the caller to filter: the
  // cleanup and the report must never disagree about which entries the sweep
  // is going to touch.
  return {
    scanned: list.length,
    orphans,
    removable: orphans.filter(o => o.removable),
    reportOnly: orphans.filter(o => !o.removable),
  };
}

// One log/report line per orphan, for the "list what it would act on before
// acting" half of the contract (AC3).
function formatOrphanLine(orphan) {
  const kind = orphan.materialized ? 'materialized' : 'stub';
  const action = orphan.removable ? '' : ' [reported only — fix the parent id by hand]';
  return `${orphan.id} (${kind}) — ${orphan.detail}${action}`;
}

module.exports = {
  ORPHAN_REASONS,
  describeOrphanReason,
  classifyOrphan,
  planOrphanCleanup,
  formatOrphanLine,
};
