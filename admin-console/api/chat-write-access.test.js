'use strict';

// Read-only agent chat for a System Admin outside the team (#2713).
// Run: node --test admin-console/api/chat-write-access.test.js
//
// Three layers: the rule (scope.js `canChatAgent`, AC12's matrix), the express
// gates over real HTTP (AC5/AC6/AC7/AC10), and the api.js wiring — which is
// express glue that cannot be required (#651), so it is asserted on the source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { computeScope, visibleAgent, canChatAgent, describeAuthz } = require('./scope');
const {
  CHAT_READ_ONLY, CHAT_READ_ONLY_MESSAGE, FORBIDDEN, ALLOWED,
  authorizeChatWrite, createChatWriteGates,
} = require('./chat-write-access');

const USERS = [
  { id: 'u-sys-member', subject: 'sys-member@example.com', systemAdmin: true },
  { id: 'u-sys-admin-of', subject: 'sys-ta@example.com', systemAdmin: true },
  { id: 'u-sys-outside', subject: 'sys-outside@example.com', systemAdmin: true },
  { id: 'u-carol', subject: 'carol@example.com' },
  { id: 'u-dave', subject: 'dave@example.com' },
];
const MEMBERSHIPS = [
  { userId: 'u-sys-member', teamId: 'team-a', role: 'team-member' },
  { userId: 'u-sys-admin-of', teamId: 'team-a', role: 'team-admin' },
  // A System Admin outside team-a who IS a member elsewhere — membership in
  // another team must not unlock team-a.
  { userId: 'u-sys-outside', teamId: 'team-b', role: 'team-admin' },
  { userId: 'u-carol', teamId: 'team-a', role: 'team-member' },
  { userId: 'u-dave', teamId: 'team-a', role: 'team-admin' },
];
// `agentMetaForScope(cfg)` shapes: the resolved boundary + owner.
const AGENTS = {
  'agent-a': { teamId: 'team-a', ownerId: 'u-dave' },
  'eph-owned': { teamId: null, ownerId: 'u-sys-outside' },
  'eph-other': { teamId: null, ownerId: 'u-carol' },
};
const ROOMS = { '!room-a:local': 'agent-a', '!room-eph:local': 'eph-owned', '!room-eph-other:local': 'eph-other' };

function scopeFor(username, opts = {}) {
  return computeScope({ username, users: USERS, memberships: MEMBERSHIPS, authEnabled: true, ...opts });
}

// ── 1. The rule ──────────────────────────────────────────────────────────

test('canChatAgent: a System Admin writes only in teams they belong to (AC8, AC12)', () => {
  const a = AGENTS['agent-a'];
  assert.equal(canChatAgent(scopeFor('sys-member@example.com'), a), true, 'team-member System Admin');
  assert.equal(canChatAgent(scopeFor('sys-ta@example.com'), a), true, 'team-admin System Admin');
  assert.equal(canChatAgent(scopeFor('sys-outside@example.com'), a), false, 'non-member System Admin');
});

test('canChatAgent: the non-member System Admin still SEES the agent (AC1, no visibility change)', () => {
  const s = scopeFor('sys-outside@example.com');
  assert.equal(s.all, true);
  assert.equal(visibleAgent(s, AGENTS['agent-a']), true);
});

test('canChatAgent: a standalone agent — its System-Admin owner writes, others do not (AC12)', () => {
  const sys = scopeFor('sys-outside@example.com');
  assert.equal(canChatAgent(sys, AGENTS['eph-owned']), true, 'owner');
  assert.equal(canChatAgent(sys, AGENTS['eph-other']), false, 'non-owner');
});

test('canChatAgent: auth disabled and the env-admin bootstrap keep full write (AC10, AC12)', () => {
  // Single-operator mode: even a System-Admin record outside the team writes.
  const off = scopeFor('sys-outside@example.com', { authEnabled: false });
  assert.equal(off.systemAdmin, undefined);
  assert.equal(canChatAgent(off, AGENTS['agent-a']), true);
  assert.equal(canChatAgent(off, AGENTS['eph-other']), true);
  // Env-admin bootstrap: only before any System-Admin record exists.
  const plain = USERS.filter(u => !u.systemAdmin);
  const boot = computeScope({ username: 'root', adminUsername: 'root', users: plain, memberships: MEMBERSHIPS });
  assert.equal(boot.all, true);
  assert.equal(canChatAgent(boot, AGENTS['agent-a']), true);
  assert.equal(canChatAgent(boot, AGENTS['eph-other']), true);
});

