'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { summarize, modelSplit } = require('./usage-summary');

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

// ── #2440: the optional second grouping level (cross-tab drill-down) ─────────

const mu = (n) => ({ input: n, output: 0, cacheCreationInput: 0, cacheReadInput: 0 });
const crossRecs = [
  // a1 used two models in one turn (turn-wide 30 = 20 + 10) …
  { ts: '2026-09-01T10:00:00.000Z', agentId: 'a1', teamId: 't1', tokens: tokens(30),
    modelUsage: { 'model-x': mu(20), 'model-y': mu(10) } },
  // … and model-x again on its own.
  { ts: '2026-09-01T11:00:00.000Z', agentId: 'a1', teamId: 't1', tokens: tokens(5),
    modelUsage: { 'model-x': mu(5) } },
  { ts: '2026-09-01T12:00:00.000Z', agentId: 'a2', teamId: 't1', tokens: tokens(7),
    modelUsage: { 'model-y': mu(7) } },
];

test('secondaryGroupBy agent × model shows each agent broken down by model (AC2)', () => {
  const res = summarize(crossRecs, { groupBy: 'agent', secondaryGroupBy: 'model' });
  assert.equal(res.groupBy, 'agent');
  assert.equal(res.secondaryGroupBy, 'model');
  const a1 = res.groups.find((g) => g.key === 'a1');
  // The primary row reconciles with the one-level Agent view: turn-wide tokens.
  assert.deepEqual([a1.tokens.total, a1.invocations], [35, 2]);
  // Its models fan over modelUsage (sorted by total desc): model-x 25, model-y 10.
  assert.deepEqual(
    a1.subgroups.map((s) => [s.key, s.tokens.total, s.invocations]),
    [['model-x', 25, 2], ['model-y', 10, 1]],
  );
  const a2 = res.groups.find((g) => g.key === 'a2');
  assert.deepEqual(a2.subgroups.map((s) => [s.key, s.tokens.total]), [['model-y', 7]]);
});

test('secondaryGroupBy fans the model axis whichever side it is on', () => {
  const res = summarize(crossRecs, { groupBy: 'model', secondaryGroupBy: 'agent' });
  const modelY = res.groups.find((g) => g.key === 'model-y');
  // model-y was used by a1 (10) and a2 (7).
  assert.deepEqual(modelY.tokens.total, 17);
  assert.deepEqual(
    modelY.subgroups.map((s) => [s.key, s.tokens.total]),
    [['a1', 10], ['a2', 7]],
  );
});

test('a non-model × non-model cross-tab reconciles with the primary and the totals', () => {
  const flat = [
    { ts: '2026-09-01T10:00:00.000Z', agentId: 'a1', teamId: 't1', tokens: tokens(10) },
    { ts: '2026-09-01T11:00:00.000Z', agentId: 'a1', teamId: 't2', tokens: tokens(4) },
    { ts: '2026-09-01T12:00:00.000Z', agentId: 'a2', teamId: 't1', tokens: tokens(6) },
  ];
  const res = summarize(flat, { groupBy: 'agent', secondaryGroupBy: 'team' });
  // Every group's subgroups sum exactly to the group (no model gap here) …
  for (const g of res.groups) {
    assert.equal(g.subgroups.reduce((s, x) => s + x.tokens.total, 0), g.tokens.total);
    assert.equal(g.subgroups.reduce((s, x) => s + x.invocations, 0), g.invocations);
  }
  // … and the whole cross-tab sums to the stable grand total (AC5).
  assert.equal(res.groups.reduce((s, g) => s + g.tokens.total, 0), res.totals.total);
  assert.equal(res.totals.total, 20);
});

test('secondaryGroupBy is ignored (output identical) when absent, unknown or equal to primary (AC6)', () => {
  const flat = [
    { ts: '2026-09-01T10:00:00.000Z', agentId: 'a1', teamId: 't1', tokens: tokens(10) },
    { ts: '2026-09-01T11:00:00.000Z', agentId: 'a2', teamId: 't1', tokens: tokens(6) },
  ];
  const single = summarize(flat, { groupBy: 'agent' });
  // The single-dimension result carries no secondary axis and no subgroups.
  assert.ok(!('secondaryGroupBy' in single));
  for (const g of single.groups) assert.ok(!('subgroups' in g));
  // A self-cross adds no information; an unknown value falls through; both are
  // byte-identical to the one-level result (no regression).
  assert.deepEqual(summarize(flat, { groupBy: 'agent', secondaryGroupBy: 'agent' }), single);
  assert.deepEqual(summarize(flat, { groupBy: 'agent', secondaryGroupBy: 'nonsense' }), single);
  assert.deepEqual(summarize(flat, { groupBy: 'agent', secondaryGroupBy: undefined }), single);
});

