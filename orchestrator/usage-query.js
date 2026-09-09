'use strict';

// Pure scoping + query builder for the agent-facing read-only usage surface
// (#679, §6 phase 3 item 3 of docs/cost-per-pr-concept.md).
//
// An agent container is volume-isolated from the orchestrator-owned
// /workspace/usage/ store (concept §4.1), so it cannot read usage records
// directly. The `usage` CLI (agent-image/scripts/usage) queries them across
// that boundary via GET /internal/agents/:id/usage/summary; this module is the
// pure core that endpoint runs after reading the records (the thin IO shell).
//
// It does two things and nothing else — read-only, tokens-only:
//   1. SCOPE the records fail-closed to what the calling agent may see:
//      its OWN usage (scope 'self') or its TEAM's aggregate (scope 'team').
//      An agent may NEVER read another team's usage: an unresolved team (unknown
//      agent, no team) yields an empty set, never all-teams.
//   2. AGGREGATE the scoped records by REUSING the Phase-1 summary module
//      (./usage-summary — a byte-identical mirror of the admin-console
//      canonical, guarded by usage-summary.test.js), so there is exactly one
//      aggregation implementation. No dollar figures ever ride along.

const { summarize, TOKEN_CLASSES } = require('./usage-summary');

const SCOPES = new Set(['self', 'team']);

function normalizeScope(scope) {
  return SCOPES.has(scope) ? scope : 'self';
}

// Which groupings an AGENT may ask for (#2137). Deliberately a SUBSET of the
// aggregator's `GROUP_BY`, and deliberately enforced here rather than only in
// the on-agent `usage` CLI — the CLI's own whitelist is a usability affordance,
// not a boundary: an agent can call the internal endpoint directly.
//
// `providerTier` is in: which tier of provider a run spent on is a property of
// the run, and knowing it helps an agent stay budget-aware (the whole point of
// the CLI). `user` is OUT: the console's per-user breakdown is System-Admin-only
// (#801), and a team-scoped answer would hand one agent the spend of every human
// on its team — data it has no decision to make with, in a context it can quote
// into a chat message. The agent's own runs are still fully visible to it; only
// the per-human axis is withheld.
//
// An excluded grouping is COERCED to the default rather than refused, matching
// how `summarize` already treats an unrecognised value, and the response echoes
// the `groupBy` actually applied so a caller is never misled about what it got.
const AGENT_GROUP_BY = new Set(['agent', 'team', 'model', 'provider', 'providerTier', 'day']);

function normalizeAgentGroupBy(groupBy) {
  return AGENT_GROUP_BY.has(groupBy) ? groupBy : undefined;
}

// Filter records to the caller's scope. Pure, fail-closed:
//   self → only records the agent itself produced (agentId === agentId).
//   team → only records of the agent's resolved team (teamId === teamId).
// A falsy agentId (self) or falsy teamId (team — unknown/teamless agent) can
// match nothing, so the result is empty rather than the whole store.
function scopeRecords(records, { scope, agentId, teamId } = {}) {
  const s = normalizeScope(scope);
  const list = Array.isArray(records) ? records : [];
  if (s === 'team') {
    if (!teamId) return [];
    return list.filter((r) => r && r.teamId === teamId);
  }
  // self
  if (!agentId) return [];
  return list.filter((r) => r && r.agentId === agentId);
}

// Build the full read-only usage response for an agent query. Pure — scope the
// records, then hand them to the shared summariser. The output carries the four
// token classes separately (in totals + every group), the scope/attribution
// context, and an explicit tokensOnly flag; it NEVER contains a dollar figure
// (summarize surfaces only the four classes + their total + invocations).
//
// `teamId` is the caller agent's resolved team (or null when unresolved); the
// IO shell resolves it fail-closed (unknown agent → null → team scope empty).
function buildUsageQuery(records, { scope, agentId, teamId, since, until, groupBy } = {}) {
  const s = normalizeScope(scope);
  const scopedTeamId = s === 'team' ? (teamId || null) : null;
  const scoped = scopeRecords(records, { scope: s, agentId, teamId });
  const summary = summarize(scoped, { since, until, groupBy: normalizeAgentGroupBy(groupBy) });
  return {
    scope: s,
    agentId: agentId || null,
    teamId: scopedTeamId,
    since: summary.since,
    until: summary.until,
    groupBy: summary.groupBy,
    tokenClasses: [...TOKEN_CLASSES],
    tokensOnly: true,
    // `invocations` (on totals) is the coverage denominator: how many usage
    // records back these numbers, so a downstream (e.g. a soft budget alert)
    // knows the totals aren't derived from zero records.
    totals: summary.totals,
    groups: summary.groups,
  };
}

module.exports = {
  buildUsageQuery, scopeRecords, normalizeScope, SCOPES,
  AGENT_GROUP_BY, normalizeAgentGroupBy,
};
