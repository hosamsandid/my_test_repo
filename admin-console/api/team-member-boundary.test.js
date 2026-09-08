'use strict';

// #2080 — the D9 Team-Member boundary, driven at the route level.
//
// AC4 requires the enforcement be "proven by route-level tests, not by
// UI-hiding". There is no HTTP harness in this directory and there cannot be
// one: api.js has no exports and binds port 4000 plus four background jobs on
// require (the constraint every api-side guard here works around), and express
// itself is not installed in every environment this suite runs in — only CI's
// `npm ci` step provides it. So "route level" is met the way the repo already
// means it, in two halves:
//
//   • this file drives THE REAL MIDDLEWARE — the exact `(req, res, next)`
//     express will invoke — with the REAL `scope.js` predicates over real
//     users/memberships fixtures run through the REAL `computeScope`, and
//     asserts the status codes. Nothing about the decision is re-stated here;
//     it is executed.
//   • `work-plane-boundary-routes.test.js` reads api.js's source and asserts
//     every route the §6 matrix calls `manage` actually carries a gate.
//
// Neither half alone would be worth much: this one proves the gate refuses the
// right people, that one proves it is mounted where it must be.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  MUTATION_CLASS,
  WORK_PLANE_ROUTES,
  MANUAL_FIRE_RULE,
  isTriggerFiringRoute,
  classifyWorkPlaneRoute,
  manageRoutes,
  authorizeAgentMutation,
  createAgentManageGate,
} = require('./team-member-boundary');

const { computeScope, visibleAgent, canManageAgent } = require('./scope');
const { resolveAgentTeam } = require('./agent-team');

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// The cast covers every row of AC1 plus both of #2080's edge cases.
//
// `carol` is the first edge case verbatim: **team-admin of team-b, team-member
// of team-a**. She is the fixture that separates a real gate from a plausible
// one, because a gate that keys on "holds any team-admin role" or on "is a
// member of this team" passes for her on both agents and only the correct
// predicate — team-admin *of this agent's own Agent Team* — tells them apart.

const ENV_ADMIN = 'envadmin';   // the #276 env single-admin credential

const USERS = [
  { id: 'u-root',  subject: 'root@example.com',  systemAdmin: true },
  // Option C (PR #2094): the env admin is a real seeded record once activated.
  { id: 'u-envadmin', subject: ENV_ADMIN, systemAdmin: true },
  { id: 'u-alice', subject: 'alice@example.com' },
  { id: 'u-bob',   subject: 'bob@example.com' },
  { id: 'u-carol', subject: 'carol@example.com' },
  { id: 'u-dave',  subject: 'dave@example.com' },
  { id: 'u-erin',  subject: 'erin@example.com' },
];

const MEMBERSHIPS = [
  { userId: 'u-alice', teamId: 'team-a', role: 'team-admin' },
  { userId: 'u-bob',   teamId: 'team-a', role: 'team-member' },
  { userId: 'u-carol', teamId: 'team-a', role: 'team-member' },
  { userId: 'u-carol', teamId: 'team-b', role: 'team-admin' },
];

// Real `config.json` shapes. Note every one carries `teamId: 'default'` — the
// credential-tenant stamp this installation really has (§8.4/A2.1) — which is
// exactly what makes the raw-config-vs-meta trap live rather than theoretical.
const AGENTS = {
  'team-a':     { id: 'team-a',     role: 'team',        ownerId: 'u-alice', teamId: 'default' },
  'team-a-dev': { id: 'team-a-dev', role: 'team-member', parentTeamId: 'team-a', teamId: 'default' },
  'team-b':     { id: 'team-b',     role: 'team',        ownerId: 'u-carol', teamId: 'default' },
  'team-b-dev': { id: 'team-b-dev', role: 'team-member', parentTeamId: 'team-b', teamId: 'default' },
  'solo':       { id: 'solo',       role: 'agent',       ownerId: 'u-dave',  teamId: 'default' },
  // An agent whose config is unreadable — the fail-closed case.
  'broken':     null,
};

