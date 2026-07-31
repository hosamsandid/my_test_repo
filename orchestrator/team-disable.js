'use strict';

// Pure planning helpers for the team-wide enable/disable feature
// (docs/superpowers/specs/2026-07-31-team-wide-disable-design.md). No I/O —
// callers pass in already-loaded config objects and apply the resulting
// id lists via the existing per-agent enableAgent/disableAgent primitives.

// A team (role: "team") config is disabled iff its own `enabled` field is
// exactly `false`. Absent or `true` means enabled, matching how every other
// role's `enabled` field defaults.
function isTeamDisabled(teamCfg) {
  return !!teamCfg && teamCfg.enabled === false;
}

// Partitions a team's member configs for a team-disable action.
// `toDisable` — members currently enabled (enabled !== false): the bulk
//   action must disableAgent() each one and tag it disabledByTeam.
// `skip` — members already enabled === false: left completely untouched
//   (no tag written) since they were off on their own before this action.
function planTeamDisable(memberConfigs) {
  const toDisable = [];
  const skip = [];
  for (const cfg of memberConfigs) {
    if (!cfg) continue;
    if (cfg.enabled !== false) toDisable.push(cfg.id);
    else skip.push(cfg.id);
  }
  return { toDisable, skip };
}

// Partitions a team's member configs for a team-enable action.
// `toEnable` — members tagged disabledByTeam === true: the bulk action must
//   enableAgent() each one and clear the tag.
// `skip` — everyone else (independently disabled, already enabled, or a
//   stub never activated): left exactly as they are.
function planTeamEnable(memberConfigs) {
  const toEnable = [];
  const skip = [];
  for (const cfg of memberConfigs) {
    if (!cfg) continue;
    if (cfg.disabledByTeam === true) toEnable.push(cfg.id);
    else skip.push(cfg.id);
  }
  return { toEnable, skip };
}

// True when a team-member's own enable/disable toggle must be locked
// because its parent team is currently disabled.
function isMemberLockedByTeam(memberCfg, teamCfg) {
  if (!memberCfg || memberCfg.role !== 'team-member' || !memberCfg.parentTeamId) return false;
  return isTeamDisabled(teamCfg);
}

// Classifies raw status/triggers data (already read from disk by the
// caller) into the { busy, activeTriggers } shape used by the
// busy-warning path and the team-members preview listing.
function deriveBusyState(statusJson, triggers) {
  const busy = statusJson?.state === 'busy';
  const activeTriggers = Array.isArray(triggers)
    ? triggers
        .filter(t => t.enabled !== false && t.id)
        .map(t => ({ id: t.id, type: t.type, description: t.description || null }))
    : [];
  return { busy, activeTriggers };
}

// HTTP status for an error thrown by enableAgent/disableAgent, surfaced on
// the single-agent enable/disable routes.
function httpStatusForAgentActionError(err) {
  if (err && err.code === 'team-disabled') return 409;
  if (err && /not found/i.test(err.message)) return 404;
  return 500;
}

// HTTP status for an error thrown by disableTeam/enableTeam, surfaced on
// the team-wide disable/enable routes. `hasMode` is true only for the
// disable route, which additionally validates the mode argument.
function httpStatusForTeamActionError(err, { hasMode = false } = {}) {
  if (!err) return 500;
  if (/not found/i.test(err.message)) return 404;
  if (/not a team/i.test(err.message)) return 400;
  if (hasMode && /mode must be/i.test(err.message)) return 400;
  return 500;
}

module.exports = {
  isTeamDisabled,
  planTeamDisable,
  planTeamEnable,
  isMemberLockedByTeam,
  deriveBusyState,
  httpStatusForAgentActionError,
  httpStatusForTeamActionError,
};
