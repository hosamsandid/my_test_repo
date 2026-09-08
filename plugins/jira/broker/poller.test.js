'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JiraPoller } = require('./poller');
const { WatchStore } = require('./watch-store');
const { InboxStore } = require('./inbox-store');

// A fake Jira: one project's issues keyed by call, driven per test.
function fakeFetch(script) {
  const orig = global.fetch;
  let n = 0;
  global.fetch = async (url, opts) => {
    n += 1;
    const step = script(url, opts, n);
    return {
      ok: step.status ? step.status < 400 : true,
      status: step.status || 200,
      text: async () => JSON.stringify(step.body || {}),
    };
  };
  return () => { global.fetch = orig; };
}

function harness(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-poll-'));
  const watchStore = new WatchStore({ stateDir: dir });
  const inboxStore = new InboxStore({ stateDir: dir, ...(opts.inbox || {}) });
  const delivered = [];
  const poller = new JiraPoller({
    watchStore,
    inboxStore,
    resolveCredential: () => ({ siteUrl: 'acme', email: 'bot@acme.com', apiToken: 'tok' }),
    deliver: async (payload) => { delivered.push(payload); },
    env: { JIRA_API_BASE: 'http://fake-jira:8080' },
    throttleStatePath: path.join(dir, 'throttle.json'),
    now: opts.now || (() => Date.parse('2026-01-01T12:00:00Z')),
    ...opts.poller,
  });
  return { dir, watchStore, inboxStore, poller, delivered };
}

const issue = (key, histories) => ({ key, fields: { summary: `${key} summary` }, changelog: { histories } });
const statusHistory = (id, from, to, created) => ({ id, created, author: { displayName: 'Jane' }, items: [{ field: 'status', fromString: from, toString: to }] });

test('first poll baselines — records seen ids, fires nothing', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'ENG' }] });
  const restore = fakeFetch(() => ({ body: { isLast: true, issues: [issue('ENG-1', [statusHistory('100', 'To Do', 'In Progress', '2026-01-01T11:59:00Z')])] } }));
  try {
    await h.poller._tick();
  } finally { restore(); }
  assert.equal(h.delivered.length, 0);
  assert.deepEqual(h.watchStore.getCursor('team-1', 'acme::ENG').seen, ['ENG-1:100']);
});

test('a fresh status change after baseline is delivered and lands in the inbox', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'ENG' }] });
  h.watchStore.saveCursor('team-1', 'acme::ENG', { seen: ['ENG-1:100'], lastPolledAt: '2026-01-01T11:55:00Z' });
  const restore = fakeFetch(() => ({ body: { isLast: true, issues: [issue('ENG-1', [
    statusHistory('100', 'To Do', 'In Progress', '2026-01-01T11:59:00Z'),   // seen
    statusHistory('101', 'In Progress', 'Ready for Dev', '2026-01-01T11:59:30Z'), // fresh
  ])] } }));
  try {
    await h.poller._tick();
  } finally { restore(); }
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].kind, 'events');
  assert.equal(h.delivered[0].events[0].id, 'ENG-1:101');
  assert.equal(h.delivered[0].events[0].toStatus, 'Ready for Dev');
  assert.deepEqual(h.inboxStore.list('team-1').map((e) => e.event.id), ['ENG-1:101']);
});

test('statusFilter gates: only transitions INTO the wanted status fire', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'ENG', statusFilter: 'Ready for Dev' }] });
  h.watchStore.saveCursor('team-1', 'acme::ENG', { seen: [], lastPolledAt: '2026-01-01T11:55:00Z' });
  const restore = fakeFetch(() => ({ body: { isLast: true, issues: [issue('ENG-1', [
    statusHistory('201', 'To Do', 'In Progress', '2026-01-01T11:58:00Z'),
    statusHistory('202', 'In Progress', 'Ready for Dev', '2026-01-01T11:59:00Z'),
  ])] } }));
  try { await h.poller._tick(); } finally { restore(); }
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].events[0].id, 'ENG-1:202');
});