/** api.js's `agentMetaForScope`, re-derived from the same `resolveAgentTeam`.
 *  `work-plane-boundary-routes.test.js` asserts api.js's own `loadAgentMeta`
 *  calls `agentMetaForScope`, so this cannot drift from the real thing. */
function metaFor(cfg) {
  return cfg ? { teamId: resolveAgentTeam(cfg), ownerId: cfg.ownerId } : null;
}

function scopeFor(username) {
  return computeScope({
    username,
    adminUsername: ENV_ADMIN,
    users: USERS,
    memberships: MEMBERSHIPS,
    authEnabled: true,
  });
}

/** The gate, wired exactly as api.js wires it — real predicates, real scope. */
function buildGate(overrides = {}) {
  return createAgentManageGate({
    getScope: (req) => scopeFor(req.user && req.user.username),
    loadAgentMeta: (id) => metaFor(AGENTS[id]),
    isValidAgentId: (id) => /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/.test(id),
    visibleAgent,
    canManageAgent,
    ...overrides,
  });
}

/** Drive a middleware the way express does and report what it did. */
function drive(gate, username, agentId, { param = 'agentId' } = {}) {
  const req = { user: username ? { username } : undefined, params: { [param]: agentId } };
  const out = { passed: false, status: null, body: null };
  const res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
  };
  gate(req, res, () => { out.passed = true; });
  return out;
}

const PEOPLE = {
  envAdmin: ENV_ADMIN,
  systemAdmin: 'root@example.com',
  teamAdminA: 'alice@example.com',
  memberA: 'bob@example.com',
  adminBmemberA: 'carol@example.com',
  soloOwner: 'dave@example.com',
  outsider: 'erin@example.com',
};

// ── AC1 — every Team-Admin-only row refuses a member and admits an admin ────

test('AC1: a team-member is refused 403 on every manage-class route', () => {
  const gate = buildGate();
  assert.equal(manageRoutes().length, 10, 'the matrix should carry 10 manage-class routes');

  for (const route of manageRoutes()) {
    const param = route.path.includes(':agentId') ? 'agentId' : 'id';
    for (const agentId of ['team-a', 'team-a-dev']) {
      const out = drive(gate, PEOPLE.memberA, agentId, { param });
      assert.equal(out.passed, false, `${route.method} ${route.path} on ${agentId} must not pass a member`);
      assert.equal(out.status, 403, `${route.method} ${route.path} on ${agentId} must answer 403`);
      assert.deepEqual(out.body, { error: 'forbidden', code: 'forbidden' });
    }
  }
});

test('AC1: the team-admin of that team passes', () => {
  const gate = buildGate();
  for (const agentId of ['team-a', 'team-a-dev']) {
    const out = drive(gate, PEOPLE.teamAdminA, agentId);
    assert.equal(out.passed, true, `team-admin must pass on ${agentId}`);
    assert.equal(out.status, null, 'the gate must not touch the response when it passes');
  }
});

test('AC1: scope.all passes — both spellings of it (D5)', () => {
  const gate = buildGate();
  for (const who of [PEOPLE.envAdmin, PEOPLE.systemAdmin]) {
    for (const agentId of ['team-a', 'team-a-dev', 'team-b', 'solo']) {
      const out = drive(gate, who, agentId);
      assert.equal(out.passed, true, `${who} must pass on ${agentId}`);
    }
  }
  // D5 is a short-circuit taken BEFORE the disk read, so it must hold even for
  // an agent whose config cannot be loaded at all.
  assert.equal(drive(gate, PEOPLE.envAdmin, 'broken').passed, true);
});

// ── The two edge cases the ticket names ─────────────────────────────────────

