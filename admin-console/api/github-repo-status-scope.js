'use strict';

// #2537 AC9: the viewer-scoped cut of the poller's repository status
// (orchestrator/github-repo-status.js, served unscoped on the internal API).
//
// A System Admin sees every repository. Anyone else sees a repository only when
// it belongs to one of their teams — i.e. one of its `relatedAgentIds` (agents
// bound to a Working Environment that lists it, agents carrying it in
// `agentRepositories`, agents with a github-event trigger naming it) is an agent
// they may see. Within a visible row, agent/trigger details and environment
// names are cut down to what the viewer may see, and the internal
// `relatedAgentIds` never leaves the server. Token VALUES are never in the input
// to begin with — only token ids.
//
// Pure: the route resolves `visibleAgentIds` / `visibleEnvIds` with the same
// scope helpers every other agent/environment route uses.

function scopeRepoStatus(rows, { all = false, visibleAgentIds = new Set(), visibleEnvIds = new Set() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const { relatedAgentIds, ...rest } = row;
    if (all) { out.push(rest); continue; }
    const related = Array.isArray(relatedAgentIds) ? relatedAgentIds : [];
    if (!related.some((id) => visibleAgentIds.has(id))) continue;
    const envVisible = (e) => e && visibleEnvIds.has(e.id);
    const scrubEnv = (e) => ({ ...e, teamId: e.teamId && visibleAgentIds.has(e.teamId) ? e.teamId : null });
    const environments = (rest.environments || []).filter(envVisible).map(scrubEnv);
    const hiddenEnvironmentCount = (rest.environments || []).length - environments.length;
    let tokenEnvironment = rest.tokenEnvironment || null;
    if (tokenEnvironment && !envVisible(tokenEnvironment)) {
      // Another team's environment supplies the token: say THAT a token is in
      // use (and whether it is usable) without naming whose.
      tokenEnvironment = { id: null, name: null, tokenId: null, tokenState: tokenEnvironment.tokenState, teamId: null, hidden: true };
    } else if (tokenEnvironment) {
      tokenEnvironment = scrubEnv(tokenEnvironment);
    }
    out.push({
      ...rest,
      tokenEnvironment,
      environments,
      hiddenEnvironmentCount,
      agentRepositoryAgents: (rest.agentRepositoryAgents || []).filter((a) => visibleAgentIds.has(a.id)),
      triggers: (rest.triggers || []).filter((t) => visibleAgentIds.has(t.agentId)),
    });
  }
  return out;
}

// #2537 AC8: the row the poller holds for one repository, looked up by the
// `owner/name` the environment banner derives from the repo URL. null when the
// poller status is unavailable or the repo has no row.
function findRepoStatus(rows, fullName) {
  if (!fullName || !Array.isArray(rows)) return null;
  return rows.find((r) => r && r.repo === fullName) || null;
}

module.exports = { scopeRepoStatus, findRepoStatus };
