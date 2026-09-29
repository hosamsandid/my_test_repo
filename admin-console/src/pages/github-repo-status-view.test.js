import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_META,
  summarize,
  summaryParts,
  defaultExpanded,
  filterByGroup,
  sortRows,
  subscriberCounts,
  subscriberSummary,
  describeRow,
  tokenSourceText,
  inWhen,
  errorText,
  TOKENS_LINK,
} from './github-repo-status-view.js';

const NOW = Date.parse('2026-09-29T10:00:00.000Z');
const envA = { id: 'env-a', name: 'Env A', tokenId: 'tok-a', tokenState: 'ok', teamId: 'team-a' };
const envB = { id: 'env-b', name: 'Env B', tokenId: null, tokenState: 'none', teamId: 'team-b' };
const counted = { agentId: 'dev', agentName: 'Developer', triggerId: 't1', counted: true, ignoredReason: null };

const rows = [
  { repo: 'acme/ok', status: 'listening', group: 'listening', tokenEnvironment: envA, environments: [envA], triggers: [counted], lastPolledAt: '2026-09-29T09:59:30.000Z' },
  { repo: 'acme/bad', status: 'failing', group: 'failing', tokenEnvironment: envA, environments: [envA], triggers: [counted],
    lastError: { status: 401, message: 'Bad credentials', rateLimited: false }, failingSince: '2026-09-29T09:40:00.000Z',
    consecutiveFailures: 3, nextRetryAt: '2026-09-29T10:04:00.000Z' },
  { repo: 'acme/quiet', status: 'no-trigger', group: 'not-listening', tokenEnvironment: envA, environments: [envA],
    triggers: [{ ...counted, counted: false, ignoredReason: 'agent-disabled', agentId: 'sleepy', agentName: 'Sleepy' }] },
];

test('every status has a label, a group and a marker tone; no-trigger is visually distinct (AC7)', () => {
  for (const s of ['listening', 'failing', 'no-token', 'no-trigger', 'not-in-environment', 'unsupported']) {
    assert.ok(STATUS_META[s]?.label && STATUS_META[s].group && STATUS_META[s].tone, s);
  }
  assert.notEqual(STATUS_META['no-trigger'].tone, STATUS_META.failing.tone);
  assert.notEqual(STATUS_META['no-trigger'].tone, STATUS_META['no-token'].tone);
});

test('summary counts, parts, default expansion and group filter (AC6)', () => {
  const c = summarize(rows);
  assert.deepEqual(c, { listening: 1, failing: 1, 'not-listening': 1, total: 3 });
  assert.deepEqual(summaryParts(c).map((p) => p.text), ['1 repository listening', '1 failing', '1 not listening']);
  assert.deepEqual(summaryParts({ listening: 4 }).map((p) => p.text), ['4 repositories listening']);
  assert.equal(defaultExpanded(rows), true);
  assert.equal(defaultExpanded([rows[0], rows[2]]), false);
  assert.deepEqual(filterByGroup(rows, 'failing').map((r) => r.repo), ['acme/bad']);
  assert.equal(filterByGroup(rows, null).length, 3);
  assert.deepEqual(sortRows(rows).map((r) => r.repo), ['acme/bad', 'acme/quiet', 'acme/ok']);
});

test('subscriber counts separate counted from ignored triggers, with the reason', () => {
  assert.deepEqual(subscriberCounts(rows[2]), { triggers: 0, agents: 0, ignored: [{ reason: 'agent-disabled', count: 1, label: 'agent disabled' }] });
  assert.equal(subscriberSummary(rows[0]), '1 trigger on 1 agent');
  assert.equal(subscriberSummary(rows[2]), '0 triggers on 0 agents · 1 trigger ignored — agent disabled');
});

test('Listening: polled time, or waiting for first poll', () => {
  assert.match(describeRow(rows[0], NOW).text, /^Polled .* · 1 trigger on 1 agent$/);
  assert.match(describeRow({ ...rows[0], waitingForFirstPoll: true }, NOW).text, /^Waiting for first poll/);
});

