// unified-render-adapter.js — ES module
//
// Bridges the unified orchestration graph (GET /api/flows/graph, edges keyed by
// `on`) onto the Process Canvas renderer's data contract (edges keyed by `kind`).
// Keeping the mapping here means the renderer (process-graph-render.js) does not
// have to fork its contract — it keeps consuming { nodes, edges:{kind}, gates,
// labels, lints }, and we additively taught it the dependency/artifact kinds.
//
//   on:'label'   → kind:'gate' when gate:'human', else kind:'agent' (orphan kept)
//   on:'event'   → kind:'agent', external:true (raw GitHub event; normalize drops)
//   on:'timer'   → kind:'timer'
//   on:'review'  → kind:'review' (reviewFlow / outcome preserved)
//   on:'dependency' → kind:'dependency'
//   on:'artifact'   → kind:'artifact', label = joined paths
//   on:'manual'  → kind:'manual'

function mapEdge(e) {
  switch (e.on) {
    case 'timer':
      return { ...e, kind: 'timer' };
    case 'review':
      return { ...e, kind: 'review' };
    case 'event':
      return { ...e, kind: 'agent', external: true };
    case 'dependency':
      return { ...e, kind: 'dependency' };
    case 'artifact':
      return { ...e, kind: 'artifact', label: Array.isArray(e.paths) ? e.paths.join(', ') : (e.label || '') };
    case 'manual':
      return { ...e, kind: 'manual', label: e.label || 'hand-off' };
    case 'parent':
      // Parent-child hierarchy is drawn by the rich renderer (#362 UI rework);
      // the process renderer has no hierarchy concept, so drop it here.
      return null;
    case 'label':
    default:
      return { ...e, kind: e.gate === 'human' ? 'gate' : 'agent' };
  }
}

/**
 * Map a unified flow graph to the shape initProcessGraph().setData expects.
 * @param {{ nodes, edges, gates, labels, lints }} graph - from /api/flows/graph
 */
export function unifiedToRenderGraph(graph) {
  const g = graph || {};
  return {
    nodes: Array.isArray(g.nodes) ? g.nodes : [],
    edges: (Array.isArray(g.edges) ? g.edges : []).map(mapEdge).filter(Boolean),
    gates: Array.isArray(g.gates) ? g.gates : [],
    labels: Array.isArray(g.labels) ? g.labels : [],
    lints: Array.isArray(g.lints) ? g.lints : [],
  };
}
