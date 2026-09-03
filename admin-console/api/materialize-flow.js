'use strict';

// ─── materialize-flow (Unified Orchestration, #362 / #368) ───────────────────
//
// Materialization adapter seam. A unified flow used to hold nodes of two
// provenances, each with its own runtime lifecycle:
//
//   • team/process nodes → materialised via POST /api/teams (templateToCustomRoles)
//   • BP nodes (role 'bp-instance' / 'orchestrator') → the orchestrator claim
//     loop (git-commit-to-claim + manual hand-off semantics)
//
// #1962 removed the BriefingPack model, so **the second provenance no longer
// exists**: both roles are gone, nothing creates them, and the claim loop they
// dispatched to has been deleted. `classifyNodeProvenance` therefore answers
// 'team' for every node, and the BP adapter slot is gone rather than left
// permanently unreachable.
//
// The seam itself is kept, deliberately unchanged in shape, because the
// north-star it was built for (epic decision 3 of #362: convergence onto
// /api/teams) is unaffected — this module has always been injected-adapter
// only and changes neither runtime. Worth knowing for whoever picks up epic
// #1961's Phase 4 (the Flows page): with one provenance left, nothing in the
// repository imports this module any more, so Phase 4 should decide whether it
// still earns its place or should go with the rest of the BP flow surface.

function classifyNodeProvenance(node) {
  void node;
  // One provenance since #1962 — see the header. Kept as a named function so
  // the seam's vocabulary survives if a second runtime is ever added back.
  return 'team';
}

// Group a flow's nodes by which runtime materialises them.
function planMaterialization(flow) {
  const nodes = Array.isArray(flow && flow.nodes) ? flow.nodes : [];
  const team = [];
  for (const n of nodes) {
    team.push(n);
  }
  return { team };
}

/**
 * Build a materialiser that dispatches each provenance group to its adapter.
 * @param {{
 *   team?: (nodes, flow) => Promise<any>,  // e.g. wraps POST /api/teams
 * }} adapters
 */
function createMaterializer(adapters = {}) {
  return async function materialize(flow) {
    const plan = planMaterialization(flow);
    const results = {};
    if (plan.team.length && adapters.team) results.team = await adapters.team(plan.team, flow);
    return { plan, results };
  };
}

module.exports = { classifyNodeProvenance, planMaterialization, createMaterializer };
