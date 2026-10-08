'use strict';

// The team's conflict-solver role (#2879), shared by the Flow Copilot's gate
// hints (flow-copilot-readiness.js) and the graph lint that asks for PR
// hand-offs to route merge conflicts to it (process-graph.js).
//
// Works on bundle roles and on graph nodes alike: both carry `id`,
// `displayName`, `role`, `triggers` (`type`, `events`, `labelFilter`) and
// `channels` (`artifact`, `label`).

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * The conflict-solver role: one that listens for `pull_request.merge_conflict`,
 * else one whose id / name / role says "conflict". Its wake label is the label
 * it is woken on. null when the team has none, or when it has no label to be
 * woken on.
 */
function findConflictSolver(bundle) {
  const roles = arr(bundle && bundle.roles).filter(r => isObj(r) && r.id);
  const byEvent = roles.find(r => arr(r.triggers).some(t => isObj(t) && arr(t.events).includes('pull_request.merge_conflict')));
  const byName = roles.find(r => /conflict/i.test([r.id, r.displayName, r.role].map(str).join(' ')));
  const role = byEvent || byName;
  if (!role) return null;
  const listener = arr(role.triggers).find(t => isObj(t) && t.type === 'github-event' && str(t.labelFilter));
  const channel = arr(role.channels).find(c => isObj(c) && c.artifact === 'pr' && str(c.label));
  const wakeLabel = listener ? str(listener.labelFilter) : (channel ? str(channel.label) : '');
  return wakeLabel ? { id: role.id, wakeLabel } : null;
}

module.exports = { findConflictSolver };
