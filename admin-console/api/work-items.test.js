'use strict';

// Unit tests for the pure work-item attribution module (#655, §3 + §5 view 2).
// Run: node --test admin-console/api/work-items.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildWorkItems, workItemDetail, attributeRun } = require('./work-items');

const REPO = 'org/repo'; // owner/name — the identity github.repo + pr-created.repo share
const SHORT = 'repo';     // the short clone-dir name git context carries

// Minimal usage record. tokens default to a flat 10 across the four classes so a
// component's total is a clean multiple of the run count.
function run(over = {}) {
  return {
    ts: '2026-07-16T10:00:00.000Z',
    agentId: 'a',
    teamId: 'team-a',
    roleId: null,
    flowInstanceId: null,
    correlationId: null,
    sessionId: 's',
    github: null,
    git: null,
    tokens: { input: 10, output: 10, cacheCreationInput: 10, cacheReadInput: 10 },
    modelUsage: { 'claude-sonnet-4-6': { input: 10, output: 10, cacheCreationInput: 10, cacheReadInput: 10 } },
    ...over,
  };
}

function prCreated(over = {}) {
  return { kind: 'pr-created', repo: REPO, prNumber: 1, branch: 'b', base: 'main', closes: [], correlationId: null, ...over };
}

// ── attributeRun tiers (exact-signal precedence) ─────────────────────────────
test('attributeRun tier A — correlationId matches a pr-created record', () => {
  const ctx = { prByCorrelation: new Map([['cid', ['pr:org/repo#42']]]), prByHeadBranch: new Map() };
  const r = attributeRun(run({ correlationId: 'cid', github: { repo: REPO, prNumber: 99 } }), ctx);
  assert.equal(r.tier, 'A');
  assert.deepEqual(r.artifacts, ['pr:org/repo#42']); // A wins over the B signal on the same run
});

test('attributeRun tier B — issue/PR event number on the github block', () => {
  const ctx = { prByCorrelation: new Map(), prByHeadBranch: new Map() };
  const r = attributeRun(run({ github: { repo: REPO, prNumber: null, issueNumber: 99 } }), ctx);
  assert.equal(r.tier, 'B');
  assert.deepEqual(r.artifacts, ['issue:org/repo#99']);
});

test('attributeRun tier C — branch join, short git repo name verified against owner/name', () => {
  const ctx = {
    prByCorrelation: new Map(),
    prByHeadBranch: new Map([['feat/x', { prNumber: 60, repoFull: REPO }]]),
  };
  const r = attributeRun(run({ git: { repo: SHORT, branch: 'feat/x', headBefore: 'a', headAfter: 'b' } }), ctx);
  assert.equal(r.tier, 'C');
  assert.deepEqual(r.artifacts, ['pr:org/repo#60']);
});

test('attributeRun tier C requires HEAD to have moved (agent authorship proxy)', () => {
  const ctx = { prByCorrelation: new Map(), prByHeadBranch: new Map([['feat/x', { prNumber: 60, repoFull: REPO }]]) };
  const r = attributeRun(run({ git: { repo: SHORT, branch: 'feat/x', headBefore: 'a', headAfter: 'a' } }), ctx);
  assert.equal(r.tier, null); // no commit -> not attributed by branch
});

test('attributeRun tier C rejects a short-name mismatch', () => {
  const ctx = { prByCorrelation: new Map(), prByHeadBranch: new Map([['feat/x', { prNumber: 60, repoFull: 'org/other' }]]) };
  const r = attributeRun(run({ git: { repo: SHORT, branch: 'feat/x', headBefore: 'a', headAfter: 'b' } }), ctx);
  assert.equal(r.tier, null);
});

test('attributeRun tier ∅ — a plain DM run attaches to nothing', () => {
  const ctx = { prByCorrelation: new Map(), prByHeadBranch: new Map() };
  const r = attributeRun(run(), ctx);
  assert.equal(r.tier, null);
  assert.deepEqual(r.artifacts, []);
});

test('attributeRun tier 0 — flowInstanceId is the strongest signal', () => {
  const ctx = { prByCorrelation: new Map(), prByHeadBranch: new Map() };
  const r = attributeRun(run({ flowInstanceId: 'f1', github: { repo: REPO, issueNumber: 99 } }), ctx);
  assert.equal(r.tier, '0');
  assert.equal(r.flow, 'flow:f1');
  assert.deepEqual(r.artifacts, ['issue:org/repo#99']); // flow groups the artifact too
});

