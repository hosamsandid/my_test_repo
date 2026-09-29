'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { computeScope, canManageAgent } = require('./scope');

// Authorization guard for the pending-queue reassignment routes (#2102 AC5).
//
// Two halves, because the property has two halves.
//
// The BEHAVIOURAL half drives the real `scope.js` predicate over a fixture of
// two teams and asserts the two-sided rule: managing the source is not managing
// the target, and vice versa. That is the actual claim of AC5 and it is worth
// proving against the predicate rather than against a mock.
//
// The WIRING half reads api.js's source, because a 15k-line Express app cannot
// be imported in a unit test (the `orphan-routes.test.js` /
// `team-stream-materialize.test.js` technique). What it pins is that the gate
// is applied to BOTH ids and that the routes sit above the parameterised
// `/api/agents/:id` — Express matches in registration order, so a route
// registered later would be swallowed and answer "Agent not found" instead of
// reassigning, silently.

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

const at = (needle) => {
  const i = SRC.indexOf(needle);
  assert.ok(i >= 0, `api.js should contain ${needle}`);
  return i;
};

// ── Fixture: two teams, four humans ─────────────────────────────────────────
// `alpha` and `beta` are separate access scopes. Agents are addressed by the
// minimal shape `agentMetaForScope` produces. Driven through the real
// `computeScope`, so the fixture has to speak its actual vocabulary: a session
// carries a SUBJECT, users are looked up by it, memberships are keyed on the
// resolved user id.
const USERS = [
  { id: 'u-alpha', subject: 'admin-alpha@example.com', systemAdmin: false },
  { id: 'u-beta', subject: 'admin-beta@example.com', systemAdmin: false },
  { id: 'u-both', subject: 'admin-both@example.com', systemAdmin: false },
  { id: 'u-member', subject: 'member-alpha@example.com', systemAdmin: false },
  { id: 'u-root', subject: 'root@example.com', systemAdmin: true },
];

const MEMBERSHIPS = [
  { userId: 'u-alpha', teamId: 'alpha', role: 'team-admin' },
  { userId: 'u-beta', teamId: 'beta', role: 'team-admin' },
  { userId: 'u-both', teamId: 'alpha', role: 'team-admin' },
  { userId: 'u-both', teamId: 'beta', role: 'team-admin' },
  { userId: 'u-member', teamId: 'alpha', role: 'team-member' },
];

function scopeFor(subject) {
  // `authEnabled: true` deliberately — with the flag off `computeScope`
  // short-circuits every caller to the implicit System Admin, which would make
  // this whole file assert nothing.
  return computeScope({
    username: subject,
    users: USERS,
    memberships: MEMBERSHIPS,
    authEnabled: true,
  });
}

const SOURCE = { teamId: 'alpha' };  // the agent holding the queued entry
const TARGET = { teamId: 'beta' };   // the agent it would be handed to

test('AC5: a user who may manage the source but not the target is refused', () => {
  const scope = scopeFor('admin-alpha@example.com');
  assert.equal(canManageAgent(scope, SOURCE), true, 'may take the entry away');
  assert.equal(canManageAgent(scope, TARGET), false,
    'but may NOT make the other team\'s agent run it — the reassignment must be refused');
});

test('AC5: and vice versa — managing the target is not managing the source', () => {
  const scope = scopeFor('admin-beta@example.com');
  assert.equal(canManageAgent(scope, SOURCE), false);
  assert.equal(canManageAgent(scope, TARGET), true);
});

test('AC5: only a caller who manages BOTH agents may reassign between them', () => {
  const scope = scopeFor('admin-both@example.com');
  assert.equal(canManageAgent(scope, SOURCE), true);
  assert.equal(canManageAgent(scope, TARGET), true);
});

test('AC5: a plain Team Member of the source team may not reassign at all', () => {
  // Injecting work into an agent's queue starts an autonomous run, which
  // #2041 §7/D9 holds to the Team-Admin bar. (Since #2119 a member may not
  // read or cancel the queue either — same predicate.)
  const scope = scopeFor('member-alpha@example.com');
  assert.equal(canManageAgent(scope, SOURCE), false);
  assert.equal(canManageAgent(scope, TARGET), false);
});

