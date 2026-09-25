'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WatchStore, normalizeWatch } = require('./watch-store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-watch-'));
  return new WatchStore({ stateDir: dir });
}

test('normalizeWatch: needs a projectKey; defaults wake to all-granted', () => {
  assert.equal(normalizeWatch({}), null);
  assert.equal(normalizeWatch({ statusFilters: ['Done'] }), null);
  assert.deepEqual(normalizeWatch({ projectKey: ' ENG ' }), { projectKey: 'ENG', events: ['status_changed'], wake: { agentIds: 'all-granted' } });
  assert.deepEqual(normalizeWatch({ projectKey: 'ENG', statusFilters: ['Ready'], wake: { agentIds: ['a', 'b'] } }), {
    projectKey: 'ENG', statusFilters: ['Ready'], events: ['status_changed'], wake: { agentIds: ['a', 'b'] },
  });
});

test('normalizeWatch: statusFilters set is trimmed, de-duplicated, order preserved; all-blank collapses out', () => {
  assert.deepEqual(
    normalizeWatch({ projectKey: 'ENG', statusFilters: [' Ready for Dev ', 'In Review', 'Ready for Dev', ''] }).statusFilters,
    ['Ready for Dev', 'In Review'],
  );
  assert.equal(normalizeWatch({ projectKey: 'ENG', statusFilters: ['', '  '] }).statusFilters, undefined);
});

test('normalizeWatch: a legacy singular statusFilter migrates to a one-element statusFilters', () => {
  assert.deepEqual(
    normalizeWatch({ projectKey: 'ENG', statusFilter: 'Ready for Dev' }),
    { projectKey: 'ENG', statusFilters: ['Ready for Dev'], events: ['status_changed'], wake: { agentIds: 'all-granted' } },
  );
});

test('normalizeWatch: events is an opt-in set — absent/empty/unknown → status_changed; unknown names dropped; KNOWN_EVENTS order', () => {
  const { KNOWN_EVENTS } = require('./event-extract');
  assert.deepEqual(normalizeWatch({ projectKey: 'ENG' }).events, ['status_changed']);
  assert.deepEqual(normalizeWatch({ projectKey: 'ENG', events: [] }).events, ['status_changed']);
  assert.deepEqual(normalizeWatch({ projectKey: 'ENG', events: ['bogus', 42] }).events, ['status_changed']);
  const all = KNOWN_EVENTS.slice().reverse();
  assert.deepEqual(normalizeWatch({ projectKey: 'ENG', events: [...all, 'bogus', all[0]] }).events, KNOWN_EVENTS);
});

test('setConfig: events round-trips through the store', () => {
  const s = tmpStore();
  const { KNOWN_EVENTS } = require('./event-extract');
  s.setConfig('team-1', { watches: [{ projectKey: 'ENG', events: KNOWN_EVENTS }] });
  assert.deepEqual(s.loadConfig('team-1').watches[0].events, KNOWN_EVENTS);
});

test('loadConfig: an untouched scope is an empty config, never a 404', () => {
  const s = tmpStore();
  const cfg = s.loadConfig('team-1');
  assert.deepEqual(cfg.watches, []);
  assert.equal('doorbell' in cfg, false); // the Phase-0 doorbell field is gone
});

test('setConfig: records setBy/setAt and round-trips watches; preserves cursors; ignores a legacy doorbell', () => {
  const s = tmpStore();
  s.saveCursor('team-1', 'https://acme.atlassian.net::ENG', { seen: ['ENG-1:1'], lastPolledAt: 'x' });
  const cfg = s.setConfig('team-1', {
    watches: [{ projectKey: 'ENG', statusFilter: 'Ready for Dev' }],
    doorbell: { url: 'http://host:4003/hooks/a/h', secret: 's3cr3t' }, // Phase-0 leftover — dropped, never persisted
    setBy: 'alice@example.com',
  });
  assert.equal(cfg.setBy, 'alice@example.com');
  assert.ok(cfg.setAt);
  assert.equal(cfg.watches.length, 1);
  assert.equal('doorbell' in cfg, false);
  assert.equal('doorbell' in s.loadConfig('team-1'), false);
  // cursor survived the config rewrite
  assert.deepEqual(s.getCursor('team-1', 'https://acme.atlassian.net::ENG').seen, ['ENG-1:1']);
});

test('listScopes: enumerates every scope with a config file', () => {
  const s = tmpStore();
  s.setConfig('team-1', { watches: [{ projectKey: 'A' }] });
  s.setConfig('team-2', { watches: [{ projectKey: 'B' }] });
  assert.deepEqual(s.listScopes().sort(), ['team-1', 'team-2']);
});

test('saveCursor / getCursor: per <siteUrl>::<projectKey> so the same key on two sites never conflates', () => {
  const s = tmpStore();
  s.saveCursor('team-1', 'https://a.atlassian.net::ENG', { seen: ['x'] });
  s.saveCursor('team-1', 'https://b.atlassian.net::ENG', { seen: ['y'] });
  assert.deepEqual(s.getCursor('team-1', 'https://a.atlassian.net::ENG').seen, ['x']);
  assert.deepEqual(s.getCursor('team-1', 'https://b.atlassian.net::ENG').seen, ['y']);
});

test('teardown: removes the config, idempotent', () => {
  const s = tmpStore();
  s.setConfig('team-1', { watches: [{ projectKey: 'A' }] });
  assert.equal(s.teardown('team-1'), 1);
  assert.equal(s.teardown('team-1'), 0);
  assert.deepEqual(s.loadConfig('team-1').watches, []);
});

test('an invalid scopeId is refused (path-traversal guard)', () => {
  const s = tmpStore();
  assert.throws(() => s.loadConfig('../../etc/passwd'));
  assert.throws(() => s.setConfig('a/b', {}));
});
