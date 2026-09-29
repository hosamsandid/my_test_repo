'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scopePendingQueue } = require('./pending-queue-scope');
const { computeScope, canManageAgent, canManageTeam } = require('./scope');

// #2119 (Flow Control §4.6): the Pending-queue list is cut to what the caller
// may manage. Driven through the real `scope.js` predicates over a two-team
// fixture, the way pending-reassign-routes.test.js proves the reassign gate.

const USERS = [
  { id: 'u-alpha', subject: 'admin-alpha@example.com', systemAdmin: false },
  { id: 'u-member', subject: 'member-alpha@example.com', systemAdmin: false },
  { id: 'u-root', subject: 'root@example.com', systemAdmin: true },
];
const MEMBERSHIPS = [
  { userId: 'u-alpha', teamId: 'alpha', role: 'team-admin' },
  { userId: 'u-member', teamId: 'alpha', role: 'team-member' },
];
const AGENT_TEAM = { 'dev-alpha': 'alpha', 'dev-beta': 'beta' };

function predicatesFor(subject) {
  // authEnabled: true — with it off every caller is the implicit System Admin.
  const scope = computeScope({ username: subject, users: USERS, memberships: MEMBERSHIPS, authEnabled: true });
  return {
    canManageAgentId: (id) => canManageAgent(scope, { teamId: AGENT_TEAM[id] || null }),
    canManageTeamId: (teamId) => canManageTeam(scope, teamId),
  };
}

const QUEUE = {
  ok: true,
  agents: [
    { agentId: 'dev-alpha', agentName: 'Dev A', count: 2, entries: [{ id: 'a1' }, { id: 'a2' }] },
    { agentId: 'dev-beta', agentName: 'Dev B', count: 3, entries: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }] },
  ],
  total: 5,
  held: [
    { agentId: 'dev-alpha', teamId: 'alpha', count: 1, entries: [{ id: 'h1' }] },
    { agentId: 'dev-beta', teamId: 'beta', count: 4, entries: [] },
  ],
  heldTotal: 5,
};

test('a Team Admin sees only their own team\'s queues and lanes, with honest totals', () => {
  const out = scopePendingQueue(QUEUE, predicatesFor('admin-alpha@example.com'));
  assert.deepEqual(out.agents.map((g) => g.agentId), ['dev-alpha']);
  assert.equal(out.total, 2, 'the other team\'s queue size must not leak through the total');
  assert.deepEqual(out.held.map((g) => g.teamId), ['alpha']);
  assert.equal(out.heldTotal, 1);
  assert.equal(out.ok, true);
});

test('a Team Member of the same team sees nothing — no longer "any signed-in user"', () => {
  const out = scopePendingQueue(QUEUE, predicatesFor('member-alpha@example.com'));
  assert.deepEqual(out.agents, []);
  assert.deepEqual(out.held, []);
  assert.equal(out.total, 0);
  assert.equal(out.heldTotal, 0);
});

test('a System Admin sees everything', () => {
  const out = scopePendingQueue(QUEUE, predicatesFor('root@example.com'));
  assert.equal(out.agents.length, 2);
  assert.equal(out.total, 5);
  assert.equal(out.held.length, 2);
  assert.equal(out.heldTotal, 5);
});

test('fails closed: no predicates, malformed groups or a missing team id show nothing', () => {
  assert.deepEqual(scopePendingQueue(QUEUE).agents, []);
  assert.deepEqual(scopePendingQueue(QUEUE).held, []);
  const all = { canManageAgentId: () => true, canManageTeamId: () => true };
  const out = scopePendingQueue({ agents: [null, { count: 1 }], held: [{ agentId: 'x', count: 1 }] }, all);
  assert.deepEqual(out.agents, []);
  assert.deepEqual(out.held, []);
  assert.deepEqual(scopePendingQueue(null, all), { agents: [], total: 0, held: [], heldTotal: 0 });
});

test('does not mutate the orchestrator body', () => {
  const copy = JSON.parse(JSON.stringify(QUEUE));
  scopePendingQueue(QUEUE, predicatesFor('admin-alpha@example.com'));
  assert.deepEqual(QUEUE, copy);
});
