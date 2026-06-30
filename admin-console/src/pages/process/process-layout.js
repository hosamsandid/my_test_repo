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

// ── Stage-lane layout (#357) ───────────────────────────────────────────────
// Turns the orchestration graph into ordered vertical *stage lanes* so a real
// process (Requirements → FDD → … → Run) reads left-to-right with labeled
// bands, instead of a free DAG that scatters the spine. Pure + unit-tested;
// the renderer (process-graph-render.js) draws the bands.

// Edges that drive forward order: agent hand-offs + the forward review edges.
// Human gates (kind 'gate', synthetic source) are folded into lane *titles*,
// not ranked; rework (review 'changes') and timers never push order forward.
const SPINE_KINDS = new Set(['agent', 'review']);

function isSpineEdge(e, isReal) {
  if (e.from === e.to) return false;
  if (e.kind === 'timer' || e.external || e.orphan || e.deadEnd) return false;
  if (e.kind === 'review' && e.outcome === 'changes') return false;
  if (!SPINE_KINDS.has(e.kind)) return false;
  return isReal(e.from) && isReal(e.to);
}

// Stage index embedded in a display name, else null. Accepts a leading number
// ("05 Technical Design" → 5) or one after a separator, as enterprise teams
// prefix the team name ("Accessio Agentic Delivery · 06 Build" → 6). Takes the
// last such match (closest to the role) and only digits adjacent to a separator
// or start, so trailing tokens like "v2" don't count.
export function stageNumber(name) {
  const re = /(?:^|[·•|:–—-]\s*)(\d{1,3})\b/g;
  let m, last = null;
  while ((m = re.exec(name || ''))) last = parseInt(m[1], 10);
  return last;
}

// Prettify a hand-off label into a stage/lane title.
//   stage:fdd → "FDD" · human:td-approved → "TD approved 🔒" · build:pr-open → "PR open"
export function prettifyStageLabel(label) {
  if (!label) return '';
  const gate = /^human:/.test(label);
  let s = String(label).replace(/^[^:]+:/, '').replace(/-/g, ' ').trim();
  s = s.replace(/\b(fdd|td|uat|sit|pr|nfr|dqc|dq|api|etl|ci|qa)\b/gi, m => m.toUpperCase());
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return gate ? `${s} 🔒` : s;
}

// Cycle-aware longest-path rank: drop DFS back-edges to get a DAG, then relax.
// Used as the fallback ordering when display names aren't numbered.
function rankDag(ids, adj) {
  const visit = {}; // 1 = on stack, 2 = done
  const onStack = new Set();
  const keep = [];
  const dfs = (u) => {
    visit[u] = 1; onStack.add(u);
    for (const v of adj.get(u) || []) {
      if (onStack.has(v)) continue;     // back-edge → drop
      keep.push([u, v]);
      if (!visit[v]) dfs(v);
    }
    onStack.delete(u); visit[u] = 2;
  };
  const indeg = {}; ids.forEach(i => { indeg[i] = 0; });
  for (const id of ids) for (const v of adj.get(id) || []) if (v in indeg) indeg[v]++;
  ids.filter(i => indeg[i] === 0).forEach(i => { if (!visit[i]) dfs(i); });
  ids.forEach(i => { if (!visit[i]) dfs(i); });

  const rank = {}; ids.forEach(i => { rank[i] = 0; });
  for (let i = 0; i < ids.length; i++) {
    let changed = false;
    for (const [u, v] of keep) if (rank[v] < rank[u] + 1) { rank[v] = rank[u] + 1; changed = true; }
    if (!changed) break;
  }
  return rank;
}

/**
 * Assign every node to a stage lane and derive each lane's title.
 * @returns {{ laneOf: Object<string,number>, lanes: Array<{index,title,ids,crossCutting}>, folded: Set<string> }}
 *   `folded` = synthetic gate node ids absorbed into lane titles (not rendered).
 */
