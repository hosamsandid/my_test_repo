'use strict';

// ─── plugin scope resolution + resource ownership (Phase 1, #1517) ───────────
//
// Two pure primitives shared by the orchestrator (mints tokens, tears down
// scopes) and every broker (stamps + filters owned resources), per
// docs/plugin-system-concept.md §4.6.
//
// 1. resolveScopeId(agentCfg, granularity) — the identity a token carries:
//      • granularity 'team' (default): the team for members, the agent id for
//        standalone agents (the `podmanScopeId` rule). A squad shares one pool.
//      • granularity 'agent': always the agent's own id, so two agents of one
//        team are as isolated from each other as two teams are.
//    Granularity multiplies *tokens*, never backend credentials.
//
// 2. Ownership labels — whatever a broker creates for a scope is labelled
//    `aee.plugin.owner=<scopeId>`, listed/operated only within the scope, and
//    torn down on team/agent deletion. Deleting one member at 'agent'
//    granularity tears down only that member's resources; the squad's other
//    scopes are untouched (this is what the `agent`-granularity acceptance
//    test exercises). Generalises podman-mcp `owner-scope.js`.

const GRANULARITIES = Object.freeze(['team', 'agent']);
const DEFAULT_GRANULARITY = 'team';

// The scopeId the orchestrator mints its OWN tokens under (the credential push,
// `plugin-runtime.pushScopeCredentials`). A broker accepts that push from this
// scope ONLY (broker-sdk `internalPushEndpoint`), so it must never be derivable
// for an agent: AGENT_ID_RE permits a leading underscore, and an agent or team
// of one literally named `_internal` would otherwise be granted the push
// credential. `resolveScopeId` returns null for it; `mintScopeToken` refuses it.
const INTERNAL_SCOPE_ID = '_internal';

function isReservedScopeId(scopeId) {
  return scopeId === INTERNAL_SCOPE_ID;
}

// Container/network labels the orchestrator stamps on a plugin's sidecar and a
// broker stamps on resources it creates.
const PLUGIN_ID_LABEL = 'aee.plugin.id';
const OWNER_LABEL_KEY = 'aee.plugin.owner';

function isMember(agentCfg) {
  return !!(agentCfg && typeof agentCfg.parentTeamId === 'string' && agentCfg.parentTeamId);
}

// The scope id a granted agent's token carries under the chosen granularity.
// Returns null when the agent has no derivable id.
function resolveScopeId(agentCfg, granularity = DEFAULT_GRANULARITY) {
  if (!agentCfg) return null;
  const g = GRANULARITIES.includes(granularity) ? granularity : DEFAULT_GRANULARITY;
  // 'agent': self. 'team': team for members, self for standalone.
  const scopeId = g === 'agent'
    ? (agentCfg.id || null)
    : (isMember(agentCfg) ? agentCfg.parentTeamId : (agentCfg.id || null));
  return isReservedScopeId(scopeId) ? null : scopeId;
}

// ── ownership label helpers (broker + orchestrator side) ────────────────────

function ownerLabelArg(scopeId) {
  return `${OWNER_LABEL_KEY}=${scopeId}`;
}

function isOwned(resource, scopeId) {
  if (typeof scopeId !== 'string' || scopeId.length === 0) return false;
  return !!(resource && resource.Labels && resource.Labels[OWNER_LABEL_KEY] === scopeId);
}

function filterOwned(resources, scopeId) {
  return (Array.isArray(resources) ? resources : []).filter((r) => isOwned(r, scopeId));
}

module.exports = {
  GRANULARITIES,
  DEFAULT_GRANULARITY,
  INTERNAL_SCOPE_ID,
  isReservedScopeId,
  PLUGIN_ID_LABEL,
  OWNER_LABEL_KEY,
  isMember,
  resolveScopeId,
  ownerLabelArg,
  isOwned,
  filterOwned,
};
