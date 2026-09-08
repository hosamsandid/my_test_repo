'use strict';

// Work-plane tenant isolation (#1459 §2 — GOV-ACCESS-3 / GOV-PLATFORM-4).
//
// Three layers, because each one can be green while the next is broken:
//
//   1. the decision            — authorizeWorkPlane over the real scope.js
//   2. the gate, over real HTTP — an express app mounted with the SAME prefix
//                                 list api.js uses, driven with fetch. This is
//                                 the layer that catches the mistakes a unit
//                                 test cannot see: an `app.use` prefix that
//                                 matches one segment too many, an SSE route
//                                 that streams before the gate runs, a status
//                                 code that leaks existence.
//   3. the wiring              — api.js boots two listeners on require and
//                                 cannot be exercised (#651), so its source is
//                                 read. Layer 3 also RE-DERIVES the prefix list
//                                 from api.js's own route table, so a
//                                 work-plane route added later without a gate
//                                 fails here rather than shipping open.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const {
  NOT_FOUND,
  WORK_PLANE_AGENT_PREFIXES,
  WORK_PLANE_ROOM_PREFIX,
  authorizeWorkPlane,
  createWorkPlaneGates,
} = require('./work-plane-access');
const { computeScope, visibleAgent } = require('./scope');

const AGENT_ID_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

// ── Fixture estate ─────────────────────────────────────────────────────────
//
// Two teams that share nothing, plus a private agent inside team A — the exact
// shape the ticket's acceptance criterion names ("a second team member cannot
// read another user's private agent's workspace tree or session log").

const USERS = [
  { id: 'u-alice', subject: 'alice@example.com' },
  { id: 'u-carol', subject: 'carol@example.com' },
  { id: 'u-bob', subject: 'bob@example.com' },
  { id: 'u-root', subject: 'root@example.com', systemAdmin: true },
];
const MEMBERSHIPS = [
  { userId: 'u-alice', teamId: 'team-a', role: 'team-admin' },
  { userId: 'u-carol', teamId: 'team-a', role: 'team-member' },
  { userId: 'u-bob', teamId: 'team-b', role: 'team-admin' },
];
const AGENTS = {
  'agent-a': { teamId: 'team-a' },
  'agent-b': { teamId: 'team-b' },
  // ownerId is populated by #2077's D6 backfill; `visibility` is what makes the
  // private branch of visibleAgent live.
  'agent-secret': { teamId: 'team-a', visibility: 'private', ownerId: 'u-alice' },
};
const ROOMS = { '!room-a:local': 'agent-a', '!room-b:local': 'agent-b', '!room-secret:local': 'agent-secret' };

function scopeFor(username) {
  return computeScope({ username, users: USERS, memberships: MEMBERSHIPS, authEnabled: true });
}

// ── 1. The decision ────────────────────────────────────────────────────────

test('an unresolvable agent is refused, and is indistinguishable from a foreign one', () => {
  const bob = scopeFor('bob@example.com');
  // No agent at all, an agent directory with no readable config, and a room
  // belonging to nobody all arrive here as null — and must all answer the same.
  assert.deepEqual(authorizeWorkPlane(bob, null, { visibleAgent }), NOT_FOUND);
  assert.deepEqual(authorizeWorkPlane(bob, AGENTS['agent-a'], { visibleAgent }), NOT_FOUND);
  assert.equal(NOT_FOUND.status, 404, '403 would tell a prober the agent exists');
});

test('no scope means no access — the gate never fails open', () => {
  assert.deepEqual(authorizeWorkPlane(null, AGENTS['agent-a'], { visibleAgent }), NOT_FOUND);
  assert.deepEqual(authorizeWorkPlane(undefined, AGENTS['agent-a'], { visibleAgent }), NOT_FOUND);
});

test('a team member reaches their own team; an admin reaches everything', () => {
  assert.equal(authorizeWorkPlane(scopeFor('carol@example.com'), AGENTS['agent-a'], { visibleAgent }).ok, true);
  assert.equal(authorizeWorkPlane(scopeFor('root@example.com'), AGENTS['agent-b'], { visibleAgent }).ok, true);
});