export function assignStageLanes(nodes, edges) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const isReal = (id) => { const n = byId.get(id); return !!n && !n.synthetic; };

  // Spine adjacency (real→real forward edges) + degree/gate-feed bookkeeping.
  const adj = new Map();
  const spineDeg = new Map();
  const gateFed = new Set();    // nodes woken by a human gate / brake — on the spine
  nodes.forEach(n => { if (!n.synthetic) { adj.set(n.id, []); spineDeg.set(n.id, 0); } });
  for (const e of edges) {
    if (isSpineEdge(e, isReal)) {
      adj.get(e.from).push(e.to);
      spineDeg.set(e.from, spineDeg.get(e.from) + 1);
      spineDeg.set(e.to, spineDeg.get(e.to) + 1);
    } else if ((e.kind === 'gate' || e.kind === 'brake') && isReal(e.to)) {
      gateFed.add(e.to);
    }
  }

  // Cross-cutting = real node off the spine: no agent/review edge AND not woken
  // by a gate (e.g. reviewers reacting to every PR — Orchestrator/Data/Design).
  const crossCutting = new Set();
  const spine = [];
  for (const n of nodes) {
    if (n.synthetic) continue;
    if (spineDeg.get(n.id) === 0 && !gateFed.has(n.id)) crossCutting.add(n.id);
    else spine.push(n.id);
  }

  // Raw lane index for spine nodes. If every spine node is numbered, honour the
  // numbering (dense-ranked); else fall back to cycle-aware graph ranking.
  const numbers = spine.map(id => stageNumber(byId.get(id).displayName));
  let rawLane;
  if (spine.length && numbers.every(x => x != null)) {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    const dense = new Map(sorted.map((v, i) => [v, i]));
    rawLane = (id) => dense.get(stageNumber(byId.get(id).displayName));
  } else {
    const rank = rankDag(spine, adj);
    rawLane = (id) => rank[id] || 0;
  }

  const laneOf = {};
  let maxLane = -1;
  for (const id of spine) { const l = rawLane(id); laneOf[id] = l; if (l > maxLane) maxLane = l; }

  // Re-index raw lanes to a contiguous 0..k column range.
  const used = [...new Set(spine.map(id => laneOf[id]))].sort((a, b) => a - b);
  const colOf = new Map(used.map((v, i) => [v, i]));
  for (const id of spine) laneOf[id] = colOf.get(laneOf[id]);
  let lastCol = used.length - 1;

  // Cross-cutting band sits after the spine (only if populated).
  let crossCol = -1;
  if (crossCutting.size) { crossCol = ++lastCol; crossCutting.forEach(id => { laneOf[id] = crossCol; }); }

  // Synthetic nodes: gates fold into titles (no lane); brakes/orphan/dead-ends
  // live in the cross-cutting band (or a new trailing band) so their edges draw.
  const folded = new Set();
  const satellites = [];
  for (const n of nodes) {
    if (!n.synthetic) continue;
    if (n.syntheticKind === 'gate') { folded.add(n.id); continue; }
    satellites.push(n.id);
  }
  if (satellites.length) {
    if (crossCol < 0) { crossCol = ++lastCol; }
    satellites.forEach(id => { laneOf[id] = crossCol; });
  }

  // Lane titles name the *work* of the stage (stage:* label or the agent), while
  // a human gate entering the lane is surfaced separately as a boundary marker —
  // matching how operators read the process: named stages, gates between them.
  const lanes = [];
  for (let col = 0; col <= lastCol; col++) {
    const ids = nodes.filter(n => laneOf[n.id] === col).map(n => n.id);
    const isCross = col === crossCol;
    lanes.push({
      index: col, ids, crossCutting: isCross,
      title: isCross ? 'Reviewers / cross-cutting' : laneTitle(col),
      gate: isCross ? null : laneGate(col),
    });
  }
  return { laneOf, lanes, folded };

  // The human gate (if any) that wakes this lane — shown as a boundary chip.
  function laneGate(col) {
    for (const e of edges) {
      if (laneOf[e.to] === col && e.kind === 'gate') return prettifyStageLabel(e.label);
    }
    return null;
  }

  function laneTitle(col) {
    let stageLabel = null;
    for (const e of edges) {
      if (laneOf[e.to] !== col || !isReal(e.from)) continue;
      if (laneOf[e.from] != null && laneOf[e.from] < col && /^stage:/.test(e.label)) {
        stageLabel = stageLabel || e.label;
      }
    }
    if (stageLabel) return prettifyStageLabel(stageLabel);
    // Else name after the lane's agent(s), dropping team-name prefix + number.
    const reals = (nodes.filter(n => laneOf[n.id] === col && !n.synthetic));
    if (reals.length === 1) {
      const dn = String(reals[0].displayName || reals[0].id);
      const tail = dn.split(/[·•|]/).pop().trim();
      return tail.replace(/^\d{1,3}\s*/, '') || tail;
    }
    return `Stage ${col + 1}`;
  }
}