test('edge case: team-admin of B, team-member of A — may mutate B, refused on A', () => {
  const gate = buildGate();

  for (const agentId of ['team-b', 'team-b-dev']) {
    assert.equal(drive(gate, PEOPLE.adminBmemberA, agentId).passed, true,
      `carol administers ${agentId} and must pass`);
  }
  for (const agentId of ['team-a', 'team-a-dev']) {
    const out = drive(gate, PEOPLE.adminBmemberA, agentId);
    assert.equal(out.passed, false, `carol is only a member of ${agentId}'s team`);
    assert.equal(out.status, 403, 'she can see it, so the refusal is 403, not 404');
  }
});

test('edge case: a standalone agent is mutable by its owner and nobody else (D8)', () => {
  const gate = buildGate();

  assert.equal(drive(gate, PEOPLE.soloOwner, 'solo').passed, true, 'the owner may mutate it');

  // A non-owner cannot even SEE a standalone agent, so the refusal must be the
  // absence-shaped 404 — not a 403, which would confirm the agent exists.
  for (const who of [PEOPLE.teamAdminA, PEOPLE.memberA, PEOPLE.outsider]) {
    const out = drive(gate, who, 'solo');
    assert.equal(out.passed, false, `${who} must be refused on a standalone agent they do not own`);
    assert.equal(out.status, 404, `${who} must get 404, not 403 — existence is the secret here`);
    assert.deepEqual(out.body, { error: 'Agent not found' });
  }
});

// ── The 404-before-403 ordering, and fail-closed ────────────────────────────

test('an invisible agent is refused as absent, not as forbidden', () => {
  const gate = buildGate();
  // erin holds no membership at all: every agent is invisible to her.
  for (const agentId of ['team-a', 'team-a-dev', 'team-b', 'solo']) {
    const out = drive(gate, PEOPLE.outsider, agentId);
    assert.equal(out.status, 404, `${agentId} must not be confirmed to exist`);
  }
  // And the two refusals are byte-identical to a genuinely missing agent, so
  // the endpoint is not an existence oracle.
  const missing = drive(gate, PEOPLE.outsider, 'no-such-agent');
  assert.deepEqual(missing.body, drive(gate, PEOPLE.outsider, 'team-a').body);
});

test('an unreadable config fails closed as absent rather than guessing a tenant', () => {
  const gate = buildGate();
  const out = drive(gate, PEOPLE.teamAdminA, 'broken');
  assert.equal(out.status, 404);
  assert.deepEqual(out.body, { error: 'Agent not found' });
});

test('an unauthenticated request is refused', () => {
  const gate = buildGate();
  const out = drive(gate, undefined, 'team-a');
  assert.equal(out.passed, false);
  assert.equal(out.status, 404);
});

test('a malformed agent id is handed to the route, which already answers 400', () => {
  const gate = buildGate();
  const out = drive(gate, PEOPLE.memberA, '../../etc/passwd');
  assert.equal(out.passed, true, 'the gate must not change the existing error for a bad request');
  assert.equal(out.status, null);
});

// ── AC2 — every "allowed" row still admits a Team Member ───────────────────

test('AC2: read/chat-class routes carry no manage gate, so a member is never refused', () => {
  const managePaths = new Set(manageRoutes().map(r => `${r.method} ${r.path}`));
  const readClass = WORK_PLANE_ROUTES.filter(r => r.cls === MUTATION_CLASS.READ);
  assert.equal(readClass.length, 12, 'the matrix should carry 12 read-class routes');
  for (const r of readClass) {
    assert.equal(managePaths.has(`${r.method} ${r.path}`), false,
      `${r.method} ${r.path} is "allowed" for a member and must not be manage-class`);
  }
});

