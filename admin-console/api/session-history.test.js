'use strict';

// Unit tests for finished-session enumeration (#544, regrouped by Claude
// session-ID in #555).
// Run: node --test admin-console/api/session-history.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionHistory, deriveFromCorrelationId, findResumableSession } = require('./session-history');

// A representative room log. Two manual DM messages ($dm1, $dm2) are handled
// within ONE Claude session (sess-A, reused via --resume), so they must group
// into a single finished entry. A github-triggered per-invocation run has its
// own fresh session (sess-B). Each run's session-ID rides only on its
// system_init/result rows; wrapper rows carry only the correlationId.
const events = [
  { ts: '2026-07-14T06:00:00.000Z', type: 'message.received', correlationId: '$dm1', body: 'hi' },
  { ts: '2026-07-14T06:00:01.000Z', type: 'system_init', correlationId: '$dm1', sessionId: 'sess-A' },
  { ts: '2026-07-14T06:00:09.000Z', type: 'result', correlationId: '$dm1', sessionId: 'sess-A' },
  { ts: '2026-07-14T06:00:09.500Z', type: 'message.posted', correlationId: '$dm1' },
  { ts: '2026-07-14T06:05:00.000Z', type: 'trigger.fired', correlationId: 'trigger:pr-review:gh:99', triggerType: 'github-event', triggerId: 'pr-review' },
  { ts: '2026-07-14T06:05:01.000Z', type: 'system_init', correlationId: 'trigger:pr-review:gh:99', sessionId: 'sess-B' },
  { ts: '2026-07-14T06:05:20.000Z', type: 'message.posted', correlationId: 'trigger:pr-review:gh:99' },
  { ts: '2026-07-14T06:10:00.000Z', type: 'message.received', correlationId: '$dm2', body: 'again' },
  { ts: '2026-07-14T06:10:10.000Z', type: 'result', correlationId: '$dm2', sessionId: 'sess-A' },
  { ts: '2026-07-14T06:10:30.000Z', type: 'message.posted', correlationId: '$dm2' },
];

test('groups runs that share a session-ID into one entry (AC1)', () => {
  const { sessions, total } = buildSessionHistory(events, []);
  assert.equal(total, 2); // sess-A (two messages) + sess-B (one trigger run)
  const bySid = Object.fromEntries(sessions.map(s => [s.sessionId, s]));
  assert.deepEqual(bySid['sess-A'].correlationIds, ['$dm1', '$dm2']);
  assert.equal(bySid['sess-A'].runCount, 2);
  assert.deepEqual(bySid['sess-B'].correlationIds, ['trigger:pr-review:gh:99']);
  assert.equal(bySid['sess-B'].runCount, 1);
});

test('session id + eventCount reflect the whole session', () => {
  const { sessions } = buildSessionHistory(events, []);
  const a = sessions.find(s => s.sessionId === 'sess-A');
  assert.equal(a.id, 'sess-A');
  assert.equal(a.eventCount, 7); // 4 rows of $dm1 + 3 rows of $dm2
});

test('start/end span the first and last run of the whole session (AC3)', () => {
  const { sessions } = buildSessionHistory(events, []);
  const a = sessions.find(s => s.sessionId === 'sess-A');
  assert.equal(a.startedAt, '2026-07-14T06:00:00.000Z'); // start of $dm1
  assert.equal(a.endedAt, '2026-07-14T06:10:30.000Z');   // end of $dm2
});

test('source label represents the opening (earliest) run (AC5 edge case)', () => {
  // A trigger resumes the DM session on a persistent agent: same session-ID,
  // mixed origin. The entry should read as it began — a DM.
  const mixed = [
    { ts: '2026-07-14T08:00:00.000Z', type: 'message.received', correlationId: '$open' },
    { ts: '2026-07-14T08:00:01.000Z', type: 'system_init', correlationId: '$open', sessionId: 'sess-M' },
    { ts: '2026-07-14T08:00:05.000Z', type: 'result', correlationId: '$open', sessionId: 'sess-M' },
    { ts: '2026-07-14T08:05:00.000Z', type: 'trigger.fired', correlationId: 'trigger:nightly:1', triggerType: 'cron', triggerId: 'nightly' },
    { ts: '2026-07-14T08:05:02.000Z', type: 'result', correlationId: 'trigger:nightly:1', sessionId: 'sess-M' },
  ];
  const { sessions, total } = buildSessionHistory(mixed, []);
  assert.equal(total, 1);
  const s = sessions[0];
  assert.equal(s.sessionId, 'sess-M');
  assert.equal(s.type, 'dm');
  assert.equal(s.label, 'Direct message');
  assert.equal(s.runCount, 2);
});

