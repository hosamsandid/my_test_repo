'use strict';

// Golden-fixture tests for the orchestrator copy of usage-summary.js (#679).
// The SAME canonical fixture lives beside the admin-console canonical
// (admin-console/api/usage-summary.fixture.json) and is asserted from both
// suites; the guard test below asserts the two module files are byte-identical,
// so the aggregation contract can never drift between the two images (mirrors
// the skill-manifest.js / knowledge-digest.js discipline). The orchestrator
// reuses this module for the agent-facing read-only usage query (#679 AC5) —
// there is exactly one aggregation implementation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { summarize } = require('./usage-summary');

const FIXTURE_PATH = path.join(__dirname, '..', 'admin-console', 'api', 'usage-summary.fixture.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const canonical = fixture.records.map((r) => r.expected);

test('summarize matches every golden summaryCase', () => {
  for (const c of fixture.summaryCases) {
    const recs = c.recordIndexes.map((i) => canonical[i]);
    assert.deepEqual(summarize(recs, c.query), c.expected, c.name);
  }
});

test('two-sided guard: orchestrator copy is byte-identical to admin-console canonical', () => {
  const here = fs.readFileSync(path.join(__dirname, 'usage-summary.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', 'admin-console', 'api', 'usage-summary.js'));
  assert.ok(here.equals(there), 'orchestrator/usage-summary.js and admin-console/api/usage-summary.js must be identical');
});
