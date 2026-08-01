'use strict';

// Unit tests for the pure PR-merge token-comment formatter (#678).
// Run: node --test orchestrator/pr-token-comment.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatPrTokenComment,
  findExistingComment,
  COMMENT_MARKER,
  fmt,
  hasUsage,
} = require('./pr-token-comment');

// A representative workItemDetail(...) result: BA(issue) + Dev(PR) + Reviewer on
// one issue↔PR chain, two models.
function detail(over = {}) {
  return {
    id: 'pr:org/repo#42',
    repo: 'org/repo',
    repos: ['org/repo'],
    issues: [99],
    prs: [42, 43],
    tokens: {
      input: 1000, output: 2000, cacheCreationInput: 300, cacheReadInput: 40000, total: 43300,
      byModel: {
        'claude-sonnet-4-6': { input: 800, output: 1500, cacheCreationInput: 300, cacheReadInput: 40000, total: 42600 },
        'claude-haiku-4-5': { input: 200, output: 500, cacheCreationInput: 0, cacheReadInput: 0, total: 700 },
      },
    },
    runs: [
      { ts: '2026-07-16T10:00:00Z', agentId: 'ba', roleId: 'business-analyst', tier: 'B' },
      { ts: '2026-07-16T11:00:00Z', agentId: 'dev', roleId: 'developer', tier: 'A' },
      { ts: '2026-07-16T12:00:00Z', agentId: 'rev', roleId: 'code-reviewer', tier: 'B' },
    ],
    agents: [
      { agentId: 'ba', roleId: 'business-analyst', runs: 1 },
      { agentId: 'dev', roleId: 'developer', runs: 1 },
      { agentId: 'rev', roleId: 'code-reviewer', runs: 1 },
    ],
    perAgent: [
      { agentId: 'ba', roleId: 'business-analyst', runs: 1, tokens: { input: 100, output: 200, cacheCreationInput: 0, cacheReadInput: 0, total: 300 } },
      { agentId: 'dev', roleId: 'developer', runs: 1, tokens: { input: 700, output: 1300, cacheCreationInput: 300, cacheReadInput: 40000, total: 42300 } },
      { agentId: 'rev', roleId: 'code-reviewer', runs: 1, tokens: { input: 200, output: 500, cacheCreationInput: 0, cacheReadInput: 0, total: 700 } },
    ],
    tiers: { '0': 0, A: 1, B: 2, C: 0 },
    shared: false,
    flowMismatch: false,
  };
}

// ── fmt helper ────────────────────────────────────────────────────────────────
test('fmt groups thousands and coerces non-numbers to 0', () => {
  assert.equal(fmt(0), '0');
  assert.equal(fmt(1000), '1,000');
  assert.equal(fmt(1234567), '1,234,567');
  assert.equal(fmt(undefined), '0');
  assert.equal(fmt(NaN), '0');
});

// ── AC1: four classes separately, per-model one section away ───────────────────
test('AC1 — headline total + all four token classes shown separately', () => {
  const { body } = formatPrTokenComment({ repo: 'org/repo', prNumber: 42, detail: detail() });
  assert.match(body, /Total: 43,300 tokens/);
  assert.match(body, /\| Input \| 1,000 \|/);
  assert.match(body, /\| Output \| 2,000 \|/);
  assert.match(body, /\| Cache write \| 300 \|/);
  assert.match(body, /\| Cache read \| 40,000 \|/);
});

test('AC1 — per-model detail present (collapsible), four classes per model', () => {
  const { body } = formatPrTokenComment({ repo: 'org/repo', prNumber: 42, detail: detail() });
  assert.match(body, /<details>/);
  assert.match(body, /Per-model detail/);
  assert.match(body, /`claude-sonnet-4-6`/);
  assert.match(body, /`claude-haiku-4-5`/);
});

