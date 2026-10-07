'use strict';

// #566 — the chat roster as a shared build + a per-caller projection. The parity
// tests pin the response to the pre-#566 route body (copied below as
// `legacyRoster`) for every query variant and several callers, so moving the
// sweep behind a cache cannot change what any caller sees.
// Run: node --test admin-console/api/matrix-agent-roster.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRosterEntries, projectRoster, poolWaitingFields, mutationInvalidatesRoster, rosterTtlMsFromEnv,
} = require('./matrix-agent-roster');
const { admitsToChatList } = require('./matrix-agent-list');
const { computeScope, visibleAgent, canManageAgent, canChatAgent, canManageTeam } = require('./scope');
const { resolveAgentTeam } = require('./agent-team');

const agentMetaForScope = (cfg) => ({ teamId: resolveAgentTeam(cfg), ownerId: cfg && cfg.ownerId });
const ACCESS = { visibleAgent, canManageAgent, canChatAgent, canManageTeam };

/* ── Fixture fleet ─────────────────────────────────────────────────────── */

const CONFIGS = {
  'squad-a': { id: 'squad-a', role: 'team', displayName: 'Squad A', token: 't', environmentId: 'env-1', ownerId: 'u-alice' },
  'squad-a-dev': { id: 'squad-a-dev', role: 'team-member', parentTeamId: 'squad-a', token: 't', environmentId: 'env-1',
    pool: { enabled: true, maxInstances: 3 } },
  'squad-a-dev-i12': { id: 'squad-a-dev-i12', role: 'team-member', parentTeamId: 'squad-a', token: 't', environmentId: 'env-1',
    poolInstance: true, poolOf: 'squad-a-dev', poolItem: 12, poolSpawnedAt: '2026-10-05T10:00:00Z' },
  'squad-a-dev-i13': { id: 'squad-a-dev-i13', role: 'team-member', parentTeamId: 'squad-a', token: 't',
    poolInstance: true, poolOf: 'squad-a-dev', poolItem: 13, poolSpawnedAt: '2026-10-05T11:00:00Z' },
  'squad-a-stub': { id: 'squad-a-stub', role: 'team-member', parentTeamId: 'squad-a', enabled: false },
  'squad-a-paused': { id: 'squad-a-paused', role: 'team-member', parentTeamId: 'squad-a', token: 't', enabled: false },
  'squad-b': { id: 'squad-b', role: 'team', token: 't', environmentId: 'env-2', ownerId: 'u-mallory' },
  'squad-b-qa': { id: 'squad-b-qa', role: 'team-member', parentTeamId: 'squad-b', token: 't', environmentId: 'env-missing',
    userId: '@custom:local', parentOrchestratorId: 'orch-1' },
  'no-token': { id: 'no-token', role: 'agent' },
  // A standalone agent converted into its team of one: the team record has no
  // token of its own but keeps the room the agent had.
  'solo': { id: 'solo', role: 'team', displayName: 'Solo', ownerId: 'u-alice' },
};
const DM_ROOMS = {
  'squad-a': '!a:local', 'squad-a-dev-i12': '!i12:local', 'squad-b-qa': '!qa:local',
  // Tokenless rows that still carry a dm-room.json.
  'solo': '!solo:local', 'squad-a-stub': '!stub:local',
};
const ENVS = { 'env-1': { name: 'Env One' }, 'env-2': { name: 'Env Two' } };
const POOL_WAITING = {
  'squad-a': {
    'squad-a-dev-i12': { waiting: true, spawnedAt: '2026-10-05T10:00:00Z', prs: [44, 41] },
    // An earlier spawn of i13 — must not leak onto the current one.
    'squad-a-dev-i13': { waiting: true, spawnedAt: '2026-10-01T00:00:00Z', prs: [7] },
  },
};

