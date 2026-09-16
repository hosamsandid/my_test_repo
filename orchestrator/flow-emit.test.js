'use strict';

// Unit tests for the internal-channel emit core (#1173).
// Run: node --test orchestrator/flow-emit.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  eventKeyForKind,
  validateEmitRequest,
  matchInternalListeners,
  buildSyntheticEvent,
  buildPendingEntry,
} = require('./flow-emit');

// ── validateEmitRequest ────────────────────────────────────────────────────

test('validateEmitRequest: accepts a well-formed issue emit', () => {
  const r = validateEmitRequest({
    agentId: 'dev', repo: 'org/repo', label: 'ready',
    target: { kind: 'issue', number: 42 },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    agentId: 'dev', repo: 'org/repo', label: 'ready',
    target: { kind: 'issue', number: 42 },
  });
});

test('validateEmitRequest: rejects malformed requests', () => {
  const bad = [
    null,
    [],
    {},
    { agentId: '', repo: 'o/r', label: 'l', target: { kind: 'issue', number: 1 } },
    { agentId: 'a', repo: 'not-a-repo', label: 'l', target: { kind: 'issue', number: 1 } },
    { agentId: 'a', repo: 'o/r', label: '  ', target: { kind: 'issue', number: 1 } },
    { agentId: 'a', repo: 'o/r', label: 'l', target: { kind: 'branch', number: 1 } },
    { agentId: 'a', repo: 'o/r', label: 'l', target: { kind: 'pr', number: 0 } },
    { agentId: 'a', repo: 'o/r', label: 'l', target: { kind: 'pr', number: 1.5 } },
    { agentId: 'a', repo: 'o/r', label: 'l' },
  ];
  for (const body of bad) {
    assert.equal(validateEmitRequest(body).ok, false, JSON.stringify(body));
  }
});

// ── matchInternalListeners ─────────────────────────────────────────────────

const internalTrigger = (over = {}) => ({
  id: 't1', type: 'github-event', transport: 'internal',
  repo: 'org/repo', events: ['issues.labeled'], labelFilter: 'ready',
  ...over,
});
const EMIT = { repo: 'org/repo', label: 'ready', kind: 'issue' };

test('matchInternalListeners: matches an internal listener on repo+event+label', () => {
  const got = matchInternalListeners(EMIT, [
    { agentId: 'consumer', enabled: true, triggers: [internalTrigger()] },
  ]);
  assert.deepEqual(got, [{ agentId: 'consumer', triggerId: 't1' }]);
});

test('matchInternalListeners: a github/absent transport never matches — the emit side of the dedup split', () => {
  const agents = [
    { agentId: 'a1', enabled: true, triggers: [internalTrigger({ transport: 'github' })] },
    { agentId: 'a2', enabled: true, triggers: [internalTrigger({ transport: undefined })] },
  ];
  assert.deepEqual(matchInternalListeners(EMIT, agents), []);
});

test('matchInternalListeners: disabled agent and disabled trigger are skipped', () => {
  const agents = [
    { agentId: 'off', enabled: false, triggers: [internalTrigger()] },
    { agentId: 'on', enabled: true, triggers: [internalTrigger({ enabled: false })] },
  ];
  assert.deepEqual(matchInternalListeners(EMIT, agents), []);
});

test('matchInternalListeners: repo, event-kind and labelFilter gates', () => {
  const agents = [
    { agentId: 'a', enabled: true, triggers: [internalTrigger({ repo: 'other/repo' })] },
    { agentId: 'b', enabled: true, triggers: [internalTrigger({ events: ['pull_request.labeled'] })] },
    { agentId: 'c', enabled: true, triggers: [internalTrigger({ labelFilter: 'other-label' })] },
  ];
  assert.deepEqual(matchInternalListeners(EMIT, agents), []);
});

test('matchInternalListeners: absent labelFilter matches any label (poller legacy semantics)', () => {
  const got = matchInternalListeners(EMIT, [
    { agentId: 'wild', enabled: true, triggers: [internalTrigger({ labelFilter: undefined })] },
  ]);
  assert.deepEqual(got, [{ agentId: 'wild', triggerId: 't1' }]);
});

