'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JiraPoller } = require('./poller');
const { WatchStore } = require('./watch-store');
const { InboxStore } = require('./inbox-store');
const { ActivityStore } = require('./activity-store');
const { deriveWatchHealth } = require('./watch-health');

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
  const activityStore = new ActivityStore({ stateDir: dir, now: opts.now });
  const delivered = [];
  const poller = new JiraPoller({
    watchStore,
    inboxStore,
    activityStore,
    resolveCredential: opts.resolveCredential || (() => ({ siteUrl: 'acme', email: 'bot@acme.com', apiToken: 'tok' })),
    deliver: async (payload) => { delivered.push(payload); },
    env: { JIRA_API_BASE: 'http://fake-jira:8080' },
    throttleStatePath: path.join(dir, 'throttle.json'),
    now: opts.now || (() => Date.parse('2026-01-01T12:00:00Z')),
    ...opts.poller,
  });
  return { dir, watchStore, inboxStore, activityStore, poller, delivered };
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

test('multi-status watch: a transition into ANY configured status fires; others are recorded filtered', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'ENG', statusFilters: ['Ready for Dev', 'In Review'] }] });
  h.watchStore.saveCursor('team-1', 'acme::ENG', { seen: [], lastPolledAt: '2026-01-01T11:55:00Z' });
  const restore = fakeFetch(() => ({ body: { isLast: true, issues: [issue('ENG-1', [
    statusHistory('301', 'To Do', 'In Progress', '2026-01-01T11:58:00Z'),      // not watched
    statusHistory('302', 'In Progress', 'Ready for Dev', '2026-01-01T11:58:30Z'), // watched
    statusHistory('303', 'Ready for Dev', 'In Review', '2026-01-01T11:59:00Z'),   // watched
  ])] } }));
  try { await h.poller._tick(); } finally { restore(); }
  assert.deepEqual(h.delivered.flatMap((d) => d.events.map((e) => e.id)).sort(), ['ENG-1:302', 'ENG-1:303']);
  const rows = h.activityStore.list('team-1');
  const byOutcome = (o) => rows.filter((r) => r.outcome === o).map((r) => r.event.id).sort();
  assert.deepEqual(byOutcome('delivered'), ['ENG-1:302', 'ENG-1:303']);
  assert.deepEqual(byOutcome('filtered'), ['ENG-1:301']);
});

test('activity log: a delivered event carries the issue summary + type; a digest is recorded as digested', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'ENG' }] });
  h.watchStore.saveCursor('team-1', 'acme::ENG', { seen: [], lastPolledAt: '2026-01-01T11:55:00Z' });
  const restore = fakeFetch(() => ({ body: { isLast: true, issues: [{
    key: 'ENG-4', fields: { summary: 'Fix the thing', issuetype: { name: 'Bug' } },
    changelog: { histories: [statusHistory('401', 'A', 'B', '2026-01-01T11:59:00Z')] },
  }] } }));
  try { await h.poller._tick(); } finally { restore(); }
  const [row] = h.activityStore.list('team-1');
  assert.equal(row.outcome, 'delivered');
  assert.equal(row.event.summary, 'Fix the thing');
  assert.equal(row.event.issueType, 'Bug');
});

test('a search failure appends a timestamped error to the cursor ring; a later success clears the failure but keeps the ring', async () => {
  let clock = Date.parse('2026-01-01T12:00:00Z');
  const h = harness({ now: () => clock });
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'ENG' }] });
  h.watchStore.saveCursor('team-1', 'acme::ENG', { seen: [], lastPolledAt: '2026-01-01T11:55:00Z' });

  let restore = fakeFetch(() => ({ status: 401, body: { error: 'nope' } }));
  try { await h.poller._tick(); } finally { restore(); }
  let cur = h.watchStore.getCursor('team-1', 'acme::ENG');
  assert.equal(cur.consecutiveFailures, 1);
  assert.equal(cur.recentErrors.length, 1);
  assert.match(cur.recentErrors[0].message, /401/);
  assert.ok(cur.recentErrors[0].at);
  assert.equal(deriveWatchHealth(cur, clock).status, 'failing');

  // backoff elapses, next poll succeeds
  clock = Date.parse('2026-01-01T13:00:00Z');
  restore = fakeFetch(() => ({ body: { isLast: true, issues: [] } }));
  try { await h.poller._tick(); } finally { restore(); }
  cur = h.watchStore.getCursor('team-1', 'acme::ENG');
  assert.equal(cur.consecutiveFailures, 0);
  assert.equal(cur.skipUntil, undefined);
  assert.equal(cur.recentErrors.length, 1);                 // ring kept
  assert.equal(deriveWatchHealth(cur, clock).status, 'degraded'); // recovered within the hour
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

// ── F3: a touched issue must not re-fire its OLD transitions ────────────────
//
// The JQL window selects issues by `updated`, but every returned issue carries
// its WHOLE changelog. Seen-id dedup alone cannot tell "new transition" from
// "old transition on an issue that just re-entered the window" — the old
// history id was never in `seen` if the issue last appeared before the
// SEEN_MAX eviction, or never appeared at all.