test('a private agent is reachable by its owner only', () => {
  const secret = AGENTS['agent-secret'];
  assert.equal(authorizeWorkPlane(scopeFor('alice@example.com'), secret, { visibleAgent }).ok, true);
  // Carol is in the same team and still refused — this is the AC.
  assert.deepEqual(authorizeWorkPlane(scopeFor('carol@example.com'), secret, { visibleAgent }), NOT_FOUND);
});

test('the predicate must be injected — no silent default that permits', () => {
  assert.throws(() => authorizeWorkPlane(scopeFor('bob@example.com'), AGENTS['agent-a']), TypeError);
  assert.throws(() => createWorkPlaneGates({ getScope: () => ({}) }), /createWorkPlaneGates needs/);
});

// ── 2. The gate, over real HTTP ─────────────────────────────────────────────

/** Boot an express app wired exactly like api.js: the gates mounted on the
 *  shared prefix list FIRST, then stub routes at the real paths. Returns the
 *  base URL plus a record of the lookups the gates performed. */
async function bootApp(t) {
  const looked = { agents: [], rooms: [] };
  const app = express();

  // Stand-in for auth.gate: the caller names themselves in a header.
  app.use('/api', (req, _res, next) => {
    const username = req.get('x-test-user');
    if (username) req.user = { username };
    next();
  });

  const gates = createWorkPlaneGates({
    getScope: (req) => scopeFor(req.user && req.user.username),
    visibleAgent,
    isValidAgentId: (id) => AGENT_ID_RE.test(id),
    loadAgentMeta: (id) => { looked.agents.push(id); return AGENTS[id] || null; },
    loadRoomAgentMeta: (roomId) => {
      looked.rooms.push(roomId);
      const owner = ROOMS[roomId];
      return owner ? AGENTS[owner] : null;
    },
  });
  for (const prefix of WORK_PLANE_AGENT_PREFIXES) app.use(prefix, gates.agentGate);
  app.use(WORK_PLANE_ROOM_PREFIX, gates.roomGate);

  // Work-plane stubs, at the real paths (a representative of each mount). Each
  // opens with the id-shape check every real handler opens with, so a request
  // the gate waves through lands on the same 400 it does in api.js.
  const ok = (req, res) => {
    const id = req.params.agentId;
    if (id !== undefined && !AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
    return res.json({ reached: req.path });
  };
  app.get('/api/agents/:agentId/workspace/tree', ok);
  app.get('/api/agents/:agentId/workspace/download', ok);
  app.delete('/api/agents/:agentId/workspace/file', ok);
  app.post('/api/agents/:agentId/workspace/git-action', ok);
  app.get('/api/agents/:agentId/sessions/history', ok);
  app.get('/api/agents/:agentId/session/:roomId/stream', ok);
  app.post('/api/agents/:agentId/session/:roomId/stop', ok);
  app.get('/api/agents/:agentId/context/tree', ok);
  app.get('/api/agents/:agentId/commands', ok);
  app.get('/api/agents/:agentId/git-info', ok);
  app.post('/api/agents/:agentId/chat-upload', ok);
  app.post('/api/matrix/agents/:agentId/dm', ok);
  app.get('/api/matrix/rooms/:roomId/messages', ok);
  app.delete('/api/matrix/rooms/:roomId/messages', ok);
  app.get('/api/matrix/rooms/:roomId/stream', ok);

  // The routes that must stay OUT of the gate's reach: the config plane (keyed
  // `:id`, already gated by #302) and the two collection routes whose first
  // segment could be mistaken for an agent id.
  app.patch('/api/agents/:id/context-mount', ok);
  app.get('/api/agents/:id/prompt', ok);
  app.get('/api/agents/statuses', ok);
  app.get('/api/agents/orphans', ok);
  app.get('/api/matrix/agents', ok);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, user) => fetch(base + url, {
    method,
    headers: user ? { 'x-test-user': user } : {},
  });
  return { call, looked };
}

