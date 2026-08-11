'use strict';

// ─── github-issues plugin: per-scope credential resolver (issue #1633) ───────
//
// The github-issues broker holds no static credential of its own; it reuses the
// single GitHub token bound to each granted team's Working Environment (AC10).
// A broker sidecar is shared across every team it is granted to, but the token
// and repository list are per-team-environment, so a static env-var injection at
// container-create cannot express them. Instead the orchestrator resolves, per
// granted TEAM scope, its `environment → { githubTokenId → token, repositories }`
// and PUSHES a `{ scopeId: { token, repos } }` map to the broker over a
// bearer-authed internal route (plugin-runtime.pushGithubIssueCredentials),
// mirroring the teardown-scope push. The token stays server-side: it never
// reaches the browser or an agent container.
//
// This module is the PURE core of that resolution — no fs, no orchestrator
// globals — so it unit-tests in isolation (the process-template.js discipline).
// The live orchestrator supplies the fs-backed collaborators (loadEnvironment,
// token reader, repo-name parser).
//
// scopeId == teamId for team granularity (plugin-scope.resolveScopeId), which is
// also the key the broker derives from the signed viewer headers
// (viewer.teamIds) and from an agent's scope token — so one map serves the UI
// path and the agent-CLI path alike.

// Deduplicate while preserving first-seen order.
function unique(list) {
  const seen = new Set();
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (x == null) continue;
    const k = String(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

// Build the `{ scopeId: { token, repos:[{fullName,defaultBranch}] } }` map for a
// set of team scope ids.
//
// Collaborators (all injected so the core stays pure):
//   • envForScope(scopeId)       → the team's normalized environment object
//                                  ({ repositories:[{url,branch}], githubTokenId })
//                                  or null.
//   • readToken(githubTokenId)   → the raw token string, or null/'' on any error.
//   • parseRepoFullName(url)     → "owner/name" or null (the poller's parser).
//
// Every granted scope gets an entry even when it has no env / no token / no
// repos — the broker renders the "configure a token" / "no repositories" empty
// states from a present-but-empty entry, and an absent entry would instead read
// as "unknown scope".
function resolveScopeGithubCredentials(scopeIds, { envForScope, readToken, parseRepoFullName } = {}) {
  if (typeof envForScope !== 'function') throw new Error('envForScope is required');
  if (typeof readToken !== 'function') throw new Error('readToken is required');
  if (typeof parseRepoFullName !== 'function') throw new Error('parseRepoFullName is required');

  const out = {};
  for (const scopeId of unique(scopeIds)) {
    const entry = { token: '', repos: [] };
    let env = null;
    try { env = envForScope(scopeId); } catch { env = null; }
    if (env && typeof env === 'object') {
      if (env.githubTokenId) {
        let token = null;
        try { token = readToken(env.githubTokenId); } catch { token = null; }
        entry.token = typeof token === 'string' ? token.trim() : '';
      }
      const seen = new Set();
      for (const r of Array.isArray(env.repositories) ? env.repositories : []) {
        let full = null;
        try { full = parseRepoFullName(r && r.url); } catch { full = null; }
        if (!full || seen.has(full)) continue;
        seen.add(full);
        entry.repos.push({ fullName: full, defaultBranch: (r && r.branch) ? String(r.branch) : 'main' });
      }
    }
    out[scopeId] = entry;
  }
  return out;
}

// The unique team scope ids from a granted-agents enumeration (the shape of
// GET /internal/plugins/:id/granted-agents). Only team-granularity grants carry
// a team scope; github-issues declares scopes:["team"] so every grant is a team
// scope, but we filter defensively.
function teamScopeIdsFromGrants(grantedAgents) {
  const ids = [];
  for (const g of Array.isArray(grantedAgents) ? grantedAgents : []) {
    if (!g || typeof g !== 'object') continue;
    if (g.scopeGranularity && g.scopeGranularity !== 'team') continue;
    const teamId = g.teamId || g.parentTeamId || (g.agentId || null);
    if (teamId) ids.push(String(teamId));
  }
  return unique(ids);
}

module.exports = {
  unique,
  resolveScopeGithubCredentials,
  teamScopeIdsFromGrants,
};