test('an old transition on an issue that merely re-entered the window is stale — recorded, seen, never fired', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'KAN', statusFilters: ['Ready for Dev'] }] });
  // Post-baseline cursor; KAN-12 was never in the seen set.
  h.watchStore.saveCursor('team-1', 'acme::KAN', { seen: ['KAN-1:1'], lastPolledAt: '2026-01-01T11:55:00Z' });
  const restore = fakeFetch(() => ({ body: { isLast: true, issues: [
    // Moved to "Ready for Dev" three weeks ago; someone commented today so
    // `updated` bumped it into the window.
    issue('KAN-12', [statusHistory('500', 'To Do', 'Ready for Dev', '2025-12-11T09:00:00Z')]),
    // A genuinely new transition in the same poll still fires.
    issue('KAN-13', [statusHistory('501', 'To Do', 'Ready for Dev', '2026-01-01T11:58:00Z')]),
  ] } }));
  try {
    await h.poller._tick();
  } finally { restore(); }
  assert.deepEqual(h.delivered.map((d) => d.events[0].id), ['KAN-13:501']);
  assert.deepEqual(h.inboxStore.list('team-1').map((e) => e.event.id), ['KAN-13:501']);
  // The stale id is still remembered, so a later eviction can't resurrect it either.
  const seen = h.watchStore.getCursor('team-1', 'acme::KAN').seen;
  assert.ok(seen.includes('KAN-12:500'));
  assert.ok(seen.includes('KAN-13:501'));
  // …and the Activity view can show "the poller saw it, and did nothing".
  const rows = h.activityStore.list('team-1');
  const stale = rows.find((r) => r.event.id === 'KAN-12:500');
  assert.equal(stale.outcome, 'stale');
  assert.equal(rows.find((r) => r.event.id === 'KAN-13:501').outcome, 'delivered');
});

test('the horizon carries a grace: a transition slightly BEFORE the last poll still fires (clock skew / late index)', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'KAN' }] });
  h.watchStore.saveCursor('team-1', 'acme::KAN', { seen: [], lastPolledAt: '2026-01-01T11:55:00Z' });
  const restore = fakeFetch(() => ({ body: { isLast: true, issues: [
    issue('KAN-20', [statusHistory('600', 'To Do', 'In Progress', '2026-01-01T11:52:00Z')]), // 3 min before last poll — inside grace
    issue('KAN-21', [statusHistory('601', 'To Do', 'In Progress', '2026-01-01T11:40:00Z')]), // 15 min before — stale
  ] } }));
  try {
    await h.poller._tick();
  } finally { restore(); }
  assert.deepEqual(h.delivered.map((d) => d.events[0].id), ['KAN-20:600']);
});

test('a history with no `created` stamp fails open (delivered), never silently dropped', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [{ projectKey: 'KAN' }] });
  h.watchStore.saveCursor('team-1', 'acme::KAN', { seen: [], lastPolledAt: '2026-01-01T11:55:00Z' });
  const restore = fakeFetch(() => ({ body: { isLast: true, issues: [
    issue('KAN-30', [statusHistory('700', 'To Do', 'In Progress', undefined)]),
  ] } }));
  try {
    await h.poller._tick();
  } finally { restore(); }
  assert.deepEqual(h.delivered.map((d) => d.events[0].id), ['KAN-30:700']);
});

// ── F7: several watches on one project share ONE poll, not one cursor ───────
//
// Rows "KAN → Ready for Dev" and "KAN → In Review" name the same projectRef.
// Polled per watch, the first row's poll marked every fresh id seen; the
// second row's poll saw nothing fresh and never fired — silently.

test('two watches on the same project: one Jira search, every watch evaluated against the same fresh set', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [
    { projectKey: 'KAN', statusFilters: ['Ready for Dev'] },
    { projectKey: 'KAN', statusFilters: ['In Review'] },
  ] });
  h.watchStore.saveCursor('team-1', 'acme::KAN', { seen: [], lastPolledAt: '2026-01-01T11:55:00Z' });
  let searches = 0;
  const restore = fakeFetch((url) => {
    if (String(url).includes('/search/jql')) searches += 1;
    return { body: { isLast: true, issues: [
      issue('KAN-1', [statusHistory('1', 'To Do', 'Ready for Dev', '2026-01-01T11:58:00Z')]),
      issue('KAN-2', [statusHistory('2', 'To Do', 'In Review', '2026-01-01T11:58:30Z')]),
      issue('KAN-3', [statusHistory('3', 'To Do', 'Done', '2026-01-01T11:59:00Z')]),
    ] } };
  });
  try {
    const summary = await h.poller._tick();
    assert.equal(searches, 1, 'one search per projectRef, not per watch');
    assert.equal(summary.scopes[0].projects.length, 1);
    assert.equal(summary.scopes[0].projects[0].watches, 2);
  } finally { restore(); }
  // both watches fired; the unwatched status is recorded filtered once
  assert.deepEqual(h.delivered.map((d) => d.events[0].id).sort(), ['KAN-1:1', 'KAN-2:2']);
  const rows = h.activityStore.list('team-1');
  assert.deepEqual(rows.filter((r) => r.outcome === 'filtered').map((r) => r.event.id), ['KAN-3:3']);
});

test('an event matching TWO watches on the same project fires once, not twice', async () => {
  const h = harness();
  h.watchStore.setConfig('team-1', { watches: [
    { projectKey: 'KAN', statusFilters: ['Ready for Dev'] },
    { projectKey: 'KAN' }, // no filter — matches everything
  ] });
  h.watchStore.saveCursor('team-1', 'acme::KAN', { seen: [], lastPolledAt: '2026-01-01T11:55:00Z' });
  const restore = fakeFetch(() => ({ body: { isLast: true, issues: [
    issue('KAN-1', [statusHistory('1', 'To Do', 'Ready for Dev', '2026-01-01T11:58:00Z')]),
  ] } }));
  try { await h.poller._tick(); } finally { restore(); }
  assert.deepEqual(h.delivered.map((d) => d.events[0].id), ['KAN-1:1']);
  assert.deepEqual(h.inboxStore.list('team-1').map((e) => e.event.id), ['KAN-1:1']);
  assert.equal(h.activityStore.list('team-1').filter((r) => r.outcome === 'delivered').length, 1);
});