function makeIo() {
  const calls = { config: 0, dm: 0, env: [], poolWaiting: [] };
  const io = {
    readConfig: (id) => { calls.config += 1; return CONFIGS[id] || null; },
    readDmRoomId: (id) => { calls.dm += 1; return DM_ROOMS[id] || null; },
    readEnvironmentName: (envId) => { calls.env.push(envId); return ENVS[envId]?.name || null; },
    readPoolWaiting: (teamId) => { calls.poolWaiting.push(teamId); return POOL_WAITING[teamId] || null; },
    agentMetaForScope,
  };
  return { io, calls };
}

const IDS = [...Object.keys(CONFIGS), 'unreadable'];

const USERS = [
  { id: 'u-alice', subject: 'alice' },
  { id: 'u-bob', subject: 'bob' },
  { id: 'u-root', subject: 'root', systemAdmin: true },
  { id: 'u-mallory', subject: 'mallory' },
];
const MEMBERSHIPS = [
  { id: 'm1', userId: 'u-alice', teamId: 'squad-a', role: 'team-admin' },
  { id: 'm2', userId: 'u-bob', teamId: 'squad-a', role: 'team-member' },
  { id: 'm3', userId: 'u-mallory', teamId: 'squad-b', role: 'team-admin' },
];
const scopeOf = (username, authEnabled = true) => computeScope({ username, users: USERS, memberships: MEMBERSHIPS, authEnabled });

/* ── The pre-#566 route body, verbatim apart from injected IO ──────────── */

function legacyRoster(scope, { includeDisabled, includeStubs }) {
  const out = [];
  const poolWaitingByTeam = new Map();
  const poolWaitingOf = (teamId) => {
    if (!poolWaitingByTeam.has(teamId)) poolWaitingByTeam.set(teamId, POOL_WAITING[teamId] || null);
    return poolWaitingByTeam.get(teamId);
  };
  for (const id of IDS) {
    const cfg = CONFIGS[id] || null;
    if (!cfg) continue;
    if (!admitsToChatList(cfg, { includeDisabled, includeStubs })) continue;
    if (!visibleAgent(scope, agentMetaForScope(cfg))) continue;
    const dm = DM_ROOMS[id] ? { roomId: DM_ROOMS[id] } : null;
    const env = cfg.environmentId ? (ENVS[cfg.environmentId] || null) : null;
    out.push({
      id,
      displayName: cfg.displayName || id,
      role: cfg.role || 'agent',
      userId: cfg.userId || `@${id}:local`,
      enabled: cfg.enabled !== false,
      hasToken: !!cfg.token,
      canManage: canManageAgent(scope, agentMetaForScope(cfg)),
      canChat: canChatAgent(scope, agentMetaForScope(cfg)),
      ...(cfg.role === 'team' ? { canManageTeam: canManageTeam(scope, id) } : {}),
      dmRoomId: dm?.roomId || null,
      environmentId: cfg.environmentId || null,
      environmentName: env?.name || cfg.environmentId || null,
      parentTeamId: cfg.parentTeamId || null,
      parentOrchestratorId: cfg.parentOrchestratorId || null,
      ...(cfg.poolInstance ? {
        poolInstance: true,
        poolOf: cfg.poolOf || null,
        poolItem: cfg.poolItem != null ? cfg.poolItem : null,
        poolSpawnedAt: cfg.poolSpawnedAt || null,
        ...poolWaitingFields(cfg.parentTeamId ? poolWaitingOf(cfg.parentTeamId) : null, id, cfg.poolSpawnedAt),
      } : {}),
      ...(!cfg.poolInstance && cfg.pool && typeof cfg.pool === 'object' && cfg.pool.enabled === true ? {
        poolMaxInstances: Number.isInteger(cfg.pool.maxInstances) && cfg.pool.maxInstances >= 1 ? cfg.pool.maxInstances : null,
      } : {}),
    });
  }
  return out;
}

/* ── Parity ─────────────────────────────────────────────────────────────── */

