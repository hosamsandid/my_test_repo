// flow-layout.js — pure layered-DAG layout for the Flows graph.
//
// The ONE layout for every flow the renderer (flow-graph-render.js) draws:
// process/draft flows, member trees and BP packs alike. The structure comes
// from the directed hand-off edges (label / review / manual), `depends_on`,
// and the parent-child hierarchy:
//
//   • break cycles (rework loops like test→build) so we have a DAG,
//   • assign each node a column via longest-path layering (sources first,
//     sinks last → a visible start and end),
//   • sibling groups (all children of one parent, via `groupOf`) share one
//     column and stay contiguous within it, so a hierarchy reads as a clearly
//     grouped row/column of siblings next to their parent,
//   • order nodes within each column to reduce edge crossings (median sweep).
//
// When nodes carry stages, the layout PARTITIONS the flow axis: every stage
// owns a contiguous, exclusive block of columns (as many as its internal flow
// needs), blocks ordered by the operator-defined stage order (stages missing
// from that order are appended in graph-flow order). Stages can therefore
// never interleave, and their bands never overlap. Unstaged nodes settle next
// to their neighbours. Everything here is pure + DOM-free so it can be
// unit-tested; the renderer turns the resulting columns/orders into pixel
// positions.

// ── graph helpers ────────────────────────────────────────────────────────────

function buildAdjacency(ids, edges) {
  const idSet = new Set(ids);
  const out = new Map();
  const inc = new Map();
  ids.forEach((id) => { out.set(id, []); inc.set(id, []); });
  for (const e of edges) {
    if (!e || e.from === e.to) continue;
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    out.get(e.from).push(e.to);
    inc.get(e.to).push(e.from);
  }
  return { out, inc };
}

// Return the subset of edges that keeps the graph acyclic, dropping detected
// back-edges (DFS grey-node rule). Deterministic given a stable node order.
function acyclicEdges(ids, edges) {
  const { out } = buildAdjacency(ids, edges);
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map(ids.map((id) => [id, WHITE]));
  const keep = [];
  const backEdges = new Set();

  const visit = (u) => {
    color.set(u, GREY);
    for (const v of out.get(u) || []) {
      const c = color.get(v);
      if (c === WHITE) { keep.push({ from: u, to: v }); visit(v); }
      else if (c === GREY) { backEdges.add(`${u}\u0000${v}`); } // back-edge → drop
      else { keep.push({ from: u, to: v }); }                  // forward/cross → keep
    }
    color.set(u, BLACK);
  };
  for (const id of ids) if (color.get(id) === WHITE) visit(id);
  return { keep, backEdges };
}

