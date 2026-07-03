// edge-router.js — pure orthogonal edge router for the layered Flows layout.
//
// The layered layout (flow-layout.js) places node cards in columns along the
// flow axis. This module routes the directed process edges between those cards
// so the wiring stays readable even on dense graphs:
//
//   • every edge LEAVES its source through the downstream face (bottom for a
//     top→down flow) and ENTERS its target through the face the arrow reads
//     naturally from (top for forward edges, bottom for a same-column U-turn),
//   • connection points are distributed along the node face (ports), ordered
//     by where the other endpoint sits, so edges fan out instead of piling
//     onto the node centre,
//   • the cross runs live in the node-free "channels" between columns; runs
//     that overlap get distinct lanes, so parallel hand-offs never sit on top
//     of each other or on a label,
//   • edges that span multiple columns, and rework/back edges, route around
//     the graph through a side gutter instead of cutting through node cards,
//   • every edge gets a label anchor ON its route (midpoint of its longest
//     channel run) so the label visually belongs to the edge.
//
// Everything here is pure and DOM-free so it can be unit-tested; the renderer
// maps the returned polylines to rounded SVG paths.

// ── channel lane assignment ──────────────────────────────────────────────────

// Greedy interval colouring: give each run the lowest lane whose previous run
// ends before this one starts. Runs come pre-padded, so no extra margin here.
function assignLanes(runs) {
  const order = runs.map((r, i) => i).sort((a, b) => runs[a].lo - runs[b].lo || a - b);
  const laneEnd = [];
  for (const i of order) {
    const r = runs[i];
    let lane = laneEnd.findIndex((end) => end <= r.lo);
    if (lane === -1) { lane = laneEnd.length; laneEnd.push(r.hi); }
    else laneEnd[lane] = r.hi;
    r.lane = lane;
  }
  return laneEnd.length;
}

// Per-channel lane count for the layered layout's gap sizing: how many cross
// runs land in the channel below column c. Keys are column indices; back
// edges into column 0 use the virtual channel above the graph (key -1).
function laneLoadByChannel(edges, colOf) {
  const load = new Map();
  const bump = (c) => load.set(c, (load.get(c) || 0) + 1);
  for (const e of edges) {
    if (!e || e.from === e.to) continue;
    const s = colOf.get(e.from);
    const t = colOf.get(e.to);
    if (s == null || t == null) continue;
    if (t === s || t === s + 1) bump(s);
    else if (t > s) { bump(s); bump(t - 1); }
    else { bump(s); bump(t - 1); } // back edge; t-1 may be -1 (above the graph)
  }
  return load;
}

// ── main router ──────────────────────────────────────────────────────────────

/**
 * Route the process edges of a layered flow as orthogonal polylines.
 *
 * @param {object} opts
 * @param {{id:string,x:number,y:number,w:number,h:number}[]} opts.nodes laid-out cards
 * @param {{from:string,to:string}[]} opts.edges  directed edges (order preserved)
 * @param {Map<string,number>} opts.colOf  node id → column index
 * @param {'down'|'right'} [opts.flow]  main flow direction on screen
 * @param {number[]} [opts.labelWidths]  per-edge label width (px) to reserve on its run
 * @returns {({points:{x:number,y:number}[], label:{x:number,y:number}, arrow:{x:number,y:number,angle:number}}|null)[]}
 */
