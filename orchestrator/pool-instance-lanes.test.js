'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lanes = require('./pool-instance-lanes');

const ROLE = { roleId: 'developer', agentId: 'acme-developer', maxInstances: 4, maxRuntimeMs: null };

function ticket(overrides) {
  return {
    ticketId: 'acme/widgets#1',
    repo: 'acme/widgets',
    number: 1,
    epicId: null,
    state: 'in-dev',
    ownerAgentId: 'acme-developer',
    ...overrides,
  };
}

function instance(overrides) {
  return {
    instanceId: 'acme-developer-i1',
    repo: 'acme/widgets',
    itemKey: 1,
    spawnedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ─── running / timed-out ─────────────────────────────────────────────────

test('a live instance with no configured runtime budget is running', () => {
  const out = lanes.buildPoolInstanceLanes({
    role: ROLE,
    instances: [instance()],
    tickets: [ticket()],
    now: Date.parse('2026-01-01T05:00:00.000Z'),
  });
  assert.equal(out.roleId, 'developer');
  assert.equal(out.agentId, 'acme-developer');
  assert.equal(out.maxInstances, 4);
  assert.equal(out.lanes.length, 1);
  assert.deepEqual(out.lanes[0], {
    instanceId: 'acme-developer-i1',
    ticketId: 'acme/widgets#1',
    repo: 'acme/widgets',
    number: 1,
    epicId: null,
    status: 'running',
    spawnedAt: '2026-01-01T00:00:00.000Z',
    sameEpicAs: null,
  });
});

test('a live instance past its maxRuntimeMs is tagged timed-out, not running', () => {
  const role = { ...ROLE, maxRuntimeMs: 3_600_000 };
  const out = lanes.buildPoolInstanceLanes({
    role,
    instances: [instance()],
    tickets: [ticket()],
    now: Date.parse('2026-01-01T00:00:00.000Z') + 3_600_000,
  });
  assert.equal(out.lanes[0].status, 'timed-out');
});

test('a live instance within its maxRuntimeMs budget stays running', () => {
  const role = { ...ROLE, maxRuntimeMs: 3_600_000 };
  const out = lanes.buildPoolInstanceLanes({
    role,
    instances: [instance()],
    tickets: [ticket()],
    now: Date.parse('2026-01-01T00:00:00.000Z') + 1_000,
  });
  assert.equal(out.lanes[0].status, 'running');
});

test('a live instance with no matching ledger ticket still gets a lane, keyed on repo#itemKey', () => {
  const out = lanes.buildPoolInstanceLanes({
    role: ROLE,
    instances: [instance({ itemKey: 99 })],
    tickets: [],
  });
  assert.equal(out.lanes.length, 1);
  assert.equal(out.lanes[0].ticketId, 'acme/widgets#99');
  assert.equal(out.lanes[0].epicId, null);
  assert.equal(out.lanes[0].status, 'running');
});

// ─── held-same-epic ──────────────────────────────────────────────────────

test('a not-yet-spawned ticket sharing an epic with a running instance is held-same-epic', () => {
  const out = lanes.buildPoolInstanceLanes({
    role: ROLE,
    instances: [instance({ itemKey: 412 })],
    tickets: [
      ticket({ ticketId: 'acme/widgets#412', number: 412, epicId: 100 }),
      ticket({ ticketId: 'acme/widgets#421', number: 421, epicId: 100, state: 'ready' }),
    ],
  });
  assert.equal(out.lanes.length, 2);
  const running = out.lanes.find((l) => l.ticketId === 'acme/widgets#412');
  const held = out.lanes.find((l) => l.ticketId === 'acme/widgets#421');
  assert.equal(running.status, 'running');
  assert.equal(held.status, 'held-same-epic');
  assert.equal(held.instanceId, null);
  assert.equal(held.sameEpicAs, 'acme/widgets#412');
});

test('a not-yet-spawned ticket with no epic in common with any running instance gets no lane', () => {
  const out = lanes.buildPoolInstanceLanes({
    role: ROLE,
    instances: [instance({ itemKey: 412 })],
    tickets: [
      ticket({ ticketId: 'acme/widgets#412', number: 412, epicId: 100 }),
      ticket({ ticketId: 'acme/widgets#500', number: 500, epicId: 200, state: 'ready' }),
    ],
  });
  assert.equal(out.lanes.length, 1);
  assert.equal(out.lanes[0].ticketId, 'acme/widgets#412');
});

test('a ready ticket with epicId null gets no held-same-epic lane (nothing to attribute it to)', () => {
  const out = lanes.buildPoolInstanceLanes({
    role: ROLE,
    instances: [instance({ itemKey: 412 })],
    tickets: [
      ticket({ ticketId: 'acme/widgets#412', number: 412, epicId: 100 }),
      ticket({ ticketId: 'acme/widgets#500', number: 500, epicId: null, state: 'ready' }),
    ],
  });
  assert.equal(out.lanes.length, 1);
});

test('a ticket owned by a DIFFERENT role never becomes a held-same-epic lane here', () => {
  const out = lanes.buildPoolInstanceLanes({
    role: ROLE,
    instances: [instance({ itemKey: 412 })],
    tickets: [
      ticket({ ticketId: 'acme/widgets#412', number: 412, epicId: 100 }),
      ticket({
        ticketId: 'acme/widgets#421', number: 421, epicId: 100, state: 'ready', ownerAgentId: 'acme-reviewer',
      }),
    ],
  });
  assert.equal(out.lanes.length, 1);
});

test('a done ticket sharing an epic with a running instance is not surfaced as held (it is finished, not waiting)', () => {
  const out = lanes.buildPoolInstanceLanes({
    role: ROLE,
    instances: [instance({ itemKey: 412 })],
    tickets: [
      ticket({ ticketId: 'acme/widgets#412', number: 412, epicId: 100 }),
      ticket({ ticketId: 'acme/widgets#380', number: 380, epicId: 100, state: 'done' }),
    ],
  });
  assert.equal(out.lanes.length, 1);
});

test('a backlog ticket for this role is never surfaced (not yet dispatched at all)', () => {
  const out = lanes.buildPoolInstanceLanes({
    role: ROLE,
    instances: [],
    tickets: [ticket({ state: 'backlog', epicId: 5 })],
  });
  assert.equal(out.lanes.length, 0);
});

// ─── ordering / determinism ──────────────────────────────────────────────

test('lanes are sorted by ticketId for a stable render across refreshes', () => {
  const out = lanes.buildPoolInstanceLanes({
    role: ROLE,
    instances: [instance({ itemKey: 9 }), instance({ instanceId: 'acme-developer-i2', itemKey: 2 })],
    tickets: [
      ticket({ ticketId: 'acme/widgets#9', number: 9 }),
      ticket({ ticketId: 'acme/widgets#2', number: 2 }),
    ],
  });
  assert.deepEqual(out.lanes.map((l) => l.ticketId), ['acme/widgets#2', 'acme/widgets#9']);
});

test('no instances and no candidate tickets yields an empty lane list, not an error', () => {
  const out = lanes.buildPoolInstanceLanes({ role: ROLE, instances: [], tickets: [] });
  assert.deepEqual(out.lanes, []);
});

test('a malformed role/instances/tickets input degrades to empty rather than throwing', () => {
  assert.deepEqual(lanes.buildPoolInstanceLanes({ role: null }).lanes, []);
  assert.equal(lanes.buildPoolInstanceLanes({ role: null }).roleId, null);
  assert.deepEqual(lanes.buildPoolInstanceLanes({ role: ROLE, instances: null, tickets: null }).lanes, []);
  assert.deepEqual(lanes.buildPoolInstanceLanes({ role: ROLE, instances: [null, 'x', 42], tickets: [null, 'x'] }).lanes, []);
});

// ─── buildTeamPoolLanes ──────────────────────────────────────────────────

test('buildTeamPoolLanes computes each role independently, sharing one ticket ledger', () => {
  const reviewer = { roleId: 'reviewer', agentId: 'acme-reviewer', maxInstances: 2, maxRuntimeMs: null };
  const tickets = [
    ticket({ ticketId: 'acme/widgets#412', number: 412, epicId: 100, ownerAgentId: 'acme-developer' }),
    ticket({ ticketId: 'acme/widgets#407', number: 407, epicId: null, ownerAgentId: 'acme-reviewer' }),
  ];
  const out = lanes.buildTeamPoolLanes(
    [
      { role: ROLE, instances: [instance({ itemKey: 412 })] },
      { role: reviewer, instances: [instance({ instanceId: 'acme-reviewer-i407', itemKey: 407 })] },
    ],
    tickets,
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].roleId, 'developer');
  assert.equal(out[0].lanes[0].ticketId, 'acme/widgets#412');
  assert.equal(out[1].roleId, 'reviewer');
  assert.equal(out[1].lanes[0].ticketId, 'acme/widgets#407');
});

test('buildTeamPoolLanes on an empty role list returns an empty array', () => {
  assert.deepEqual(lanes.buildTeamPoolLanes([], []), []);
  assert.deepEqual(lanes.buildTeamPoolLanes(null, null), []);
});

// #2789 — instances waiting on an open PR.

test('#2789: an instance waiting on an open PR is tagged waiting, with its PRs, never timed-out', () => {
  const out = lanes.buildPoolInstanceLanes({
    role: { ...ROLE, maxRuntimeMs: 60_000 },
    instances: [instance({ waiting: true, prs: [40], waitedMs: 0 })],
    tickets: [ticket()],
    now: Date.parse('2026-01-02T00:00:00.000Z'),
  });
  assert.equal(out.lanes[0].status, 'waiting');
  assert.deepEqual(out.lanes[0].prs, [40]);
});

test('#2789 AC2: time spent waiting is left out of the lane timed-out test, like the reaper', () => {
  const now = Date.parse('2026-01-01T00:02:00.000Z');
  const role = { ...ROLE, maxRuntimeMs: 100_000 };
  const plain = lanes.buildPoolInstanceLanes({ role, instances: [instance()], tickets: [ticket()], now });
  assert.equal(plain.lanes[0].status, 'timed-out');
  const waited = lanes.buildPoolInstanceLanes({ role, instances: [instance({ waitedMs: 60_000 })], tickets: [ticket()], now });
  assert.equal(waited.lanes[0].status, 'running');
  assert.equal('prs' in waited.lanes[0], false, 'only waiting lanes carry prs');
});

// ─── #2814: per-role instance rows for the Flow Editor's role-node hint ─────

test('#2814 liveInstanceRows: one row per live instance with its item number and the lane status rule', () => {
  const now = Date.parse('2026-01-01T02:00:00.000Z');
  const rows = lanes.liveInstanceRows({
    role: { maxRuntimeMs: 60 * 60 * 1000 },
    now,
    instances: [
      instance({ instanceId: 'acme-developer-i71', itemKey: 71, spawnedAt: '2026-01-01T01:30:00.000Z' }),
      instance({ instanceId: 'acme-developer-i9', itemKey: 9, spawnedAt: '2026-01-01T00:00:00.000Z' }),
      instance({ instanceId: 'acme-developer-i12', itemKey: 12, waiting: true, prs: [40] }),
    ],
  });
  assert.deepEqual(rows, [
    { instanceId: 'acme-developer-i9', item: 9, status: 'timed-out' },
    { instanceId: 'acme-developer-i12', item: 12, status: 'waiting' },
    { instanceId: 'acme-developer-i71', item: 71, status: 'running' },
  ]);
});

test('#2814 liveInstanceRows: waiting time does not count toward the timeout, like the reaper', () => {
  const now = Date.parse('2026-01-01T02:00:00.000Z');
  const rows = lanes.liveInstanceRows({
    role: { maxRuntimeMs: 60 * 60 * 1000 },
    now,
    instances: [instance({ spawnedAt: '2026-01-01T00:00:00.000Z', waitedMs: 90 * 60 * 1000 })],
  });
  assert.equal(rows[0].status, 'running');
});

test('#2814 liveInstanceRows: an instance without a repo/item is still listed; junk is dropped', () => {
  const rows = lanes.liveInstanceRows({
    role: { maxRuntimeMs: null },
    instances: [instance({ repo: null, itemKey: null }), null, { repo: 'x' }],
  });
  assert.deepEqual(rows, [{ instanceId: 'acme-developer-i1', item: null, status: 'running' }]);
});

test('#2814 instanceStatus agrees with the lane tag for the same instance', () => {
  const now = Date.parse('2026-01-01T02:00:00.000Z');
  const role = { ...ROLE, maxRuntimeMs: 60 * 60 * 1000 };
  for (const inst of [instance(), instance({ waiting: true, prs: [] }), instance({ spawnedAt: '2026-01-01T01:59:00.000Z' })]) {
    const lane = lanes.buildPoolInstanceLanes({ role, instances: [inst], tickets: [], now }).lanes[0];
    assert.equal(lanes.instanceStatus(inst, role.maxRuntimeMs, now), lane.status);
  }
});
