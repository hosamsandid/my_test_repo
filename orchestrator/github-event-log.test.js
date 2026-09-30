'use strict';

// Unit tests for the GitHub poller event-transparency log (#469).
// Run: node --test orchestrator/github-event-log.test.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the log at a throwaway dir before requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'github-event-log-test-'));
process.env.GITHUB_EVENT_LOG_DIR = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const eventLog = require('./github-event-log');

test('buildEventEntry captures event identity and outcomes', () => {
  const ghEvent = { id: '123', actor: { login: 'alice' }, created_at: '2026-07-08T10:00:00Z' };
  const entry = eventLog.buildEventEntry({
    ghEvent,
    repoFullName: 'org/repo',
    key: 'pull_request.opened',
    outcomes: [{ agentId: 'developer', triggerId: 't1', status: 'delivered' }],
  });
  assert.equal(entry.eventId, '123');
  assert.equal(entry.repo, 'org/repo');
  assert.equal(entry.event, 'pull_request.opened');
  assert.equal(entry.actor, 'alice');
  assert.equal(entry.createdAt, '2026-07-08T10:00:00Z');
  assert.equal(entry.noMatchingTrigger, false);
  assert.deepEqual(entry.outcomes, [{ agentId: 'developer', triggerId: 't1', status: 'delivered' }]);
  assert.ok(entry.ts);
});

test('buildEventEntry marks events with zero outcomes as having no matching trigger', () => {
  const ghEvent = { id: '456', actor: { login: 'bob' }, created_at: '2026-07-08T10:00:00Z' };
  const entry = eventLog.buildEventEntry({ ghEvent, repoFullName: 'org/repo', key: 'watch.started', outcomes: [] });
  assert.equal(entry.noMatchingTrigger, true);
  assert.deepEqual(entry.outcomes, []);
});

test('buildEventEntry tolerates a missing actor and null event key', () => {
  const entry = eventLog.buildEventEntry({ ghEvent: { id: '789' }, repoFullName: 'org/repo', key: null, outcomes: [] });
  assert.equal(entry.actor, null);
  assert.equal(entry.event, null);
});

test('buildEventEntry captures the label name for a labeled event', () => {
  const ghEvent = {
    id: '999', actor: { login: 'carol' }, created_at: '2026-07-09T10:00:00Z',
    payload: { label: { name: 'ready' } },
  };
  const entry = eventLog.buildEventEntry({ ghEvent, repoFullName: 'org/repo', key: 'issues.labeled', outcomes: [] });
  assert.equal(entry.label, 'ready');
});

test('buildEventEntry captures the label name for an unlabeled event', () => {
  const ghEvent = {
    id: '1000', actor: { login: 'dave' }, created_at: '2026-07-09T10:05:00Z',
    payload: { label: { name: 'ready' } },
  };
  const entry = eventLog.buildEventEntry({ ghEvent, repoFullName: 'org/repo', key: 'issues.unlabeled', outcomes: [] });
  assert.equal(entry.label, 'ready');
});

test('buildEventEntry leaves label null for events without a label payload', () => {
  const ghEvent = { id: '1001', actor: { login: 'erin' }, created_at: '2026-07-09T10:10:00Z' };
  const entry = eventLog.buildEventEntry({ ghEvent, repoFullName: 'org/repo', key: 'issues.opened', outcomes: [] });
  assert.equal(entry.label, null);
});

test('buildEventEntry captures a PR work item (kind/number/title/url) from payload.pull_request', () => {
  const ghEvent = {
    id: '2001', actor: { login: 'frank' }, created_at: '2026-08-01T10:00:00Z',
    payload: { pull_request: { number: 1817, title: 'Remove the global Triggers page', html_url: 'https://github.com/org/repo/pull/1817' } },
  };
  const entry = eventLog.buildEventEntry({ ghEvent, repoFullName: 'org/repo', key: 'pull_request.labeled', outcomes: [] });
  assert.deepEqual(entry.workItem, {
    kind: 'pr',
    number: 1817,
    title: 'Remove the global Triggers page',
    url: 'https://github.com/org/repo/pull/1817',
  });
});

test('buildEventEntry captures an issue work item from payload.issue', () => {
  const ghEvent = {
    id: '2002', actor: { login: 'gina' }, created_at: '2026-08-01T10:05:00Z',
    payload: { issue: { number: 42, title: 'Surface the work item', html_url: 'https://github.com/org/repo/issues/42' } },
  };
  const entry = eventLog.buildEventEntry({ ghEvent, repoFullName: 'org/repo', key: 'issues.opened', outcomes: [] });
  assert.deepEqual(entry.workItem, {
    kind: 'issue',
    number: 42,
    title: 'Surface the work item',
    url: 'https://github.com/org/repo/issues/42',
  });
});

