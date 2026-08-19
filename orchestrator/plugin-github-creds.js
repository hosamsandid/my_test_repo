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

// ─── flow labels + label→agent trigger preview (issue #1642, Item 2) ─────────
//
// The plugin's "Add a label" suggestions should surface the labels the team's
// FLOW actually uses (gate/outcome labels), not the raw GitHub repo label list,
// and each suggested label should preview WHICH agent(s) it wakes. Both are
// derivable server-side from the team's flow definition; this pure core does the
// derivation and the orchestrator pushes the result alongside the credentials.
//
// A label counts as a flow label when it appears as:
//   • a gate/brake entry in the team's label registry (`labels[].name`), or
//   • a `labelFilter` on a member's `*.labeled` github-event trigger (a wake
//     label — the label that hands work to that agent), or
//   • an `emits` token the flow's work sets (an outcome label).
// The union is order-stable (registry → wake → emits) and repo-independent
// (union across the team's flows), matching the resolved decision for AC1–3.
//
// The trigger preview (AC6–8) is per repository, because a trigger is repo-
// specific: `labelAgents[repo][label] = [agentDisplayName, ...]` for the enabled
// agents a label wakes there. A trigger with no/blank `labelFilter` wakes on ANY
// label, so its agent is recorded under the empty-string key `''` (never a valid
// label name) for the UI to fold into every label's preview.

const LABELED_EVENTS = ['issues.labeled', 'pull_request.labeled'];

function pushUnique(list, seen, value) {
  if (typeof value !== 'string') return;
  const v = value.trim();
  if (!v || seen.has(v)) return;
  seen.add(v);
  list.push(v);
}

// Add an agent display name to labelAgents[repo][labelKey], creating containers
// as needed and de-duplicating (an agent listening for the same label on both
// issues and PRs is still one entry).
function addLabelAgent(labelAgents, repo, labelKey, name) {
  if (!repo || typeof name !== 'string' || !name) return;
  const byRepo = labelAgents[repo] || (labelAgents[repo] = {});
  const arr = byRepo[labelKey] || (byRepo[labelKey] = []);
  if (!arr.includes(name)) arr.push(name);
}

// Build `{ flowLabels, labelAgents, labelUsage }` for one team from its label
// registry and its members (each `{ displayName, enabled, triggers, emits }`).
// Pure.
//
// `labelUsage` (#1730) classifies each flow label by HOW it is normally set, so
// the plugin can colour-code the workflow-trigger buttons: a `humanGate`-flagged
// registry label is `'humanGate'` (a hand-off a human deliberately sets), a
// label some agent `emits` is `'agentEmitted'` (a label an agent usually sets
// itself). `humanGate` wins if a label is somehow both (an agent emitting a gate
// label is the flow's `gate-violation`, so the human intent is the truthful
// classification). A label we cannot place (a wake label neither gate-flagged
// nor emitted) is simply omitted — the UI degrades it to a single neutral
// treatment rather than mis-colouring it.
function buildTeamFlowLabels({ teamLabels, members } = {}) {
  const flowLabels = [];
  const seen = new Set();
  const labelAgents = {};
  const labelUsage = {};

  // 1) registry gate/brake/outcome labels first
  for (const l of Array.isArray(teamLabels) ? teamLabels : []) {
    if (l && typeof l === 'object') {
      pushUnique(flowLabels, seen, l.name);
      if (l.humanGate && typeof l.name === 'string' && l.name.trim()) {
        labelUsage[l.name.trim()] = 'humanGate';
      }
    } else if (typeof l === 'string') {
      pushUnique(flowLabels, seen, l);
    }
  }

  // 2) wake labels (labelFilter on *.labeled triggers) + the per-repo preview
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || m.enabled === false) continue;
    const name = (typeof m.displayName === 'string' && m.displayName.trim()) || '';
    for (const t of Array.isArray(m.triggers) ? m.triggers : []) {
      if (!t || t.type !== 'github-event' || t.enabled === false) continue;
      if (!Array.isArray(t.events) || !t.events.some((e) => LABELED_EVENTS.includes(e))) continue;
      const repo = typeof t.repo === 'string' ? t.repo.trim() : '';
      const filter = typeof t.labelFilter === 'string' ? t.labelFilter.trim() : '';
      if (filter) {
        pushUnique(flowLabels, seen, filter);
        addLabelAgent(labelAgents, repo, filter, name);
      } else {
        // no labelFilter → wakes on ANY label in this repo
        addLabelAgent(labelAgents, repo, '', name);
      }
    }
  }

  // 3) outcome labels the work sets (emits). An emitted label is agent-set —
  // unless the registry already flagged it a human gate (which wins, above).
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || m.enabled === false) continue;
    for (const e of Array.isArray(m.emits) ? m.emits : []) {
      pushUnique(flowLabels, seen, e);
      if (typeof e === 'string' && e.trim() && !labelUsage[e.trim()]) {
        labelUsage[e.trim()] = 'agentEmitted';
      }
    }
  }

  return { flowLabels, labelAgents, labelUsage };
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
  buildTeamFlowLabels,
};
