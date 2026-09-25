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

// ── extractFieldChangeEvents ────────────────────────────────────────────────

const fieldIssue = (items, created = '2026-01-01T11:58:00.000+0000') => ({
  key: 'KAN-6', summary: 'S', issueType: 'Story',
  changelog: { histories: [{ id: '10500', created, author: { displayName: 'Jane' }, items }] },
});

test('extractFieldChangeEvents: status + assignee in one history → only the assignee is a field event, with its own id', () => {
  const { extractFieldChangeEvents, EVENT_ID_RE } = require('./event-extract');
  const issue = fieldIssue([
    { field: 'status', fieldtype: 'jira', fieldId: 'status', fromString: 'To Do', toString: 'Done' },
    { field: 'assignee', fieldtype: 'jira', fieldId: 'assignee', fromString: null, toString: 'Bob' },
  ]);
  const events = extractFieldChangeEvents(issue, { projectKey: 'KAN', siteBase: 'https://acme.atlassian.net' });
  assert.deepEqual(events, [{
    id: 'KAN-6:10500.assignee',
    event: 'field_changed',
    issueKey: 'KAN-6',
    projectKey: 'KAN',
    issueType: 'Story',
    summary: 'S',
    created: '2026-01-01T11:58:00.000+0000',
    author: 'Jane',
    field: 'assignee',
    fieldId: 'assignee',
    fieldType: 'jira',
    from: null,
    to: 'Bob',
    origin: 'human',
    issueUrl: 'https://acme.atlassian.net/browse/KAN-6',
  }]);
  assert.ok(EVENT_ID_RE.test(events[0].id));
  // and the status item is still a status event with the history id alone
  assert.deepEqual(extractStatusChangeEvents(issue).map((e) => e.id), ['KAN-6:10500']);
});

test('extractFieldChangeEvents: Rank, description and status are denylisted (field or fieldId, any case)', () => {
  const { extractFieldChangeEvents } = require('./event-extract');
  const events = extractFieldChangeEvents(fieldIssue([
    { field: 'Rank', fieldtype: 'custom', fieldId: 'customfield_10019', fromString: '', toString: 'Ranked higher' },
    { field: 'description', fieldId: 'description', fromString: 'a', toString: 'b' },
    { field: 'Status', fromString: 'A', toString: 'B' },
    { field: 'labels', fieldId: 'labels', fromString: '', toString: 'urgent' },
  ]));
  assert.deepEqual(events.map((e) => e.field), ['labels']);
});

test('extractFieldChangeEvents: a custom field keeps its stable fieldId; ids never carry a second colon', () => {
  const { extractFieldChangeEvents, EVENT_ID_RE } = require('./event-extract');
  const [sprint, weird] = extractFieldChangeEvents(fieldIssue([
    { field: 'Sprint', fieldtype: 'custom', fieldId: 'customfield_10020', fromString: '', toString: 'KAN Sprint 4' },
    { field: 'Fix Version: odd/name', fromString: null, toString: '1.2' }, // no fieldId → slug of the name
  ]));
  assert.equal(sprint.id, 'KAN-6:10500.customfield_10020');
  assert.equal(sprint.fieldType, 'custom');
  assert.equal(sprint.to, 'KAN Sprint 4');
  assert.equal(weird.id, 'KAN-6:10500.Fix_Version_odd_name');
  assert.ok(EVENT_ID_RE.test(sprint.id) && EVENT_ID_RE.test(weird.id));
});

test('extractFieldChangeEvents: long values are clamped', () => {
  const { extractFieldChangeEvents, FIELD_VALUE_MAX } = require('./event-extract');
  const [ev] = extractFieldChangeEvents(fieldIssue([{ field: 'environment', fieldId: 'environment', fromString: null, toString: 'x'.repeat(5000) }]));
  assert.equal(ev.to.length, FIELD_VALUE_MAX);
  assert.ok(ev.to.endsWith('…'));
});

test('resolveFieldOrigin: agent only for a recorded write to the same issue+field close to the history time', () => {
  const { extractFieldChangeEvents, OWN_FIELD_WRITE_SKEW_MS } = require('./event-extract');
  const at = Date.parse('2026-01-01T11:58:00.000Z');
  const own = (key, iso) => ({ fields: { [key]: [iso] } });
  const item = { field: 'Team', fieldtype: 'custom', fieldId: 'customfield_20001', fromString: null, toString: 'Blue' };
  const origin = (ownWrites) => extractFieldChangeEvents(fieldIssue([item]), { ownWrites })[0].origin;
  assert.equal(origin(own('KAN-6|customfield_20001', new Date(at + 3000).toISOString())), 'agent'); // by fieldId
  assert.equal(origin(own('KAN-6|team', new Date(at - 1000).toISOString())), 'agent'); // by case-folded name
  assert.equal(origin(own('KAN-6|customfield_20001', new Date(at + OWN_FIELD_WRITE_SKEW_MS + 1000).toISOString())), 'human'); // too far apart
  assert.equal(origin(own('KAN-7|customfield_20001', new Date(at).toISOString())), 'human'); // another issue
  assert.equal(origin(null), 'human');
});

