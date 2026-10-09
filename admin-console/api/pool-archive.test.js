'use strict';

// #2944 — reading a removed pool instance's archive (pool-archive.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pa = require('./pool-archive');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-09T12:00:00Z');

function fixture() {
  const teamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-archive-'));
  const root = path.join(teamsDir, 't', 'pool-archive');
  fs.mkdirSync(root, { recursive: true });
  const write = (key, { meta, sessions = {}, chat } = {}) => {
    const dir = path.join(root, key);
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    for (const [name, body] of Object.entries(sessions)) fs.writeFileSync(path.join(dir, 'sessions', name), body);
    if (chat) fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify(chat));
    if (meta) fs.writeFileSync(path.join(dir, 'archived-at.json'), JSON.stringify(meta));
  };
  return { teamsDir, root, write, cleanup: () => fs.rmSync(teamsDir, { recursive: true, force: true }) };
}

const stamp = (instanceId, daysAgo, extra = {}) => ({
  archivedAt: new Date(NOW - daysAgo * DAY).toISOString(),
  instanceId, roleId: 't-dev', item: '7', repo: 'o/r', spawnedAt: '2026-10-01T00:00:00.000Z',
  reason: 'done', roomId: '!r:local', chat: true, ...extra,
});

test('the default retention matches the orchestrator (AC6)', () => {
  const { TEARDOWN_DEFAULTS } = require('../../orchestrator/agent-pool');
  assert.equal(pa.POOL_ARCHIVE_DEFAULT_RETAIN_MS, TEARDOWN_DEFAULTS.retainLogsMs);
  assert.equal(pa.POOL_ARCHIVE_DEFAULT_RETAIN_MS, 30 * DAY);
});

test('archive keys: instance ids with an optional ~epoch, never a dotfile or a path', () => {
  assert.equal(pa.isValidArchiveKey('t-dev-i7~1760000000000'), true);
  assert.equal(pa.isValidArchiveKey('t-dev-i7'), true);
  for (const bad of ['.tmp-t-dev-i7~1', '..', '../x', 't/dev', 't-dev-i7~', '', null]) {
    assert.equal(pa.isValidArchiveKey(bad), false, String(bad));
  }
});

test('belongsToRole: the stamp decides; a pre-#2944 archive maps by its instance-id prefix', () => {
  assert.equal(pa.belongsToRole('t-dev-i7~1', { roleId: 't-dev' }, 't-dev'), true);
  assert.equal(pa.belongsToRole('t-dev-i7~1', { roleId: 't-qa' }, 't-dev'), false);
  assert.equal(pa.belongsToRole('t-dev-i7', { archivedAt: 'x' }, 't-dev'), true);
  assert.equal(pa.belongsToRole('t-dev-x-i7', { archivedAt: 'x' }, 't-dev'), false);
  assert.equal(pa.belongsToRole('t-dev-i', { archivedAt: 'x' }, 't-dev'), false);
});

test('projectArchiveEntry: the list row, its expiry from the role retention, and expired rows hidden (AC3/AC7)', () => {
  const row = pa.projectArchiveEntry('t-dev-i7~1', stamp('t-dev-i7', 2), { now: NOW });
  assert.deepEqual(row, {
    key: 't-dev-i7~1', instanceId: 't-dev-i7', item: '7', repo: 'o/r',
    spawnedAt: '2026-10-01T00:00:00.000Z', archivedAt: new Date(NOW - 2 * DAY).toISOString(),
    reason: 'done', hasChat: true, legacy: false, expiresAt: new Date(NOW + 28 * DAY).toISOString(),
  });
  assert.equal(pa.projectArchiveEntry('k', stamp('x', 2), { retainLogsMs: DAY, now: NOW }), null, 'shortened retention hides it');
  assert.equal(pa.projectArchiveEntry('k', stamp('x', 31), { now: NOW }), null);
  assert.equal(pa.projectArchiveEntry('k', stamp('x', 31), { retainLogsMs: 60 * DAY, now: NOW }).key, 'k');
  assert.equal(pa.projectArchiveEntry('k', { archivedAt: 'nope' }, { now: NOW }), null);
  assert.equal(pa.projectArchiveEntry('k', stamp('x', 1, { reason: 'weird' }), { now: NOW }).reason, null);
});

