'use strict';

// Unit tests for the internal label fast-path core (#1858).
// Run: node --test orchestrator/github-label-fastpath.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  eventKeyForKind,
  validateLabelAppliedRequest,
  matchPollerListeners,
  buildSyntheticEvent,
} = require('./github-label-fastpath');

// ── validateLabelAppliedRequest ─────────────────────────────────────────────

test('validate: accepts a well-formed issue label-apply, kind defaults to issue', () => {
  const r = validateLabelAppliedRequest({ repo: 'org/repo', number: 42, label: 'ready', actor: 'alice' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { repo: 'org/repo', number: 42, kind: 'issue', label: 'ready', actor: 'alice' });
});

test('validate: accepts an explicit pr kind and trims label; actor optional', () => {
  const r = validateLabelAppliedRequest({ repo: 'org/repo', number: 7, kind: 'pr', label: '  ready-to-merge  ' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { repo: 'org/repo', number: 7, kind: 'pr', label: 'ready-to-merge', actor: null });
});

test('validate: rejects malformed requests', () => {
  const bad = [
    null,
    [],
    {},
    { repo: 'not-a-repo', number: 1, label: 'l' },
    { repo: 'o/r', number: 0, label: 'l' },
    { repo: 'o/r', number: 1.5, label: 'l' },
    { repo: 'o/r', number: 1, label: '   ' },
    { repo: 'o/r', number: 1, label: 'l', kind: 'branch' },
  ];
  for (const b of bad) assert.equal(validateLabelAppliedRequest(b).ok, false, JSON.stringify(b));
});

// ── eventKeyForKind ─────────────────────────────────────────────────────────

test('eventKeyForKind maps kind to the poller event key', () => {
  assert.equal(eventKeyForKind('issue'), 'issues.labeled');
  assert.equal(eventKeyForKind('pr'), 'pull_request.labeled');
});

// ── matchPollerListeners ────────────────────────────────────────────────────

const AGENTS = [
  {
    agentId: 'dev',
    enabled: true,
    triggers: [
      { id: 't-ready', type: 'github-event', repo: 'org/repo', events: ['issues.labeled'], labelFilter: 'ready' },
      { id: 't-refine', type: 'github-event', repo: 'org/repo', events: ['issues.labeled'], labelFilter: 'req:refine' },
    ],
  },
  {
    agentId: 'dispatcher',
    enabled: true,
    triggers: [
      // any-label listener (no labelFilter) — matches every label
      { id: 't-any', type: 'github-event', repo: 'org/repo', events: ['issues.labeled'] },
    ],
  },
];

test('match: exact labelFilter and any-label listeners both match', () => {
  const out = matchPollerListeners({ repo: 'org/repo', label: 'ready', kind: 'issue' }, AGENTS);
  assert.deepEqual(out, [
    { agentId: 'dev', triggerId: 't-ready' },
    { agentId: 'dispatcher', triggerId: 't-any' },
  ]);
});

test('match: a non-matching label wakes only the any-label listener', () => {
  const out = matchPollerListeners({ repo: 'org/repo', label: 'ux', kind: 'issue' }, AGENTS);
  assert.deepEqual(out, [{ agentId: 'dispatcher', triggerId: 't-any' }]);
});

test('match: transport:internal listeners are NOT matched (poller-subscribed only)', () => {
  const agents = [{
    agentId: 'dev', enabled: true,
    triggers: [{ id: 't', type: 'github-event', repo: 'org/repo', events: ['issues.labeled'], labelFilter: 'ready', transport: 'internal' }],
  }];
  assert.deepEqual(matchPollerListeners({ repo: 'org/repo', label: 'ready', kind: 'issue' }, agents), []);
});

test('match: gated out by disabled agent / disabled trigger / wrong repo / wrong event', () => {
  const agents = [
    { agentId: 'a1', enabled: false, triggers: [{ id: 't', type: 'github-event', repo: 'org/repo', events: ['issues.labeled'], labelFilter: 'ready' }] },
    { agentId: 'a2', enabled: true, triggers: [{ id: 't', type: 'github-event', enabled: false, repo: 'org/repo', events: ['issues.labeled'], labelFilter: 'ready' }] },
    { agentId: 'a3', enabled: true, triggers: [{ id: 't', type: 'github-event', repo: 'other/repo', events: ['issues.labeled'], labelFilter: 'ready' }] },
    { agentId: 'a4', enabled: true, triggers: [{ id: 't', type: 'github-event', repo: 'org/repo', events: ['issues.opened'], labelFilter: 'ready' }] },
  ];
  assert.deepEqual(matchPollerListeners({ repo: 'org/repo', label: 'ready', kind: 'issue' }, agents), []);
});

test('match: kind pr matches only pull_request.labeled subscribers', () => {
  const agents = [{
    agentId: 'rev', enabled: true,
    triggers: [
      { id: 't-pr', type: 'github-event', repo: 'org/repo', events: ['pull_request.labeled'], labelFilter: 'revisions-required' },
      { id: 't-iss', type: 'github-event', repo: 'org/repo', events: ['issues.labeled'], labelFilter: 'revisions-required' },
    ],
  }];
  assert.deepEqual(
    matchPollerListeners({ repo: 'org/repo', label: 'revisions-required', kind: 'pr' }, agents),
    [{ agentId: 'rev', triggerId: 't-pr' }],
  );
});

// ── buildSyntheticEvent ─────────────────────────────────────────────────────

test('buildSyntheticEvent: issue shape carries the human actor + labeled action', () => {
  const ev = buildSyntheticEvent({ repo: 'org/repo', label: 'ready', kind: 'issue', number: 42, actor: 'alice', eventId: 'x1', now: '2026-09-01T00:00:00Z' });
  assert.deepEqual(ev, {
    id: 'x1',
    actor: { login: 'alice' },
    repo: { name: 'org/repo' },
    created_at: '2026-09-01T00:00:00Z',
    payload: {
      action: 'labeled',
      label: { name: 'ready' },
      issue: { number: 42, html_url: 'https://github.com/org/repo/issues/42' },
    },
  });
});

test('buildSyntheticEvent: pr shape uses pull_request + /pull/ url; actor falls back to console', () => {
  const ev = buildSyntheticEvent({ repo: 'org/repo', label: 'ready', kind: 'pr', number: 7, actor: null, eventId: 'x2', now: '2026-09-01T00:00:00Z' });
  assert.equal(ev.actor.login, 'console');
  assert.deepEqual(ev.payload.pull_request, { number: 7, html_url: 'https://github.com/org/repo/pull/7' });
  assert.equal(ev.payload.issue, undefined);
});

test('buildSyntheticEvent: resolved title rides on the subject (#1897 AC8)', () => {
  const ev = buildSyntheticEvent({ repo: 'org/repo', label: 'ready', kind: 'issue', number: 42, title: 'Fix login', actor: 'alice', eventId: 'x3', now: '2026-09-01T00:00:00Z' });
  assert.equal(ev.payload.issue.title, 'Fix login');
  // Blank/absent title is not carried (backward-compatible, notice degrades).
  const noTitle = buildSyntheticEvent({ repo: 'org/repo', label: 'ready', kind: 'issue', number: 42, title: '', actor: 'alice', eventId: 'x4', now: '2026-09-01T00:00:00Z' });
  assert.equal(noTitle.payload.issue.title, undefined);
});