// ── #2972: model rows are per-turn and reconcile with the totals ─────────────
// `modelUsage` is the SESSION's cumulative per-model usage (the CLI restores its
// cost tracker on resume), while `tokens` is the turn's own. These records are a
// resumed session: three turns of one sessionId with a growing `modelUsage`.

const t4 = (input, output, cacheCreationInput, cacheReadInput) =>
  ({ input, output, cacheCreationInput, cacheReadInput });
const CLASSES = ['input', 'output', 'cacheCreationInput', 'cacheReadInput'];
const RESUMED = [
  { ts: '2026-10-13T09:00:00.000Z', agentId: 'dev', teamId: 't1', sessionId: 's1',
    tokens: t4(10, 100, 1000, 5000),
    modelUsage: { opus: t4(10, 100, 1000, 5000) } },
  { ts: '2026-10-13T10:00:00.000Z', agentId: 'dev', teamId: 't1', sessionId: 's1',
    tokens: t4(5, 50, 0, 6000),
    modelUsage: { opus: t4(15, 150, 1000, 11000) } },
  // A third turn that also drove a sub-agent on a second model.
  { ts: '2026-10-13T11:00:00.000Z', agentId: 'dev', teamId: 't1', sessionId: 's1',
    tokens: t4(4, 40, 200, 7000),
    modelUsage: { opus: t4(18, 180, 1100, 17500), haiku: t4(3, 30, 100, 500) } },
  // Another agent's turn with no per-model detail at all.
  { ts: '2026-10-13T12:00:00.000Z', agentId: 'rev', teamId: 't1', sessionId: 's2',
    tokens: t4(1, 2, 3, 4) },
];

const sumClass = (rows, k) => rows.reduce((s, r) => s + r.tokens[k], 0);

test('#2972 AC1: a single-model record adds exactly its own tokens to its model row', () => {
  for (const rec of RESUMED.slice(0, 2)) {
    const res = summarize([rec], { groupBy: 'model' });
    assert.deepEqual(res.groups.map((g) => g.key), ['opus']);
    const total = CLASSES.reduce((sum, k) => sum + rec.tokens[k], 0);
    assert.deepEqual(res.groups[0].tokens, { ...rec.tokens, total });
  }
  // The second turn's cumulative modelUsage (15/150/1000/11000) is NOT what counts.
  const both = summarize(RESUMED.slice(0, 2), { groupBy: 'model' });
  assert.deepEqual(both.groups[0].tokens, { ...t4(15, 150, 1000, 11000), total: 12165 });
  assert.equal(both.groups[0].tokens.total, both.totals.total);
});

test('#2972 AC2: model rows add up to the stat tiles per class, gaps in an unknown row', () => {
  const res = summarize(RESUMED, { groupBy: 'model' });
  for (const k of [...CLASSES, 'total']) assert.equal(sumClass(res.groups, k), res.totals[k], k);
  const unknown = res.groups.find((g) => g.key === 'unknown');
  assert.deepEqual(unknown.tokens, { ...t4(1, 2, 3, 4), total: 10 });
  assert.equal(unknown.invocations, 1);
  // Also over a narrower range.
  const late = summarize(RESUMED, { groupBy: 'model', since: '2026-10-13T10:30:00.000Z' });
  for (const k of [...CLASSES, 'total']) assert.equal(sumClass(late.groups, k), late.totals[k], k);
});

test('#2972 AC3: a multi-model turn is split so its parts add up to its tokens, not more', () => {
  const rec = RESUMED[2];
  const parts = modelSplit(rec);
  assert.deepEqual(parts.map((p) => p.key), ['opus', 'haiku']);
  for (const k of CLASSES) {
    assert.equal(parts.reduce((s, p) => s + p.tokens[k], 0), rec.tokens[k], k);
    for (const p of parts) assert.ok(Number.isInteger(p.tokens[k]) && p.tokens[k] >= 0, `${p.key}.${k}`);
  }
  // Split by the per-class model mix: output 180:30 of 40 → 34 + 6.
  assert.deepEqual(parts.map((p) => p.tokens.output), [34, 6]);
  const res = summarize([rec], { groupBy: 'model' });
  assert.equal(sumClass(res.groups, 'total'), rec.tokens.input + rec.tokens.output
    + rec.tokens.cacheCreationInput + rec.tokens.cacheReadInput);
});