test('matchInternalListeners: pr emit maps to pull_request.labeled', () => {
  const got = matchInternalListeners({ ...EMIT, kind: 'pr' }, [
    { agentId: 'rev', enabled: true, triggers: [internalTrigger({ events: ['pull_request.labeled'] })] },
  ]);
  assert.deepEqual(got, [{ agentId: 'rev', triggerId: 't1' }]);
});

test('matchInternalListeners: fan-out — every matching listener gets an entry', () => {
  const got = matchInternalListeners(EMIT, [
    { agentId: 'a', enabled: true, triggers: [internalTrigger()] },
    { agentId: 'b', enabled: true, triggers: [internalTrigger({ id: 't2' })] },
  ]);
  assert.equal(got.length, 2);
});

// ── synthesized shapes ─────────────────────────────────────────────────────

test('buildSyntheticEvent + buildPendingEntry: issue entry satisfies the claim-plan contract', () => {
  // `_claim_plan` in agent-entrypoint.py reads github.repo ("owner/name") and
  // payload.issue.number — the swap must work on an internally delivered wake.
  const ev = buildSyntheticEvent({
    repo: 'org/repo', label: 'ready', kind: 'issue', number: 42,
    producerId: 'dev', eventId: 'int:abc123', now: '2026-08-02T10:00:00Z',
  });
  const entry = buildPendingEntry('t1', 'issues.labeled', ev);
  assert.equal(entry.triggerId, 't1');
  assert.equal(entry.source, 'internal');
  // #2151: stamped from the synthesized event's own label — always correct
  // here since the emit and the synthetic payload agree by construction.
  assert.equal(entry.wakeLabel, 'ready');
  assert.equal(entry.github.event, 'issues.labeled');
  assert.equal(entry.github.eventId, 'int:abc123');
  assert.equal(entry.github.repo, 'org/repo');
  assert.equal(entry.github.actor, 'agent:dev');
  assert.equal(entry.github.createdAt, '2026-08-02T10:00:00Z');
  assert.equal(entry.github.payload.action, 'labeled');
  assert.equal(entry.github.payload.label.name, 'ready');
  assert.equal(entry.github.payload.issue.number, 42);
  assert.equal(entry.github.payload.pull_request, undefined);
});

test('buildSyntheticEvent: pr emit carries payload.pull_request.number', () => {
  const ev = buildSyntheticEvent({
    repo: 'org/repo', label: 'qa:approved', kind: 'pr', number: 7,
    producerId: 'dev', eventId: 'int:def', now: '2026-08-02T10:00:00Z',
  });
  assert.equal(ev.payload.pull_request.number, 7);
  assert.equal(ev.payload.issue, undefined);
  assert.match(ev.payload.pull_request.html_url, /\/pull\/7$/);
  // No title supplied → subject carries none (notice degrades to `#N`, #1897).
  assert.equal(ev.payload.pull_request.title, undefined);
});

test('buildSyntheticEvent: resolved title rides on the subject (#1897 AC8)', () => {
  const ev = buildSyntheticEvent({
    repo: 'org/repo', label: 'ready', kind: 'issue', number: 42, title: 'Fix the bug',
    producerId: 'dev', eventId: 'int:abc', now: '2026-08-02T10:00:00Z',
  });
  assert.equal(ev.payload.issue.title, 'Fix the bug');
  // A blank/absent title is not carried (kept optional, backward-compatible).
  const noTitle = buildSyntheticEvent({
    repo: 'org/repo', label: 'ready', kind: 'issue', number: 42, title: '',
    producerId: 'dev', eventId: 'int:abc', now: '2026-08-02T10:00:00Z',
  });
  assert.equal(noTitle.payload.issue.title, undefined);
});

test('eventKeyForKind maps both target kinds', () => {
  assert.equal(eventKeyForKind('issue'), 'issues.labeled');
  assert.equal(eventKeyForKind('pr'), 'pull_request.labeled');
});

test('#2151: buildPendingEntry stamps wakeLabel null when the synthesized event carries no label', () => {
  const entry = buildPendingEntry('t1', 'issues.labeled', {
    id: 'int:no-label', actor: { login: 'agent:dev' }, repo: { name: 'org/repo' },
    created_at: '2026-08-02T10:00:00Z', payload: { action: 'labeled', issue: { number: 1 } },
  });
  assert.equal(entry.wakeLabel, null);
});
