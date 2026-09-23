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

// Sort key for a group / subgroup list: largest total first, ties broken by key
// ascending so the order is stable and reproducible.
function byTotalThenKey(a, b) {
  return b.tokens.total - a.tokens.total || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// The single group key a record carries for a non-`model` dimension. `model` is
// the one dimension that fans a record across several keys (its per-model split),
// so it is handled separately by the callers below.
function keyFor(rec, groupBy) {
  if (groupBy === 'team') return rec.teamId || UNKNOWN;
  // A record with no resolvable charge (no requester, no agent owner) lands in
  // `unknown` exactly like a team-less one — the gap is reported, never folded
  // into somebody else's total. Same for a legacy pre-#2137 record.
  if (groupBy === 'user') return (rec.attribution && rec.attribution.userId) || UNKNOWN;
  if (groupBy === 'provider') return rec.provider || UNKNOWN;
  if (groupBy === 'providerTier') return rec.providerTier || UNKNOWN;
  if (groupBy === 'day') return typeof rec.ts === 'string' ? rec.ts.slice(0, 10) : UNKNOWN;
  return rec.agentId || UNKNOWN; // 'agent'
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
  return [{ key: keyFor(rec, groupBy), tokens: rec.tokens }];
}

// Which (primary, secondary) cell(s) a record contributes to for a cross-tab
// (#2440), paired with the tokens for each. Mirrors `contributions`: when
// neither axis is `model` the record lands in ONE cell carrying its turn-wide
// tokens; when either axis is `model` the record fans over its per-model split,
// the model axis taking the model name and the other axis its single key (so a
// record with no modelUsage contributes to no cell, exactly as the single-axis
// `model` grouping drops it — the primary group still holds it via
// `contributions`, so the primary column keeps reconciling with the one-level
// view). `model` on both axes never reaches here — the caller rejects a
// secondary equal to the primary.
function pairContributions(rec, primary, secondary) {
  const primaryIsModel = primary === 'model';
  const secondaryIsModel = secondary === 'model';
  if (primaryIsModel || secondaryIsModel) {
    const mu = rec.modelUsage && typeof rec.modelUsage === 'object' ? rec.modelUsage : {};
    return Object.keys(mu).map((model) => ({
      pKey: primaryIsModel ? model : keyFor(rec, primary),
      sKey: secondaryIsModel ? model : keyFor(rec, secondary),
      tokens: mu[model],
    }));
  }
  return [{ pKey: keyFor(rec, primary), sKey: keyFor(rec, secondary), tokens: rec.tokens }];
}

// summarize(records, { since, until, groupBy, secondaryGroupBy })
//   -> { since, until, groupBy, totals, groups[, secondaryGroupBy] }
// totals = sum of every in-range record's turn-wide tokens (+ invocations = record count),
// so totals stay stable regardless of groupBy; `groups` are sorted by total desc, key asc.
//
// An optional `secondaryGroupBy` (#2440) adds a second grouping level: each group
// gains a `subgroups` array (same shape, same sort) cross-tabulating the second
// dimension inside the first. It is ignored — and the output is byte-identical to
// the single-dimension result — when it is absent, unknown, or equal to the
// primary (a self-cross adds no information; the UI never offers it).
function summarize(records, query = {}) {
  const since = query.since || null;
  const until = query.until || null;
  const groupBy = GROUP_BY.has(query.groupBy) ? query.groupBy : 'agent';
  const secondaryGroupBy = GROUP_BY.has(query.secondaryGroupBy) && query.secondaryGroupBy !== groupBy
    ? query.secondaryGroupBy
    : null;

  const totals = zeroTokens();
  let invocations = 0;
  const groups = new Map(); // key -> { tokens, invocations, sub? }

  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || !inRange(rec.ts, since, until)) continue;
    addTokens(totals, rec.tokens);
    invocations += 1;
    for (const { key, tokens } of contributions(rec, groupBy)) {
      let g = groups.get(key);
      if (!g) {
        g = { tokens: zeroTokens(), invocations: 0 };
        if (secondaryGroupBy) g.sub = new Map();
        groups.set(key, g);
      }
      addTokens(g.tokens, tokens);
      g.invocations += 1;
    }
    if (!secondaryGroupBy) continue;
    for (const { pKey, sKey, tokens } of pairContributions(rec, groupBy, secondaryGroupBy)) {
      const g = groups.get(pKey);
      if (!g) continue; // pKey is always one of the primary keys created above
      let s = g.sub.get(sKey);
      if (!s) {
        s = { tokens: zeroTokens(), invocations: 0 };
        g.sub.set(sKey, s);
      }
      addTokens(s.tokens, tokens);
      s.invocations += 1;
    }
  }

  const totalsOut = { ...withTotal(totals), invocations };
  const groupsOut = [...groups.entries()]
    .map(([key, g]) => {
      const out = { key, tokens: withTotal(g.tokens), invocations: g.invocations };
      if (secondaryGroupBy) {
        out.subgroups = [...g.sub.entries()]
          .map(([k, s]) => ({ key: k, tokens: withTotal(s.tokens), invocations: s.invocations }))
          .sort(byTotalThenKey);
      }
      return out;
    })
    .sort(byTotalThenKey);

  const result = { since, until, groupBy, totals: totalsOut, groups: groupsOut };
  if (secondaryGroupBy) result.secondaryGroupBy = secondaryGroupBy;
  return result;
}

module.exports = { summarize, GROUP_BY, TOKEN_CLASSES };