const CALLERS = {
  'system admin': scopeOf('root'),
  'team admin of squad-a': scopeOf('alice'),
  'team member of squad-a': scopeOf('bob'),
  'team admin of squad-b': scopeOf('mallory'),
  'stranger': scopeOf('nobody'),
  'single-user mode': scopeOf('alice', false),
  'no identity': scopeOf(undefined),
};
const VARIANTS = [
  { includeDisabled: false, includeStubs: false },
  { includeDisabled: false, includeStubs: true },
  { includeDisabled: true, includeStubs: false },
  { includeDisabled: true, includeStubs: true },
];

for (const [caller, scope] of Object.entries(CALLERS)) {
  test(`projectRoster matches the pre-#566 response byte for byte — ${caller}`, () => {
    const { io } = makeIo();
    const entries = buildRosterEntries(IDS, io);
    for (const variant of VARIANTS) {
      // JSON.stringify also pins key ORDER, not just deep equality.
      assert.equal(
        JSON.stringify(projectRoster(entries, scope, variant, ACCESS)),
        JSON.stringify(legacyRoster(scope, variant)),
        `variant ${JSON.stringify(variant)}`,
      );
    }
  });
}

test('the fixture exercises every optional field (guards a vacuous parity test)', () => {
  const { io } = makeIo();
  const rows = projectRoster(buildRosterEntries(IDS, io), scopeOf('root'), VARIANTS[3], ACCESS);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId['squad-a'].canManageTeam, true);
  assert.equal(byId['squad-a'].environmentName, 'Env One');
  assert.equal(byId['squad-a-dev'].poolMaxInstances, 3);
  assert.equal(byId['squad-a-dev-i12'].poolWaiting, true);
  assert.equal(byId['squad-a-dev-i12'].poolWaitingPr, 41);
  assert.equal(byId['squad-a-dev-i13'].poolWaiting, undefined, 'an earlier spawn\'s record is ignored');
  assert.equal(byId['squad-a-stub'].hasToken, false);
  assert.equal(byId['squad-b-qa'].environmentName, 'env-missing', 'falls back to the id');
  assert.equal(byId['squad-b-qa'].userId, '@custom:local');
  assert.ok(!('no-token' in byId), 'a tokenless standalone agent is not admitted');
});

test('a member sees only their own Agent Team; caller fields are per caller', () => {
  const { io } = makeIo();
  const entries = buildRosterEntries(IDS, io);
  const bob = projectRoster(entries, scopeOf('bob'), VARIANTS[0], ACCESS);
  assert.ok(bob.length > 0);
  assert.ok(bob.every((r) => r.id.startsWith('squad-a')));
  const alice = projectRoster(entries, scopeOf('alice'), VARIANTS[0], ACCESS);
  assert.equal(alice.find((r) => r.id === 'squad-a').canManageTeam, true);
  assert.equal(bob.find((r) => r.id === 'squad-a').canManageTeam, false);
  assert.deepEqual(projectRoster(entries, scopeOf('nobody'), VARIANTS[3], ACCESS), []);
});

/* ── Build cost ────────────────────────────────────────────────────────── */

test('buildRosterEntries reads each environment and each team\'s pool-waiting record once per build', () => {
  const { io, calls } = makeIo();
  buildRosterEntries(IDS, io);
  assert.deepEqual(calls.env.sort(), ['env-1', 'env-2', 'env-missing'], 'env-1 is shared by three agents');
  assert.deepEqual(calls.poolWaiting, ['squad-a'], 'two instances, one read');
  assert.equal(calls.config, IDS.length);
});

test('projectRoster does no IO', () => {
  const { io, calls } = makeIo();
  const entries = buildRosterEntries(IDS, io);
  const before = JSON.stringify(calls);
  for (const scope of Object.values(CALLERS)) for (const v of VARIANTS) projectRoster(entries, scope, v, ACCESS);
  assert.equal(JSON.stringify(calls), before);
});

