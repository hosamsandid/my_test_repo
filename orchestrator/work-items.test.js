'use strict';

// The orchestrator carries a VERBATIM mirror of admin-console/api/work-items.js
// so the PR-token-comment feature (#678) can reuse the Phase-2 work-item
// aggregation (§3 of docs/cost-per-pr-concept.md) at merge time WITHOUT a
// cross-package runtime require — the orchestrator and admin-console container
// images are built from separate contexts and cannot require each other's files.
// Same discipline as skill-manifest.js / knowledge-digest.js: the guard test
// asserts the two module files are byte-identical, so the mirror can never drift
// (the canonical copy + its full unit suite live in admin-console/api).
//
// Run: node --test orchestrator/work-items.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildWorkItems, workItemDetail, TOKEN_CLASSES } = require('./work-items');

test('two-sided guard: orchestrator mirror is byte-identical to admin-console canonical', () => {
  const here = fs.readFileSync(path.join(__dirname, 'work-items.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', 'admin-console', 'api', 'work-items.js'));
  assert.ok(here.equals(there), 'orchestrator/work-items.js and admin-console/api/work-items.js must be identical');
});

// Smoke test: the mirror actually loads and computes from the orchestrator side
// (the canonical, exhaustive coverage is in admin-console/api/work-items.test.js).
test('mirror computes a work-item detail from the orchestrator side', () => {
  assert.deepEqual(TOKEN_CLASSES, ['input', 'output', 'cacheCreationInput', 'cacheReadInput']);

  const tokens = { input: 10, output: 10, cacheCreationInput: 10, cacheReadInput: 10 };
  const modelUsage = { 'claude-sonnet-4-6': { ...tokens } };
  const prEvents = [
    { kind: 'pr-created', repo: 'org/repo', prNumber: 42, branch: 'agent/dev/issue-99', base: 'main', closes: [99], correlationId: 'cid-dev' },
  ];
  const usage = [
    { ts: '2026-07-16T10:00:00.000Z', agentId: 'ba', roleId: 'business-analyst', correlationId: null, github: { repo: 'org/repo', issueNumber: 99 }, git: null, tokens, modelUsage },
    { ts: '2026-07-16T11:00:00.000Z', agentId: 'dev', roleId: 'developer', correlationId: 'cid-dev', github: null, git: null, tokens, modelUsage },
  ];

  const detail = workItemDetail(usage, prEvents, 'org/repo', 42, {});
  assert.ok(detail, 'PR 42 resolves to a work item');
  assert.deepEqual(detail.issues, [99]);
  assert.deepEqual(detail.prs, [42]);
  assert.equal(detail.runs.length, 2); // workItemDetail overrides `runs` with the run-row list
  assert.equal(detail.tokens.total, 80);

  // The same chain is addressable by the linked issue.
  const byIssue = workItemDetail(usage, prEvents, 'org/repo', 99, {});
  assert.equal(byIssue.id, detail.id);

  // A PR that maps to no work item returns null (AC6 degrade-visibly path).
  assert.equal(workItemDetail(usage, prEvents, 'org/repo', 777, {}), null);

  const list = buildWorkItems(usage, prEvents, {});
  assert.equal(list.workItems.length, 1);
});
