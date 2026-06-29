// process-layout.js — pure, DOM-free layout helpers for the Process Canvas
// renderer (#330). Kept separate so the layered-DAG logic is unit-testable
// without a browser. The renderer (process-graph-render.js) owns all DOM/SVG.

// Expand every null endpoint (gates, brakes, orphan listeners, dead-end
// emitters) into a synthetic node so layout + rendering stay uniform. Returns
// { nodes, edges } where every edge has concrete string endpoints.
export function normalizeGraph(graph) {
  const nodes = (graph.nodes || []).map(n => ({ ...n, synthetic: false }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = [];
  const ensure = (id, kind, label) => {
    if (!byId.has(id)) {
      const n = { id, synthetic: true, syntheticKind: kind, displayName: label, triggers: [] };
      byId.set(id, n); nodes.push(n);
    }
    return id;
  };
  for (const e of graph.edges || []) {
    let { from, to } = e;
    if (e.kind === 'gate' && from === null) from = ensure(`gate:${e.label}`, 'gate', e.label);
    else if (e.kind === 'brake' && from === null) from = ensure(`brake:${e.label}`, 'brake', e.label);
    else if (e.orphan && from === null) from = ensure(`orphan:${e.label}`, 'orphan', e.label);
    else if (e.deadEnd && to === null) to = ensure(`deadend:${e.label}`, 'deadend', e.label);
    if (from === null || to === null) continue;
    edges.push({ ...e, from, to });
  }
  return { nodes, edges };
}

// Longest-path layering (left→right rank), capped to tolerate the odd
// back-edge/cycle (e.g. test→build, incident→requirements). Timer self-loops
// and self-edges don't constrain order.
export function computeRanks(nodes, edges) {
  const rank = {};
  nodes.forEach(n => { rank[n.id] = 0; });
  const real = edges.filter(e => e.kind !== 'timer' && e.from !== e.to
    && (e.from in rank) && (e.to in rank));
  const cap = nodes.length + 1;
  for (let i = 0; i < cap; i++) {
    let changed = false;
    for (const e of real) {
      if (rank[e.to] < rank[e.from] + 1 && rank[e.from] + 1 <= cap) {
        rank[e.to] = rank[e.from] + 1; changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

// Group nodes into rank columns and order within each column by the barycenter
// of predecessor positions (two sweeps) to reduce edge crossings.
export function orderWithinRanks(nodes, edges, rank) {
  const cols = {};
  nodes.forEach(n => { (cols[rank[n.id]] ||= []).push(n.id); });
  const ranksSorted = Object.keys(cols).map(Number).sort((a, b) => a - b);

  const preds = {};
  edges.forEach(e => { if (e.from !== e.to) (preds[e.to] ||= []).push(e.from); });

  for (let pass = 0; pass < 2; pass++) {
    for (let ri = 1; ri < ranksSorted.length; ri++) {
      const r = ranksSorted[ri];
      const prevOrder = {};
      (cols[ranksSorted[ri - 1]] || []).forEach((id, i) => { prevOrder[id] = i; });
      const bary = (id) => {
        const ps = (preds[id] || []).filter(p => p in prevOrder);
        if (!ps.length) return Number.MAX_SAFE_INTEGER;
        return ps.reduce((s, p) => s + prevOrder[p], 0) / ps.length;
      };
      cols[r].sort((a, b) => bary(a) - bary(b));
    }
  }
  return { cols, ranksSorted };
}