test('a burst over the cap collapses into one digest; every event is still in the inbox (lossless)', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'ENG' }] });
  h.watchStore.saveCursor('team-1', 'acme::ENG', { seen: [], lastPolledAt: '2026-01-01T11:00:00Z' });
  const histories = [1, 2, 3, 4, 5].map((i) => statusHistory(`30${i}`, 'A', 'B', `2026-01-01T11:0${i}:00Z`));
  const restore = fakeFetch(() => ({ body: { isLast: true, issues: [issue('ENG-7', histories)] } }));
  try { await h.poller._tick(); } finally { restore(); }
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].kind, 'digest');
  assert.equal(h.delivered[0].events.length, 5);
  assert.equal(h.inboxStore.count('team-1'), 5);
});

test('an issue returned with no inline changelog is backfilled via /issue/:key/changelog', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'ENG' }] });
  h.watchStore.saveCursor('team-1', 'acme::ENG', { seen: [], lastPolledAt: '2026-01-01T11:55:00Z' });
  const restore = fakeFetch((url) => {
    if (url.includes('/search/jql')) {
      return { body: { isLast: true, issues: [{ key: 'ENG-1', fields: { summary: 'no inline log' } }] } }; // no changelog key
    }
    // the per-issue changelog backfill
    return { body: { isLast: true, values: [
      { id: '900', created: '2026-01-01T11:59:00Z', items: [{ field: 'status', fromString: 'A', toString: 'B' }] },
    ] } };
  });
  try { await h.poller._tick(); } finally { restore(); }
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].events[0].id, 'ENG-1:900');
});

test('a search failure sets an exponential backoff on the cursor and fires nothing', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'ENG' }] });
  h.watchStore.saveCursor('team-1', 'acme::ENG', { seen: [], lastPolledAt: '2026-01-01T11:55:00Z' });
  const restore = fakeFetch(() => ({ status: 500, body: { error: 'boom' } }));
  try { await h.poller._tick(); } finally { restore(); }
  assert.equal(h.delivered.length, 0);
  const cur = h.watchStore.getCursor('team-1', 'acme::ENG');
  assert.equal(cur.consecutiveFailures, 1);
  assert.ok(Date.parse(cur.skipUntil) > Date.parse('2026-01-01T12:00:00Z'));
});

test('a project in backoff is skipped until skipUntil passes', async () => {
  let clock = Date.parse('2026-01-01T12:00:00Z');
  const h = harness({ now: () => clock });
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'ENG' }] });
  h.watchStore.saveCursor('team-1', 'acme::ENG', { seen: [], skipUntil: '2026-01-01T12:30:00Z' });
  let called = 0;
  const restore = fakeFetch(() => { called += 1; return { body: { isLast: true, issues: [] } }; });
  try {
    await h.poller._tick();               // still in backoff → no fetch
    assert.equal(called, 0);
    clock = Date.parse('2026-01-01T13:00:00Z');
    await h.poller._tick();               // backoff elapsed → fetch happens
    assert.equal(called, 1);
  } finally { restore(); }
});

test('the two scopes with the same project key on the same site stay isolated cursors', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'ENG' }] });
  h.watchStore.setConfig('team-2', { watches: [{ projectKey: 'ENG' }] });
  h.watchStore.saveCursor('team-1', 'acme::ENG', { seen: ['ENG-1:100'], lastPolledAt: '2026-01-01T11:55:00Z' });
  // team-2 has no cursor → it baselines while team-1 fires
  const restore = fakeFetch(() => ({ body: { isLast: true, issues: [issue('ENG-1', [statusHistory('101', 'A', 'B', '2026-01-01T11:59:00Z')])] } }));
  try { await h.poller._tick(); } finally { restore(); }
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].scopeId, 'team-1');
  assert.equal(h.watchStore.getCursor('team-2', 'acme::ENG').seen.length, 1); // baselined, no fire
});
