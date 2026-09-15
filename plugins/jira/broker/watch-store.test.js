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
  assert.deepEqual(normalizeWatch({ projectKey: ' ENG ' }), { projectKey: 'ENG', wake: { agentIds: 'all-granted' } });
  assert.deepEqual(normalizeWatch({ projectKey: 'ENG', statusFilters: ['Ready'], wake: { agentIds: ['a', 'b'] } }), {
    projectKey: 'ENG', statusFilters: ['Ready'], wake: { agentIds: ['a', 'b'] },
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
    { projectKey: 'ENG', statusFilters: ['Ready for Dev'], wake: { agentIds: 'all-granted' } },
  );
});

test('loadConfig: an untouched scope is an empty config, never a 404', () => {
  const s = tmpStore();
  const cfg = s.loadConfig('team-1');
  assert.deepEqual(cfg.watches, []);
  assert.equal(cfg.doorbell, null);
});

test('setConfig: records setBy/setAt and round-trips watches + doorbell; preserves cursors', () => {
  const s = tmpStore();
  s.saveCursor('team-1', 'https://acme.atlassian.net::ENG', { seen: ['ENG-1:1'], lastPolledAt: 'x' });
  const cfg = s.setConfig('team-1', {
    watches: [{ projectKey: 'ENG', statusFilter: 'Ready for Dev' }],
    doorbell: { url: 'http://host:4003/hooks/a/h', secret: 's3cr3t' },
    setBy: 'alice@example.com',
  });
  assert.equal(cfg.setBy, 'alice@example.com');
  assert.ok(cfg.setAt);
  assert.equal(cfg.watches.length, 1);
  assert.equal(cfg.doorbell.url, 'http://host:4003/hooks/a/h');
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
