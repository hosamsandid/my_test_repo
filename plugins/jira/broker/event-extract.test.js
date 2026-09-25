'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveJiraApiBase,
  isChangelogTruncated,
  extractStatusChangeEvents,
  matchesStatusFilter,
  matchesStatusFilters,
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
    fields: { summary: 'Fix login bug', issuetype: { name: 'Bug' } },
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
    event: 'status_changed',
    issueKey: 'ENG-42',
    projectKey: 'ENG',
    issueType: 'Bug',
    created: '2026-07-27T10:00:00.000Z',
    author: 'Jane Doe',
    fromStatus: 'To Do',
    toStatus: 'In Progress',
    summary: 'Fix login bug',
    issueUrl: 'https://acme.atlassian.net/browse/ENG-42',
  }]);
});

test('extractStatusChangeEvents: reads the narrowed shapeIssue form (summary + issueType), not just raw fields', () => {
  // The poller passes the shaped issue (`{ key, summary, status, issueType, changelog }`),
  // which has no `.fields` — before this the poller path always produced summary: null.
  const shaped = {
    key: 'ENG-9',
    summary: 'Shaped summary',
    issueType: 'Story',
    changelog: { histories: [{ id: '5', items: [{ field: 'status', fromString: 'A', toString: 'B' }] }] },
  };
  const [ev] = extractStatusChangeEvents(shaped, { projectKey: 'ENG' });
  assert.equal(ev.summary, 'Shaped summary');
  assert.equal(ev.issueType, 'Story');
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

test('matchesStatusFilters: empty set fires on anything; otherwise membership', () => {
  assert.equal(matchesStatusFilters('Done', null), true);
  assert.equal(matchesStatusFilters('Done', []), true);
  assert.equal(matchesStatusFilters('Done', ['']), true); // all-blank collapses to "no filter"
  assert.equal(matchesStatusFilters('Ready for Dev', ['Ready for Dev', 'In Review']), true);
  assert.equal(matchesStatusFilters('In Review', ['Ready for Dev', 'In Review']), true);
  assert.equal(matchesStatusFilters('Backlog', ['Ready for Dev', 'In Review']), false);
  assert.equal(matchesStatusFilters(null, ['Ready for Dev']), false);
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

// ── kinds, ids, describeEvent ───────────────────────────────────────────────

test('every status_changed id satisfies EVENT_ID_RE (the inbox --consume gate)', () => {
  const { EVENT_ID_RE } = require('./event-extract');
  const events = extractStatusChangeEvents({
    key: 'ENG-42',
    changelog: { histories: [{ id: '10001', items: [{ field: 'status', fromString: 'A', toString: 'B' }] }] },
  });
  assert.equal(events.length, 1);
  assert.ok(events.every((e) => EVENT_ID_RE.test(e.id)), events.map((e) => e.id).join(','));
  assert.equal(EVENT_ID_RE.test('ENG-42:1:assignee'), false, 'a second colon is un-consumable');
});

test('describeEvent: status change reads from → to; unknown kinds fall back to the key', () => {
  const { describeEvent } = require('./event-extract');
  assert.equal(describeEvent({ event: 'status_changed', issueKey: 'KAN-6', fromStatus: 'To Do', toStatus: 'Done' }), 'KAN-6: To Do → Done');
  assert.equal(describeEvent({ event: 'mystery', issueKey: 'KAN-6' }), 'KAN-6');
  assert.equal(describeEvent(null), 'event');
});

test('the manifest declares only kinds the broker can produce (events[].name ⊆ KNOWN_EVENTS)', () => {
  const { KNOWN_EVENTS, EVENT_KINDS } = require('./event-extract');
  const manifest = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'plugin.json'), 'utf8'));
  for (const e of manifest.events) assert.ok(KNOWN_EVENTS.includes(e.name), `manifest event ${e.name} is not in KNOWN_EVENTS`);
  for (const k of KNOWN_EVENTS) assert.ok(Array.isArray(EVENT_KINDS[k].rowFields) && EVENT_KINDS[k].label && EVENT_KINDS[k].noun);
});

// ── extractIssueCreatedEvents ───────────────────────────────────────────────

test('extractIssueCreatedEvents: an issue created inside the window → one issue_created event', () => {
  const { extractIssueCreatedEvents, EVENT_ID_RE } = require('./event-extract');
  const events = extractIssueCreatedEvents(
    { key: 'KAN-12', summary: 'New thing', issueType: 'Story', status: 'To Do', reporter: 'Jane', priority: 'High', created: '2026-01-01T11:58:00.000+0000' },
    { projectKey: 'KAN', siteBase: 'https://acme.atlassian.net', windowStartIso: '2026-01-01T11:50:00Z' },
  );
  assert.deepEqual(events, [{
    id: 'KAN-12:created',
    event: 'issue_created',
    issueKey: 'KAN-12',
    projectKey: 'KAN',
    issueType: 'Story',
    summary: 'New thing',
    created: '2026-01-01T11:58:00.000+0000',
    author: 'Jane',
    reporter: 'Jane',
    status: 'To Do',
    priority: 'High',
    origin: 'human',
    issueUrl: 'https://acme.atlassian.net/browse/KAN-12',
  }]);
  assert.ok(EVENT_ID_RE.test(events[0].id));
});

test('extractIssueCreatedEvents: an old issue merely touched inside the window is not "created"', () => {
  const { extractIssueCreatedEvents } = require('./event-extract');
  assert.deepEqual(extractIssueCreatedEvents(
    { key: 'KAN-1', created: '2025-06-01T09:00:00.000+0000' },
    { windowStartIso: '2026-01-01T11:50:00Z' },
  ), []);
});

test('extractIssueCreatedEvents: no parseable created stamp → nothing (never guess an issue is new)', () => {
  const { extractIssueCreatedEvents } = require('./event-extract');
  assert.deepEqual(extractIssueCreatedEvents({ key: 'KAN-1' }, { windowStartIso: '2026-01-01T11:50:00Z' }), []);
  assert.deepEqual(extractIssueCreatedEvents({ key: 'KAN-1', created: 'yesterday' }, {}), []);
  assert.deepEqual(extractIssueCreatedEvents(null, {}), []);
});

test('extractIssueCreatedEvents: origin is agent when the own-writes registry holds the key', () => {
  const { extractIssueCreatedEvents } = require('./event-extract');
  const [ev] = extractIssueCreatedEvents(
    { key: 'KAN-12', created: '2026-01-01T11:58:00Z' },
    { ownWrites: { issues: { 'KAN-12': '2026-01-01T11:57:59Z' } } },
  );
  assert.equal(ev.origin, 'agent');
});

test('describeEvent: issue_created reads "<key> created: <summary>"', () => {
  const { describeEvent } = require('./event-extract');
  assert.equal(describeEvent({ event: 'issue_created', issueKey: 'KAN-12', summary: 'New thing' }), 'KAN-12 created: New thing');
});
