'use strict';

// Which agent roles the platform still supports, and what to do with a config
// that names one it doesn't (#1962, epic #1961 decisions R2 + AC3).
//
// The BriefingPack model is removed, but epic decision R2 is a **hard cut, not
// a migration**: existing `orchestrator` / `bp-instance` configurations are
// left on disk untouched — nothing is deleted automatically and there is no
// deprecation release. So an upgraded stack WILL find configs naming a role
// that no longer exists, and it has to start cleanly anyway.
//
// Two things follow, and both live here so there is one definition of
// "supported role" rather than a role list repeated per call site:
//
//   1. Startup skips an unsupported config **silently in the operational
//      sense** — no error, no throw, and exactly ONE log line per config for
//      the whole process lifetime (the boot loop runs once), so a leftover
//      orchestrator can never turn into recurring log noise. It is reported
//      rather than swallowed entirely, because "my orchestrator vanished" needs
//      an answer an operator can find in the log.
//
//   2. A **still-running mission container is stopped and not restarted**.
//      That is not extra machinery: `evictStaleAgentContainers` already
//      force-removes every agent container at boot (it keys on the
//      `aee.agent.id` label, not on role), and `startAllEnabledAgents`
//      immediately recreates the ones whose config is enabled and carries a
//      token. Filtering that respawn on `isSupportedAgentRole` is what turns
//      the existing eviction into the documented behaviour: the container goes
//      away on upgrade, the configuration stays on disk for the operator to
//      read or delete, and nothing brings the container back.
//
// Legacy `expert` / `expert-group` / `expert-instance` names are NOT listed:
// `normalizeAgentConfig` maps them onto the modern trio before any consumer
// sees them, so by the time a role reaches this predicate it is already
// normalized. `ephemeral` IS listed — the ephemeral-agent route creates one.

const SUPPORTED_AGENT_ROLES = Object.freeze([
  'agent',
  'team',
  'team-member',
  'ephemeral',
]);

// Roles the platform used to support and deliberately no longer does. Kept
// named (rather than folded into "anything unknown") so the startup log can
// say *why* a config was skipped and point at the ticket, which is the whole
// difference between a useful line and noise.
const RETIRED_AGENT_ROLES = Object.freeze({
  'orchestrator': 'the BriefingPack model was removed (#1961)',
  'bp-instance': 'the BriefingPack model was removed (#1961)',
});

// Is this role one the platform can still run? A missing/empty role counts as
// unsupported: a config with no role is not something we can spawn correctly,
// and quietly treating it as `agent` is how a corrupt file becomes a running
// container.
function isSupportedAgentRole(role) {
  return SUPPORTED_AGENT_ROLES.includes(role);
}

// The one log line a skipped config earns, or null when the role is fine.
// Returns the message rather than logging it so the decision stays pure and
// the caller owns the console.
function unsupportedRoleNote(id, role) {
  if (isSupportedAgentRole(role)) return null;
  const reason = RETIRED_AGENT_ROLES[role];
  const shown = role === undefined || role === null || role === ''
    ? '(none)'
    : String(role);
  return reason
    ? `[Orchestrator] Skipping agent '${id}': role '${shown}' is no longer supported — ${reason}. ` +
      `Its configuration is left on disk; delete it when you no longer need it.`
    : `[Orchestrator] Skipping agent '${id}': unknown role '${shown}'. ` +
      `Its configuration is left on disk untouched.`;
}

module.exports = {
  SUPPORTED_AGENT_ROLES,
  RETIRED_AGENT_ROLES,
  isSupportedAgentRole,
  unsupportedRoleNote,
};