test('buildEventEntry sets workItem null for an event with no work item (e.g. push)', () => {
  const ghEvent = { id: '2003', actor: { login: 'hank' }, created_at: '2026-08-01T10:10:00Z', payload: { ref: 'refs/heads/main' } };
  const entry = eventLog.buildEventEntry({ ghEvent, repoFullName: 'org/repo', key: 'push', outcomes: [] });
  assert.equal(entry.workItem, null);
});

test('buildEventEntry work item is null-safe: partial payload never throws, missing fields are null', () => {
  const ghEvent = { id: '2004', payload: { pull_request: { number: 7 } } };
  const entry = eventLog.buildEventEntry({ ghEvent, repoFullName: 'org/repo', key: 'pull_request.reopened', outcomes: [] });
  assert.deepEqual(entry.workItem, { kind: 'pr', number: 7, title: null, url: null });
  // A pull_request object without a number carries no identifiable work item.
  assert.equal(
    eventLog.buildEventEntry({ ghEvent: { id: '2005', payload: { pull_request: {} } }, repoFullName: 'org/repo', key: 'pull_request.opened', outcomes: [] }).workItem,
    null,
  );
});

test('extractWorkItem classifies an issue_comment on a PR as kind pr (#1848)', () => {
  // GitHub fires issue_comment for both issues and PRs; a PR's issue object
  // carries a nested pull_request marker and no top-level payload.pull_request.
  const workItem = eventLog.extractWorkItem({
    issue: {
      number: 1846,
      title: 'Label attribution on the event log',
      html_url: 'https://github.com/org/repo/pull/1846',
      pull_request: { url: 'https://api.github.com/repos/org/repo/pulls/1846' },
    },
  });
  assert.deepEqual(workItem, {
    kind: 'pr',
    number: 1846,
    title: 'Label attribution on the event log',
    url: 'https://github.com/org/repo/pull/1846',
  });
});

test('extractWorkItem keeps a plain issue_comment (no pull_request marker) as kind issue (#1848)', () => {
  assert.deepEqual(
    eventLog.extractWorkItem({ issue: { number: 99, title: 'A real issue' } }),
    { kind: 'issue', number: 99, title: 'A real issue', url: null },
  );
});

test('extractWorkItem returns null for absent/oddly-shaped payloads without throwing', () => {
  assert.equal(eventLog.extractWorkItem(undefined), null);
  assert.equal(eventLog.extractWorkItem(null), null);
  assert.equal(eventLog.extractWorkItem({}), null);
  assert.equal(eventLog.extractWorkItem({ pull_request: 'not-an-object' }), null);
});

test('extractWorkItem carries closesIssues for a PR whose enriched payload holds them (#1833)', () => {
  const workItem = eventLog.extractWorkItem({
    pull_request: {
      number: 1828, title: 'Fix the thing', html_url: 'https://github.com/org/repo/pull/1828',
      closesIssues: [1796],
    },
  });
  assert.deepEqual(workItem, {
    kind: 'pr', number: 1828, title: 'Fix the thing',
    url: 'https://github.com/org/repo/pull/1828', closesIssues: [1796],
  });
});

test('extractWorkItem omits closesIssues when absent/empty and never carries it for an issue (#1833)', () => {
  // A PR with no closes linkage — the key is omitted entirely (issue rows and
  // un-enriched PR rows stay byte-identical to their pre-#1833 shape).
  assert.deepEqual(
    eventLog.extractWorkItem({ pull_request: { number: 5, closesIssues: [] } }),
    { kind: 'pr', number: 5, title: null, url: null },
  );
  // An issue payload is never given closesIssues even if one leaked onto it.
  assert.deepEqual(
    eventLog.extractWorkItem({ issue: { number: 9, closesIssues: [1] } }),
    { kind: 'issue', number: 9, title: null, url: null },
  );
});

test('extractWorkItem drops non-positive/non-integer closes and never throws (#1833)', () => {
  assert.deepEqual(
    eventLog.extractWorkItem({ pull_request: { number: 5, closesIssues: [1796, 0, -3, 2.5, '7', 1797] } }),
    { kind: 'pr', number: 5, title: null, url: null, closesIssues: [1796, 1797] },
  );
});