function routeOrthogonalEdges({
  nodes, edges, colOf, flow = 'down', labelWidths = [],
  laneGap = 18, portMargin = 26, gutterOffset = 44, gutterGap = 12, virtualChannel = 70,
}) {
  // Work in abstract (main, cross) coordinates: main = flow axis, cross = the
  // perpendicular. Mapped back to x/y only when emitting points.
  const toXY = flow === 'down'
    ? (cross, main) => ({ x: cross, y: main })
    : (cross, main) => ({ x: main, y: cross });

  const rects = new Map();
  let K = 0;
  for (const n of nodes) {
    const col = colOf.get(n.id);
    if (col == null) continue;
    const r = flow === 'down'
      ? { m0: n.y, m1: n.y + n.h, c0: n.x, c1: n.x + n.w }
      : { m0: n.x, m1: n.x + n.w, c0: n.y, c1: n.y + n.h };
    r.col = col;
    r.cc = (r.c0 + r.c1) / 2;
    rects.set(n.id, r);
    K = Math.max(K, col + 1);
  }
  if (rects.size === 0) return edges.map(() => null);

  // Column extents along the main axis (empty columns stay ±Infinity).
  const colM0 = new Array(K).fill(Infinity);
  const colM1 = new Array(K).fill(-Infinity);
  let minC = Infinity, maxC = -Infinity, firstM0 = Infinity;
  rects.forEach((r) => {
    colM0[r.col] = Math.min(colM0[r.col], r.m0);
    colM1[r.col] = Math.max(colM1[r.col], r.m1);
    minC = Math.min(minC, r.c0);
    maxC = Math.max(maxC, r.c1);
    firstM0 = Math.min(firstM0, r.m0);
  });

  // Channels are the node-free bands between columns, keyed canonically by the
  // non-empty column they sit BELOW ('b<col>'), plus the virtual band above the
  // whole graph ('top') used by back edges into the first column.
  const nextM0 = (c) => { for (let i = c + 1; i < K; i++) if (colM0[i] !== Infinity) return colM0[i]; return null; };
  const prevNonEmpty = (c) => { for (let i = c - 1; i >= 0; i--) if (colM1[i] !== -Infinity) return i; return null; };
  const channelBelow = (c) => `b${c}`;
  const channelAbove = (t) => { const p = prevNonEmpty(t); return p == null ? 'top' : `b${p}`; };
  // Virtual channels (above the first column / below the last) start a bit
  // away from the cards so their lanes clear the stage-band frames drawn
  // around each column (18px pad + label strip).
  const VIRT_MARGIN = 28;
  const channelRegion = (key) => {
    if (key === 'top') return { top: firstM0 - VIRT_MARGIN - virtualChannel, bottom: firstM0 - VIRT_MARGIN };
    const c = Number(key.slice(1));
    const nb = nextM0(c);
    return nb != null
      ? { top: colM1[c], bottom: nb }
      : { top: colM1[c] + VIRT_MARGIN, bottom: colM1[c] + VIRT_MARGIN + virtualChannel };
  };

  const gutterBaseL = minC - gutterOffset;
  const gutterBaseR = maxC + gutterOffset;

  // 1. Classify every edge; pick the gutter side for around-the-graph routes
  //    from the node centres (ports don't exist yet).
  const routes = edges.map((e, idx) => {
    if (!e || e.from === e.to) return null;
    const s = rects.get(e.from);
    const t = rects.get(e.to);
    if (!s || !t) return null;
    const srcCh = channelBelow(s.col);
    const dstCh = t.col > s.col ? channelAbove(t.col) : null;
    let type, side = null;
    if (t.col === s.col) type = 'same';
    else if (t.col > s.col && dstCh === srcCh) type = 'fwd';   // adjacent (incl. across empty stages)
    else {
      type = t.col > s.col ? 'fwdLong' : 'back';
      const costL = Math.abs(s.cc - gutterBaseL) + Math.abs(t.cc - gutterBaseL);
      const costR = Math.abs(s.cc - gutterBaseR) + Math.abs(t.cc - gutterBaseR);
      side = costL < costR ? 'L' : 'R';
    }
    return { idx, s, t, type, side, srcCh, dstCh: type === 'same' || type === 'fwd' ? srcCh : channelAbove(t.col) };
  });

  // 2. Distribute ports along each node face, ordered by where the edge is
  //    headed so stubs fan out without crossing right at the card.
  const faces = new Map(); // `${id}|m0` / `${id}|m1` → [{route, end, key}]
  const addPort = (id, face, route, end, key) => {
    const k = `${id}|${face}`;
    if (!faces.has(k)) faces.set(k, []);
    faces.get(k).push({ route, end, key });
  };
  for (const r of routes) {
    if (!r) continue;
    const e = edges[r.idx];
    const gBase = r.side === 'L' ? gutterBaseL : gutterBaseR;
    addPort(e.from, 'm1', r, 'src', r.side ? gBase : r.t.cc);
    if (r.type === 'same') addPort(e.to, 'm1', r, 'dst', r.s.cc);
    else addPort(e.to, 'm0', r, 'dst', r.side ? gBase : r.s.cc);
  }
  faces.forEach((list, k) => {
    const id = k.slice(0, -3);
    const rect = rects.get(id);
    list.sort((a, b) => a.key - b.key || a.route.idx - b.route.idx);
    const usable = rect.c1 - rect.c0 - 2 * portMargin;
    list.forEach((p, i) => {
      const cross = usable > 0
        ? rect.c0 + portMargin + ((i + 0.5) * usable) / list.length
        : rect.cc;
      if (p.end === 'src') p.route.sp = cross; else p.route.tp = cross;
    });
  });

  // 3. Collect the cross runs per channel. The run that will carry the label
  //    is widened to the label's width so lanes never stack a run under a
  //    neighbour's label.
  const channelRuns = new Map(); // chKey → [{lo, hi, route, which}]
  const addRun = (chKey, route, which, a, b, reserve) => {
    let lo = Math.min(a, b), hi = Math.max(a, b);
    const mid = (lo + hi) / 2;
    const half = Math.max(hi - lo, reserve) / 2 + 8;
    lo = mid - half; hi = mid + half;
    if (!channelRuns.has(chKey)) channelRuns.set(chKey, []);
    const run = { lo, hi, route, which, mid };
    channelRuns.get(chKey).push(run);
    if (which === 'src') route.srcRun = run; else route.dstRun = run;
  };
  for (const r of routes) {
    if (!r) continue;
    const labelW = labelWidths[r.idx] || 0;
    if (!r.side) {
      addRun(r.srcCh, r, 'src', r.sp, r.tp, labelW);
    } else {
      const gBase = r.side === 'L' ? gutterBaseL : gutterBaseR;
      const srcLen = Math.abs(r.sp - gBase);
      const dstLen = Math.abs(r.tp - gBase);
      r.labelOn = srcLen >= dstLen ? 'src' : 'dst';
      addRun(r.srcCh, r, 'src', r.sp, gBase, r.labelOn === 'src' ? labelW : 0);
      addRun(r.dstCh, r, 'dst', r.tp, gBase, r.labelOn === 'dst' ? labelW : 0);
    }
  }

  // 4. Lanes: overlapping runs in one channel get distinct main coordinates,
  //    the whole bundle centred in the channel band.
  channelRuns.forEach((runs, chKey) => {
    const laneCount = assignLanes(runs);
    const { top, bottom } = channelRegion(chKey);
    const avail = Math.max(0, bottom - top - 24);
    const spacing = laneCount > 1 ? Math.max(8, Math.min(laneGap, avail / (laneCount - 1))) : 0;
    const start = top + (bottom - top - (laneCount - 1) * spacing) / 2;
    runs.forEach((run) => { run.main = start + run.lane * spacing; });
  });

  // 5. Gutter lanes: vertical runs on one side get distinct offsets, stacked
  //    outward so inner lanes stay shortest.
  const gutterRuns = { L: [], R: [] };
  for (const r of routes) {
    if (!r || !r.side) continue;
    const a = r.srcRun.main, b = r.dstRun.main;
    gutterRuns[r.side].push({ lo: Math.min(a, b) - 6, hi: Math.max(a, b) + 6, route: r });
  }
  for (const side of ['L', 'R']) {
    assignLanes(gutterRuns[side]);
    for (const run of gutterRuns[side]) {
      run.route.g = side === 'L'
        ? gutterBaseL - run.lane * gutterGap
        : gutterBaseR + run.lane * gutterGap;
    }
  }

  // 6. Emit polylines, label anchors (always on the labelled run) and the
  //    arrowhead pose at the target port.
  return routes.map((r) => {
    if (!r) return null;
    const pts = [];
    let label;
    if (!r.side) {
      const L = r.srcRun.main;
      const enter = r.type === 'same' ? r.t.m1 : r.t.m0;
      pts.push(toXY(r.sp, r.s.m1), toXY(r.sp, L), toXY(r.tp, L), toXY(r.tp, enter));
      label = toXY((r.sp + r.tp) / 2, L);
    } else {
      const L1 = r.srcRun.main, L2 = r.dstRun.main, g = r.g;
      pts.push(
        toXY(r.sp, r.s.m1), toXY(r.sp, L1), toXY(g, L1),
        toXY(g, L2), toXY(r.tp, L2), toXY(r.tp, r.t.m0),
      );
      label = r.labelOn === 'src' ? toXY((r.sp + g) / 2, L1) : toXY((r.tp + g) / 2, L2);
    }
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    const arrow = { x: last.x, y: last.y, angle: Math.atan2(last.y - prev.y, last.x - prev.x) };
    return { points: pts, label, arrow };
  });
}

// ── path building ────────────────────────────────────────────────────────────

// Turn an orthogonal polyline into an SVG path with rounded corners. Collinear
// and zero-length intermediate points are dropped first so tiny jogs (port and
// target almost aligned) collapse into a straight segment.
function roundedPathD(points, radius = 10) {
  const pts = [];
  for (const p of points) {
    const prev = pts[pts.length - 1];
    if (prev && Math.abs(prev.x - p.x) < 0.5 && Math.abs(prev.y - p.y) < 0.5) continue;
    pts.push(p);
  }
  for (let i = pts.length - 2; i > 0; i--) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) pts.splice(i, 1);
  }
  if (pts.length < 2) return '';
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.5) { d += ` L ${p1.x} ${p1.y}`; continue; }
    const ax = p1.x - ((p1.x - p0.x) / l1) * r;
    const ay = p1.y - ((p1.y - p0.y) / l1) * r;
    const bx = p1.x + ((p2.x - p1.x) / l2) * r;
    const by = p1.y + ((p2.y - p1.y) / l2) * r;
    d += ` L ${ax} ${ay} Q ${p1.x} ${p1.y} ${bx} ${by}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

export { routeOrthogonalEdges, roundedPathD, laneLoadByChannel, assignLanes };
