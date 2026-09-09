'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { summarize } = require('./usage-summary');

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'usage-summary.fixture.json'), 'utf8'),
);

// Two-sided contract: the aggregator consumes exactly the canonical records the
// Python emitter (build_usage_record) produces — records[].expected. Each
// summary case references those records by index, so the schema can't drift.
const canonical = fixture.records.map((r) => r.expected);

test('summarize matches every golden summaryCase', () => {
  for (const c of fixture.summaryCases) {
    const recs = c.recordIndexes.map((i) => canonical[i]);
    assert.deepEqual(summarize(recs, c.query), c.expected, c.name);
  }
});

test('groupBy defaults to agent for unknown/missing value', () => {
  const res = summarize(canonical, { groupBy: 'nonsense' });
  assert.equal(res.groupBy, 'agent');
});

test('empty / non-array input yields zeroed totals and no groups', () => {
  for (const input of [[], null, undefined, {}]) {
    const res = summarize(input, { groupBy: 'agent' });
    assert.deepEqual(res.totals, {
      input: 0, output: 0, cacheCreationInput: 0, cacheReadInput: 0, total: 0, invocations: 0,
    });
    assert.deepEqual(res.groups, []);
  }
});

test('four-class split is always present on totals and every group', () => {
  const res = summarize(canonical, { groupBy: 'agent' });
  for (const k of ['input', 'output', 'cacheCreationInput', 'cacheReadInput', 'total']) {
    assert.ok(k in res.totals, `totals missing ${k}`);
  }
  for (const g of res.groups) {
    for (const k of ['input', 'output', 'cacheCreationInput', 'cacheReadInput', 'total']) {
      assert.ok(k in g.tokens, `group ${g.key} missing ${k}`);
    }
  }
});

test('totals are stable across groupBy (sum of turn-wide record tokens)', () => {
  const byAgent = summarize(canonical, { groupBy: 'agent' }).totals;
  for (const gb of ['team', 'user', 'model', 'provider', 'providerTier', 'day']) {
    assert.deepEqual(summarize(canonical, { groupBy: gb }).totals, byAgent, gb);
  }
});

// ── #2137: the two groupings a GLOBAL provider makes necessary ───────────────
//
// `attribution` and `providerTier` are stamped by the ORCHESTRATOR at ingest
// (enrichUsageRecord over usage-attribution.js), not by the agent, so they are
// deliberately absent from the emitter side of usage-summary.fixture.json —
// these records are the ENRICHED shape the store actually holds.

const tokens = (n) => ({ input: n, output: 0, cacheCreationInput: 0, cacheReadInput: 0 });
const enriched = [
  // Ada, chatting with a team agent on the team's own provider.
  { ts: '2026-09-01T10:00:00.000Z', agentId: 'team-a-dev', teamId: 'team-a', provider: 'ep-team',
    providerTier: 'team', attribution: { userId: 'u-ada', kind: 'requesting-user' }, tokens: tokens(10) },
  // Ada again, this time on a GLOBAL provider — no team on the record at all,
  // which is exactly the case `teamId` could not account for.
  { ts: '2026-09-01T11:00:00.000Z', agentId: 'solo', teamId: null, provider: 'ep-global',
    providerTier: 'global', attribution: { userId: 'u-ada', kind: 'requesting-user' }, tokens: tokens(3) },
  // An autonomous run on the same global provider, charged to the agent's owner.
  { ts: '2026-09-01T12:00:00.000Z', agentId: 'solo', teamId: null, provider: 'ep-global',
    providerTier: 'global', attribution: { userId: 'u-bob', kind: 'agent-owner' }, tokens: tokens(4) },
  // Neither resolved — and a provider that has since been deleted.
  { ts: '2026-09-01T13:00:00.000Z', agentId: 'ghost', teamId: null, provider: 'ep-gone',
    providerTier: null, attribution: { userId: null, kind: 'unattributed' }, tokens: tokens(1) },
  // A record written before #2137 carries neither field.
  { ts: '2026-09-01T14:00:00.000Z', agentId: 'legacy', teamId: 'team-a', provider: 'ep-team', tokens: tokens(2) },
];