test('#2972 AC4: cross-tabs with model on either axis reconcile with their primary rows', () => {
  for (const [primary, secondary] of [['agent', 'model'], ['model', 'agent'], ['team', 'model'], ['model', 'day']]) {
    const res = summarize(RESUMED, { groupBy: primary, secondaryGroupBy: secondary });
    const single = summarize(RESUMED, { groupBy: primary });
    assert.deepEqual(res.groups.map((g) => [g.key, g.tokens]), single.groups.map((g) => [g.key, g.tokens]));
    for (const g of res.groups) {
      for (const k of [...CLASSES, 'total']) {
        assert.equal(sumClass(g.subgroups, k), g.tokens[k], `${primary}×${secondary} ${g.key}.${k}`);
      }
    }
  }
});

test('#2972: the split stays exact for very large cumulative figures', () => {
  const rec = { ts: '2026-10-13T09:00:00.000Z', tokens: t4(0, 0, 0, 987654321),
    modelUsage: { a: t4(0, 0, 0, 4e12 + 7), b: t4(0, 0, 0, 3e12 + 1), c: t4(0, 0, 0, 1) } };
  const parts = modelSplit(rec);
  assert.equal(parts.reduce((s, p) => s + p.tokens.cacheReadInput, 0), 987654321);
  for (const p of parts) assert.ok(Number.isInteger(p.tokens.cacheReadInput));
});

test('#2972: a class without any per-model signal falls back to the record-wide model mix', () => {
  // modelUsage reports no cache read for either model, but the turn had some.
  const rec = { ts: '2026-10-13T09:00:00.000Z', tokens: t4(0, 0, 0, 100),
    modelUsage: { a: t4(30, 0, 0, 0), b: t4(10, 0, 0, 0) } };
  assert.deepEqual(modelSplit(rec).map((p) => p.tokens.cacheReadInput), [75, 25]);
  assert.deepEqual(modelSplit({ tokens: t4(1, 0, 0, 0) }), []);
  assert.deepEqual(modelSplit({ tokens: t4(3, 0, 0, 0), modelUsage: { a: t4(0, 0, 0, 0), b: t4(0, 0, 0, 0) } })
    .map((p) => p.tokens.input), [2, 1]);
});

// The orchestrator carries a byte-identical mirror of this module (#679) so the
// agent-facing read-only usage query reuses one aggregation implementation.
// This guard is the twin of orchestrator/usage-summary.test.js — either side
// editing usage-summary.js without the other fails both suites.
// ── #2585: auto-scaled pool instances fold into their main agent ─────────────
const T = 'agent-studio-2-0';
function poolRec(agentId, tokens, extra = {}) {
  return {
    ts: '2026-09-29T10:00:00Z', agentId, teamId: T, provider: 'p1', providerTier: 'global',
    tokens, modelUsage: { 'claude-x': tokens }, ...extra,
  };
}
const POOL_RECORDS = [
  poolRec(`${T}-developer`, { input: 1, output: 2, cacheCreationInput: 3, cacheReadInput: 4 }),
  // Legacy (pre-#2585) instance records: no `poolOf` key — folded by naming.
  poolRec(`${T}-developer-i2556`, { input: 10, output: 20, cacheCreationInput: 30, cacheReadInput: 40 }),
  poolRec(`${T}-developer-i2573`, { input: 100, output: 200, cacheCreationInput: 300, cacheReadInput: 400 }, { providerTier: 'team' }),
  // Stamped instance record: `poolOf` is authoritative.
  poolRec(`${T}-developer-i2289`, { input: 5, output: 5, cacheCreationInput: 5, cacheReadInput: 5 }, { poolOf: `${T}-developer` }),
  // Look-alikes that are no pool instance.
  poolRec(`${T}-developer-conflicts`, { input: 7, output: 0, cacheCreationInput: 0, cacheReadInput: 0 }),
  poolRec(`${T}-helper-i7`, { input: 8, output: 0, cacheCreationInput: 0, cacheReadInput: 0 }, { poolOf: null }),
  poolRec(`${T}-manual-i3`, { input: 9, output: 0, cacheCreationInput: 0, cacheReadInput: 0 }),
  // Another team's id that merely ends in -i<n>, not under its own team prefix.
  { ...poolRec('solo-i4', { input: 11, output: 0, cacheCreationInput: 0, cacheReadInput: 0 }), teamId: 'other' },
];