/* ── Invalidation + TTL ────────────────────────────────────────────────── */

test('mutationInvalidatesRoster: roster-affecting mutations clear, everything else does not', () => {
  const clears = [
    ['POST', '/api/agents'],
    ['POST', '/api/agents/import'],
    ['PUT', '/api/agents/cobol-agent'],
    ['PUT', '/api/agents/cobol-agent?x=1'],
    ['DELETE', '/api/agents/cobol-agent'],
    ['POST', '/api/agents/cobol-agent/clone'],
    ['POST', '/api/agents/cobol-agent/deactivate'],
    ['POST', '/api/agents/squad-a/members'],
    ['POST', '/api/agents/orphans/cleanup'],
    ['POST', '/api/agents/team-of-one-migration/apply'],
    ['post', '/api/teams'],
    ['POST', '/api/teams/stream'],
    ['POST', '/api/teams/squad-a/enable'],
    ['POST', '/api/teams/squad-a/disable'],
    ['POST', '/api/teams/squad-a/force-dispatch'],
    ['POST', '/api/teams/squad-a/hill-climb/cards/c1/apply'],
    ['POST', '/api/teams/squad-a/hill-climb/cards/c1/rollback'],
    ['PUT', '/api/environments/env-1'],
    ['DELETE', '/api/environments/env-1'],
    ['POST', '/api/quickstart'],
    ['POST', '/api/quickstart/llm'],
    ['POST', '/api/blueprints/bp/instances'],
    ['DELETE', '/api/admin/users/u-1'],
    ['DELETE', '/api/admin/teams/t-1'],
  ];
  for (const [m, u] of clears) assert.equal(mutationInvalidatesRoster(m, u), true, `${m} ${u}`);

  // Reads, and the hot or POST-shaped non-roster mutations the old denylist let through.
  const keeps = [
    ['GET', '/api/matrix/agents'],
    ['HEAD', '/api/agents/x'],
    ['OPTIONS', '/api/agents/x'],
    ['POST', '/api/matrix/rooms/!r:local/messages'],
    ['POST', '/api/client-errors'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/agents/cobol-agent/chat-upload'],
    ['POST', '/api/agents/cobol-agent/session/!r:local/stop'],
    ['POST', '/api/agents/cobol-agent/sessions/s1/stop'],
    ['POST', '/api/agents/cobol-agent/wake'],
    ['POST', '/api/agents/cobol-agent/workspace/upload'],
    ['PATCH', '/api/agents/cobol-agent/model'],
    ['PUT', '/api/agents/cobol-agent/prompt'],
    ['POST', '/api/helper/chat'],
    ['POST', '/api/process/copilot'],
    ['POST', '/api/transcribe'],
    ['PUT', '/api/me/preferences'],
    ['POST', '/api/flows/graph'],
    ['POST', '/api/process/graph'],
    ['PUT', '/api/process/drafts/d1'],
    ['PUT', '/api/teams/squad-a/copilot-history'],
    ['POST', '/api/environments'],
    // Idempotent create-or-get: the console's DM-room write clears at the write site instead.
    ['POST', '/api/matrix/agents/a/dm'],
  ];
  for (const [m, u] of keeps) assert.equal(mutationInvalidatesRoster(m, u), false, `${m} ${u}`);
});

test('mutationInvalidatesRoster: a refused or failed mutation leaves the cache alone', () => {
  assert.equal(mutationInvalidatesRoster('PUT', '/api/agents/a', 200), true);
  assert.equal(mutationInvalidatesRoster('POST', '/api/agents', 201), true);
  for (const status of [400, 401, 403, 404, 409, 500, 502]) {
    assert.equal(mutationInvalidatesRoster('PUT', '/api/agents/a', status), false, String(status));
  }
});

/* ── Shared-cache hygiene (#566 review) ────────────────────────────────── */

test('a cached entry holds no Matrix token and no prompt — only the row inputs', () => {
  const secretFleet = {
    ...CONFIGS,
    'squad-a-dev': { ...CONFIGS['squad-a-dev'], token: 'syt_SECRET', systemPromptTemplate: 'PROMPT', systemPrompt: 'PROMPT' },
  };
  const io = { ...makeIo().io, readConfig: (id) => secretFleet[id] || null };
  const json = JSON.stringify(buildRosterEntries(IDS, io));
  assert.doesNotMatch(json, /syt_SECRET|PROMPT/);
  const dev = buildRosterEntries(IDS, io).find((e) => e.id === 'squad-a-dev');
  assert.equal(dev.admission.token, true, 'the token collapses to a boolean');
  assert.equal(dev.head.hasToken, true);
});

test('one malformed agent is skipped and reported; the rest of the rail still builds', () => {
  const broken = { ...CONFIGS, 'squad-a-bad': { id: 'squad-a-bad', role: 'team-member', parentTeamId: 'squad-a', token: 't', environmentId: { not: 'a string' } } };
  const { io } = makeIo();
  const errors = [];
  const entries = buildRosterEntries([...IDS, 'squad-a-bad'], {
    ...io,
    readConfig: (id) => broken[id] || null,
    // loadEnvironment's path.join throws on a non-string id.
    readEnvironmentName: (envId) => { if (typeof envId !== 'string') throw new TypeError('The "path" argument must be of type string'); return ENVS[envId]?.name || null; },
    onEntryError: (id, err) => errors.push([id, err.message]),
  });
  assert.deepEqual(errors.map(([id]) => id), ['squad-a-bad']);
  assert.ok(!entries.some((e) => e.id === 'squad-a-bad'));
  // Everyone else's rail is exactly what it was.
  for (const scope of Object.values(CALLERS)) {
    for (const v of VARIANTS) {
      assert.equal(JSON.stringify(projectRoster(entries, scope, v, ACCESS)), JSON.stringify(legacyRoster(scope, v)));
    }
  }
});

test('a tokenless row (team record, stub member) still ships its DM room, as before #566', () => {
  const { io } = makeIo();
  const entries = buildRosterEntries(IDS, io);
  const dmOf = (id) => entries.find((e) => e.id === id).tail.dmRoomId;
  assert.equal(dmOf('solo'), '!solo:local');
  assert.equal(dmOf('squad-a-stub'), '!stub:local');
  assert.equal(dmOf('squad-a-dev-i13'), null, 'no dm-room.json → null');
});

test('rosterTtlMsFromEnv: default 2000, explicit 0 disables, junk falls back', () => {
  assert.equal(rosterTtlMsFromEnv({}), 2000);
  assert.equal(rosterTtlMsFromEnv({ AGENT_ROSTER_TTL_MS: '' }), 2000);
  assert.equal(rosterTtlMsFromEnv({ AGENT_ROSTER_TTL_MS: '0' }), 0);
  assert.equal(rosterTtlMsFromEnv({ AGENT_ROSTER_TTL_MS: '3500' }), 3500);
  assert.equal(rosterTtlMsFromEnv({ AGENT_ROSTER_TTL_MS: 'soon' }), 2000);
  assert.equal(rosterTtlMsFromEnv({ AGENT_ROSTER_TTL_MS: '-5' }), 2000);
  assert.equal(rosterTtlMsFromEnv(undefined), 2000);
});

test('mutationInvalidatesRoster: trailing slashes are trimmed linearly, not by a backtracking regex', () => {
  assert.equal(mutationInvalidatesRoster('PUT', '/api/agents/a///'), true);
  assert.equal(mutationInvalidatesRoster('POST', '/api/agents/?x=1'), true);
  const hostile = `/api/${'/'.repeat(200_000)}a`;
  const t0 = Date.now();
  assert.equal(mutationInvalidatesRoster('POST', hostile), false);
  assert.ok(Date.now() - t0 < 1000, 'a long run of slashes must not cost quadratic time');
});
