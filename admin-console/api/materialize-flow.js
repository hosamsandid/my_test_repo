'use strict';

// ─── materialize-flow (Unified Orchestration, #362 / #368) ───────────────────
//
// Materialization adapter seam. A unified flow can hold nodes of two
// provenances, each with its own runtime lifecycle today:
//
//   • team/process nodes → materialised via POST /api/teams (templateToCustomRoles)
//   • BP nodes (role 'bp-instance' / 'orchestrator') → the orchestrator claim
//     loop (git-commit-to-claim + manual hand-off semantics)
//
// This module is the ONE interface over both. It does not change either runtime —
// the adapters are injected, so today they delegate to the existing paths. The
// north-star (epic decision 3) is convergence onto /api/teams; this seam makes
// that possible later without rebuilding the BP claim/git path under risk now.

function classifyNodeProvenance(node) {
  const role = node && node.role;
  if (role === 'bp-instance' || role === 'orchestrator') return 'bp';
  return 'team';
}

// Group a flow's nodes by which runtime materialises them.
function planMaterialization(flow) {
  const nodes = Array.isArray(flow && flow.nodes) ? flow.nodes : [];
  const team = [];
  const bp = [];
  for (const n of nodes) {
    (classifyNodeProvenance(n) === 'bp' ? bp : team).push(n);
  }
  return { team, bp };
}

/**
 * Build a materialiser that dispatches each provenance group to its adapter.
 * @param {{
 *   team?: (nodes, flow) => Promise<any>,  // e.g. wraps POST /api/teams
 *   bp?:   (nodes, flow) => Promise<any>,  // e.g. wraps the orchestrator claim loop
 * }} adapters
 */
function createMaterializer(adapters = {}) {
  return async function materialize(flow) {
    const plan = planMaterialization(flow);
    const results = {};
    if (plan.team.length && adapters.team) results.team = await adapters.team(plan.team, flow);
    if (plan.bp.length && adapters.bp) results.bp = await adapters.bp(plan.bp, flow);
    return { plan, results };
  };
}

module.exports = { classifyNodeProvenance, planMaterialization, createMaterializer };