test('Failing shows error + status, count, next retry and links to the token fix (AC5/AC4)', () => {
  const d = describeRow(rows[1], NOW);
  assert.match(d.text, /Bad credentials \(401\)/);
  assert.match(d.text, /3 failed attempts/);
  assert.match(d.text, /next retry in 4 min/);
  assert.ok(d.links.some((l) => l.to === '/github-tokens'));
  assert.ok(d.links.some((l) => l.to === '/chats/team-a?tab=repositories'));
});

test('Failing with another environment that has a token notes it', () => {
  const envC = { id: 'env-c', name: 'Env C', tokenId: 'tok-c', tokenState: 'ok', teamId: 'team-c' };
  const d = describeRow({ ...rows[1], environments: [envA, envC] }, NOW);
  assert.match(d.text, /“Env C” also has a token/);
});

test('rate limiting is Failing with its own wording', () => {
  assert.equal(errorText({ status: 403, message: 'API rate limit exceeded', rateLimited: true }), 'Rate limited by GitHub (403)');
  assert.equal(errorText({ status: null, message: 'timeout' }), 'Network error: timeout');
});

test('No token names the environment and links to its Repositories tab', () => {
  const d = describeRow({ repo: 'acme/x', status: 'no-token', environments: [envB], tokenEnvironment: null, triggers: [] }, NOW);
  assert.match(d.text, /Environment “Env B” has no GitHub token/);
  assert.deepEqual(d.links.map((l) => l.to), ['/chats/team-b?tab=repositories']);
  const missing = { ...envA, tokenState: 'unreadable' };
  const d2 = describeRow({ repo: 'acme/y', status: 'no-token', environments: [missing], tokenEnvironment: missing, triggers: [] }, NOW);
  assert.match(d2.text, /is missing or empty/);
  assert.equal(d2.links[0].to, TOKENS_LINK.to);
});

test('No trigger links each involved agent’s Triggers tab and names ignored triggers', () => {
  const d = describeRow(rows[2], NOW);
  assert.match(d.text, /No active GitHub trigger.*1 trigger ignored — agent disabled/);
  assert.deepEqual(d.links.map((l) => l.to), ['/chats/sleepy?rail=triggers']);
});

test('Not in an environment names the agent-scoped holder; unsupported names the host', () => {
  const d = describeRow({ repo: 'acme/a', status: 'not-in-environment', environments: [], agentRepositoryAgents: [{ id: 'reader', name: 'Reader' }], triggers: [] }, NOW);
  assert.match(d.text, /Only attached to agent “Reader”/);
  const u = describeRow({ repo: 'git@git.example.com:a/b.git', status: 'unsupported', host: 'git.example.com', environments: [], triggers: [] }, NOW);
  assert.match(u.text, /Host “git.example.com” is not supported/);
});

test('token source never shows a token value, and hides another team’s environment', () => {
  assert.equal(tokenSourceText(rows[0]), 'Env A');
  assert.equal(tokenSourceText({ tokenEnvironment: envA, environments: [envA, envB] }), 'Env A (+1 other environment)');
  assert.equal(tokenSourceText({ tokenEnvironment: { id: null, hidden: true, tokenState: 'ok' }, environments: [], hiddenEnvironmentCount: 1 }), 'Another team’s environment');
  assert.equal(tokenSourceText({ tokenEnvironment: null, environments: [] }), '—');
});

test('inWhen phrases a future instant', () => {
  assert.equal(inWhen('2026-09-29T10:00:30.000Z', NOW), 'in 30 s');
  assert.equal(inWhen('2026-09-29T09:00:00.000Z', NOW), 'now');
  assert.equal(inWhen('nope', NOW), '');
});

test('AgentChat honours the ?rail=triggers deep link the status links use', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./AgentChat.jsx', import.meta.url), 'utf8');
  assert.match(src, /searchParams\.get\('rail'\)/);
  assert.match(src, /setRailTabRequest\(\{ tab: 'triggers'/);
  assert.match(src, /next\.delete\('rail'\)/);
});
