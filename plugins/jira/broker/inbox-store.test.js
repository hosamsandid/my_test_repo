'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { InboxStore } = require('./inbox-store');

function tmpStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-inbox-'));
  return new InboxStore({ stateDir: dir, ...opts });
}

const EV = (id) => ({ id, issueKey: id.split(':')[0], toStatus: 'Done' });

test('append / list / count: entries accumulate in insertion order', () => {
  const s = tmpStore();
  s.append('team-1', EV('ENG-1:1'), { triggerId: 't1' });
  s.append('team-1', EV('ENG-2:2'));
  assert.equal(s.count('team-1'), 2);
  assert.deepEqual(s.list('team-1').map((e) => e.event.id), ['ENG-1:1', 'ENG-2:2']);
  assert.equal(s.list('team-1')[0].triggerId, 't1');
});

test('consume: drains and clears', () => {
  const s = tmpStore();
  s.append('team-1', EV('ENG-1:1'));
  const drained = s.consume('team-1');
  assert.equal(drained.length, 1);
  assert.equal(s.count('team-1'), 0);
  assert.deepEqual(s.consume('team-1'), []);
});

test('count cap: appending past maxObjects drops the oldest (ring)', () => {
  const s = tmpStore({ maxObjects: 3 });
  for (let i = 1; i <= 5; i += 1) s.append('team-1', EV(`ENG-${i}:${i}`));
  const ids = s.list('team-1').map((e) => e.event.id);
  assert.deepEqual(ids, ['ENG-3:3', 'ENG-4:4', 'ENG-5:5']);
});

test('TTL: stale entries are reaped on append and by reap()', () => {
  let clock = Date.parse('2026-01-10T00:00:00Z');
  const s = tmpStore({ ttlSeconds: 3600, now: () => clock });
  s.append('team-1', EV('OLD:1'));
  clock += 2 * 3600_000; // +2h — past the 1h TTL
  assert.equal(s.list('team-1').length, 0); // list is TTL-filtered
  s.append('team-1', EV('NEW:2'));           // append reaps first
  assert.deepEqual(s.list('team-1').map((e) => e.event.id), ['NEW:2']);
  assert.equal(s.reap('team-1'), 0);         // nothing stale left
});

test('scopes are isolated; teardown removes one scope only', () => {
  const s = tmpStore();
  s.append('team-1', EV('A:1'));
  s.append('team-2', EV('B:1'));
  assert.equal(s.teardown('team-1'), 1);
  assert.equal(s.count('team-1'), 0);
  assert.equal(s.count('team-2'), 1);
});

test('an invalid scopeId is refused', () => {
  const s = tmpStore();
  assert.throws(() => s.append('../evil', EV('X:1')));
});
