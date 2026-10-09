'use strict';

// #2944 — a removed pool instance's chat history and session log stay readable.
// orchestrator.js can't be `require`d in a unit test, so the archive writer
// (`archivePoolInstance` + `fetchDmRoomChat`) runs here in a vm against a real
// temp directory and a stubbed homeserver; the reap wiring is pinned by source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const agentPool = require('./agent-pool');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function fn(name) {
  const re = new RegExp(`\\n(?:async )?function ${name}\\(`);
  const m = re.exec(SRC);
  assert.ok(m, `${name} not found — this guard needs re-pointing`);
  const start = m.index + 1;
  const rest = SRC.slice(start + 1);
  const end = rest.search(/\n(?:async )?function /);
  return SRC.slice(start, end === -1 ? undefined : start + 1 + end);
}

// A homeserver serving `events` (oldest first) in pages of `page`, newest
// first, the way `/messages?dir=b` does.
function fakeMessagesFetch(events, { page = 2, status = 200 } = {}) {
  const calls = [];
  const fetchStub = async (url) => {
    calls.push(url);
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    const from = Number(new URL(url).searchParams.get('from') || 0);
    const newestFirst = [...events].reverse();
    const chunk = newestFirst.slice(from, from + page);
    const end = from + page < newestFirst.length ? String(from + page) : undefined;
    return { ok: true, status: 200, json: async () => ({ chunk, ...(end ? { end } : {}) }) };
  };
  return { fetchStub, calls };
}

function harness({ events = [], fetchOpts, sessions = true, dmRoom = true, fsImpl = fs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-archive-wiring-'));
  const agentsDir = path.join(root, 'agents');
  const teamsDir = path.join(root, 'teams');
  const id = 't-dev-i7';
  fs.mkdirSync(path.join(agentsDir, id, 'sessions'), { recursive: true });
  if (sessions) {
    fs.writeFileSync(path.join(agentsDir, id, 'sessions', '!r:local.jsonl'), '{"type":"result"}\n');
    fs.writeFileSync(path.join(agentsDir, id, 'sessions', '!r:local.1.jsonl'), '{"type":"system_init"}\n');
    fs.writeFileSync(path.join(agentsDir, id, 'sessions', '!r:local.current.json'), '{}');
  } else {
    fs.rmSync(path.join(agentsDir, id, 'sessions'), { recursive: true });
  }
  if (dmRoom) fs.writeFileSync(path.join(agentsDir, id, 'dm-room.json'), JSON.stringify({ roomId: '!r:local' }));
  const { fetchStub, calls } = fakeMessagesFetch(events, fetchOpts);
  const warnings = [];
  const ctx = vm.createContext({
    agentPool, fs: fsImpl, path, URLSearchParams, AbortSignal, Date, JSON, Math,
    fetch: fetchStub,
    console: { log() {}, warn: (m) => warnings.push(m), error() {} },
    HOMESERVER: 'http://hs',
    CONDUWUIT_ADMIN_TOKEN: 'admin-token',
    HILL_CLIMB_TEAMS_DIR: teamsDir,
    knowledgeFeed: { safeTeamSegment: (s) => s || null },
    agentDir: (aid) => path.join(agentsDir, aid),
    agentStatePath: (aid, ...segs) => path.join(agentsDir, aid, ...segs),
  });
  vm.runInContext([fn('archivePoolInstance'), fn('fetchDmRoomChat')].join('\n'), ctx);
  const cfg = {
    id, parentTeamId: 't', poolInstance: true, poolOf: 't-dev', poolItem: 7, poolRepo: 'o/r',
    poolSpawnedAt: '2026-10-09T10:00:00.000Z',
  };
  const archiveDir = path.join(teamsDir, 't', 'pool-archive');
  const entries = () => (fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : []);
  return { ctx, cfg, id, archiveDir, entries, warnings, calls, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const msg = (n, sender) => ({ type: 'm.room.message', event_id: `$e${n}`, sender, origin_server_ts: n, content: { body: `m${n}` } });

test('AC1: the archive holds the transcript (rotations, no pointer), the chat oldest-first and the metadata', async () => {
  const events = [msg(1, '@u-human:local'), { type: 'm.room.member', event_id: '$m' }, msg(2, '@t-dev-i7:local'), msg(3, '@u-human:local')];
  const h = harness({ events });
  try {
    await h.ctx.archivePoolInstance(h.id, h.cfg, 'done');
    const [key] = h.entries();
    assert.match(key, /^t-dev-i7~\d+$/);
    const dir = path.join(h.archiveDir, key);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'sessions')).sort(), ['!r:local.1.jsonl', '!r:local.jsonl']);
    const chat = JSON.parse(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8'));
    assert.deepEqual(chat.events.map((e) => e.event_id), ['$e1', '$e2', '$e3'], 'only messages, oldest first, across pages');
    assert.equal(chat.truncated, false);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'archived-at.json'), 'utf8'));
    assert.equal(meta.instanceId, 't-dev-i7');
    assert.equal(meta.roleId, 't-dev');
    assert.equal(meta.item, '7');
    assert.equal(meta.repo, 'o/r');
    assert.equal(meta.spawnedAt, '2026-10-09T10:00:00.000Z');
    assert.equal(meta.reason, 'done');
    assert.equal(meta.roomId, '!r:local');
    assert.equal(meta.chat, true);
    assert.ok(Number.isFinite(Date.parse(meta.archivedAt)));
    assert.ok(h.calls.every((u) => u.startsWith('http://hs/_matrix/client/v3/rooms/!r%3Alocal/messages?')));
  } finally {
    h.cleanup();
  }
});

