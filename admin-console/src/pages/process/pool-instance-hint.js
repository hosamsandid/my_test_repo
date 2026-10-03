// Pure view helpers for a pooled role's live instances in the Flow Editor of a
// live team (#2814). Auto-scaled pool instances are no longer graph nodes
// (the server's live graph builders leave them out); instead the role's node
// carries a compact "n running" hint and the Node Inspector lists them.
// Dependency-free so it unit-tests under `node --test` (#651).
//
// Source of truth: the team's `GET /api/teams/:teamId/pool-control` read —
// each `roles[]` row's `instances` (`[{instanceId, item, status}]`), built by
// the orchestrator with the pool-instance lane view's own instance read and
// status rule, so the hint never disagrees with what the reapers act on.

const STATUS_TEXT = {
  running: 'running',
  waiting: 'waiting for PR',
  'timed-out': 'timed out',
};

/** Human label for one instance status; unknown statuses pass through. */
export function instanceStatusText(status) {
  return STATUS_TEXT[status] || String(status || 'running');
}

/** `#71` for an instance on item 71; the bare instance id when it has none. */
export function instanceLabel(inst) {
  return inst && Number.isInteger(inst.item) ? `#${inst.item}` : String((inst && inst.instanceId) || '');
}

/**
 * The hint for one role (`memberId` = the role's own agent id), or `null` when
 * it has no live instance — the node then looks exactly as it did before.
 * `{ count, text, title, instances: [{ instanceId, label, status, statusText }] }`.
 */
export function poolInstanceHint(poolControl, memberId) {
  const roles = poolControl && Array.isArray(poolControl.roles) ? poolControl.roles : [];
  const row = roles.find((r) => r && r.agentId === memberId);
  const list = row && Array.isArray(row.instances) ? row.instances.filter((i) => i && i.instanceId) : [];
  if (!list.length) return null;
  const instances = list.map((i) => ({
    instanceId: i.instanceId,
    label: instanceLabel(i),
    status: i.status || 'running',
    statusText: instanceStatusText(i.status),
  }));
  const count = instances.length;
  return {
    count,
    text: `${count} running`,
    title: `${count} live instance${count === 1 ? '' : 's'} of this role: `
      + instances.map((i) => `${i.label} (${i.statusText})`).join(', '),
    instances,
  };
}

/** `{ [roleAgentId]: hint }` for every role of the read with a live instance. */
export function poolInstanceHintsByNode(poolControl) {
  const out = {};
  const roles = poolControl && Array.isArray(poolControl.roles) ? poolControl.roles : [];
  for (const r of roles) {
    if (!r || !r.agentId) continue;
    const hint = poolInstanceHint(poolControl, r.agentId);
    if (hint) out[r.agentId] = hint;
  }
  return out;
}

/** Whether an `/api/agents` row is an auto-scaled pool instance (config flag, never id shape). */
export function isPoolInstanceRow(agent) {
  return !!(agent && agent.poolInstance === true);
}

/**
 * `{ [instanceId]: roleAgentId }` from the `/api/agents` list, so a per-agent
 * figure the orchestrator attributes to an instance (e.g. a flow anomaly) is
 * shown on its role's node instead of on a node that no longer exists.
 */
export function poolInstanceRoleMap(agents) {
  const out = {};
  for (const a of Array.isArray(agents) ? agents : []) {
    if (isPoolInstanceRow(a) && typeof a.poolOf === 'string' && a.poolOf) out[a.id] = a.poolOf;
  }
  return out;
}
