'use strict';

// Pool instance lanes — the read-only "Live surface" from Amendment 2 A2.2
// (#2273, epic #2251). Configuration without observation is half the feature:
// this module answers "which instances are running, which are held, per
// pooled role" without any new persistence — it derives everything from data
// two other sweeps already compute.
//
// THE SHAPE, mirroring `admission-control.js`/`agent-pool.js`: pure core, no
// fs, no network, no clock of its own (`now` is always injected).
// `orchestrator.js` is the I/O adapter: it reads each pooled role's live
// instance configs, the team's admission lane, and the ticket ledger
// (`GET /internal/teams/:id/tickets`), then calls in here.
//
// FOUR TAGS, not a general status enum:
//
//   running        — a live pool instance, within its configured runtime budget.
//   waiting        — a live pool instance that is idle with an open linked PR
//                     (#2789): kept alive so review feedback returns to it.
//                     Outside the role's cap and never timed out. `prs` names
//                     the open PR numbers (empty when GitHub could not be read).
//   timed-out      — a live pool instance past its `pool.teardown.maxRuntimeMs`
//                     (time spent waiting does not count, #2789)
//                     (`agent-pool.js`'s `isInstanceTimedOut` — the hard-timeout
//                     reaper's own predicate, reused so the lane view can never
//                     disagree with what will actually get reaped).
//   held-same-epic — no instance has spawned yet, but the ticket ledger shows
//                     this role's OWN next-in-line ticket shares an `epicId`
//                     with one already running under this role. This is
//                     Amendment 1 A1.4's epic-serialization rule (always on,
//                     never gated by `contentionPolicy`) made visible — the
//                     one contention reason worth naming, because it is the
//                     one every pooled role always enforces.
//
// A ticket that is simply not yet dispatched, or held on the team's `wipLimit`
// for a reason OTHER than epic-serialization, gets no lane here — the Flow
// Control board's existing `HeldPanel` (#2250) already surfaces WIP-limit
// holds team-wide; duplicating that per-role would be a second, driftable
// rendering of the same fact rather than a new one.

const { isInstanceTimedOut } = require('./agent-pool');

// Ticket-ledger states in which a ticket is still active work for its owning
// role — mirrors `orchestrator.js`'s own `FLOW_SUPERVISOR_ACTIVE_STATES`
// (kept as a private copy: importing orchestrator.js for one Set literal
// would drag in the whole I/O module, which boots servers on require).
const ACTIVE_TICKET_STATES = new Set(['ready', 'in-dev', 'in-review', 'rework', 'doc', 'mergeable']);

function ticketKey(repo, number) {
  return `${repo}#${Number(number)}`;
}

// One live instance's tag — `waiting`, `timed-out` or `running` — shared by the
// lanes below and `liveInstanceRows` (#2814), so the Flow Editor's role-node
// hint can never disagree with the lane view or the hard-timeout reaper.
function instanceStatus(inst, maxRuntimeMs, now) {
  if (inst && inst.waiting) return 'waiting';
  const waitedMs = Number.isFinite(inst && inst.waitedMs) ? inst.waitedMs : 0;
  return isInstanceTimedOut({ spawnedAt: inst && inst.spawnedAt, maxRuntimeMs, waitedMs }, now)
    ? 'timed-out' : 'running';
}

/**
 * Every live instance of ONE pooled role as `{instanceId, item, status}`
 * (#2814) — the Flow Editor's per-role instance list. Unlike the lanes, an
 * instance without a repo/item is still listed (it is still live capacity);
 * no ticket ledger is needed, so the cheap `pool-control` read can carry it.
 * Sorted by item number, then id, for a stable list.
 *
 * @param {object} args
 * @param {{maxRuntimeMs:number|null}} args.role
 * @param {Array<object>} [args.instances] - same shape as `buildPoolInstanceLanes`.
 * @param {number} [args.now]
 */
function liveInstanceRows({ role, instances = [], now = Date.now() }) {
  const maxRuntimeMs = role && Number.isFinite(role.maxRuntimeMs) && role.maxRuntimeMs > 0 ? role.maxRuntimeMs : null;
  return (Array.isArray(instances) ? instances : [])
    .filter((inst) => inst && typeof inst === 'object' && inst.instanceId)
    .map((inst) => ({
      instanceId: inst.instanceId,
      item: inst.itemKey != null && Number.isFinite(Number(inst.itemKey)) ? Number(inst.itemKey) : null,
      status: instanceStatus(inst, maxRuntimeMs, now),
    }))
    .sort((a, b) => ((a.item ?? Infinity) - (b.item ?? Infinity)) || String(a.instanceId).localeCompare(String(b.instanceId)));
}

