'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveJiraApiBase,
  isChangelogTruncated,
  extractStatusChangeEvents,
  matchesStatusFilter,
  computeQueryWindowMinutes,
  MAX_WINDOW_MINUTES,
} = require('./event-extract');

// ── resolveJiraApiBase ──────────────────────────────────────────────────────

test('resolveJiraApiBase: bare subdomain → .atlassian.net origin', () => {
  assert.equal(resolveJiraApiBase('acme'), 'https://acme.atlassian.net');
});

test('resolveJiraApiBase: full origin used verbatim; trailing slashes stripped', () => {
  assert.equal(resolveJiraApiBase('https://jira.acme.internal'), 'https://jira.acme.internal');
  assert.equal(resolveJiraApiBase('https://acme.atlassian.net///'), 'https://acme.atlassian.net');
  assert.equal(resolveJiraApiBase('http://fake-jira:8080'), 'http://fake-jira:8080');
});

// ── isChangelogTruncated ────────────────────────────────────────────────────

test('isChangelogTruncated: total > histories.length', () => {
  assert.equal(isChangelogTruncated({ total: 50, histories: [{}, {}] }), true);
  assert.equal(isChangelogTruncated({ total: 2, histories: [{}, {}] }), false);
  assert.equal(isChangelogTruncated(null), false);
  assert.equal(isChangelogTruncated({ total: 5 }), false);
});

// ── extractStatusChangeEvents ───────────────────────────────────────────────

test('extractStatusChangeEvents: one status item → one event with composite id', () => {
  const issue = {
    key: 'ENG-42',
    fields: { summary: 'Fix login bug' },
    changelog: {
      histories: [{
        id: '10001',
        created: '2026-07-27T10:00:00.000Z',
        author: { displayName: 'Jane Doe' },
        items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
      }],
    },
  };
  const events = extractStatusChangeEvents(issue, { projectKey: 'ENG', siteBase: 'https://acme.atlassian.net' });
  assert.deepEqual(events, [{
    id: 'ENG-42:10001',
    issueKey: 'ENG-42',
    projectKey: 'ENG',
    created: '2026-07-27T10:00:00.000Z',
    author: 'Jane Doe',
    fromStatus: 'To Do',
    toStatus: 'In Progress',
    summary: 'Fix login bug',
    issueUrl: 'https://acme.atlassian.net/browse/ENG-42',
  }]);
});

test('extractStatusChangeEvents: non-status items ignored; multiple changes get distinct ids', () => {
  const issue = {
    key: 'ENG-2',
    changelog: {
      histories: [
        { id: '1', items: [{ field: 'assignee', toString: 'x' }, { field: 'status', fromString: 'Open', toString: 'In Progress' }] },
        { id: '2', items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }] },
      ],
    },
  };
  assert.deepEqual(extractStatusChangeEvents(issue, { projectKey: 'ENG' }).map((e) => e.id), ['ENG-2:1', 'ENG-2:2']);
});

test('extractStatusChangeEvents: malformed input → [], never throws; id-less history skipped', () => {
  assert.deepEqual(extractStatusChangeEvents(null, {}), []);
  assert.deepEqual(extractStatusChangeEvents({}, {}), []);
  assert.deepEqual(extractStatusChangeEvents({ key: 'X-1' }, {}), []);
  assert.deepEqual(extractStatusChangeEvents({ key: 'X-1', changelog: { histories: [{ items: [{ field: 'status', toString: 'B' }] }] } }, {}), []);
});

// ── matchesStatusFilter ─────────────────────────────────────────────────────

test('matchesStatusFilter: no filter matches anything; otherwise exact match', () => {
  assert.equal(matchesStatusFilter('Done', null), true);
  assert.equal(matchesStatusFilter('Done', ''), true);
  assert.equal(matchesStatusFilter('Ready for Dev', 'Ready for Dev'), true);
  assert.equal(matchesStatusFilter('In Progress', 'Ready for Dev'), false);
  assert.equal(matchesStatusFilter(null, 'Ready for Dev'), false);
});

// ── computeQueryWindowMinutes ───────────────────────────────────────────────

test('computeQueryWindowMinutes: no last-poll → base window', () => {
  assert.equal(computeQueryWindowMinutes(null, Date.now(), { baseMinutes: 10 }), 10);
  assert.equal(computeQueryWindowMinutes('not-a-date', Date.now(), { baseMinutes: 7 }), 7);
});

test('computeQueryWindowMinutes: a gap widens the window to cover the outage + overlap', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const last = '2026-01-01T11:30:00Z'; // 30m gap
  assert.equal(computeQueryWindowMinutes(last, now, { baseMinutes: 10 }), 40); // 30 + 10 overlap
});

test('computeQueryWindowMinutes: capped at 24h no matter how long the sidecar was dead', () => {
  const now = Date.parse('2026-01-10T00:00:00Z');
  const last = '2026-01-01T00:00:00Z'; // 9 days
  assert.equal(computeQueryWindowMinutes(last, now, { baseMinutes: 10 }), MAX_WINDOW_MINUTES);
});

test('computeQueryWindowMinutes: a future last-poll (clock skew) → base window, never negative', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(computeQueryWindowMinutes('2026-01-01T13:00:00Z', now, { baseMinutes: 10 }), 10);
});
