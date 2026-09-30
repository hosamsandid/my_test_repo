'use strict';

// #2119 (Flow Control §4.6): the viewer-scoped cut of the orchestrator's
// aggregated pending queue (`/internal/pending-queue`, served unscoped).
//
// Until #2119 the read and cancel routes answered any signed-in user, so anyone
// could read every agent's queue — GitHub payloads and trigger prompts included
// — and cancel any entry in it. The queue is an operator surface, so it now
// carries the MANAGEMENT bar its neighbour, the #2102 reassignment, already
// did: an agent's waiting entries are shown to whoever may manage that agent,
// and to nobody else.
//
// Two sections, two predicates, each matching the action that section offers:
//
//  - `agents[]` (the per-agent pending-triggers.json queues) — `canManageAgent`
//    on the agent. That is the gate on the entry's own cancel/reassign routes,
//    so a row is listed exactly when its buttons would be honoured.
//  - `held[]` (dispatches held behind a team's WIP lane, #2114) — `canManageTeam`
//    on the lane's team. That is the gate on `POST /api/teams/:teamId/force-dispatch`,
//    the one action a held row offers.
//
// Totals are recomputed from what survives, so a count never leaks the size of
// a queue the viewer may not see.
//
// Pure: the route injects the two predicates, already bound to the caller's
// scope and to the agent-config lookup.

function scopePendingQueue(body, { canManageAgentId, canManageTeamId } = {}) {
  const src = body && typeof body === 'object' ? body : {};
  const agentOk = typeof canManageAgentId === 'function' ? canManageAgentId : () => false;
  const teamOk = typeof canManageTeamId === 'function' ? canManageTeamId : () => false;

  const agents = (Array.isArray(src.agents) ? src.agents : [])
    .filter((g) => g && typeof g.agentId === 'string' && agentOk(g.agentId));
  const held = (Array.isArray(src.held) ? src.held : [])
    .filter((g) => g && typeof g.teamId === 'string' && teamOk(g.teamId));

  const count = (groups) => groups.reduce((n, g) => n + (Number.isFinite(g.count) ? g.count : 0), 0);
  return {
    ...src,
    agents,
    total: count(agents),
    held,
    heldTotal: count(held),
  };
}

module.exports = { scopePendingQueue };