test('buildEventEntry captures the git ref for push/create/delete rows, null otherwise (#1833 AC1.3)', () => {
  const push = eventLog.buildEventEntry({
    ghEvent: { id: '3001', payload: { ref: 'refs/heads/feat/x' } },
    repoFullName: 'org/repo', key: 'push', outcomes: [],
  });
  assert.equal(push.ref, 'refs/heads/feat/x');
  // A PR labeled event carries no ref.
  const pr = eventLog.buildEventEntry({
    ghEvent: { id: '3002', payload: { pull_request: { number: 1, title: 't', html_url: 'u' } } },
    repoFullName: 'org/repo', key: 'pull_request.labeled', outcomes: [],
  });
  assert.equal(pr.ref, null);
});

test('record + file round-trip: one JSONL line per entry, day-bucketed', () => {
  eventLog.record(eventLog.buildEventEntry({
    ghEvent: { id: '1', actor: { login: 'a' }, created_at: '2026-06-30T10:00:00Z' },
    repoFullName: 'org/repo', key: 'issues.opened', outcomes: [],
  }));
  const files = fs.readdirSync(TMP).filter(f => /^github-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  assert.ok(files.length >= 1);
  const lines = fs.readFileSync(path.join(TMP, files[0]), 'utf8').trim().split('\n');
  const parsed = JSON.parse(lines[lines.length - 1]);
  assert.equal(parsed.eventId, '1');
});

test('record never throws even with a malformed entry', () => {
  assert.doesNotThrow(() => eventLog.record({ ts: 12345 }));
});

test('expiredDayFiles keeps files inside the retention window and flags older ones', () => {
  const now = Date.parse('2026-07-08T12:00:00Z');
  const files = [
    'github-events-2026-07-08.jsonl', // today
    'github-events-2026-07-02.jsonl', // 6 days ago — inside a 7-day window
    'github-events-2026-07-01.jsonl', // 7 days ago — right at the edge, still inside
    'github-events-2026-06-30.jsonl', // 8 days ago — expired
    'github-events-2026-01-01.jsonl', // long expired
    'not-a-log-file.txt',
  ];
  const expired = eventLog.expiredDayFiles(files, now, 7);
  assert.deepEqual(expired.sort(), ['github-events-2026-01-01.jsonl', 'github-events-2026-06-30.jsonl'].sort());
});

// ── wakeLabel (#1846) — per-outcome attribution ───────────────────────────────

test('buildEventEntry passes wakeLabel through outcomes — matched labelFilter', () => {
  const ghEvent = {
    id: '5001', actor: { login: 'alice' }, created_at: '2026-09-01T10:00:00Z',
    payload: { label: { name: 'ux' }, labels: [{ name: 'ux' }, { name: 'ready' }] },
  };
  const entry = eventLog.buildEventEntry({
    ghEvent,
    repoFullName: 'org/repo',
    key: 'issues.labeled',
    outcomes: [
      { agentId: 'developer', triggerId: 't1', status: 'delivered', reason: null, digest: false, wakeLabel: 'ready' },
    ],
  });
  // event-level label stays as the raw collapsed value
  assert.equal(entry.label, 'ux');
  // per-outcome wakeLabel carries the subscriber's matched filter
  assert.equal(entry.outcomes[0].wakeLabel, 'ready');
});

test('buildEventEntry passes wakeLabel through outcomes — null for any-label listener', () => {
  const ghEvent = {
    id: '5002', actor: { login: 'bob' }, created_at: '2026-09-01T10:05:00Z',
    payload: { label: { name: 'ready' } },
  };
  const entry = eventLog.buildEventEntry({
    ghEvent,
    repoFullName: 'org/repo',
    key: 'issues.labeled',
    outcomes: [
      { agentId: 'any-listener', triggerId: 't2', status: 'delivered', reason: null, digest: false, wakeLabel: null },
    ],
  });
  assert.equal(entry.outcomes[0].wakeLabel, null);
});

test('buildEventEntry preserves absent wakeLabel on legacy / label-filter-dropped outcomes', () => {
  const ghEvent = { id: '5003', actor: { login: 'carol' }, created_at: '2026-09-01T10:10:00Z' };
  const entry = eventLog.buildEventEntry({
    ghEvent,
    repoFullName: 'org/repo',
    key: 'issues.labeled',
    outcomes: [
      { agentId: 'other', triggerId: 't3', status: 'dropped', reason: 'label-filter', digest: false },
    ],
  });
  assert.equal(entry.outcomes[0].wakeLabel, undefined);
});

test('expiredDayFiles returns nothing for an empty or all-fresh file list', () => {
  const now = Date.parse('2026-07-08T12:00:00Z');
  assert.deepEqual(eventLog.expiredDayFiles([], now, 7), []);
  assert.deepEqual(eventLog.expiredDayFiles(['github-events-2026-07-08.jsonl'], now, 7), []);
});

test('cleanupOldEntries deletes only expired day files on disk', () => {
  // EVENT_LOG_DIR is captured at module-load time (TMP, set above), so
  // exercise cleanup directly against it.
  const freshFile = path.join(TMP, 'github-events-2026-07-08.jsonl');
  const staleFile = path.join(TMP, 'github-events-2020-01-01.jsonl');
  fs.writeFileSync(freshFile, '{}\n');
  fs.writeFileSync(staleFile, '{}\n');
  eventLog.cleanupOldEntries(Date.parse('2026-07-08T12:00:00Z'), 7);
  assert.ok(fs.existsSync(freshFile));
  assert.ok(!fs.existsSync(staleFile));
});

test('cleanupOldEntries does not throw when the log directory does not exist yet', () => {
  // EVENT_LOG_DIR is fixed to TMP at module-load time; remove it to simulate
  // "nothing logged yet" (last test in the file — nothing runs after it).
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.doesNotThrow(() => eventLog.cleanupOldEntries());
});

test('readEntries (#2525) returns every recorded entry across day files, skipping corrupt lines', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(TMP, 'github-events-2026-09-27.jsonl'), '{"eventId":"a","ts":"2026-09-27T10:00:00Z"}\nnot json\n');
  fs.writeFileSync(path.join(TMP, 'github-events-2026-09-28.jsonl'), '{"eventId":"b","ts":"2026-09-28T10:00:00Z"}\n');
  fs.writeFileSync(path.join(TMP, 'unrelated.txt'), 'x');
  assert.deepEqual(eventLog.readEntries().map((e) => e.eventId), ['a', 'b']);
});