test('describeEvent: field_changed reads "<key>: <field> <from> → <to>" with ∅ for a missing side', () => {
  const { describeEvent } = require('./event-extract');
  assert.equal(describeEvent({ event: 'field_changed', issueKey: 'KAN-6', field: 'assignee', from: null, to: 'Bob' }), 'KAN-6: assignee ∅ → Bob');
});

// ── comment_added ───────────────────────────────────────────────────────────

const adf = (...paras) => ({ type: 'doc', version: 1, content: paras.map((p) => (typeof p === 'string' ? { type: 'paragraph', content: [{ type: 'text', text: p }] } : p)) });
const commentIssue = (comments, total) => ({
  key: 'KAN-6', summary: 'S', issueType: 'Story',
  comment: { total: total == null ? comments.length : total, comments },
});
const cmt = (id, created, body, author = 'Jane') => ({ id, created, author: { displayName: author }, body });

test('adfToText: paragraphs, hard breaks, mentions, lists and code blocks flatten to readable text', () => {
  const { adfToText } = require('./event-extract');
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { id: 'x', text: '@Bob' } }, { type: 'text', text: ',' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' }] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
    ] },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'x = 1' }] },
    { type: 'paragraph', content: [{ type: 'mention', attrs: { text: 'Carol' } }, { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } }] },
  ] };
  assert.equal(adfToText(doc), 'Hi @Bob,\nsecond line\n- one\n- two\nx = 1\n@Carol😄');
  assert.equal(adfToText(null), '');
  assert.equal(adfToText({ type: 'weird', content: 'nope' }), 'nope');
});

test('extractCommentEvents: one event per comment inside the window; id <key>:c<id>; body flattened', () => {
  const { extractCommentEvents, EVENT_ID_RE } = require('./event-extract');
  const events = extractCommentEvents(commentIssue([
    cmt('100', '2025-12-01T09:00:00.000+0000', adf('old')),
    cmt('101', '2026-01-01T11:58:00.000+0000', adf('Is this', 'ready?')),
  ]), { projectKey: 'KAN', siteBase: 'https://acme.atlassian.net', windowStartIso: '2026-01-01T11:50:00Z' });
  assert.deepEqual(events, [{
    id: 'KAN-6:c101',
    event: 'comment_added',
    issueKey: 'KAN-6',
    projectKey: 'KAN',
    issueType: 'Story',
    summary: 'S',
    created: '2026-01-01T11:58:00.000+0000',
    author: 'Jane',
    commentId: '101',
    body: 'Is this\nready?',
    origin: 'human',
    issueUrl: 'https://acme.atlassian.net/browse/KAN-6?focusedCommentId=101',
  }]);
  assert.ok(EVENT_ID_RE.test(events[0].id));
});

test('extractCommentEvents: origin — registry → agent; marker only → agent (body without the marker); same account, plain → human', () => {
  const { extractCommentEvents, AGENT_COMMENT_MARKER } = require('./event-extract');
  const marked = adf({ type: 'paragraph', content: [{ type: 'text', text: `${AGENT_COMMENT_MARKER} "team-1" via Agent Studio.`, marks: [{ type: 'em' }] }] }, 'Refined the ACs.');
  const events = extractCommentEvents(commentIssue([
    cmt('201', '2026-01-01T11:58:00Z', adf('registered'), 'Admin'),
    cmt('202', '2026-01-01T11:58:10Z', marked, 'Admin'),
    cmt('203', '2026-01-01T11:58:20Z', adf('typed by the admin'), 'Admin'),
  ]), { ownWrites: { comments: { 'KAN-6:c201': '2026-01-01T11:58:00Z' } } });
  assert.deepEqual(events.map((e) => [e.commentId, e.origin]), [['201', 'agent'], ['202', 'agent'], ['203', 'human']]);
  assert.equal(events[1].body, 'Refined the ACs.');
});

test('extractCommentEvents: body clamp + bodyTruncated as a string', () => {
  const { extractCommentEvents, COMMENT_BODY_MAX } = require('./event-extract');
  const [long, short] = extractCommentEvents(commentIssue([
    cmt('301', '2026-01-01T11:58:00Z', adf('y'.repeat(COMMENT_BODY_MAX + 50))),
    cmt('302', '2026-01-01T11:58:00Z', adf('short')),
  ]));
  assert.equal(long.body.length, COMMENT_BODY_MAX);
  assert.equal(long.bodyTruncated, 'true');
  assert.equal('bodyTruncated' in short, false);
});

test('extractCommentEvents: no comment field / no created stamp → nothing', () => {
  const { extractCommentEvents } = require('./event-extract');
  assert.deepEqual(extractCommentEvents({ key: 'KAN-6' }), []);
  assert.deepEqual(extractCommentEvents(commentIssue([cmt('1', undefined, adf('x'))])), []);
});

test('isCommentListTruncated: total beyond the inlined list', () => {
  const { isCommentListTruncated } = require('./event-extract');
  assert.equal(isCommentListTruncated({ total: 30, comments: [{}] }), true);
  assert.equal(isCommentListTruncated({ total: 1, comments: [{}] }), false);
  assert.equal(isCommentListTruncated(null), false);
});

test('describeEvent: comment_added names author and origin', () => {
  const { describeEvent } = require('./event-extract');
  assert.equal(describeEvent({ event: 'comment_added', issueKey: 'KAN-6', author: 'Jane', origin: 'human' }), 'KAN-6: comment by Jane (human)');
});