test('a foreign team member is refused on every work-plane route', async (t) => {
  const { call } = await bootApp(t);
  const routes = [
    ['GET', '/api/agents/agent-a/workspace/tree'],
    ['GET', '/api/agents/agent-a/workspace/download?path=.env'],
    ['DELETE', '/api/agents/agent-a/workspace/file'],
    ['POST', '/api/agents/agent-a/workspace/git-action'],
    ['GET', '/api/agents/agent-a/sessions/history'],
    ['GET', '/api/agents/agent-a/session/!r:local/stream'],
    ['POST', '/api/agents/agent-a/session/!r:local/stop'],
    ['GET', '/api/agents/agent-a/context/tree'],
    ['GET', '/api/agents/agent-a/commands'],
    ['GET', '/api/agents/agent-a/git-info'],
    ['POST', '/api/agents/agent-a/chat-upload'],
    ['POST', '/api/matrix/agents/agent-a/dm'],
    ['GET', '/api/matrix/rooms/!room-a:local/messages'],
    ['DELETE', '/api/matrix/rooms/!room-a:local/messages'],
    ['GET', '/api/matrix/rooms/!room-a:local/stream'],
  ];
  for (const [method, url] of routes) {
    const res = await call(method, url, 'bob@example.com');
    assert.equal(res.status, 404, `${method} ${url} must be refused`);
    assert.deepEqual(await res.json(), { error: 'Agent not found' }, `${method} ${url} body`);
  }
  // Anti-vacuity: the same routes really are reachable for the team's own member.
  for (const [method, url] of routes) {
    const res = await call(method, url, 'alice@example.com');
    assert.equal(res.status, 200, `${method} ${url} must work for the owning team`);
  }
});

test('the AC — a second team member cannot read a private agent, not even its own team-mate', async (t) => {
  const { call } = await bootApp(t);
  for (const [user, expected] of [['alice@example.com', 200], ['carol@example.com', 404], ['bob@example.com', 404]]) {
    const tree = await call('GET', '/api/agents/agent-secret/workspace/tree', user);
    const log = await call('GET', '/api/agents/agent-secret/sessions/history', user);
    const chat = await call('GET', '/api/matrix/rooms/!room-secret:local/messages', user);
    assert.equal(tree.status, expected, `${user} workspace tree`);
    assert.equal(log.status, expected, `${user} session log`);
    assert.equal(chat.status, expected, `${user} chat transcript`);
  }
});

test('an unauthenticated caller and an unknown agent are both plain 404s', async (t) => {
  const { call } = await bootApp(t);
  // No x-test-user header at all → computeScope fails closed.
  assert.equal((await call('GET', '/api/agents/agent-a/workspace/tree')).status, 404);
  assert.equal((await call('GET', '/api/agents/no-such-agent/workspace/tree', 'bob@example.com')).status, 404);
  // A room nobody owns is refused rather than proxied with the admin token.
  assert.equal((await call('GET', '/api/matrix/rooms/!orphan:local/messages', 'bob@example.com')).status, 404);
});

test('reads and writes coincide today — and the write side is real membership', async (t) => {
  const { call } = await bootApp(t);
  // GOV-ACCESS-3 and #1459's AC both state the rule as two halves ("reads
  // require visibleAgent, writes require membership in the agent's team"). This
  // pins that the single predicate satisfies BOTH, by asserting the outcome
  // equals `visible ∧ member-of-the-agent's-team` for every method — so a
  // refactor that lets a non-member write, or that refuses a member's read,
  // fails here.
  //
  // This test is also the one that must CHANGE when #2041 D9's P2 split lands
  // (workspace writes → Team Admin only): today it asserts the two halves are
  // equal, and that is exactly the property that split breaks. Left as an
  // equality rather than weakened in advance, so the successor ticket has to
  // come here and state the new rule instead of finding a test that tolerates
  // both.
  const READ = ['GET', '/api/agents/%ID%/workspace/tree'];
  const WRITE = ['POST', '/api/agents/%ID%/workspace/git-action'];
  for (const user of ['alice@example.com', 'carol@example.com', 'bob@example.com', 'root@example.com']) {
    const scope = scopeFor(user);
    for (const agentId of Object.keys(AGENTS)) {
      const agent = AGENTS[agentId];
      const member = scope.all || scope.teamIds.has(agent.teamId);
      const expected = (visibleAgent(scope, agent) && member) ? 200 : 404;
      for (const [method, tpl] of [READ, WRITE]) {
        const res = await call(method, tpl.replace('%ID%', agentId), user);
        assert.equal(res.status, expected, `${user} ${method} ${agentId}`);
      }
    }
  }
});