test('canChatAgent: regular members and outsiders are unchanged — write = visibility (AC11)', () => {
  assert.equal(canChatAgent(scopeFor('carol@example.com'), AGENTS['agent-a']), true);
  assert.equal(canChatAgent(scopeFor('dave@example.com'), AGENTS['agent-a']), true);
  assert.equal(canChatAgent(scopeFor('carol@example.com'), AGENTS['eph-other']), true, 'own standalone agent');
  assert.equal(canChatAgent(scopeFor('dave@example.com'), AGENTS['eph-other']), false, 'not visible');
  assert.equal(canChatAgent(scopeFor('nobody@example.com'), AGENTS['agent-a']), false);
  assert.equal(canChatAgent(null, AGENTS['agent-a']), false);
});

test('canChatAgent: joining the team unlocks writing on the next scope read (AC9)', () => {
  const joined = [...MEMBERSHIPS, { userId: 'u-sys-outside', teamId: 'team-a', role: 'team-member' }];
  const s = computeScope({ username: 'sys-outside@example.com', users: USERS, memberships: joined });
  assert.equal(canChatAgent(s, AGENTS['agent-a']), true);
});

test('the System Admin memberships do not leak into the other scope fields', () => {
  // `teamIds`/`roles` stay empty for a System Admin, so describeAuthz's `teams`
  // list and every other predicate keep their pre-#2713 answers.
  const s = scopeFor('sys-member@example.com');
  assert.equal(s.teamIds.size, 0);
  assert.equal(s.roles.size, 0);
  assert.deepEqual([...s.memberTeamIds], ['team-a']);
  assert.deepEqual(describeAuthz({ username: 'sys-member@example.com', users: USERS, memberships: MEMBERSHIPS }).teams, []);
});

// ── 2. The decision + gates ──────────────────────────────────────────────

test('authorizeChatWrite: 403 with the stable code, pass-through for a non-agent room', () => {
  const sys = scopeFor('sys-outside@example.com');
  assert.deepEqual(authorizeChatWrite(sys, AGENTS['agent-a'], { canChatAgent }), FORBIDDEN);
  assert.equal(FORBIDDEN.status, 403);
  assert.equal(FORBIDDEN.code, CHAT_READ_ONLY);
  assert.match(CHAT_READ_ONLY_MESSAGE, /System Admin.*add yourself to the team/);
  assert.deepEqual(authorizeChatWrite(sys, null, { canChatAgent }), ALLOWED);
  assert.throws(() => authorizeChatWrite(sys, AGENTS['agent-a']), TypeError);
  assert.throws(() => createChatWriteGates({ getScope: () => ({}) }), /createChatWriteGates needs/);
});

async function bootApp(t, { authEnabled = true } = {}) {
  const looked = { agents: [], rooms: [] };
  const reached = [];
  const app = express();
  app.use('/api', (req, _res, next) => {
    const username = req.get('x-test-user');
    if (username) req.user = { username };
    next();
  });
  const gates = createChatWriteGates({
    getScope: (req) => scopeFor(req.user && req.user.username, { authEnabled }),
    canChatAgent,
    isValidAgentId: (id) => /^[a-z0-9][a-z0-9-]*$/.test(id),
    loadAgentMeta: (id) => { looked.agents.push(id); return AGENTS[id] || null; },
    loadRoomAgentMeta: (roomId) => {
      looked.rooms.push(roomId);
      return ROOMS[roomId] ? AGENTS[ROOMS[roomId]] : null;
    },
  });
  const ok = (req, res) => { reached.push(`${req.method} ${req.path}`); res.json({ ok: true }); };
  app.post('/api/matrix/rooms/:roomId/messages', gates.roomChatGate, ok);
  app.post('/api/agents/:agentId/chat-upload', gates.agentChatGate, ok);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, user) => fetch(base + url, { method: 'POST', headers: user ? { 'x-test-user': user } : {} });
  return { call, looked, reached };
}

