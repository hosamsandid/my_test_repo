'use strict';

// Pure aggregation for token-usage records (#654, view 1 of docs/cost-per-pr-concept.md).
// Emitter contract lives in the shared golden fixture usage-summary.fixture.json,
// asserted from both this suite and the Python emitter's suite — the canonical
// usage-record schema (build_usage_record) is the shared contract. Tokens only:
// totalCostUsd may ride along opaque on a record but is NEVER read/surfaced here.

// `user` and `providerTier` (#2137) group on fields the ORCHESTRATOR stamps at
// ingest (enrichUsageRecord over usage-attribution.js), not on anything the
// agent emits — which is why they are absent from the emitter side of
// usage-summary.fixture.json and covered by this module's own suite instead.
// They exist because #2136's global providers broke the assumption that `team`
// is always the accounting anchor: a global provider has no team.
const GROUP_BY = new Set(['agent', 'team', 'user', 'model', 'provider', 'providerTier', 'day']);
const TOKEN_CLASSES = ['input', 'output', 'cacheCreationInput', 'cacheReadInput'];
const UNKNOWN = 'unknown';

function zeroTokens() {
  return { input: 0, output: 0, cacheCreationInput: 0, cacheReadInput: 0 };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// since inclusive, until exclusive (half-open) — clean day-boundary queries.
function inRange(ts, since, until) {
  if (typeof ts !== 'string' || !ts) return false;
  if (since && ts < since) return false;
  if (until && ts >= until) return false;
  return true;
}

function addTokens(acc, tokens) {
  for (const k of TOKEN_CLASSES) acc[k] += num(tokens && tokens[k]);
}

function withTotal(tokens) {
  const total = TOKEN_CLASSES.reduce((s, k) => s + num(tokens[k]), 0);
  return { ...tokens, total };
}

// Which group key(s) a record contributes to, paired with the tokens for each.
// All groupings but `model` attribute the record's turn-wide tokens to one key;
// `model` fans the record across its per-model split (a record with no
// modelUsage contributes to no model group, but still counts in totals).
function contributions(rec, groupBy) {
  if (groupBy === 'model') {
    const mu = rec.modelUsage && typeof rec.modelUsage === 'object' ? rec.modelUsage : {};
    return Object.keys(mu).map((model) => ({ key: model, tokens: mu[model] }));
  }
  let key;
  if (groupBy === 'team') key = rec.teamId || UNKNOWN;
  // A record with no resolvable charge (no requester, no agent owner) lands in
  // `unknown` exactly like a team-less one — the gap is reported, never folded
  // into somebody else's total. Same for a legacy pre-#2137 record.
  else if (groupBy === 'user') key = (rec.attribution && rec.attribution.userId) || UNKNOWN;
  else if (groupBy === 'provider') key = rec.provider || UNKNOWN;
  else if (groupBy === 'providerTier') key = rec.providerTier || UNKNOWN;
  else if (groupBy === 'day') key = typeof rec.ts === 'string' ? rec.ts.slice(0, 10) : UNKNOWN;
  else key = rec.agentId || UNKNOWN; // 'agent'
  return [{ key, tokens: rec.tokens }];
}

// summarize(records, { since, until, groupBy }) -> { since, until, groupBy, totals, groups }
// totals = sum of every in-range record's turn-wide tokens (+ invocations = record count),
// so totals stay stable regardless of groupBy; `groups` are sorted by total desc, key asc.
function summarize(records, query = {}) {
  const since = query.since || null;
  const until = query.until || null;
  const groupBy = GROUP_BY.has(query.groupBy) ? query.groupBy : 'agent';

  const totals = zeroTokens();
  let invocations = 0;
  const groups = new Map(); // key -> { tokens, invocations }

  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || !inRange(rec.ts, since, until)) continue;
    addTokens(totals, rec.tokens);
    invocations += 1;
    for (const { key, tokens } of contributions(rec, groupBy)) {
      let g = groups.get(key);
      if (!g) {
        g = { tokens: zeroTokens(), invocations: 0 };
        groups.set(key, g);
      }
      addTokens(g.tokens, tokens);
      g.invocations += 1;
    }
  }

  const totalsOut = { ...withTotal(totals), invocations };
  const groupsOut = [...groups.entries()]
    .map(([key, g]) => ({ key, tokens: withTotal(g.tokens), invocations: g.invocations }))
    .sort((a, b) => b.tokens.total - a.tokens.total || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { since, until, groupBy, totals: totalsOut, groups: groupsOut };
}

module.exports = { summarize, GROUP_BY, TOKEN_CLASSES };