// ── buildWorkItems: the acceptance-criteria scenarios ─────────────────────────
test('BA→Dev→Reviewer→Reworker on one issue↔PR chain = ONE work item', () => {
  const prEvents = [
    prCreated({ prNumber: 42, branch: 'agent/dev/issue-99', closes: [99], correlationId: 'cid-dev' }),
    prCreated({ prNumber: 43, branch: 'agent/rework/issue-99', closes: [99], correlationId: 'cid-rework' }),
  ];
  const usage = [
    run({ agentId: 'ba', roleId: 'business-analyst', github: { repo: REPO, issueNumber: 99 } }), // tier B (issue-side BA work included)
    run({ agentId: 'dev', roleId: 'developer', correlationId: 'cid-dev' }),                        // tier A -> pr42
    run({ agentId: 'rev', roleId: 'code-reviewer', github: { repo: REPO, prNumber: 42 } }),        // tier B -> pr42
    run({ agentId: 'rw', roleId: 'reworker', correlationId: 'cid-rework' }),                        // tier A -> pr43 (joins via closes 99)
  ];
  const res = buildWorkItems(usage, prEvents, {});
  assert.equal(res.workItems.length, 1, 'the whole chain collapses to one work item');
  const wi = res.workItems[0];
  assert.deepEqual(wi.issues, [99]);
  assert.deepEqual(wi.prs, [42, 43]);
  assert.equal(wi.repo, REPO);
  assert.equal(wi.runs, 4);
  assert.equal(wi.tokens.total, 160); // 4 runs × 40
  assert.deepEqual(wi.tiers, { '0': 0, A: 2, B: 2, C: 0 });
  // Per-role breakdown is present, one entry per agent.
  assert.deepEqual(wi.agents.map((a) => a.roleId).sort(),
    ['business-analyst', 'code-reviewer', 'developer', 'reworker']);
  // Full coverage, nothing unattributed.
  assert.equal(res.coverage.tokens.unattributed, 0);
  assert.equal(res.coverage.attributedPct, 1);
});

test('startedAt (#2261) is the earliest run.ts across the work item, regardless of run order', () => {
  const prEvents = [prCreated({ prNumber: 42, branch: 'agent/dev/issue-99', closes: [99], correlationId: 'cid-dev' })];
  const usage = [
    run({ agentId: 'dev', correlationId: 'cid-dev', ts: '2026-07-16T10:00:00.000Z' }),
    run({ agentId: 'rev', github: { repo: REPO, prNumber: 42 }, ts: '2026-07-14T09:00:00.000Z' }), // earliest
    run({ agentId: 'rw', github: { repo: REPO, prNumber: 42 }, ts: '2026-07-18T12:00:00.000Z' }),
  ];
  const res = buildWorkItems(usage, prEvents, {});
  assert.equal(res.workItems[0].startedAt, '2026-07-14T09:00:00.000Z');
});

test('a missing `closes #N` degrades visibly into TWO work items', () => {
  const prEvents = [
    prCreated({ prNumber: 42, branch: 'agent/dev/issue-99', closes: [99], correlationId: 'cid-dev' }),
    prCreated({ prNumber: 43, branch: 'agent/rework/nolink', closes: [], correlationId: 'cid-rework' }), // forgot the keyword
  ];
  const usage = [
    run({ agentId: 'ba', github: { repo: REPO, issueNumber: 99 } }),
    run({ agentId: 'dev', correlationId: 'cid-dev' }),
    run({ agentId: 'rw', correlationId: 'cid-rework' }),
  ];
  const res = buildWorkItems(usage, prEvents, {});
  assert.equal(res.workItems.length, 2);
  const byPrs = res.workItems.map((w) => w.prs).sort((a, b) => (a[0] || 0) - (b[0] || 0));
  assert.deepEqual(byPrs, [[42], [43]]);
});

test('the unattributed remainder is always reported (a DM run)', () => {
  const usage = [
    run({ agentId: 'dev', correlationId: 'cid-dev' }),
    run({ agentId: 'chat', tokens: { input: 5, output: 5, cacheCreationInput: 0, cacheReadInput: 0 } }), // tier ∅
  ];
  const prEvents = [prCreated({ prNumber: 42, closes: [99], correlationId: 'cid-dev' })];
  const res = buildWorkItems(usage, prEvents, {});
  assert.equal(res.unattributed.runs, 1);
  assert.equal(res.unattributed.total, 10);
  assert.equal(res.coverage.runs.unattributed, 1);
  assert.equal(res.workItems.length, 1);
});

test('tier C: a run on a PR head branch joins that PR without an event/correlation', () => {
  const prEvents = [prCreated({ prNumber: 60, branch: 'feat/x', closes: [], correlationId: null })];
  const usage = [run({ agentId: 'dev', git: { repo: SHORT, branch: 'feat/x', headBefore: 'a', headAfter: 'b' } })];
  const res = buildWorkItems(usage, prEvents, {});
  assert.equal(res.workItems.length, 1);
  assert.deepEqual(res.workItems[0].prs, [60]);
  assert.deepEqual(res.workItems[0].tiers, { '0': 0, A: 0, B: 0, C: 1 });
});

