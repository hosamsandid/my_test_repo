'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ActivityStore } = require('./activity-store');

function tmpStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-activity-'));
  return new ActivityStore({ stateDir: dir, ...opts });
}

const ev = (id, over = {}) => ({
  id, issueKey: id.split(':')[0], projectKey: 'ENG', issueType: 'Story',
  summary: `${id} summary`, fromStatus: 'A', toStatus: 'B', author: 'Jane',
  created: '2026-01-01T12:00:00Z', issueUrl: `https://acme.atlassian.net/browse/${id.split(':')[0]}`,
  payload: { huge: 'x'.repeat(1000) }, ...over,
});

test('append: shapes the event (drops payload), defaults the outcome, stamps at', () => {
  const s = tmpStore();
  s.append('team-1', { event: ev('ENG-1:1') });
  const [row] = s.list('team-1');
  assert.equal(row.outcome, 'delivered');
  assert.ok(row.at);
  assert.equal(row.event.summary, 'ENG-1:1 summary');
  assert.equal(row.event.issueType, 'Story');
  assert.equal(row.event.payload, undefined); // narrowed
});

test('append: takes an array; list is newest-first and honours a limit', () => {
  const s = tmpStore();
  s.append('team-1', [
    { event: ev('ENG-1:1'), outcome: 'baseline' },
    { event: ev('ENG-2:2'), outcome: 'delivered' },
    { event: ev('ENG-3:3'), outcome: 'throttled', detail: '6/5 per hour' },
  ]);
  const rows = s.list('team-1');
  assert.deepEqual(rows.map((r) => r.event.id), ['ENG-3:3', 'ENG-2:2', 'ENG-1:1']);
  assert.equal(rows[0].detail, '6/5 per hour');
  assert.deepEqual(s.list('team-1', { limit: 1 }).map((r) => r.event.id), ['ENG-3:3']);
});

test('append: TTL reaps rows older than the retention window', () => {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const s = tmpStore({ retentionMs: 24 * 3600 * 1000, now: () => clock });
  s.append('team-1', { event: ev('OLD:1') });
  clock += 48 * 3600 * 1000; // two days later
  s.append('team-1', { event: ev('NEW:1') });
  assert.deepEqual(s.list('team-1').map((r) => r.event.id), ['NEW:1']);
  assert.equal(s.count('team-1'), 1);
});

test('append: past the row cap drops the oldest (a ring)', () => {
  const s = tmpStore({ maxRows: 3 });
  for (let i = 1; i <= 6; i += 1) s.append('team-1', { event: ev(`ENG-${i}:${i}`) });
  assert.deepEqual(s.list('team-1').map((r) => r.event.id), ['ENG-6:6', 'ENG-5:5', 'ENG-4:4']);
});

test('reap: rewrites only when something expired; returns the count removed', () => {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const s = tmpStore({ retentionMs: 3600 * 1000, now: () => clock });
  s.append('team-1', { event: ev('A:1') });
  assert.equal(s.reap('team-1'), 0);
  clock += 2 * 3600 * 1000;
  assert.equal(s.reap('team-1'), 1);
  assert.equal(s.count('team-1'), 0);
});

test('scopes are isolated; teardown removes the log and is idempotent', () => {
  const s = tmpStore();
  s.append('team-1', { event: ev('ENG-1:1') });
  s.append('team-2', { event: ev('OPS-1:1') });
  assert.equal(s.list('team-2').length, 1);
  assert.equal(s.list('team-1')[0].event.issueKey, 'ENG-1');
  assert.equal(s.teardown('team-1'), 1);
  assert.equal(s.teardown('team-1'), 0);
  assert.equal(s.list('team-1').length, 0);
});

test('an invalid scopeId is refused (path-traversal guard)', () => {
  const s = tmpStore();
  assert.throws(() => s.list('../../etc/passwd'));
  assert.throws(() => s.append('a/b', { event: ev('X:1') }));
});

test('append: a row keeps the event kind and that kind\'s own fields only', () => {
  const s = tmpStore();
  s.append('team-1', { event: ev('ENG-1:1', { event: 'status_changed', body: 'not a status field' }) });
  const [row] = s.list('team-1');
  assert.equal(row.event.event, 'status_changed');
  assert.equal(row.event.fromStatus, 'A');
  assert.equal(row.event.toStatus, 'B');
  assert.equal('body' in row.event, false);
});

test('append: an event without a kind (pre-kinds shape) keeps the status fields', () => {
  const s = tmpStore();
  s.append('team-1', { event: ev('ENG-1:1') });
  const [row] = s.list('team-1');
  assert.equal(row.event.event, null);
  assert.equal(row.event.toStatus, 'B');
});