function rowOf(res, key) {
  return res.groups.find((g) => g.key === key);
}

test('#2585 AC1/AC2: agent grouping folds pool instances into the main agent with summed classes', () => {
  const res = summarize(POOL_RECORDS, { groupBy: 'agent', nonInstanceAgentIds: [`${T}-manual-i3`] });
  assert.ok(!res.groups.some((g) => /-i(2556|2573|2289)$/.test(g.key)), 'no instance row survives');
  assert.deepEqual(rowOf(res, `${T}-developer`), {
    key: `${T}-developer`,
    tokens: { input: 116, output: 227, cacheCreationInput: 338, cacheReadInput: 449, total: 1130 },
    invocations: 4,
  });
});

test('#2585 AC3: folding needs no registry — a main agent with no own runs still gets one row', () => {
  const onlyInstances = POOL_RECORDS.slice(1, 3);
  const res = summarize(onlyInstances, { groupBy: 'agent' });
  assert.deepEqual(res.groups.map((g) => [g.key, g.invocations]), [[`${T}-developer`, 2]]);
});

test('#2585 AC8: look-alike ids that are no pool instance keep their own row', () => {
  const res = summarize(POOL_RECORDS, { groupBy: 'agent', nonInstanceAgentIds: new Set([`${T}-manual-i3`]) });
  for (const id of [`${T}-developer-conflicts`, `${T}-helper-i7`, `${T}-manual-i3`, 'solo-i4']) {
    assert.equal(rowOf(res, id)?.invocations, 1, id);
  }
  assert.equal(rowOf(res, `${T}-helper`), undefined);
  assert.equal(rowOf(res, `${T}-manual`), undefined);
  assert.equal(rowOf(res, 'solo'), undefined);
});

test('#2585 AC4: grand totals and non-agent groupings are unchanged by folding', () => {
  const unfolded = POOL_RECORDS.map((r) => ({ ...r, poolOf: null }));
  for (const groupBy of ['agent', 'team', 'user', 'model', 'provider', 'providerTier', 'day']) {
    const folded = summarize(POOL_RECORDS, { groupBy });
    const raw = summarize(unfolded, { groupBy });
    assert.deepEqual(folded.totals, raw.totals, groupBy);
    if (groupBy !== 'agent') assert.deepEqual(folded.groups, raw.groups, groupBy);
  }
  const res = summarize(POOL_RECORDS, { groupBy: 'agent' });
  const sum = res.groups.reduce((s, g) => s + g.tokens.total, 0);
  assert.equal(sum, res.totals.total);
});

test('#2585 AC5: agent as the secondary grouping folds instances too', () => {
  const res = summarize(POOL_RECORDS, { groupBy: 'providerTier', secondaryGroupBy: 'agent' });
  const global = rowOf(res, 'global');
  const team = rowOf(res, 'team');
  assert.ok(!res.groups.some((g) => g.subgroups.some((s) => /-i(2556|2573|2289)$/.test(s.key))));
  assert.equal(global.subgroups.find((s) => s.key === `${T}-developer`).invocations, 3);
  assert.deepEqual(team.subgroups.map((s) => [s.key, s.invocations]), [[`${T}-developer`, 1]]);
  // agent × model fans over the model split under the folded key as well
  const byModel = summarize(POOL_RECORDS, { groupBy: 'agent', secondaryGroupBy: 'model' });
  assert.equal(rowOf(byModel, `${T}-developer`).subgroups[0].tokens.total, 1130);
});

test('two-sided guard: admin-console canonical is byte-identical to orchestrator copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'usage-summary.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'usage-summary.js'));
  assert.ok(here.equals(there), 'admin-console/api/usage-summary.js and orchestrator/usage-summary.js must be identical');
});

