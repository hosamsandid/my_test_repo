'use strict';

// Merge-detection tests for the PR-token-comment feature (#678).
// Run: node --test orchestrator/github-poller-merge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { GitHubPoller, detectMergedPrs } = require('./github-poller');

function prEvent(number, action, merged, over = {}) {
  return {
    id: `${number}-${action}-${merged}`,
    type: 'PullRequestEvent',
    created_at: over.created_at || '2026-07-16T10:00:00Z',
    payload: { action, pull_request: { number, merged } },
    ...over,
  };
}

// ── detectMergedPrs (pure) ────────────────────────────────────────────────────
test('detects a merged PR (closed + merged:true)', () => {
  const out = detectMergedPrs([prEvent(42, 'closed', true)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].prNumber, 42);
});

test('ignores a PR closed WITHOUT merge (merged:false)', () => {
  assert.deepEqual(detectMergedPrs([prEvent(42, 'closed', false)]), []);
});

test('ignores non-close PR actions and non-PR events', () => {
  const out = detectMergedPrs([
    prEvent(42, 'opened', false),
    prEvent(43, 'labeled', false),
    { type: 'IssuesEvent', payload: { action: 'closed', issue: { number: 9 } } },
    { type: 'PushEvent', payload: { ref: 'refs/heads/x' } },
  ]);
  assert.deepEqual(out, []);
});

test('dedupes a re-delivered merge by number, keeping the latest event', () => {
  const early = prEvent(42, 'closed', true, { id: 'a', created_at: '2026-07-16T10:00:00Z' });
  const late = prEvent(42, 'closed', true, { id: 'b', created_at: '2026-07-16T12:00:00Z' });
  const out = detectMergedPrs([late, early]);
  assert.equal(out.length, 1);
  assert.equal(out[0].event.id, 'b');
});

test('rejects a merged event with no valid PR number', () => {
  const ev = { type: 'PullRequestEvent', payload: { action: 'closed', pull_request: { merged: true } } };
  assert.deepEqual(detectMergedPrs([ev]), []);
});

test('handles empty / non-array input', () => {
  assert.deepEqual(detectMergedPrs(undefined), []);
  assert.deepEqual(detectMergedPrs([]), []);
});

// ── _handleMergedPrs (poller shell) ───────────────────────────────────────────
test('_handleMergedPrs fires the callback once per merged PR with repo + number', async () => {
  const calls = [];
  const poller = new GitHubPoller({ onMergedPr: async (repo, n, ev) => { calls.push({ repo, n, id: ev.id }); } });
  await poller._handleMergedPrs('org/repo', [
    prEvent(42, 'closed', true, { id: 'e42' }),
    prEvent(7, 'opened', false),
    prEvent(43, 'closed', true, { id: 'e43' }),
  ]);
  assert.deepEqual(calls.map((c) => c.n).sort((a, b) => a - b), [42, 43]);
  assert.ok(calls.every((c) => c.repo === 'org/repo'));
});

test('_handleMergedPrs is a no-op when no callback is wired', async () => {
  const poller = new GitHubPoller();
  await assert.doesNotReject(poller._handleMergedPrs('org/repo', [prEvent(42, 'closed', true)]));
});

test('_handleMergedPrs isolates a throwing callback per PR (never rejects)', async () => {
  const seen = [];
  const poller = new GitHubPoller({
    onMergedPr: async (repo, n) => { seen.push(n); if (n === 42) throw new Error('boom'); },
  });
  await assert.doesNotReject(poller._handleMergedPrs('org/repo', [
    prEvent(42, 'closed', true, { id: 'e42' }),
    prEvent(43, 'closed', true, { id: 'e43' }),
  ]));
  assert.deepEqual(seen.sort((a, b) => a - b), [42, 43]); // 43 still processed after 42 threw
});