// ── AC2: run count, agents/roles, tiers, coverage ─────────────────────────────
test('AC2 — run count, contributors (agents+roles), tier breakdown, coverage', () => {
  const { body } = formatPrTokenComment({ repo: 'org/repo', prNumber: 42, detail: detail() });
  assert.match(body, /across 3 runs/);
  assert.match(body, /business-analyst/);
  assert.match(body, /developer/);
  assert.match(body, /code-reviewer/);
  assert.match(body, /Tiers:/);
  assert.match(body, /Opened the PR/);
  assert.match(body, /Ran on an issue\/PR event/);
  assert.match(body, /Aborted runs .* not captured/);
});

// ── AC3: no dollar / cost figures anywhere ────────────────────────────────────
test('AC3 — body contains no currency symbol or cost wording', () => {
  const { body } = formatPrTokenComment({ repo: 'org/repo', prNumber: 42, detail: detail() });
  assert.ok(!body.includes('$'), 'no dollar sign');
  assert.ok(!/€|£|USD|EUR/.test(body), 'no currency codes/symbols');
  assert.ok(!/\bcost\b/i.test(body.replace(/no cost figures/i, '')), 'no cost wording (beyond the explicit disclaimer)');
  assert.match(body, /Token counts only/);
});

// ── AC6: no work item -> clearly-labelled unattributed note, never wrong total ─
test('AC6 — null detail yields a labelled unattributed note, no total', () => {
  const { body, attributed } = formatPrTokenComment({ repo: 'org/repo', prNumber: 77, detail: null });
  assert.equal(attributed, false);
  assert.match(body, /No agent token usage could be attributed/);
  assert.match(body, /org\/repo#77/);
  assert.ok(!/Total: /.test(body), 'no misleading total');
  assert.ok(body.includes(COMMENT_MARKER));
});

test('AC6 — a resolved work item with zero counted runs is treated as unattributed', () => {
  const empty = { ...detail(), runs: [] };
  const { attributed, body } = formatPrTokenComment({ repo: 'org/repo', prNumber: 42, detail: empty });
  assert.equal(attributed, false);
  assert.ok(!/Total: /.test(body));
});

// ── AC7: idempotency marker present + findable ────────────────────────────────
test('AC7 — marker is present and findExistingComment locates a prior comment', () => {
  const { body, marker } = formatPrTokenComment({ repo: 'org/repo', prNumber: 42, detail: detail() });
  assert.equal(marker, COMMENT_MARKER);
  assert.ok(body.includes(COMMENT_MARKER));
  const existing = findExistingComment([
    { id: 1, body: 'unrelated' },
    { id: 2, body: `stale summary\n${COMMENT_MARKER}` },
  ]);
  assert.equal(existing.id, 2);
  assert.equal(findExistingComment([{ id: 1, body: 'nope' }]), null);
  assert.equal(findExistingComment(undefined), null);
});

// ── data-quality flags surface ────────────────────────────────────────────────
test('shared + flowMismatch flags render as caveats', () => {
  const d = { ...detail(), shared: true, flowMismatch: true };
  const { body } = formatPrTokenComment({ repo: 'org/repo', prNumber: 42, detail: d });
  assert.match(body, /counted once, in their primary item/);
  assert.match(body, /flow instance collided/);
});

test('hasUsage guards empty/undefined details', () => {
  assert.equal(hasUsage(null), false);
  assert.equal(hasUsage({ runs: [] }), false);
  assert.equal(hasUsage({ runs: [{}] }), true);
});

test('single-run work item uses singular phrasing', () => {
  const d = { ...detail(), runs: [{ agentId: 'dev', tier: 'A' }], perAgent: [{ agentId: 'dev', roleId: 'developer', runs: 1, tokens: { total: 5 } }], agents: [{ agentId: 'dev', roleId: 'developer', runs: 1 }] };
  const { body } = formatPrTokenComment({ repo: 'org/repo', prNumber: 42, detail: d });
  assert.match(body, /across 1 run\b/);
});
