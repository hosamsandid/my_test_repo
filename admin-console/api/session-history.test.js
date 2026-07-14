'use strict';

// Unit tests for finished-session enumeration (#544).
// Run: node --test admin-console/api/session-history.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionHistory, deriveFromCorrelationId } = require('./session-history');

// A representative room log: two DM sessions and one github-triggered run,
// interleaved the way the runner appends them (each event tagged with its
// correlationId; wrapper events carry the type metadata).
const events = [
  { ts: '2026-07-14T06:00:00.000Z', type: 'message.received', correlationId: '$dm1', body: 'hi' },
  { ts: '2026-07-14T06:00:01.000Z', type: 'claude.invoke', correlationId: '$dm1' },
  { ts: '2026-07-14T06:00:09.000Z', type: 'message.posted', correlationId: '$dm1' },
  { ts: '2026-07-14T06:05:00.000Z', type: 'trigger.fired', correlationId: 'trigger:pr-review:gh:99', triggerType: 'github-event', triggerId: 'pr-review' },
  { ts: '2026-07-14T06:05:20.000Z', type: 'message.posted', correlationId: 'trigger:pr-review:gh:99' },
  { ts: '2026-07-14T06:10:00.000Z', type: 'message.received', correlationId: '$dm2', body: 'again' },
  { ts: '2026-07-14T06:10:30.000Z', type: 'message.posted', correlationId: '$dm2' },
];

test('groups events by correlationId into one descriptor each', () => {
  const { sessions, total } = buildSessionHistory(events, []);
  assert.equal(total, 3);
  assert.equal(sessions.length, 3);
  const ids = sessions.map(s => s.correlationId).sort();
  assert.deepEqual(ids, ['$dm1', '$dm2', 'trigger:pr-review:gh:99']);
});

test('derives type/label/trigger metadata from wrapper events', () => {
  const { sessions } = buildSessionHistory(events, []);
  const byId = Object.fromEntries(sessions.map(s => [s.correlationId, s]));
  assert.equal(byId['$dm1'].type, 'dm');
  assert.equal(byId['$dm1'].label, 'Direct message');
  const trig = byId['trigger:pr-review:gh:99'];
  assert.equal(trig.type, 'trigger');
  assert.equal(trig.triggerType, 'github-event');
  assert.equal(trig.triggerId, 'pr-review');
  assert.equal(trig.label, 'pr-review');
});

test('start/end times span the first and last event of the group', () => {
  const { sessions } = buildSessionHistory(events, []);
  const dm1 = sessions.find(s => s.correlationId === '$dm1');
  assert.equal(dm1.startedAt, '2026-07-14T06:00:00.000Z');
  assert.equal(dm1.endedAt, '2026-07-14T06:00:09.000Z');
  assert.equal(dm1.eventCount, 3);
});

test('orders sessions most-recent-first by startedAt', () => {
  const { sessions } = buildSessionHistory(events, []);
  assert.deepEqual(
    sessions.map(s => s.correlationId),
    ['$dm2', 'trigger:pr-review:gh:99', '$dm1'],
  );
});

test('excludes currently-active correlationIds', () => {
  const { sessions, total } = buildSessionHistory(events, ['$dm2']);
  assert.equal(total, 2);
  assert.ok(!sessions.some(s => s.correlationId === '$dm2'));
  assert.ok(sessions.some(s => s.correlationId === '$dm1'));
});

test('internal markers without a correlationId are ignored', () => {
  const withMarkers = [
    { ts: '2026-07-14T06:00:00.000Z', type: '_truncated' },
    { type: '_cursor', cursor: 42 },
    ...events,
  ];
  const { total } = buildSessionHistory(withMarkers, []);
  assert.equal(total, 3);
});

test('paginates with limit/offset and reports truncation', () => {
  const page1 = buildSessionHistory(events, [], { limit: 2, offset: 0 });
  assert.equal(page1.sessions.length, 2);
  assert.equal(page1.total, 3);
  assert.equal(page1.truncated, true);
  assert.deepEqual(page1.sessions.map(s => s.correlationId), ['$dm2', 'trigger:pr-review:gh:99']);

  const page2 = buildSessionHistory(events, [], { limit: 2, offset: 2 });
  assert.equal(page2.sessions.length, 1);
  assert.equal(page2.truncated, false);
  assert.equal(page2.sessions[0].correlationId, '$dm1');
});

test('empty / non-array input yields an empty result', () => {
  assert.deepEqual(buildSessionHistory([], []), { sessions: [], total: 0, truncated: false });
  assert.deepEqual(buildSessionHistory(null, []), { sessions: [], total: 0, truncated: false });
});

test('falls back to correlationId prefix when wrapper events are missing', () => {
  // A log tail that captured only the closing rows of each session.
  const tail = [
    { ts: '2026-07-14T07:00:09.000Z', type: 'message.posted', correlationId: '$dmX' },
    { ts: '2026-07-14T07:05:20.000Z', type: 'message.posted', correlationId: 'trigger:nightly:1730000000000' },
    { ts: '2026-07-14T07:06:00.000Z', type: 'message.posted', correlationId: 'handover-dm:1730000000001' },
  ];
  const { sessions } = buildSessionHistory(tail, []);
  const byId = Object.fromEntries(sessions.map(s => [s.correlationId, s]));
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