test('edge case: the same item archived twice keeps both archives', async () => {
  const h = harness({ events: [msg(1, '@u:local')] });
  try {
    await h.ctx.archivePoolInstance(h.id, h.cfg, 'done');
    await new Promise((r) => setTimeout(r, 5));
    await h.ctx.archivePoolInstance(h.id, h.cfg, 'idle-timeout');
    assert.equal(h.entries().length, 2);
  } finally {
    h.cleanup();
  }
});

test('an unreadable room still archives the session log, says so, and records chat: false', async () => {
  const h = harness({ events: [], fetchOpts: { status: 403 } });
  try {
    await h.ctx.archivePoolInstance(h.id, h.cfg, 'hard-timeout');
    const [key] = h.entries();
    const dir = path.join(h.archiveDir, key);
    assert.equal(fs.existsSync(path.join(dir, 'chat.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'archived-at.json'), 'utf8')).chat, false);
    assert.ok(h.warnings.some((w) => /chat history/.test(w)));
  } finally {
    h.cleanup();
  }
});

test('AC11: a failure half-way leaves no entry (and no .tmp- leftover) and is logged', async () => {
  const h = harness({ events: [msg(1, '@u:local')], fsImpl: { ...fs, cpSync: () => { throw new Error('ENOSPC'); } } });
  try {
    await h.ctx.archivePoolInstance(h.id, h.cfg, 'done');
    assert.deepEqual(h.entries(), []);
    assert.ok(h.warnings.some((w) => /archive failed: ENOSPC/.test(w)));
  } finally {
    h.cleanup();
  }
});

test('nothing to archive (no transcript, no room) writes nothing', async () => {
  const h = harness({ sessions: false, dmRoom: false });
  try {
    await h.ctx.archivePoolInstance(h.id, h.cfg, 'done');
    assert.deepEqual(h.entries(), []);
  } finally {
    h.cleanup();
  }
});

// ─── reap wiring (source) ────────────────────────────────────────────────────

test('AC1: every reap path names its reason on the internal DELETE', () => {
  const sweep = fn('poolReapSweepTeam');
  assert.match(sweep, /_internalSelfDelete\(id, "hard-timeout"\)/);
  assert.match(sweep, /_internalSelfDelete\(id, "pr-closed"\)/);
  assert.match(sweep, /_internalSelfDelete\(id, "idle-timeout"\)/);
  assert.match(fn('_reapPooledInstancesForTicket'), /_internalSelfDelete\(instanceId, "done"\)/);
  assert.match(fn('_internalSelfDelete'), /\?reason=\$\{encodeURIComponent\(reason\)\}/);
});

test('AC1/AC2: the DELETE route reads the reason and archives before deleteAgentFiles', () => {
  const start = SRC.indexOf("const deleteMatch = req.method === 'DELETE'");
  const body = SRC.slice(start, SRC.indexOf('// ── Ephemeral agent', start));
  assert.match(body, /\/\^\\\/internal\\\/agents\\\/\(\[\^\/\?\]\+\)\(\?:\\\?\(\.\*\)\)\?\$\//);
  assert.match(body, /agentPool\.normalizeReapReason\(/);
  const graceful = body.indexOf('gracefulPoolTeardown(targetId, cfg, { reason: reapReason, archive })');
  assert.ok(graceful > 0);
  assert.ok(body.indexOf('deleteAgentFiles(targetId)') > graceful, 'archived before the files are deleted');
  // Team deleted → its archives go with it.
  assert.match(body, /removeTeamPoolArchive\(id\)/);
});

test('gracefulPoolTeardown archives through archivePoolInstance unless told not to', () => {
  assert.match(fn('gracefulPoolTeardown'), /if \(archive\) await archivePoolInstance\(id, cfg, reason\)/);
  const writer = fn('archivePoolInstance');
  // Built under the tmp name, renamed into place last.
  assert.ok(writer.indexOf('fs.renameSync(archiveRoot') > writer.indexOf('archived-at.json'));
});
