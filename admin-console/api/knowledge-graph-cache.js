'use strict';

/*
 * The decisions behind the knowledge-graph response cache (#571). Pure; the
 * cache itself is a `createTtlCache` (ttl-cache.js) wired in api.js.
 *
 * The Knowledge page reloads the graph on every feed event while it streams, and
 * each build reads every team's KB store plus three orchestrator augment calls.
 * A short single-flight cache lets every caller with the same view share one build.
 */

const { ttlMsFromEnv } = require('./ttl-cache');
const { mutationInvalidatesRoster, trimTrailingSlashes } = require('./matrix-agent-roster');

// The response depends only on the resolved scope string, includeArchived and
// WHO is asking (visibility). Every `scope.all` caller sees the same graph, so
// on the single-operator default every caller shares one build.
function knowledgeGraphCacheKey({ scope, includeArchived, viewerScope }) {
  const viewer = viewerScope && viewerScope.all ? 'all' : `u:${viewerScope && viewerScope.userId != null ? viewerScope.userId : ''}`;
  return `${scope}|${includeArchived ? 1 : 0}|${viewer}`;
}

// Console mutations that can change a graph: every knowledge and skill write,
// membership changes (visibility), plus the agent/team/env table the chat
// roster already invalidates on (a grant, a rename, a new member, a deleted team).
const KNOWLEDGE_GRAPH_MUTATIONS = [
  /^\/api\/knowledge(\/|$)/,
  /^\/api\/skills(\/|$)/,
  /^\/api\/admin\/memberships(\/|$)/,
];

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Does this request, IF it succeeds, invalidate the cached graphs? The final
 * status is the middleware's call (invalidate-on-write.js), not this one's.
 * @param {string} method
 * @param {string} url      `req.originalUrl` (a query string is ignored)
 */
function mutationInvalidatesKnowledgeGraph(method, url) {
  const m = String(method || '').toUpperCase();
  if (!MUTATING.has(m)) return false;
  const p = trimTrailingSlashes(String(url || '').split('?')[0]); // linear, not /\/+$/ (ReDoS)
  if (KNOWLEDGE_GRAPH_MUTATIONS.some((re) => re.test(p))) return true;
  return mutationInvalidatesRoster(m, p);
}

// Which cached graphs does one tailed knowledge-feed event make stale? The
// orchestrator stamps every event with the KNOWLEDGE team it wrote for (the
// squad id the graph's `team:` scope uses). A `team:T` graph only reads T's
// entries and T's skills (team tier, or global with originTeamId T), so only
// `team:<event.teamId>` goes; `global` summarises every team and always goes.
// An `agent:` key cannot say which squad its agent resolves to, so it always
// goes too (one agent's graph is the cheap build). An event without a team id
// clears everything — the safe answer when the event can't be placed.
function knowledgeGraphKeyStaleForEvent(key, event) {
  const k = String(key);
  const bar = k.indexOf('|');
  const scope = bar >= 0 ? k.slice(0, bar) : k;
  const teamId = event && typeof event.teamId === 'string' ? event.teamId.trim() : '';
  if (!teamId) return true;
  if (scope.startsWith('team:')) return scope.slice('team:'.length) === teamId;
  return true; // global, agent:<id>, anything unrecognised
}

// Every open `/api/knowledge/stream` tails the same events file, so without a
// shared mark each event would clear the cache once PER STREAM — and every
// clear detaches the builds the previous streams' reloads just started. The
// mark is the byte offset (end of line) through which events have already
// invalidated: the first stream to reach a line clears, the rest skip it.
// Returns the decision and the advanced mark.
function claimKnowledgeEventOffset(mark, endOffset) {
  const m = Number.isFinite(mark) && mark > 0 ? mark : 0;
  if (!Number.isFinite(endOffset) || endOffset <= m) return { invalidate: false, mark: m };
  return { invalidate: true, mark: endOffset };
}

// The events file was truncated/rotated below the mark: its offsets start over,
// so every line in the new file is new — reset the mark.
function knowledgeEventMarkForFileSize(mark, size) {
  const m = Number.isFinite(mark) && mark > 0 ? mark : 0;
  return Number.isFinite(size) && size < m ? 0 : m;
}

// `KNOWLEDGE_GRAPH_TTL_MS`: unset/invalid ⇒ 5000; `0` turns the cache off.
function knowledgeGraphTtlMsFromEnv(env) {
  return ttlMsFromEnv(env && env.KNOWLEDGE_GRAPH_TTL_MS, 5000);
}

// `KNOWLEDGE_AUGMENT_TIMEOUT_MS`: the per-call bound on the orchestrator
// augment fetches. Unset/invalid/0 ⇒ 2500 (a timeout must never be "off").
function knowledgeAugmentTimeoutMsFromEnv(env) {
  const n = ttlMsFromEnv(env && env.KNOWLEDGE_AUGMENT_TIMEOUT_MS, 2500);
  return n > 0 ? n : 2500;
}

module.exports = {
  knowledgeGraphCacheKey,
  knowledgeGraphKeyStaleForEvent,
  claimKnowledgeEventOffset,
  knowledgeEventMarkForFileSize,
  mutationInvalidatesKnowledgeGraph,
  knowledgeGraphTtlMsFromEnv,
  knowledgeAugmentTimeoutMsFromEnv,
  KNOWLEDGE_GRAPH_MUTATIONS,
};