test('groupBy user attributes spend per human across teams and tiers (AC1)', () => {
  const res = summarize(enriched, { groupBy: 'user' });
  assert.equal(res.groupBy, 'user');
  assert.deepEqual(
    res.groups.map((g) => [g.key, g.tokens.total, g.invocations]),
    [['u-ada', 13, 2], ['u-bob', 4, 1], ['unknown', 3, 2]],
  );
  // Ada's two runs are one row even though one is team-scoped and the other has
  // no team at all — the whole point of a user key.
  assert.equal(res.totals.total, 20);
});

test('groupBy user folds an unattributed record and a legacy one into unknown', () => {
  const res = summarize(enriched, { groupBy: 'user' });
  const unknown = res.groups.find((g) => g.key === 'unknown');
  // The explicitly-unattributed record (1) plus the pre-#2137 record (2) — the
  // gap is reported rather than charged to a plausible-looking account.
  assert.deepEqual([unknown.tokens.total, unknown.invocations], [3, 2]);
});

test('groupBy providerTier makes global usage distinguishable from team-scoped (AC2)', () => {
  const res = summarize(enriched, { groupBy: 'providerTier' });
  assert.deepEqual(
    res.groups.map((g) => [g.key, g.tokens.total, g.invocations]),
    // `unknown` holds the deleted-provider record AND the legacy one: a tier
    // that cannot be resolved is reported, not guessed into `team`.
    [['team', 10, 1], ['global', 7, 2], ['unknown', 3, 2]],
  );
});

test('every enriched record contributes to exactly one tier — no double counting', () => {
  const res = summarize(enriched, { groupBy: 'providerTier' });
  assert.equal(res.groups.reduce((s, g) => s + g.invocations, 0), enriched.length);
  assert.equal(res.groups.reduce((s, g) => s + g.tokens.total, 0), res.totals.total);
});

test('the pre-#2137 records still group exactly as before (AC4)', () => {
  // No regression: the enriched fields are additive, so every existing grouping
  // over the golden emitter records is untouched by their absence.
  for (const gb of ['agent', 'team', 'model', 'provider', 'day']) {
    const res = summarize(canonical, { groupBy: gb });
    assert.equal(res.groupBy, gb);
    assert.ok(res.groups.length > 0, gb);
  }
  // And a store holding only legacy records answers the new groupings honestly
  // rather than crashing or inventing a key.
  assert.deepEqual(
    summarize(canonical, { groupBy: 'user' }).groups.map((g) => g.key),
    ['unknown'],
  );
  assert.deepEqual(
    summarize(canonical, { groupBy: 'providerTier' }).groups.map((g) => g.key),
    ['unknown'],
  );
});

test('a malformed attribution block cannot break the user grouping', () => {
  const bad = [
    { ts: '2026-09-01T10:00:00.000Z', attribution: null, tokens: tokens(1) },
    { ts: '2026-09-01T10:00:00.000Z', attribution: 'u-ada', tokens: tokens(1) },
    { ts: '2026-09-01T10:00:00.000Z', attribution: { userId: '' }, tokens: tokens(1) },
  ];
  const res = summarize(bad, { groupBy: 'user' });
  assert.deepEqual(res.groups.map((g) => g.key), ['unknown']);
  assert.equal(res.groups[0].invocations, 3);
});

// The orchestrator carries a byte-identical mirror of this module (#679) so the
// agent-facing read-only usage query reuses one aggregation implementation.
// This guard is the twin of orchestrator/usage-summary.test.js — either side
// editing usage-summary.js without the other fails both suites.
test('two-sided guard: admin-console canonical is byte-identical to orchestrator copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'usage-summary.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'usage-summary.js'));
  assert.ok(here.equals(there), 'admin-console/api/usage-summary.js and orchestrator/usage-summary.js must be identical');
});