// ── #2976: filterBy / filterKey — the chart drill-down's data ─────────────
// A drilled chart shows one primary value split by the secondary dimension and
// by day; its figures must equal the nested table row it was opened from.
const DRILL_RECORDS = [
  { ts: '2026-10-01T10:00:00Z', agentId: 'a', teamId: 't', tokens: t4(30, 6, 0, 0),
    modelUsage: { 'model-x': t4(20, 4, 0, 0), 'model-y': t4(10, 2, 0, 0) } },
  { ts: '2026-10-02T10:00:00Z', agentId: 'a', teamId: 't', tokens: t4(5, 1, 0, 0),
    modelUsage: { 'model-x': t4(5, 1, 0, 0) } },
  { ts: '2026-10-02T11:00:00Z', agentId: 'b', teamId: 't', tokens: t4(7, 0, 3, 0),
    modelUsage: { 'model-y': t4(7, 0, 3, 0) } },
  { ts: '2026-10-03T11:00:00Z', agentId: 'b', teamId: 't', tokens: t4(9, 0, 0, 0) },
];

test('#2976: without both filter halves the output is unchanged', () => {
  const plain = summarize(DRILL_RECORDS, { groupBy: 'model', secondaryGroupBy: 'day' });
  for (const q of [{ filterBy: 'agent' }, { filterKey: 'a' }, { filterBy: 'nonsense', filterKey: 'a' }, { filterBy: 'agent', filterKey: '' }]) {
    assert.deepEqual(summarize(DRILL_RECORDS, { groupBy: 'model', secondaryGroupBy: 'day', ...q }), plain, JSON.stringify(q));
  }
});

test('#2976: drilling into an agent equals that agent\'s nested model rows', () => {
  const nested = summarize(DRILL_RECORDS, { groupBy: 'agent', secondaryGroupBy: 'model' });
  const drilled = summarize(DRILL_RECORDS, { groupBy: 'model', secondaryGroupBy: 'day', filterBy: 'agent', filterKey: 'a' });
  assert.equal(drilled.filterBy, 'agent');
  assert.equal(drilled.filterKey, 'a');
  const row = rowOf(nested, 'a');
  assert.deepEqual(drilled.totals, { ...row.tokens, invocations: row.invocations });
  assert.deepEqual(
    drilled.groups.map((g) => [g.key, g.tokens, g.invocations]),
    row.subgroups.map((s) => [s.key, s.tokens, s.invocations]),
  );
  // the per-day cells add up to each model's row
  for (const g of drilled.groups) {
    assert.equal(g.subgroups.reduce((s, d) => s + d.tokens.total, 0), g.tokens.total);
    assert.equal(g.subgroups.reduce((s, d) => s + d.invocations, 0), g.invocations);
  }
});

test('#2976: drilling into a model keeps only that model\'s share of each record', () => {
  const nested = summarize(DRILL_RECORDS, { groupBy: 'model', secondaryGroupBy: 'agent' });
  const drilled = summarize(DRILL_RECORDS, { groupBy: 'agent', secondaryGroupBy: 'day', filterBy: 'model', filterKey: 'model-y' });
  const row = rowOf(nested, 'model-y');
  assert.deepEqual(drilled.totals, { ...row.tokens, invocations: row.invocations });
  assert.deepEqual(
    drilled.groups.map((g) => [g.key, g.tokens.total, g.invocations]),
    row.subgroups.map((s) => [s.key, s.tokens.total, s.invocations]),
  );
  // a record with no model detail is reachable through the `unknown` model
  const unknown = summarize(DRILL_RECORDS, { groupBy: 'agent', filterBy: 'model', filterKey: 'unknown' });
  assert.deepEqual(unknown.groups.map((g) => [g.key, g.tokens.total]), [['b', 9]]);
  // a model the drilled records' split would otherwise produce never leaks in
  const byModel = summarize(DRILL_RECORDS, { groupBy: 'model', filterBy: 'model', filterKey: 'model-y' });
  assert.deepEqual(byModel.groups.map((g) => g.key), ['model-y']);
});

test('#2976: a key with no records yields an empty, zeroed summary', () => {
  const res = summarize(DRILL_RECORDS, { groupBy: 'model', filterBy: 'agent', filterKey: 'gone' });
  assert.deepEqual(res.groups, []);
  assert.equal(res.totals.total, 0);
  assert.equal(res.totals.invocations, 0);
});

test('#2976: the summary route passes filterBy / filterKey through after team scoping', () => {
  const src = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const route = src.slice(src.indexOf("app.get('/api/usage/summary',"), src.indexOf("app.get('/api/usage/summary/export',"));
  assert.match(route, /const \{ filterBy, filterKey \} = req\.query;/);
  assert.match(route, /narrowUsageRecords\(records, scope, usageTeamParam\(req\)\);\s*res\.json\(summarize\(records, \{[^}]*filterBy, filterKey/);
});