test('a distinct session-ID stays a separate entry (AC4)', () => {
  // Same room, a Reset between two DMs → two different session-IDs.
  const reset = [
    { ts: '2026-07-14T09:00:00.000Z', type: 'message.received', correlationId: '$before' },
    { ts: '2026-07-14T09:00:02.000Z', type: 'result', correlationId: '$before', sessionId: 'sess-1' },
    { ts: '2026-07-14T09:30:00.000Z', type: 'message.received', correlationId: '$after' },
    { ts: '2026-07-14T09:30:02.000Z', type: 'result', correlationId: '$after', sessionId: 'sess-2' },
  ];
  const { sessions, total } = buildSessionHistory(reset, []);
  assert.equal(total, 2);
  assert.deepEqual(sessions.map(s => s.sessionId).sort(), ['sess-1', 'sess-2']);
});

test('excludes a session when any of its runs is currently active (AC7)', () => {
  // sess-A's second run ($dm2) is still running → the whole session is active
  // and must not also appear as a finished entry.
  const { sessions, total } = buildSessionHistory(events, ['$dm2']);
  assert.equal(total, 1);
  assert.ok(!sessions.some(s => s.sessionId === 'sess-A'));
  assert.ok(sessions.some(s => s.sessionId === 'sess-B'));
});

test('a run with no observed session-ID still appears as a fallback entry (AC6)', () => {
  // Early error before any system_init: no sessionId, must not be dropped.
  const early = [
    { ts: '2026-07-14T10:00:00.000Z', type: 'message.received', correlationId: '$err' },
    { ts: '2026-07-14T10:00:01.000Z', type: 'error', correlationId: '$err', error: 'boom' },
  ];
  const { sessions, total } = buildSessionHistory(early, []);
  assert.equal(total, 1);
  assert.equal(sessions[0].sessionId, null);
  assert.equal(sessions[0].id, '$err');
  assert.deepEqual(sessions[0].correlationIds, ['$err']);
  assert.equal(sessions[0].type, 'dm');
});

test('two session-less runs stay separate (keyed by correlationId)', () => {
  const early = [
    { ts: '2026-07-14T10:00:00.000Z', type: 'message.received', correlationId: '$e1' },
    { ts: '2026-07-14T10:05:00.000Z', type: 'message.received', correlationId: '$e2' },
  ];
  const { total } = buildSessionHistory(early, []);
  assert.equal(total, 2);
});

test('orders sessions most-recent-first by last activity (endedAt)', () => {
  const { sessions } = buildSessionHistory(events, []);
  // sess-A ends 06:10:30, sess-B ends 06:05:20 → sess-A first.
  assert.deepEqual(sessions.map(s => s.sessionId), ['sess-A', 'sess-B']);
});

test('derives type/label/trigger metadata from wrapper events', () => {
  const { sessions } = buildSessionHistory(events, []);
  const trig = sessions.find(s => s.sessionId === 'sess-B');
  assert.equal(trig.type, 'trigger');
  assert.equal(trig.triggerType, 'github-event');
  assert.equal(trig.triggerId, 'pr-review');
  assert.equal(trig.label, 'pr-review');
});

test('internal markers without a correlationId are ignored', () => {
  const withMarkers = [
    { ts: '2026-07-14T06:00:00.000Z', type: '_truncated' },
    { type: '_cursor', cursor: 42 },
    ...events,
  ];
  const { total } = buildSessionHistory(withMarkers, []);
  assert.equal(total, 2);
});

test('paginates over grouped sessions and reports truncation (AC8)', () => {
  const page1 = buildSessionHistory(events, [], { limit: 1, offset: 0 });
  assert.equal(page1.sessions.length, 1);
  assert.equal(page1.total, 2);
  assert.equal(page1.truncated, true);
  assert.equal(page1.sessions[0].sessionId, 'sess-A');

  const page2 = buildSessionHistory(events, [], { limit: 1, offset: 1 });
  assert.equal(page2.sessions.length, 1);
  assert.equal(page2.truncated, false);
  assert.equal(page2.sessions[0].sessionId, 'sess-B');
});

test('empty / non-array input yields an empty result', () => {
  assert.deepEqual(buildSessionHistory([], []), { sessions: [], total: 0, truncated: false });
  assert.deepEqual(buildSessionHistory(null, []), { sessions: [], total: 0, truncated: false });
});

