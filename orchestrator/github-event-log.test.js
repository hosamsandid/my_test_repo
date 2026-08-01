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