test('the config plane and the collection routes are untouched', async (t) => {
  const { call, looked } = await bootApp(t);
  // `/context` must not swallow `/context-mount`, and `/api/agents/statuses`
  // must not be read as an agent named "statuses" — both are segment-boundary
  // claims about express's app.use matching, so they are asserted, not assumed.
  for (const [method, url] of [
    ['PATCH', '/api/agents/agent-a/context-mount'],
    ['GET', '/api/agents/agent-a/prompt'],
    ['GET', '/api/agents/statuses'],
    ['GET', '/api/agents/orphans'],
    ['GET', '/api/matrix/agents'],
  ]) {
    const res = await call(method, url, 'bob@example.com');
    assert.equal(res.status, 200, `${method} ${url} must reach its own #302 gate, not this one`);
  }
  assert.deepEqual(looked.agents, [], 'the gate must not even look these up');
  assert.deepEqual(looked.rooms, []);
});

test('a malformed agent id keeps the route’s own 400', async (t) => {
  const { call, looked } = await bootApp(t);
  const res = await call('GET', '/api/agents/..%2Fetc/workspace/tree', 'bob@example.com');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid agent id' });
  assert.deepEqual(looked.agents, [], 'an id that can match no agent needs no lookup');
});

test('an admin costs the request path nothing — no lookup at all', async (t) => {
  const { call, looked } = await bootApp(t);
  // On the shipped single-operator default (AUTH_ENABLED=false) every caller is
  // `all: true`; the gate must add zero reads there, or it taxes every chat
  // poll and SSE reconnect with a scan of the agents directory.
  assert.equal((await call('GET', '/api/agents/agent-b/workspace/tree', 'root@example.com')).status, 200);
  assert.equal((await call('GET', '/api/matrix/rooms/!room-b:local/messages', 'root@example.com')).status, 200);
  assert.deepEqual(looked.agents, []);
  assert.deepEqual(looked.rooms, []);
});

// ── 3. The wiring in api.js ────────────────────────────────────────────────

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** Strip comments so prose about the gate cannot stand in for the gate.
 *  Line comments FIRST: a `//` comment mentioning a path glob contains a `/*`
 *  that would otherwise pair with a real `*​/` hundreds of lines below. */
function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}
const API_CODE = stripComments(API_SRC);

test('the gates are constructed from the real scope machinery', () => {
  assert.match(API_CODE, /require\('\.\/work-plane-access'\)/);
  const call = API_CODE.slice(API_CODE.indexOf('createWorkPlaneGates({'));
  const args = call.slice(0, call.indexOf('});'));
  for (const dep of ['getScope,', 'visibleAgent,', 'isValidAgentId:', 'loadAgentMeta:', 'loadRoomAgentMeta:']) {
    assert.ok(args.includes(dep), `createWorkPlaneGates must be passed ${dep}`);
  }
  assert.match(args, /AGENT_ID_RE\.test/);
  assert.match(args, /agentMetaForScope\(cfg\)/, 'the meta must resolve a team-member’s tenant via its parent');
  assert.match(args, /findAgentByDmRoom\(roomId\)/);
});