test('AC10: a pre-#2944 archive is listed as legacy with no chat', () => {
  const row = pa.projectArchiveEntry('t-dev-i7', { archivedAt: new Date(NOW - DAY).toISOString() }, { now: NOW });
  assert.equal(row.instanceId, 't-dev-i7');
  assert.equal(row.legacy, true);
  assert.equal(row.hasChat, false);
  assert.equal(row.item, null);
});

test('listForRole: only the role\'s stamped, complete, unexpired archives, newest first (AC3/AC11)', () => {
  const f = fixture();
  try {
    f.write('t-dev-i7~1', { meta: stamp('t-dev-i7', 3) });
    f.write('t-dev-i7~2', { meta: stamp('t-dev-i7', 1, { reason: 'idle-timeout' }) }); // same item twice
    f.write('t-dev-i9', { meta: { archivedAt: new Date(NOW - 2 * DAY).toISOString() } }); // legacy
    f.write('t-dev-i8~3', { meta: stamp('t-dev-i8', 40) }); // expired
    f.write('t-qa-i7~4', { meta: stamp('t-qa-i7', 1, { roleId: 't-qa' }) }); // another role
    f.write('.tmp-t-dev-i5~5', { meta: stamp('t-dev-i5', 0) }); // in progress
    f.write('t-dev-i6~6', {}); // unstamped
    const r = pa.createPoolArchiveReader({ teamsDir: f.teamsDir });
    assert.deepEqual(r.listForRole('t', 't-dev', { now: NOW }).map(e => e.key), ['t-dev-i7~2', 't-dev-i9', 't-dev-i7~1']);
    assert.deepEqual(r.listForRole('t', 't-dev', { now: NOW, retainLogsMs: 2.5 * DAY }).map(e => e.key), ['t-dev-i7~2', 't-dev-i9']);
    assert.deepEqual(r.listForRole('missing-team', 't-dev', { now: NOW }), []);
    assert.deepEqual(r.listForRole('../etc', 't-dev', { now: NOW }), []);
  } finally {
    f.cleanup();
  }
});

test('the scan is memoized on the directory mtime and picks up a new archive', () => {
  const f = fixture();
  try {
    f.write('t-dev-i7~1', { meta: stamp('t-dev-i7', 1) });
    let reads = 0;
    const fsImpl = { ...fs, readFileSync: (...a) => { reads += 1; return fs.readFileSync(...a); } };
    const r = pa.createPoolArchiveReader({ teamsDir: f.teamsDir, fsImpl });
    r.listForRole('t', 't-dev', { now: NOW });
    r.listForRole('t', 't-dev', { now: NOW });
    assert.equal(reads, 1);
    // A rename into the directory (how the orchestrator publishes) bumps its mtime.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(f.root, past, past);
    f.write('t-dev-i8~2', { meta: stamp('t-dev-i8', 0.5) });
    assert.equal(r.listForRole('t', 't-dev', { now: NOW }).length, 2);
  } finally {
    f.cleanup();
  }
});