const SEND_A = `/api/matrix/rooms/${encodeURIComponent('!room-a:local')}/messages`;
const UPLOAD_A = '/api/agents/agent-a/chat-upload';

test('a non-member System Admin is refused on send and upload — the route is never reached (AC5, AC6, AC7)', async (t) => {
  const { call, reached } = await bootApp(t);
  for (const url of [SEND_A, UPLOAD_A]) {
    const res = await call(url, 'sys-outside@example.com');
    assert.equal(res.status, 403, url);
    assert.deepEqual(await res.json(), { error: CHAT_READ_ONLY_MESSAGE, code: CHAT_READ_ONLY });
  }
  // Nothing after the gate ran: no room join, no Matrix send, no file stored.
  assert.deepEqual(reached, []);
});

test('member System Admins, team members and a standalone owner pass (AC8, AC11)', async (t) => {
  const { call, reached } = await bootApp(t);
  for (const user of ['sys-member@example.com', 'sys-ta@example.com', 'carol@example.com', 'dave@example.com']) {
    assert.equal((await call(SEND_A, user)).status, 200, `${user} send`);
    assert.equal((await call(UPLOAD_A, user)).status, 200, `${user} upload`);
  }
  const ephRoom = `/api/matrix/rooms/${encodeURIComponent('!room-eph:local')}/messages`;
  assert.equal((await call(ephRoom, 'sys-outside@example.com')).status, 200, 'owner of a standalone agent');
  assert.equal((await call(`/api/matrix/rooms/${encodeURIComponent('!room-eph-other:local')}/messages`, 'sys-outside@example.com')).status, 403);
  assert.equal((await call('/api/agents/eph-owned/chat-upload', 'sys-outside@example.com')).status, 200);
  assert.ok(reached.length > 0);
});

test('with auth disabled nothing is refused, and nothing is read from disk (AC10)', async (t) => {
  const { call, looked } = await bootApp(t, { authEnabled: false });
  assert.equal((await call(SEND_A, 'sys-outside@example.com')).status, 200);
  assert.equal((await call(UPLOAD_A, 'sys-outside@example.com')).status, 200);
  assert.deepEqual(looked, { agents: [], rooms: [] });
});

test('a non-System-Admin caller costs no lookup; unknown rooms/agents pass to the route', async (t) => {
  const { call, looked } = await bootApp(t);
  await call(SEND_A, 'carol@example.com');
  await call(UPLOAD_A, 'carol@example.com');
  assert.deepEqual(looked, { agents: [], rooms: [] });
  assert.equal((await call(`/api/matrix/rooms/${encodeURIComponent('!orphan:local')}/messages`, 'sys-outside@example.com')).status, 200);
  assert.equal((await call('/api/agents/no-such-agent/chat-upload', 'sys-outside@example.com')).status, 200);
});

// ── 3. api.js wiring (source-asserted, #651) ──────────────────────────────

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

test('the send route runs the room gate before any join or send', () => {
  assert.match(API_SRC,
    /app\.post\('\/api\/matrix\/rooms\/:roomId\/messages', apiLimiter, chatWriteGates\.roomChatGate, async \(req, res\) =>/);
});

test('the chat-upload route runs the agent gate before multer reads the files', () => {
  assert.match(API_SRC,
    /app\.post\('\/api\/agents\/:agentId\/chat-upload', heavyLimiter, requireAgentIdParam, chatWriteGates\.agentChatGate, uploadFiles,/);
});

test('the gates are built on canChatAgent with the work-plane lookups', () => {
  const at = API_SRC.indexOf('const chatWriteGates = createChatWriteGates({');
  assert.ok(at > 0);
  const region = API_SRC.slice(at, at + 900);
  assert.match(region, /canChatAgent,/);
  assert.match(region, /findAgentByDmRoom\(roomId\)/);
  assert.match(region, /agentMetaForScope\(cfg\)/);
  assert.ok(at < API_SRC.indexOf("app.post('/api/matrix/rooms/:roomId/messages'"), 'defined before use');
});

test('GET /api/matrix/agents ships canChat from the same predicate (AC12)', () => {
  const at = API_SRC.indexOf("app.get('/api/matrix/agents',");
  const region = API_SRC.slice(at, at + 4000);
  assert.match(region, /canChat: canChatAgent\(scope, agentMetaForScope\(cfg\)\),/);
});