test('AC2: a Team Member satisfies visibleAgent for their own team — reads, chat and export stay open', () => {
  const bob = scopeFor(PEOPLE.memberA);
  // The durable form of "a member succeeds": the read/chat rows are ungated
  // today, so passing is trivial — what must hold is that the member passes the
  // predicate those rows resolve to once #1459 §2's tenant gate lands in front
  // of them. Asserting only "no gate refuses bob" would silently stop meaning
  // anything the day that gate arrives.
  for (const agentId of ['team-a', 'team-a-dev']) {
    assert.equal(visibleAgent(bob, metaFor(AGENTS[agentId])), true,
      `${agentId} must stay readable by a member of its team`);
    assert.equal(canManageAgent(bob, metaFor(AGENTS[agentId])), false,
      `${agentId} must NOT be manageable by that same member — that is the whole of D9`);
  }
  // ...and the same member sees nothing of the other team.
  assert.equal(visibleAgent(bob, metaFor(AGENTS['team-b'])), false);
});

// ── AC3 — manual trigger firing ─────────────────────────────────────────────

test('AC3: no manual-fire route exists yet, and the classification is pre-decided', () => {
  // Recorded, not implemented: there is no firing route in api.js today (the
  // source scan in the sibling test is what keeps that true). What this ticket
  // owes AC3 is that such a route cannot arrive ungated.
  assert.equal(MANUAL_FIRE_RULE.cls, MUTATION_CLASS.MANAGE);
  assert.match(MANUAL_FIRE_RULE.why, /attributable/);

  for (const p of [
    '/api/agents/:id/triggers/:triggerId/run',
    '/api/agents/:id/triggers/:triggerId/fire',
    '/api/agents/:agentId/triggers/:triggerId/execute',
  ]) {
    assert.equal(isTriggerFiringRoute(p), true, `${p} should read as a firing route`);
    assert.equal(classifyWorkPlaneRoute('post', p), MUTATION_CLASS.MANAGE,
      `${p} must classify as manage without anyone editing the table`);
  }

  // Neighbouring paths must NOT be swept up by that pattern — the ratchet is
  // worth nothing if it also silently claims routes it has not considered.
  for (const p of [
    '/api/agents/:id/triggers',
    '/api/agents/:id/triggers/:triggerId',
    '/api/teams/:id/hill-climb/run',
  ]) {
    assert.equal(isTriggerFiringRoute(p), false, `${p} is not a firing route`);
  }
});

test('AC3: firing is refused for a member while chatting is not', () => {
  const gate = buildGate();
  // The gate is param-name agnostic, so the same middleware already refuses a
  // firing route the day one is registered — with `:id`, which the trigger
  // family uses.
  const out = drive(gate, PEOPLE.memberA, 'team-a-dev', { param: 'id' });
  assert.equal(out.status, 403);
  // And the member keeps the attributable path: chat is a read/chat-class
  // surface, which the same person passes.
  assert.equal(visibleAgent(scopeFor(PEOPLE.memberA), metaFor(AGENTS['team-a-dev'])), true);
});

// ── The table's own integrity ───────────────────────────────────────────────

test('every route in the matrix is classified exactly once', () => {
  const seen = new Set();
  for (const r of WORK_PLANE_ROUTES) {
    const key = `${r.method} ${r.path}`;
    assert.equal(seen.has(key), false, `${key} is listed twice`);
    seen.add(key);
    assert.ok(Object.values(MUTATION_CLASS).includes(r.cls), `${key} has an unknown class ${r.cls}`);
    assert.equal(r.method, r.method.toLowerCase(), `${key} must use a lowercase method`);
  }
  assert.equal(WORK_PLANE_ROUTES.length, 22);
});

test('classifyWorkPlaneRoute returns null for an unknown route rather than defaulting', () => {
  // Defaulting an unclassified mutation to `read` is how a gate goes missing
  // silently; defaulting it to `manage` would break a chat route nobody
  // classified. Both are worse than failing the ratchet.
  assert.equal(classifyWorkPlaneRoute('post', '/api/agents/:agentId/workspace/brand-new'), null);
  assert.equal(classifyWorkPlaneRoute('post', '/api/something/else'), null);
  // Method matters: the same path with a different verb is a different row.
  assert.equal(classifyWorkPlaneRoute('get', '/api/agents/:agentId/workspace/file'), MUTATION_CLASS.READ);
  assert.equal(classifyWorkPlaneRoute('delete', '/api/agents/:agentId/workspace/file'), MUTATION_CLASS.MANAGE);
});