test('two distinct flow instances colliding on one chain raise flowMismatch', () => {
  const usage = [
    run({ agentId: 'x', flowInstanceId: 'f1', github: { repo: REPO, issueNumber: 77 } }),
    run({ agentId: 'y', flowInstanceId: 'f2', github: { repo: REPO, issueNumber: 77 } }),
  ];
  const res = buildWorkItems(usage, [], {});
  assert.equal(res.workItems.length, 1);
  assert.equal(res.workItems[0].flowMismatch, true);
});

test('a run spanning two components is shared: tokens counted once', () => {
  // pr42 closes issue 99; a second run references BOTH pr42 and an unrelated issue 88
  // via a github block — but github only carries one pr + one issue, so to force a
  // >1-artifact run we use the github block's pr+issue pair against DIFFERENT chains.
  const prEvents = [prCreated({ prNumber: 42, closes: [99], correlationId: 'cid-dev' })];
  const usage = [
    run({ agentId: 'dev', correlationId: 'cid-dev' }),                          // pr42 (chain {pr42,issue99})
    run({ agentId: 'multi', github: { repo: REPO, prNumber: 42, issueNumber: 88 } }), // pr42 + issue88 (issue88 is its own chain)
  ];
  const res = buildWorkItems(usage, prEvents, {});
  // Two components: {pr42, issue99, issue88-via-shared?} — issue88 unions with pr42
  // through the multi run's flow? No flow here, so artifacts don't union each other;
  // the shared run's tokens land once in its primary (pr42) component.
  const totalCounted = res.workItems.reduce((s, w) => s + w.tokens.total, 0);
  assert.equal(totalCounted, res.coverage.tokens.attributed);
  assert.ok(res.workItems.some((w) => w.shared), 'the multi-artifact run marks its components shared');
});

// ── workItemDetail drill-down ─────────────────────────────────────────────────
test('workItemDetail returns per-agent split + run rows addressable by any artifact', () => {
  const prEvents = [prCreated({ prNumber: 42, branch: 'agent/dev/issue-99', closes: [99], correlationId: 'cid-dev' })];
  const usage = [
    run({ agentId: 'ba', roleId: 'business-analyst', correlationId: 'x', github: { repo: REPO, issueNumber: 99 } }),
    run({ agentId: 'dev', roleId: 'developer', correlationId: 'cid-dev' }),
  ];
  // Address by the ISSUE number — must resolve the same component as the PR.
  const byIssue = workItemDetail(usage, prEvents, REPO, 99, {});
  assert.ok(byIssue);
  assert.deepEqual(byIssue.prs, [42]);
  assert.deepEqual(byIssue.issues, [99]);
  assert.equal(byIssue.perAgent.length, 2);
  // The detail view overrides `runs` with the per-run rows (for the drill-down table).
  assert.ok(Array.isArray(byIssue.runs));
  assert.equal(byIssue.runs.length, 2);
  // Each run row carries the correlationId for the session-log deep link.
  const devRow = workItemDetail(usage, prEvents, REPO, 42, {}).runs.find((r) => r.agentId === 'dev');
  assert.equal(devRow.correlationId, 'cid-dev');
  assert.equal(devRow.tier, 'A');
  // Addressing an unknown artifact returns null.
  assert.equal(workItemDetail(usage, prEvents, REPO, 12345, {}), null);
});

test('since/until window: a run outside the window is excluded', () => {
  const prEvents = [prCreated({ prNumber: 42, closes: [99], correlationId: 'cid-dev' })];
  const usage = [
    run({ agentId: 'dev', ts: '2026-07-10T00:00:00.000Z', correlationId: 'cid-dev' }),
    run({ agentId: 'dev2', ts: '2026-07-16T00:00:00.000Z', correlationId: 'cid-dev' }),
  ];
  const res = buildWorkItems(usage, prEvents, { since: '2026-07-15', until: '2026-07-17' });
  assert.equal(res.totals.runs, 1);
  assert.equal(res.workItems[0].runs, 1);
});

// Two-sided guard: the orchestrator mirrors this canonical module verbatim so the
// PR-token-comment feature (#678) can reuse the Phase-2 aggregation without a
// cross-package runtime require (the two container images can't require each
// other's files). Same discipline as skill-manifest.js — assert byte-identical
// so the mirror can never drift.
test('two-sided guard: admin-console canonical is byte-identical to orchestrator mirror', () => {
  const here = fs.readFileSync(path.join(__dirname, 'work-items.js'));
  const there = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'work-items.js'));
  assert.ok(here.equals(there), 'admin-console/api/work-items.js and orchestrator/work-items.js must be identical');
});