/**
 * Build the lane list for ONE pooled role (#2273).
 *
 * @param {object} args
 * @param {{roleId:string, agentId:string, maxInstances:number|null,
 *   maxRuntimeMs:number|null}} args.role - `agentId` is the role TEMPLATE's
 *   full agent id (what `ticket.ownerAgentId` names); `maxRuntimeMs` is the
 *   role's `pool.teardown.maxRuntimeMs` (null = no hard timeout).
 * @param {Array<{instanceId:string, repo:string|null, itemKey:number|null,
 *   spawnedAt:string|null, waiting?:boolean, prs?:number[], waitedMs?:number}>}
 *   [args.instances] - the role's LIVE pool instances only
 *   (`_liveInstanceIdsForRole` + each instance's own
 *   `poolRepo`/`poolItem`/`poolSpawnedAt`, plus the #2789 waiting record).
 * @param {Array<object>} [args.tickets] - the team's full ticket ledger
 *   (`computeTeamTicketLedger`'s `tickets` array) — each entry carries at
 *   least `{ticketId, repo, number, epicId, state, ownerAgentId}`.
 * @param {number} [args.now]
 * @returns {{roleId:string|null, agentId:string|null,
 *   maxInstances:number|null, lanes: Array<{instanceId:string|null,
 *   ticketId:string, repo:string, number:number, epicId:*, status:string,
 *   spawnedAt:string|null, sameEpicAs:string|null}>}}
 */
function buildPoolInstanceLanes({ role, instances = [], tickets = [], now = Date.now() }) {
  const roleAgentId = (role && role.agentId) || null;
  const maxRuntimeMs = role && Number.isFinite(role.maxRuntimeMs) && role.maxRuntimeMs > 0 ? role.maxRuntimeMs : null;

  const ticketByKey = new Map();
  for (const t of Array.isArray(tickets) ? tickets : []) {
    if (!t || typeof t !== 'object' || !t.repo || t.number == null) continue;
    ticketByKey.set(ticketKey(t.repo, t.number), t);
  }

  const lanes = [];
  const runningKeys = new Set();
  // First epicId → ticketId seen among this role's own running instances —
  // the "sameEpicAs" a held lane points at. Deterministic by insertion order
  // over `instances`, which the I/O side already lists in a stable order
  // (`_liveInstanceIdsForRole`'s own `listAgentIds()` walk).
  const runningEpicOwner = new Map();

  for (const inst of Array.isArray(instances) ? instances : []) {
    if (!inst || typeof inst !== 'object' || !inst.repo || inst.itemKey == null) continue;
    const key = ticketKey(inst.repo, inst.itemKey);
    const ticket = ticketByKey.get(key) || null;
    runningKeys.add(key);
    if (ticket && ticket.epicId != null && !runningEpicOwner.has(ticket.epicId)) {
      runningEpicOwner.set(ticket.epicId, ticket.ticketId || key);
    }
    lanes.push({
      instanceId: inst.instanceId || null,
      ticketId: ticket ? ticket.ticketId : key,
      repo: inst.repo,
      number: Number(inst.itemKey),
      epicId: ticket ? (ticket.epicId ?? null) : null,
      status: instanceStatus(inst, maxRuntimeMs, now),
      spawnedAt: inst.spawnedAt || null,
      sameEpicAs: null,
      ...(inst.waiting ? { prs: Array.isArray(inst.prs) ? inst.prs.slice() : [] } : {}),
    });
  }

  // held-same-epic: every OTHER ticket the ledger already routes to this role
  // (`ownerAgentId === role.agentId`, still active) that has not itself
  // spawned an instance yet, and shares an epic with one that has.
  for (const ticket of ticketByKey.values()) {
    if (!roleAgentId || ticket.ownerAgentId !== roleAgentId) continue;
    if (!ACTIVE_TICKET_STATES.has(ticket.state)) continue;
    const key = ticketKey(ticket.repo, ticket.number);
    if (runningKeys.has(key)) continue; // already has its own lane above
    if (ticket.epicId == null) continue;
    const sameEpicAs = runningEpicOwner.get(ticket.epicId);
    if (!sameEpicAs) continue;
    lanes.push({
      instanceId: null,
      ticketId: ticket.ticketId || key,
      repo: ticket.repo,
      number: Number(ticket.number),
      epicId: ticket.epicId,
      status: 'held-same-epic',
      spawnedAt: null,
      sameEpicAs,
    });
  }

  lanes.sort((a, b) => String(a.ticketId).localeCompare(String(b.ticketId)));

  return {
    roleId: (role && role.roleId) || null,
    agentId: roleAgentId,
    maxInstances: role && role.maxInstances != null ? role.maxInstances : null,
    lanes,
  };
}

/**
 * Build lanes for every pooled role of a team in one pass, so the caller
 * needs one ticket-ledger fetch shared across all roles.
 *
 * @param {Array<{role:object, instances:Array<object>}>} roleInputs
 * @param {Array<object>} tickets
 * @param {number} [now]
 */
function buildTeamPoolLanes(roleInputs, tickets, now = Date.now()) {
  return (Array.isArray(roleInputs) ? roleInputs : []).map(({ role, instances }) =>
    buildPoolInstanceLanes({ role, instances, tickets, now }));
}

module.exports = {
  ACTIVE_TICKET_STATES,
  ticketKey,
  isInstanceTimedOut,
  instanceStatus,
  liveInstanceRows,
  buildPoolInstanceLanes,
  buildTeamPoolLanes,
};