// ── #2596: pooled routing verdict folded into a delivered outcome ─────────
test('applyPoolDecision stamps the pool instance a delivered outcome ran on', () => {
  const o = { agentId: 'team-developer', triggerId: 't1', status: 'delivered', reason: null, digest: false };
  assert.deepEqual(
    eventLog.applyPoolDecision(o, { held: false, instanceId: 'team-developer-i2562' }),
    { ...o, instanceId: 'team-developer-i2562' },
  );
});

test('applyPoolDecision leaves a non-pooled delivery exactly as it was (AC7)', () => {
  const o = { agentId: 'dev', triggerId: 't1', status: 'delivered', reason: null, digest: false };
  assert.equal(eventLog.applyPoolDecision(o, { held: false }), o);
  assert.equal(eventLog.applyPoolDecision(o, {}), o);
  assert.equal(eventLog.applyPoolDecision(o, undefined), o);
});

test('applyPoolDecision records a WIP hold as held (WIP n), pooled or not — like the poller (AC6, review B1)', () => {
  // Pooled role behind a full lane: the dispatch will land on an instance only
  // after promotion, so the row must not claim delivery to (or link) the role.
  const pooled = { agentId: 't-developer', triggerId: 't1', status: 'delivered', reason: null, digest: false };
  assert.deepEqual(
    eventLog.applyPoolDecision(pooled, { held: true, reason: 'wip', wipLimit: 2 }),
    { ...pooled, status: 'held', reason: 'wip', wipLimit: 2 },
  );
  // A hold with no reason defaults to 'wip'; no wipLimit → none recorded.
  const r = eventLog.applyPoolDecision(pooled, { held: true });
  assert.equal(r.status, 'held');
  assert.equal(r.reason, 'wip');
  assert.equal('wipLimit' in r, false);
  assert.equal(r.instanceId, undefined);
  // Non-pooled WIP hold: same truthful `held` the poller path already records.
  const plain = { agentId: 'dev', triggerId: 't1', status: 'delivered', reason: null, digest: false };
  assert.equal(eventLog.applyPoolDecision(plain, { held: true, reason: 'wip', wipLimit: 3 }).status, 'held');
});

test("applyPoolDecision records a pool pause/drain hold as held, never a link to the role (AC6)", () => {
  const o = { agentId: 'team-developer', triggerId: 't1', status: 'delivered', reason: null, digest: false };
  const r = eventLog.applyPoolDecision(o, { held: true, reason: 'pool-paused' });
  assert.equal(r.status, 'held');
  assert.equal(r.reason, 'pool-paused');
  assert.equal(r.instanceId, undefined);
});

test('applyPoolDecision never touches a non-delivered outcome', () => {
  const o = { agentId: 'a', status: 'dropped', reason: 'throttle' };
  assert.equal(eventLog.applyPoolDecision(o, { instanceId: 'a-i1' }), o);
});