// Longest-path layering over an acyclic edge set. Sources (no kept incoming
// edge) land on layer 0; every other node sits one past its deepest predecessor.
function longestPathLayers(ids, keptEdges) {
  const { out, inc } = buildAdjacency(ids, keptEdges);
  // Kahn topological order.
  const indeg = new Map(ids.map((id) => [id, (inc.get(id) || []).length]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const topo = [];
  while (queue.length) {
    const u = queue.shift();
    topo.push(u);
    for (const v of out.get(u) || []) {
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  // Any node not reached (shouldn't happen on a DAG) appended so it still lays out.
  for (const id of ids) if (!topo.includes(id)) topo.push(id);

  const layer = new Map(ids.map((id) => [id, 0]));
  for (const u of topo) {
    for (const v of out.get(u) || []) {
      layer.set(v, Math.max(layer.get(v), layer.get(u) + 1));
    }
  }
  return layer;
}

// ── crossing reduction ──────────────────────────────────────────────────────

// Group node ids into per-column arrays, seeded in the given order.
function columnsFromLayers(ids, colOf) {
  const maxCol = ids.reduce((m, id) => Math.max(m, colOf.get(id) || 0), 0);
  const cols = Array.from({ length: maxCol + 1 }, () => []);
  ids.forEach((id) => { cols[colOf.get(id) || 0].push(id); });
  return cols;
}

// Bring the members of each sibling group together within a column, stable:
// the group occupies the position of its first-seen member.
function groupContiguous(col, groupOf) {
  const byGroup = new Map(); // groupKey -> member ids (in column order)
  const seq = [];
  for (const id of col) {
    const g = groupOf(id);
    if (g == null) { seq.push([id]); continue; }
    if (byGroup.has(g)) { byGroup.get(g).push(id); continue; }
    const arr = [id];
    byGroup.set(g, arr);
    seq.push(arr);
  }
  return seq.flat();
}

// Order nodes within each column to reduce crossings using the median heuristic
// over all edges (both directions), alternating down/up sweeps. Keeps the best
// order seen by a cheap crossing count. With `groupOf`, the members of one
// sibling group move as a contiguous block (the block sorts by the mean key of
// its members, members by their own key). Pure — returns a new array of arrays.
function orderWithinColumns(cols, edges, colOf, { iterations = 8, groupOf = null } = {}) {
  const nbrs = new Map(); // id -> [neighbourId]
  const add = (a, b) => { if (!nbrs.has(a)) nbrs.set(a, []); nbrs.get(a).push(b); };
  for (const e of edges) {
    if (!e || e.from === e.to) continue;
    if (colOf.get(e.from) == null || colOf.get(e.to) == null) continue;
    add(e.from, e.to); add(e.to, e.from);
  }

  let cur = cols.map((c) => (groupOf ? groupContiguous(c, groupOf) : c.slice()));
  const posIn = (col) => { const m = new Map(); col.forEach((id, i) => m.set(id, i)); return m; };

  const median = (id, refPos) => {
    const ps = (nbrs.get(id) || []).map((n) => refPos.get(n)).filter((p) => p != null).sort((a, b) => a - b);
    if (ps.length === 0) return null;
    const mid = Math.floor(ps.length / 2);
    return ps.length % 2 ? ps[mid] : (ps[mid - 1] + ps[mid]) / 2;
  };

  const sortByKeys = (col, keyOf) => {
    const withIdx = col.map((id, i) => ({ id, i, k: keyOf(id) }));
    const eff = (x) => (x.k == null ? x.i : x.k); // no neighbours → keep relative position
    if (!groupOf) {
      withIdx.sort((a, b) => (eff(a) === eff(b) ? a.i - b.i : eff(a) - eff(b)));
      return withIdx.map((x) => x.id);
    }
    const blocks = [];
    const byGroup = new Map();
    for (const x of withIdx) {
      const g = groupOf(x.id);
      if (g == null) { blocks.push({ items: [x] }); continue; }
      if (!byGroup.has(g)) { const b = { items: [] }; byGroup.set(g, b); blocks.push(b); }
      byGroup.get(g).items.push(x);
    }
    for (const b of blocks) {
      b.items.sort((a, c) => (eff(a) === eff(c) ? a.i - c.i : eff(a) - eff(c)));
      b.k = b.items.reduce((s, x) => s + eff(x), 0) / b.items.length;
      b.i = Math.min(...b.items.map((x) => x.i));
    }
    blocks.sort((a, b) => (b.k === a.k ? a.i - b.i : a.k - b.k));
    return blocks.flatMap((b) => b.items.map((x) => x.id));
  };

  let best = cur.map((c) => c.slice());
  let bestX = countCrossings(cur, edges, colOf);

  for (let it = 0; it < iterations; it++) {
    const down = it % 2 === 0;
    if (down) {
      for (let c = 1; c < cur.length; c++) {
        const refPos = posIn(cur[c - 1]);
        cur[c] = sortByKeys(cur[c], (id) => median(id, refPos));
      }
    } else {
      for (let c = cur.length - 2; c >= 0; c--) {
        const refPos = posIn(cur[c + 1]);
        cur[c] = sortByKeys(cur[c], (id) => median(id, refPos));
      }
    }
    const x = countCrossings(cur, edges, colOf);
    if (x < bestX) { bestX = x; best = cur.map((c) => c.slice()); }
  }
  return best;
}

// Count edge crossings between adjacent columns (approximate quality metric).
function countCrossings(cols, edges, colOf) {
  const posOf = new Map();
  cols.forEach((col) => col.forEach((id, i) => posOf.set(id, i)));
  let total = 0;
  // Only compare edges that live between the same pair of adjacent columns.
  const byPair = new Map();
  for (const e of edges) {
    if (!e || e.from === e.to) continue;
    const cf = colOf.get(e.from), ct = colOf.get(e.to);
    if (cf == null || ct == null || Math.abs(cf - ct) !== 1) continue;
    const lo = Math.min(cf, ct);
    const key = lo;
    const a = cf < ct ? e.from : e.to; // node in the lower column
    const b = cf < ct ? e.to : e.from;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push([posOf.get(a), posOf.get(b)]);
  }
  for (const pairs of byPair.values()) {
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const [a1, b1] = pairs[i];
        const [a2, b2] = pairs[j];
        if ((a1 - a2) * (b1 - b2) < 0) total++;
      }
    }
  }
  return total;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Compute the column (layer) index and within-column order for a flat flow.
 *
 * @param {string[]} ids    visible node ids
 * @param {{from:string,to:string}[]} edges  directed hand-off / dependency edges
 * @param {object} [opts]
 * @param {(id:string)=>(string|null)} [opts.stageOf]  a node's stage name (or null)
 * @param {string[]} [opts.stageOrder]  operator-defined ordered stage names; stages
 *   seen on nodes but missing here are appended in graph-flow order
 * @param {(id:string)=>(string|null)} [opts.groupOf]  sibling-group key (e.g. the
 *   parent id for all children of one parent). Members of one group share a
 *   column and stay contiguous within it.
 * @returns {{ colOf: Map<string,number>, columns: string[][], columnCount: number }}
 */
function computeFlowLayout(ids, edges, { stageOf = null, stageOrder = [], groupOf = null } = {}) {
  if (ids.length === 0) return { colOf: new Map(), columns: [], columnCount: 0 };

  // Sibling groups (all children of one parent) must land in ONE column so the
  // hierarchy reads as a row/column of siblings. For the layering, each group
  // is contracted into a super-node: edges to/from members attach to the
  // super-node, intra-group edges collapse to self-loops and drop out (they
  // become same-column edges for the router). Every member then inherits the
  // super-node's column. All layering below runs on this contracted graph
  // (identity when there are no groups).
  const hasGroups = typeof groupOf === 'function' && ids.some((id) => groupOf(id) != null);
  const rep = (id) => (hasGroups && groupOf(id) != null ? `@@g:${groupOf(id)}` : id);
  const cIds = hasGroups ? [...new Set(ids.map(rep))] : ids;
  const cEdges = hasGroups
    ? edges
        .filter((e) => e && e.from !== e.to)
        .map((e) => ({ from: rep(e.from), to: rep(e.to) }))
        .filter((e) => e.from !== e.to)
    : edges;
  const { keep } = acyclicEdges(cIds, cEdges);
  const cAuto = longestPathLayers(cIds, keep);

  // Stage of a contracted node: the first non-empty member stage (siblings
  // inherit their parent's stage, so members rarely disagree; when they do the
  // group stays together and the group's stage wins).
  const memberStage = new Map(); // contracted id → stage
  if (stageOf) {
    for (const id of ids) {
      const s = stageOf(id);
      if (s == null || s === '') continue;
      const r = rep(id);
      if (!memberStage.has(r)) memberStage.set(r, s);
    }
  }

  const cColOf = new Map(); // contracted id → column

  if (memberStage.size > 0) {
    // Stage partitioning: every stage owns a CONTIGUOUS, EXCLUSIVE block of
    // columns (as many as its internal flow needs), blocks ordered by the
    // stage order — so stages can never interleave along the flow axis and
    // their bands never overlap. Stages seen on nodes but missing from the
    // defined order are appended, ordered by where the plain layering puts
    // their nodes.
    const present = [];
    const seenStage = new Set();
    for (const cid of cIds) {
      const s = memberStage.get(cid);
      if (s != null && !seenStage.has(s)) { seenStage.add(s); present.push(s); }
    }
    const defined = stageOrder.filter((s, i) => stageOrder.indexOf(s) === i);
    const avgAuto = new Map(); // stage → mean plain layer of its nodes
    for (const s of present) {
      const members = cIds.filter((cid) => memberStage.get(cid) === s);
      avgAuto.set(s, members.reduce((sum, cid) => sum + (cAuto.get(cid) || 0), 0) / members.length);
    }
    const appended = present
      .filter((s) => !defined.includes(s))
      .sort((a, b) => (avgAuto.get(a) - avgAuto.get(b)) || (present.indexOf(a) - present.indexOf(b)));
    const orderedStages = [...defined, ...appended];

    // Internal layering per stage (longest path over the stage's own edges),
    // then stack the blocks: offset(stage) = sum of the depths of all earlier
    // stages. A defined stage without nodes keeps one (empty) column so the
    // authored order stays visible.
    const internal = new Map(); // contracted id → layer within its stage
    const offset = new Map();   // stage → first column of its block
    let acc = 0;
    for (const s of orderedStages) {
      const sub = cIds.filter((cid) => memberStage.get(cid) === s);
      offset.set(s, acc);
      if (sub.length === 0) { acc += 1; continue; }
      const subSet = new Set(sub);
      const subEdges = keep.filter((e) => subSet.has(e.from) && subSet.has(e.to));
      const layers = longestPathLayers(sub, subEdges);
      let depth = 1;
      sub.forEach((cid) => {
        internal.set(cid, layers.get(cid) || 0);
        depth = Math.max(depth, (layers.get(cid) || 0) + 1);
      });
      acc += depth;
    }
    const total = Math.max(acc, 1);

    cIds.forEach((cid) => {
      const s = memberStage.get(cid);
      if (s != null) cColOf.set(cid, offset.get(s) + (internal.get(cid) || 0));
    });

    // Unstaged nodes: seed from the plain layering scaled into the stage
    // column range, then pull towards the average column of their neighbours.
    const unstaged = cIds.filter((cid) => memberStage.get(cid) == null);
    const autoMax = Math.max(1, ...cIds.map((cid) => cAuto.get(cid) || 0));
    unstaged.forEach((cid) => {
      cColOf.set(cid, Math.round(((cAuto.get(cid) || 0) / autoMax) * (total - 1)));
    });
    const { out, inc } = buildAdjacency(cIds, cEdges);
    for (let pass = 0; pass < 6; pass++) {
      for (const cid of unstaged) {
        const ns = [...(out.get(cid) || []), ...(inc.get(cid) || [])];
        if (ns.length === 0) continue;
        const avg = ns.reduce((sum, n) => sum + cColOf.get(n), 0) / ns.length;
        cColOf.set(cid, Math.max(0, Math.min(total - 1, Math.round(avg))));
      }
    }
  } else {
    cIds.forEach((cid) => cColOf.set(cid, cAuto.get(cid) || 0));
  }

  const colOf = new Map(ids.map((id) => [id, cColOf.get(rep(id)) || 0]));
  const seeded = columnsFromLayers(ids, colOf);
  const columns = orderWithinColumns(seeded, edges, colOf, { groupOf: hasGroups ? groupOf : null });
  return { colOf, columns, columnCount: columns.length };
}

// ── over-wide column wrapping ────────────────────────────────────────────────

// A column holds every node the layering put in one layer, and for a hierarchy
// that means every sibling of one parent. A root with 270 children therefore
// puts 270 cards in ONE column, and at 320px per card plus a gap that is a
// canvas ~100 000px wide and ~400px tall. The measurements come from the
// hierarchy that forced this — BriefingPack packs, removed from the editor in
// #1965 — but the runaway is a property of any wide parent, so the wrap
// outlives them: 81 nodes already give 15 637px, 324 give 58 428px, 648 give
// 115 525px. "Fit to view" then runs
// into the renderer's 10% zoom floor and still shows a sliver, so there is no
// zoom level at which such a flow can be read or worked on.
//
// The fix is to stop letting one column run away along the cross axis: past a
// pixel budget it wraps into stacked sub-rows, so the column becomes a compact
// BLOCK that still occupies exactly one slot on the flow axis. The layering,
// crossing reduction and channel/lane routing are untouched — a wrapped column
// is still one column to every one of them, it just occupies more than one line
// of pixels.

// Never wrap a column with at most this many members, whatever the budget says:
// small hand-authored flows must keep reading as a single row of siblings.
const WRAP_MIN_COLUMN = 8;

/**
 * How many members of a column fit on one line within the cross-axis budget,
 * balanced so the last line is not left nearly empty (17 members with room for
 * 16 becomes 9 + 8, not 16 + 1).
 *
 * @param {number} count         members in the column
 * @param {number} crossExtent   cross-axis px one member occupies, gap included
 * @param {number} maxCrossExtent  cross-axis px budget for the whole column
 * @returns {number} members per line (>= 1, never more than `count`)
 */
function membersPerLine(count, crossExtent, maxCrossExtent) {
  if (!(count > 0)) return 1;
  const step = crossExtent > 0 ? crossExtent : 1;
  const budget = maxCrossExtent > 0 ? maxCrossExtent : Infinity;
  const fit = Math.max(1, Math.floor(budget / step));
  if (count <= fit) return count;
  const lines = Math.ceil(count / fit);
  return Math.ceil(count / lines);
}

/**
 * Split one column into stacked sub-rows. Order is preserved, so the crossing
 * reduction that produced it is not thrown away: sub-row 0 holds the first
 * members, sub-row 1 the next, and so on.
 *
 * @param {string[]} ids  the column's members, in order
 * @param {object} opts
 * @param {number} opts.crossExtent      cross-axis px per member, gap included
 * @param {number} opts.maxCrossExtent   cross-axis px budget
 * @param {number} [opts.threshold]      never wrap at or below this member count
 * @returns {string[][]} one array per sub-row; always at least one
 */
function wrapColumn(ids, { crossExtent, maxCrossExtent, threshold = WRAP_MIN_COLUMN } = {}) {
  const col = Array.isArray(ids) ? ids : [];
  if (col.length <= Math.max(1, threshold)) return [col.slice()];
  const perLine = membersPerLine(col.length, crossExtent, maxCrossExtent);
  if (perLine >= col.length) return [col.slice()];
  const rows = [];
  for (let i = 0; i < col.length; i += perLine) rows.push(col.slice(i, i + perLine));
  return rows;
}

/**
 * Apply wrapColumn to every column. `crossExtentOf(col, index)` gives that
 * column's per-member cross extent, because it is a constant card width for a
 * top→down flow but the measured card height for a left→right one.
 *
 * @returns {string[][][]} per column, its sub-rows
 */
function wrapColumns(columns, { crossExtentOf, maxCrossExtent, threshold = WRAP_MIN_COLUMN } = {}) {
  return (columns || []).map((col, i) => wrapColumn(col, {
    crossExtent: typeof crossExtentOf === 'function' ? crossExtentOf(col, i) : crossExtentOf,
    maxCrossExtent,
    threshold,
  }));
}

// ── cross-axis coordinate assignment ──────────────────────────────────────────

// Isotonic (non-decreasing) least-squares fit via Pool-Adjacent-Violators.
// Given per-slot desired centres and the minimum spacing each slot needs from
// its predecessor, returns overlap-free centres (order preserved) that stay as
// close as possible to the desired values. This is the coordinate step of a
// Sugiyama layout: it aligns a node with its neighbours yet never overlaps.
function resolveOrder(desired, minGaps) {
  const n = desired.length;
  if (n === 0) return [];
  const pref = new Array(n);
  pref[0] = 0;
  for (let i = 1; i < n; i++) pref[i] = pref[i - 1] + minGaps[i];
  const target = desired.map((d, i) => d - pref[i]);

  const val = [], cnt = [];
  for (let i = 0; i < n; i++) {
    let v = target[i], c = 1;
    while (val.length && val[val.length - 1] > v) {
      const pv = val.pop(), pc = cnt.pop();
      v = (pv * pc + v * c) / (pc + c);
      c = pc + c;
    }
    val.push(v); cnt.push(c);
  }
  const fitted = new Array(n);
  let idx = 0;
  for (let b = 0; b < val.length; b++) for (let k = 0; k < cnt[b]; k++) fitted[idx++] = val[b];
  return fitted.map((f, i) => f + pref[i]);
}

/**
 * Assign a cross-axis centre to every node so connected nodes line up while
 * columns stay overlap-free. Pure — `sizeOf(id)` gives the node's cross extent.
 * @returns {Map<string,number>} id → centre coordinate on the cross axis
 */
function assignCrossCoords(columns, edges, sizeOf, { gap = 28, iterations = 14 } = {}) {
  const colOf = new Map();
  columns.forEach((col, ci) => col.forEach((id) => colOf.set(id, ci)));
  const nbrs = new Map();
  const add = (a, b) => { if (!nbrs.has(a)) nbrs.set(a, []); nbrs.get(a).push(b); };
  for (const e of edges) {
    if (!e || e.from === e.to) continue;
    if (!colOf.has(e.from) || !colOf.has(e.to)) continue;
    add(e.from, e.to); add(e.to, e.from);
  }

  const center = new Map();
  for (const col of columns) {
    let c = 0;
    for (const id of col) { const s = sizeOf(id); center.set(id, c + s / 2); c += s + gap; }
  }
  const minGapsFor = (col) => col.map((id, i) => (i === 0 ? 0 : sizeOf(col[i - 1]) / 2 + gap + sizeOf(id) / 2));

  for (let it = 0; it < iterations; it++) {
    const order = it % 2 === 0
      ? columns.map((_, i) => i)
      : columns.map((_, i) => i).reverse();
    for (const ci of order) {
      const col = columns[ci];
      if (col.length === 0) continue;
      const desired = col.map((id) => {
        const ns = nbrs.get(id) || [];
        if (ns.length === 0) return center.get(id);
        return ns.reduce((s, n) => s + center.get(n), 0) / ns.length;
      });
      const fitted = resolveOrder(desired, minGapsFor(col));
      col.forEach((id, i) => center.set(id, fitted[i]));
    }
  }
  return center;
}

export {
  WRAP_MIN_COLUMN,
  membersPerLine,
  wrapColumn,
  wrapColumns,
  computeFlowLayout,
  acyclicEdges,
  longestPathLayers,
  orderWithinColumns,
  countCrossings,
  assignCrossCoords,
  resolveOrder,
};
