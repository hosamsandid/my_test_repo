'use strict';

// Live re-derivation of a team's data-flow push triggers from its members'
// declarative ports (the pure core of api.js `reconcileTeamDataFlow`).
//
// A derived data-flow trigger is one the `expandDataFlowSteps` derivation owns:
// it carries the `dataFlow` marker and the canonical `<consumer>-on-push-<up>`
// id. Two id shapes exist on live agents: the reconciler's full member ids
// (`<member>-on-push-<upstreamMember>`) and the materialiser's role keys
// (`<role>-on-push-<upstreamRole>`, member ids being `<team>-<role>`) left by a
// team created from a Flow-editor bundle. Both must be recognised, or re-pointing
// / removing the edge on such a team leaves the role-key trigger — and, since
// #2571, its `pushedBy` naming the OLD upstream — in place next to the new one.
// Manually-authored data-flow triggers (arbitrary ids) don't match and are
// preserved untouched.

const { expandDataFlowSteps, stampDerivedActivation } = require('./process-template');

// `<role>-on-push-` prefix of a member's role-key derived ids, or null when the
// member id is not `<team>-<role>`.
function roleKeyPrefix(memberId, teamId) {
  const team = `${teamId}-`;
  if (!teamId || typeof memberId !== 'string' || !memberId.startsWith(team)) return null;
  return `${memberId.slice(team.length)}-on-push-`;
}

function isDerivedDataFlowTrigger(t, memberId, teamId) {
  if (!t || t.dataFlow !== true || typeof t.id !== 'string') return false;
  if (t.id.startsWith(`${memberId}-on-push-`)) return true;
  const short = roleKeyPrefix(memberId, teamId);
  return !!short && t.id.startsWith(short);
}

// The previous triggers with each role-key derived id rewritten to its full-id
// replacement (`<member>-on-push-<team>-<upRole>`), so `stampDerivedActivation`
// (id-match only) carries the old history horizon over instead of stamping
// "now" and dropping a push that is still pending. A full-id trigger already
// present wins.
function rekeyRoleKeyDerived(prevTriggers, memberId, teamId) {
  const list = Array.isArray(prevTriggers) ? prevTriggers : [];
  const short = roleKeyPrefix(memberId, teamId);
  if (!short) return list;
  const ids = new Set(list.map(t => t && t.id));
  return list.map((t) => {
    if (!t || t.dataFlow !== true || typeof t.id !== 'string' || !t.id.startsWith(short)) return t;
    const full = `${memberId}-on-push-${teamId}-${t.id.slice(short.length)}`;
    return ids.has(full) ? t : { ...t, id: full };
  });
}

/**
 * Re-derive every member's triggers from its ports.
 * @param {string} teamId
 * @param {{id:string, displayName?:string, triggers:object[], df:object}[]} members
 * @param {string} [now] - injectable activation stamp (tests)
 * @returns {Map<string, object[]>} member id → next trigger array (repo not injected)
 */
function rederiveTeamDataFlow(teamId, members, now) {
  const roles = members.map(m => ({
    id: m.id,
    displayName: m.displayName || m.id,
    inputs: Array.isArray(m.df.inputs) ? m.df.inputs : [],
    outputs: Array.isArray(m.df.outputs) ? m.df.outputs : [],
    dependsOn: Array.isArray(m.df.dependsOn) ? m.df.dependsOn : [],
    triggers: m.triggers.filter(t => !isDerivedDataFlowTrigger(t, m.id, teamId)),
  }));
  const byId = new Map(expandDataFlowSteps({ roles }).roles.map(r => [r.id, r]));
  const out = new Map();
  for (const m of members) {
    out.set(m.id, stampDerivedActivation(
      byId.get(m.id)?.triggers || [],
      rekeyRoleKeyDerived(m.triggers, m.id, teamId),
      now,
    ));
  }
  return out;
}

module.exports = { isDerivedDataFlowTrigger, rekeyRoleKeyDerived, rederiveTeamDataFlow };