test('falls back to correlationId prefix when wrapper events are missing', () => {
  // A log tail that captured only the closing rows of each session, no
  // system_init/result → session-less fallback entries keyed by correlationId.
  const tail = [
    { ts: '2026-07-14T07:00:09.000Z', type: 'message.posted', correlationId: '$dmX' },
    { ts: '2026-07-14T07:05:20.000Z', type: 'message.posted', correlationId: 'trigger:nightly:1730000000000' },
    { ts: '2026-07-14T07:06:00.000Z', type: 'message.posted', correlationId: 'handover-dm:1730000000001' },
  ];
  const { sessions } = buildSessionHistory(tail, []);
  const byId = Object.fromEntries(sessions.map(s => [s.id, s]));
  assert.equal(byId['$dmX'].type, 'dm');
  assert.equal(byId['$dmX'].label, 'Direct message');
  assert.equal(byId['trigger:nightly:1730000000000'].type, 'trigger');
  assert.equal(byId['trigger:nightly:1730000000000'].triggerId, 'nightly');
  assert.equal(byId['handover-dm:1730000000001'].type, 'handover');
});

test('deriveFromCorrelationId maps known prefixes', () => {
  assert.equal(deriveFromCorrelationId('$abc').type, 'dm');
  assert.equal(deriveFromCorrelationId('trigger:foo:123').type, 'trigger');
  assert.equal(deriveFromCorrelationId('trigger:foo:123').triggerId, 'foo');
  assert.equal(deriveFromCorrelationId('claim-suggest:1').type, 'claim-suggest');
  assert.equal(deriveFromCorrelationId('weird').type, 'unknown');
  assert.equal(deriveFromCorrelationId('').type, 'unknown');
});

// ─── findResumableSession (#574) ──────────────────────────────────────────

// A room log with: a finished DM session (sess-A, two messages), a finished
// github-triggered session (sess-B), and an active DM session (sess-C).
function resumeFixture() {
  return [
    // finished DM session sess-A
    { ts: '2026-07-14T06:00:00.000Z', type: 'message.received', correlationId: '$dm1' },
    { ts: '2026-07-14T06:00:01.000Z', type: 'system_init', sessionId: 'sess-A', correlationId: '$dm1' },
    { ts: '2026-07-14T06:00:05.000Z', type: 'result', sessionId: 'sess-A', correlationId: '$dm1' },
    { ts: '2026-07-14T06:10:00.000Z', type: 'message.received', correlationId: '$dm2' },
    { ts: '2026-07-14T06:10:05.000Z', type: 'result', sessionId: 'sess-A', correlationId: '$dm2' },
    // finished triggered session sess-B
    { ts: '2026-07-14T07:00:00.000Z', type: 'trigger.fired', triggerType: 'github-event', triggerId: 'pr', correlationId: 'trigger:pr:1' },
    { ts: '2026-07-14T07:00:02.000Z', type: 'result', sessionId: 'sess-B', correlationId: 'trigger:pr:1' },
    // active DM session sess-C (correlationId $dm3 is in the active set)
    { ts: '2026-07-14T08:00:00.000Z', type: 'message.received', correlationId: '$dm3' },
    { ts: '2026-07-14T08:00:01.000Z', type: 'system_init', sessionId: 'sess-C', correlationId: '$dm3' },
  ];
}

test('findResumableSession: returns a finished DM session by session-ID', () => {
  const s = findResumableSession(resumeFixture(), [], 'sess-A');
  assert.ok(s);
  assert.equal(s.sessionId, 'sess-A');
  assert.equal(s.type, 'dm');
  // Both DM runs collapse into the one resumable session.
  assert.deepEqual(s.correlationIds.sort(), ['$dm1', '$dm2']);
});

test('findResumableSession: a triggered (non-DM) session is NOT resumable', () => {
  assert.equal(findResumableSession(resumeFixture(), [], 'sess-B'), null);
});

test('findResumableSession: an active session is NOT resumable', () => {
  // sess-C is still running ($dm3 active) so it is excluded from history.
  assert.equal(findResumableSession(resumeFixture(), ['$dm3'], 'sess-C'), null);
});

test('findResumableSession: unknown / malformed session-ID → null', () => {
  assert.equal(findResumableSession(resumeFixture(), [], 'no-such'), null);
  assert.equal(findResumableSession(resumeFixture(), [], ''), null);
  assert.equal(findResumableSession(resumeFixture(), [], null), null);
  assert.equal(findResumableSession(resumeFixture(), [], undefined), null);
});