// ── The decision function, and two ways of getting it wrong ────────────────

test('authorizeAgentMutation refuses to run without both predicates', () => {
  assert.throws(() => authorizeAgentMutation({ all: false }, { teamId: 'team-a' }, { visibleAgent }),
    /requires the visibleAgent and canManageAgent predicates/);
  assert.throws(() => authorizeAgentMutation({ all: false }, { teamId: 'team-a' }, {}), /requires/);
});

test('the proof has teeth: a gate built on visibleAgent alone wrongly admits the member', () => {
  // The mutation that matters. `visibleAgent` and `canManageAgent` agree on
  // every fixture EXCEPT a Team Member of the owning team — which is precisely
  // the person D9 is about — so a test suite that never distinguishes them
  // would pass against the pre-#2080 code. Injecting the weaker predicate in
  // place of the stronger one proves this suite does distinguish them.
  const naive = buildGate({ canManageAgent: visibleAgent });
  assert.equal(drive(naive, PEOPLE.memberA, 'team-a').passed, true,
    'the naive gate admits the member — so the real gate refusing them is a real result');
  assert.equal(drive(buildGate(), PEOPLE.memberA, 'team-a').passed, false);

  // The converse mutation: swapping the ORDER of the two predicates turns the
  // standalone non-owner's 404 into a 403 and leaks existence.
  const swapped = createAgentManageGate({
    getScope: (req) => scopeFor(req.user && req.user.username),
    loadAgentMeta: (id) => metaFor(AGENTS[id]),
    isValidAgentId: () => true,
    visibleAgent: canManageAgent,   // check management first
    canManageAgent: visibleAgent,
  });
  assert.equal(drive(swapped, PEOPLE.outsider, 'solo').status, 404);
  assert.equal(drive(swapped, PEOPLE.memberA, 'team-a').status, 404,
    'with the order swapped a member gets 404 instead of the honest 403');
});

test('the meta, not the raw config: a raw config.json defeats both predicates', () => {
  // Why `authorizeAgentMutation` takes `agentMetaForScope(cfg)` and never a raw
  // config. A raw config carries `teamId` = the credential-tenant stamp
  // (`'default'` here), so:
  const rawTeam = AGENTS['team-a'];
  const rawSolo = AGENTS['solo'];
  const bob = scopeFor(PEOPLE.memberA);
  const erin = scopeFor(PEOPLE.outsider);

  //  (1) a team agent is checked against the wrong key space entirely...
  assert.notEqual(resolveAgentTeam(rawTeam), rawTeam.teamId);
  assert.equal(visibleAgent(bob, metaFor(rawTeam)), true);
  assert.equal(visibleAgent(bob, rawTeam), false,
    'the raw config asks about access-scope "default", which no membership names since #2078');

  //  (2) ...and for a STANDALONE agent the truthy `'default'` turns D8's
  //  owner-only rule into a team check, which is the dangerous direction.
  assert.equal(resolveAgentTeam(rawSolo), null);
  assert.equal(visibleAgent(erin, metaFor(rawSolo)), false, 'meta: owner-only, so erin cannot see it');
  const defaultMember = computeScope({
    username: 'erin@example.com',
    adminUsername: ENV_ADMIN,
    users: USERS,
    memberships: [...MEMBERSHIPS, { userId: 'u-erin', teamId: 'default', role: 'team-member' }],
    authEnabled: true,
  });
  assert.equal(visibleAgent(defaultMember, rawSolo), true,
    'raw config: anyone holding a membership named "default" sees a private standalone agent');
  assert.equal(visibleAgent(defaultMember, metaFor(rawSolo)), false,
    'the meta closes that — which is why this module demands it');
});