test('resolve: only an archive the role can list; rooms and paged transcript incl. rotations', () => {
  const f = fixture();
  try {
    const live = ['{"n":5}', '{"n":6}'].join('\n') + '\n';
    f.write('t-dev-i7~1', {
      meta: stamp('t-dev-i7', 1),
      sessions: {
        '!r:local.jsonl': live,
        '!r:local.1.jsonl': '{"n":1}\n{"n":2}\n',
        '!r:local.2.jsonl': '{"n":3}\n{"n":4}\n',
        '!other:local.jsonl': '{"n":9}\n',
      },
    });
    f.write('t-qa-i7~2', { meta: stamp('t-qa-i7', 1, { roleId: 't-qa' }) });
    const r = pa.createPoolArchiveReader({ teamsDir: f.teamsDir });
    assert.equal(r.resolve('t', 't-dev', 't-qa-i7~2', { now: NOW }), null, 'another role\'s archive');
    assert.equal(r.resolve('t', 't-dev', '../t-qa-i7~2', { now: NOW }), null);
    assert.equal(r.resolve('t', 't-dev', 't-dev-i7~1', { now: NOW, retainLogsMs: 1000 }), null, 'expired');
    const a = r.resolve('t', 't-dev', 't-dev-i7~1', { now: NOW });
    assert.deepEqual(r.rooms(a), ['!r:local', '!other:local']);
    const all = r.sessionPage(a, '!r:local', { limit: 500 });
    assert.deepEqual(all.events.map(e => e.n), [1, 2, 3, 4, 5, 6]);
    assert.equal(all.truncated, false);
    // Edge case: a large transcript pages from its end.
    const p0 = r.sessionPage(a, '!r:local', { limit: 4, page: 0 });
    assert.deepEqual(p0.events.map(e => e.n), [3, 4, 5, 6]);
    assert.equal(p0.pages, 2);
    assert.equal(p0.truncated, true);
    assert.deepEqual(r.sessionPage(a, '!r:local', { limit: 4, page: 1 }).events.map(e => e.n), [1, 2]);
    assert.deepEqual(r.sessionPage(a, '!none:local').events, []);
  } finally {
    f.cleanup();
  }
});

test('chatPage: Matrix-shaped newest-first pages; noChat for an archive without chat (AC4/AC10)', () => {
  const f = fixture();
  try {
    const events = [1, 2, 3, 4, 5].map(n => ({ type: 'm.room.message', event_id: `$${n}` }));
    f.write('t-dev-i7~1', { meta: stamp('t-dev-i7', 1), chat: { roomId: '!r:local', truncated: false, events } });
    f.write('t-dev-i9', { meta: { archivedAt: new Date(NOW - DAY).toISOString() } });
    const r = pa.createPoolArchiveReader({ teamsDir: f.teamsDir });
    const a = r.resolve('t', 't-dev', 't-dev-i7~1', { now: NOW });
    const first = r.chatPage(a, { limit: 2 });
    assert.deepEqual(first.chunk.map(e => e.event_id), ['$5', '$4']);
    assert.equal(first.end, '2');
    const last = r.chatPage(a, { from: '4', limit: 2 });
    assert.deepEqual(last.chunk.map(e => e.event_id), ['$1']);
    assert.equal(last.end, undefined);
    const legacy = r.resolve('t', 't-dev', 't-dev-i9', { now: NOW });
    assert.deepEqual(r.chatPage(legacy), { chunk: [], noChat: true });
  } finally {
    f.cleanup();
  }
});

test('archiveKeyForEvent: the lifetime the event ran in, else nothing', () => {
  const entries = [
    { key: 'i7~3', instanceId: 'i7', archivedAt: '2026-10-05T00:00:00.000Z' },
    { key: 'i7~1', instanceId: 'i7', archivedAt: '2026-10-01T00:00:00.000Z' },
    { key: 'i8~2', instanceId: 'i8', archivedAt: '2026-10-02T00:00:00.000Z' },
  ];
  assert.equal(pa.archiveKeyForEvent(entries, 'i7', '2026-09-30T00:00:00Z'), 'i7~1');
  assert.equal(pa.archiveKeyForEvent(entries, 'i7', '2026-10-03T00:00:00Z'), 'i7~3', 'reaped twice: the second lifetime');
  assert.equal(pa.archiveKeyForEvent(entries, 'i7', '2026-10-06T00:00:00Z'), null);
  assert.equal(pa.archiveKeyForEvent(entries, 'i9', '2026-10-01T00:00:00Z'), null);
  assert.equal(pa.archiveKeyForEvent(entries, 'i7', undefined), 'i7~1');
});
