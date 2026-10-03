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
  buildPendingEntry,
  TARGET_KINDS,
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

test('match: a legacy transport field is ignored — the trigger is poller-subscribed (#2578)', () => {
  const agents = [{
    agentId: 'dev', enabled: true,
    triggers: [{ id: 't', type: 'github-event', repo: 'org/repo', events: ['issues.labeled'], labelFilter: 'ready', transport: 'internal' }],
  }];
  assert.deepEqual(
    matchPollerListeners({ repo: 'org/repo', label: 'ready', kind: 'issue' }, agents),
    [{ agentId: 'dev', triggerId: 't' }],
  );
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

test('TARGET_KINDS lists both label-apply targets', () => {
  assert.deepEqual(TARGET_KINDS, ['issue', 'pr']);
});

// ── buildPendingEntry ───────────────────────────────────────────────────────

test('buildSyntheticEvent + buildPendingEntry: issue entry satisfies the claim-plan contract', () => {
  // `_claim_plan` in agent-entrypoint.py reads github.repo ("owner/name") and
  // payload.issue.number — the swap must work on a fast-path delivered wake.
  const ev = buildSyntheticEvent({
    repo: 'org/repo', label: 'ready', kind: 'issue', number: 42,
    actor: 'alice', eventId: 'intlbl:abc123', now: '2026-08-02T10:00:00Z',
  });
  const entry = buildPendingEntry('t1', 'issues.labeled', ev);
  assert.equal(entry.triggerId, 't1');
  assert.equal(entry.source, 'internal');
  // #2151: stamped from the synthesized event's own label.
  assert.equal(entry.wakeLabel, 'ready');
  assert.equal(entry.github.event, 'issues.labeled');
  assert.equal(entry.github.eventId, 'intlbl:abc123');
  assert.equal(entry.github.repo, 'org/repo');
  assert.equal(entry.github.actor, 'alice');
  assert.equal(entry.github.createdAt, '2026-08-02T10:00:00Z');
  assert.equal(entry.github.payload.action, 'labeled');
  assert.equal(entry.github.payload.label.name, 'ready');
  assert.equal(entry.github.payload.issue.number, 42);
  assert.equal(entry.github.payload.pull_request, undefined);
});

test('#2151: buildPendingEntry stamps wakeLabel null when the synthesized event carries no label', () => {
  const entry = buildPendingEntry('t1', 'issues.labeled', {
    id: 'intlbl:no-label', actor: { login: 'alice' }, repo: { name: 'org/repo' },
    created_at: '2026-08-02T10:00:00Z', payload: { action: 'labeled', issue: { number: 1 } },
  });
  assert.equal(entry.wakeLabel, null);
});

test('match: a gated PR trigger carries its normalized readinessGate; issue and ungated listeners do not (#2795 review B2)', () => {
  const agents = [{
    agentId: 'rev', enabled: true,
    triggers: [
      { id: 't-gated', type: 'github-event', repo: 'org/repo', events: ['pull_request.labeled'], labelFilter: 'ready-for-review', readinessGate: { ci: true } },
      { id: 't-off', type: 'github-event', repo: 'org/repo', events: ['pull_request.labeled'], labelFilter: 'ready-for-review', readinessGate: { ci: false, conflict: false } },
      { id: 't-iss', type: 'github-event', repo: 'org/repo', events: ['issues.labeled'], labelFilter: 'ready-for-review', readinessGate: { ci: true } },
    ],
  }];
  assert.deepEqual(matchPollerListeners({ repo: 'org/repo', label: 'ready-for-review', kind: 'pr' }, agents), [
    { agentId: 'rev', triggerId: 't-gated', readinessGate: { ci: true, conflict: false, failureLabel: 'revisions-required', timeoutMinutes: 60 } },
    { agentId: 'rev', triggerId: 't-off' },
  ]);
  assert.deepEqual(matchPollerListeners({ repo: 'org/repo', label: 'ready-for-review', kind: 'issue' }, agents), [
    { agentId: 'rev', triggerId: 't-iss' },
  ]);
});
