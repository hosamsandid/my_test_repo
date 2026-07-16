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
  for (const gb of ['team', 'model', 'provider', 'day']) {
    assert.deepEqual(summarize(canonical, { groupBy: gb }).totals, byAgent, gb);
  }
});