test('every prefix is mounted, and mounted before the routes it protects', () => {
  assert.match(API_CODE, /for \(const prefix of WORK_PLANE_AGENT_PREFIXES\) app\.use\(prefix, workPlaneGates\.agentGate\);/);
  assert.match(API_CODE, /app\.use\(WORK_PLANE_ROOM_PREFIX, workPlaneGates\.roomGate\);/);

  const mount = API_CODE.indexOf('app.use(prefix, workPlaneGates.agentGate)');
  const roomMount = API_CODE.indexOf('app.use(WORK_PLANE_ROOM_PREFIX');
  const gate = API_CODE.indexOf("app.use('/api', auth.gate)");
  assert.ok(gate > 0 && mount > gate, 'authentication must still run first');

  // Express walks its stack in registration order, so the mount has to precede
  // every work-plane route definition. There is exactly one occurrence of each
  // marker, so this fails if the block is moved down rather than passing on an
  // earlier coincidental match.
  const firstAgentRoute = API_CODE.search(/app\.[a-z]+\('\/api\/agents\/:agentId\//);
  const firstMatrixRoute = API_CODE.search(/app\.[a-z]+\('\/api\/matrix\//);
  assert.ok(firstAgentRoute > 0 && mount < firstAgentRoute, 'the agent gate must be registered first');
  assert.ok(firstMatrixRoute > 0 && roomMount < firstMatrixRoute, 'the room gate must be registered first');
});

/** Does `prefix` cover `routePath`, comparing whole segments and treating a
 *  `:param` on either side as a wildcard (that is what express does)? */
function prefixCovers(prefix, routePath) {
  const p = prefix.split('/');
  const r = routePath.split('/');
  if (p.length > r.length) return false;
  return p.every((seg, i) => seg.startsWith(':') || r[i].startsWith(':') || seg === r[i]);
}

// Routes in these families that carry their own gate instead of this one.
const SELF_GATED = ['/api/matrix/agents'];

test('drift guard — no work-plane route escapes the mount list', () => {
  const found = [...API_CODE.matchAll(/app\.[a-z]+\('(\/api\/agents\/:agentId\/[^']*|\/api\/matrix\/[^']*)'/g)]
    .map(m => m[1]);
  assert.ok(found.length >= 34, `expected the whole family, found ${found.length} — re-point this guard`);

  const prefixes = [...WORK_PLANE_AGENT_PREFIXES, WORK_PLANE_ROOM_PREFIX];
  const escaped = found.filter(r => !SELF_GATED.includes(r) && !prefixes.some(p => prefixCovers(p, r)));
  assert.deepEqual(escaped, [], 'these routes are ungated — add a prefix to WORK_PLANE_AGENT_PREFIXES');

  // And the one exemption really does gate itself, so the allowlist above is
  // not a hole someone can widen by adding a name to it.
  const list = API_CODE.slice(API_CODE.indexOf("app.get('/api/matrix/agents',"));
  assert.match(list.slice(0, list.indexOf('\napp.')), /visibleAgent\(scope, cfg\)/);
});

test('every mounted prefix still corresponds to real routes', () => {
  // The mirror of the drift guard: a prefix left behind after its routes are
  // renamed silently protects nothing, and would make the guard above pass by
  // covering a family that no longer exists.
  const found = [...API_CODE.matchAll(/app\.[a-z]+\('(\/api\/[^']*)'/g)].map(m => m[1]);
  for (const prefix of [...WORK_PLANE_AGENT_PREFIXES, WORK_PLANE_ROOM_PREFIX]) {
    assert.ok(found.some(r => prefixCovers(prefix, r)), `${prefix} guards nothing — stale mount`);
  }
});

test('the room→agent lookup is shared, and the token router keeps its own rule', () => {
  // findAgentByDmRoom must return the config even for a tokenless agent: the
  // gate reads a null as "no agent owns this room" and would wave it through.
  const fn = API_CODE.slice(API_CODE.indexOf('function findAgentByDmRoom'));
  const body = fn.slice(0, fn.indexOf('\nfunction findAgentTokenByDmRoom'));
  assert.match(body, /return \{ agentId, cfg \};/);
  assert.doesNotMatch(body, /cfg\?\.token \?/, 'the token rule belongs to the token router, not the lookup');

  const tokenFn = API_CODE.slice(API_CODE.indexOf('function findAgentTokenByDmRoom'));
  assert.match(tokenFn.slice(0, 400), /findAgentByDmRoom\(roomId\)/, 'one scan, two callers');
  assert.match(tokenFn.slice(0, 400), /cfg\?\.token \?/);
});