test('AC5: a System Admin may reassign anywhere', () => {
  const scope = scopeFor('root@example.com');
  assert.equal(scope.all, true);
  assert.equal(canManageAgent(scope, SOURCE), true);
  assert.equal(canManageAgent(scope, TARGET), true);
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test('the reassign POST gates BOTH the source and the target agent', () => {
  const route = at("app.post('/api/agents/:id/pending/:entryId/reassign'");
  const body = SRC.slice(route, route + 2000);
  // Two distinct calls, one per agent. A single gate would let a caller who
  // manages only the source fire a run on an agent in another team.
  assert.match(body, /resolveManageableAgentDir\(req, res, id\)/,
    'the source agent must be gated');
  assert.match(body, /resolveManageableAgentDir\(req, res, targetAgentId\)/,
    'the target agent must be gated');
  // And the helper really applies the shared management gate.
  const helper = at('function resolveManageableAgentDir');
  assert.match(SRC.slice(helper, helper + 900), /denyUnlessCanManageAgent\(req, res, agentDir\)/);
});

test('the target list is filtered to targets the caller may actually manage', () => {
  // Otherwise the picker offers an option the POST would then refuse — the
  // menu must not promise what the server declines (epic #1925 D1).
  const route = at("app.get('/api/agents/:id/pending/:entryId/reassign-targets'");
  const body = SRC.slice(route, route + 1600);
  assert.match(body, /canManageAgent\(/);
  assert.match(body, /body\.targets = body\.targets\.filter/);
});

test('both reassign routes are registered ABOVE the parameterised /api/agents/:id', () => {
  const targets = at("app.get('/api/agents/:id/pending/:entryId/reassign-targets'");
  const move = at("app.post('/api/agents/:id/pending/:entryId/reassign'");
  const byId = at("app.get('/api/agents/:id'");
  assert.ok(targets < byId, 'GET reassign-targets must precede GET /api/agents/:id');
  assert.ok(move < byId, 'POST reassign must precede GET /api/agents/:id');
});

test('the acting human is taken from the session, never from the request body', () => {
  // `byUserId` lands in the audit trail, so a body-supplied actor would be a
  // self-asserted one — the same reason #2077 stamps owners console-side.
  const route = at("app.post('/api/agents/:id/pending/:entryId/reassign'");
  const body = SRC.slice(route, route + 2000);
  assert.match(body, /byUserId: \(req\.user &&/,
    'byUserId must be resolved from req.user');
  assert.doesNotMatch(body, /req\.body\.byUserId/,
    'byUserId must never be read from the request body');
});

test('the entry id and both agent ids are validated before anything is proxied', () => {
  const route = at("app.post('/api/agents/:id/pending/:entryId/reassign'");
  const body = SRC.slice(route, route + 2000);
  assert.match(body, /PENDING_ENTRY_ID_RE\.test\(entryId\)/);
  assert.match(body, /AGENT_ID_RE\.test\(targetAgentId\)/);
});

test('#2119: the read/cancel neighbours carry the same management gate', () => {
  // The #2041 P2 gap this file used to flag is closed: detail and cancel refuse
  // an agent the caller may not manage, through the same helper as reassign.
  for (const method of ['get', 'delete']) {
    const route = at(`app.${method}('/api/agents/:id/pending/:entryId', async`);
    const body = SRC.slice(route, route + 700);
    assert.match(body, /resolveManageableAgentDir\(req, res, id\)/,
      `${method.toUpperCase()} /api/agents/:id/pending/:entryId must be gated`);
    assert.ok(body.indexOf('resolveManageableAgentDir') < body.indexOf('fetch('),
      'the gate must run before anything is proxied to the orchestrator');
  }
  // And the aggregated list is cut to what the caller may manage.
  const list = at("app.get('/api/pending-queue'");
  const listBody = SRC.slice(list, list + 1200);
  assert.match(listBody, /scopePendingQueue\(body, \{/);
  assert.match(listBody, /canManageAgentId: \(agentId\) => AGENT_ID_RE\.test\(agentId\) && canManageAgent\(/);
  assert.match(listBody, /canManageTeamId: \(teamId\) => canManageTeam\(scope, teamId\)/);
  assert.doesNotMatch(SRC, /FLAGGED FOR THE P2 OWNER/, 'the stale flag must not outlive the gap');
});
