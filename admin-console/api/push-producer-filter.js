'use strict';

// Write-side validation of the optional "pushed by agent" producer filter on
// push triggers (#2571). The poller (orchestrator/github-poller.js +
// push-attribution.js) fires a trigger carrying `pushedBy: [agentId, …]` only on
// a push the platform recorded as made by one of those agents — or a pool
// instance of one — from the trigger owner's own Agent Team.
//
// Field contract, as stored on the trigger:
//   absent / `null`  → no filter (any push; `null` on a write clears the field)
//   `[]`             → explicitly "any push" — kept, so the start-up migration
//                      and the data-flow reconciler never re-add a filter a
//                      human removed from a derived hand-off
//   `[ids…]`         → same-team member ids (never a pool instance — the role
//                      id already covers its instances)
//
// Pure: the caller supplies `lookupAgent(id) → config | null`.

function teamOfConfig(cfg) {
  return cfg && typeof cfg.parentTeamId === 'string' && cfg.parentTeamId ? cfg.parentTeamId : null;
}

/**
 * Validate + normalise `trigger.pushedBy` in place-free fashion.
 * @param {object} trigger - the merged trigger about to be saved
 * @param {object} opts
 * @param {string} opts.ownerId - the agent that owns the trigger
 * @param {(id:string) => object|null} opts.lookupAgent - reads an agent config
 * @returns {{error: string} | {trigger: object}} a new trigger object on success
 */
function applyPushedBy(trigger, { ownerId, lookupAgent }) {
  if (!trigger || !Object.prototype.hasOwnProperty.call(trigger, 'pushedBy')) return { trigger };
  const raw = trigger.pushedBy;
  if (raw === null || raw === undefined) {
    const { pushedBy: _drop, ...rest } = trigger;
    return { trigger: rest };
  }
  if (!Array.isArray(raw)) return { error: 'pushedBy must be an array of agent ids' };
  const ids = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !v.trim()) return { error: 'pushedBy must be an array of agent ids' };
    const id = v.trim();
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return { trigger: { ...trigger, pushedBy: [] } };

  const events = Array.isArray(trigger.events) ? trigger.events : [];
  if (trigger.type !== 'github-event' || !events.includes('push')) {
    return { error: 'pushedBy (producer filter) applies to push triggers only' };
  }
  const ownerTeam = teamOfConfig(lookupAgent(ownerId));
  if (!ownerTeam) return { error: 'pushedBy (producer filter) needs an agent that belongs to an Agent Team' };
  for (const id of ids) {
    const cfg = lookupAgent(id);
    if (!cfg || teamOfConfig(cfg) !== ownerTeam) {
      return { error: `pushedBy: '${id}' is not an agent of this Agent Team` };
    }
    if (cfg.poolInstance) {
      return { error: `pushedBy: '${id}' is a pool instance — name its role${cfg.poolOf ? ` ('${cfg.poolOf}')` : ''} instead` };
    }
  }
  return { trigger: { ...trigger, pushedBy: ids } };
}

module.exports = { applyPushedBy };
