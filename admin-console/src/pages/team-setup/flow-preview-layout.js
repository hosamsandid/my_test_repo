// Pure layout math for the wizard's mini flow preview (BundleFlowPreview,
// #427). Kept React-free so the edge-routing rules are unit-testable. Edges
// fall into three classes, each routed to stay next to the boxes it connects:
//   • forward (target in a later column) — a cubic bezier in the column
//     corridor; labels staggered when several share a corridor
//   • intra-column (rework/escalation loops between roles stacked in one
//     stage) — a short orthogonal bracket in that column's right gutter, with
//     the label beside it; the loops stay local to their stage instead of
//     being dragged into a band below the whole grid
//   • cross-column back (target in an earlier column) — one orthogonal lane
//     per edge below the grid, one label line each
// The renderer stays a light, read-only SVG — not flow-graph-render.js.

export const PREVIEW = {
  NODE_W: 168, NODE_H: 40, COL_W: 264, ROW_H: 62, PAD: 16, HEADER: 26,
  LANE_START: 26,  // gap between the grid bottom and the first back-edge lane
  LANE_STEP: 14,   // one label line per back-edge lane
  LABEL_GAP: 12,   // min vertical distance between staggered labels
  BUS_INSET: 10,   // gutter offset of the first intra-column loop bracket
  BUS_STEP: 8,     // extra offset per nested intra-column loop
  CHAR_W: 5.3,     // rough px per char at the 9.5px label font
};

export function ellipsize(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function estimateLabelWidth(text) {
  return String(text).length * PREVIEW.CHAR_W;
}

// Orthogonal polyline with rounded corners.
export function roundedPath(pts, r = 6) {
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]; const [cx, cy] = pts[i]; const [nx, ny] = pts[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    if (!inLen || !outLen) continue;
    const ri = Math.min(r, inLen / 2, outLen / 2);
    d += ` L ${cx - ((cx - px) / inLen) * ri} ${cy - ((cy - py) / inLen) * ri}`
      + ` Q ${cx} ${cy} ${cx + ((nx - cx) / outLen) * ri} ${cy + ((ny - cy) / outLen) * ri}`;
  }
  d += ` L ${pts[pts.length - 1][0]} ${pts[pts.length - 1][1]}`;
  return d;
}

export function bundleEdges(bundle) {
  const roles = bundle.roles || [];
  const edges = [];
  // Channels: producer → consumer (with optional label + human gate).
  for (const r of roles) {
    for (const ch of (r.channels || [])) {
      if (!ch || !ch.from) continue;
      edges.push({ from: ch.from, to: r.id, label: ch.label || (ch.artifact === 'issue' ? 'issue' : 'PR'), gate: ch.gate === 'human' });
    }
  }
  // Label hand-offs: emitter → listener. Emitters are the role-level `emits`
  // only (#414/#783) — trigger-level emits were removed as a redundant surface.
  const emitters = new Map(); // label -> Set(roleId)
  const addEmit = (label, id) => {
    if (!emitters.has(label)) emitters.set(label, new Set());
    emitters.get(label).add(id);
  };
  for (const r of roles) {
    for (const e of (r.emits || [])) addEmit(e, r.id);
  }
  for (const r of roles) {
    for (const t of (r.triggers || [])) {
      if (t.channel || !t.labelFilter) continue;
      for (const from of (emitters.get(t.labelFilter) || [])) {
        if (from === r.id) continue;
        if (edges.some(e => e.from === from && e.to === r.id && e.label === t.labelFilter)) continue;
        edges.push({ from, to: r.id, label: t.labelFilter, gate: false });
      }
    }
  }
  return edges;
}

export function computePreviewLayout(bundle) {
  if (!bundle || !Array.isArray(bundle.roles) || bundle.roles.length === 0) return null;
  const { NODE_W, NODE_H, COL_W, ROW_H, PAD, HEADER, LANE_START, LANE_STEP, LABEL_GAP, BUS_INSET, BUS_STEP } = PREVIEW;
  const GAP = COL_W - NODE_W;

  const stages = Array.isArray(bundle.stages) && bundle.stages.length ? bundle.stages : [''];
  const colOf = (r) => {
    const i = stages.indexOf(r.stage);
    return i === -1 ? stages.length : i;
  };
  const cols = new Map();
  const pos = new Map();
  for (const r of bundle.roles) {
    const c = colOf(r);
    if (!cols.has(c)) cols.set(c, []);
    pos.set(r.id, { col: c, row: cols.get(c).length, role: r });
    cols.get(c).push(r.id);
  }
  const nCols = Math.max(...[...cols.keys()]) + 1;
  const maxRows = Math.max(...[...cols.values()].map(v => v.length));
  const xy = (id) => {
    const p = pos.get(id);
    return { x: PAD + p.col * COL_W, y: PAD + HEADER + p.row * ROW_H };
  };
  const nodes = [...pos.values()].map(({ role }) => ({ role, ...xy(role.id) }));
  const gridBottom = PAD + HEADER + (maxRows - 1) * ROW_H + NODE_H;

  const fw = [];
  const intra = [];
  const cross = [];
  for (const e of bundleEdges(bundle)) {
    if (!pos.has(e.from) || !pos.has(e.to)) continue;
    const cf = pos.get(e.from).col;
    const ct = pos.get(e.to).col;
    const a = xy(e.from);
    const b = xy(e.to);
    const labelText = e.gate ? `⛔ ${e.label}` : e.label;
    const rec = { ...e, a, b, labelText, cf, ct };
    if (ct > cf) fw.push(rec);            // forward: target in a later column
    else if (ct === cf) intra.push(rec);  // rework/escalation loop within a stage
    else cross.push(rec);                 // back: target in an earlier column
  }

  // A label baseline sitting on a node row is pushed into the gap below it.
  const nudgeOffRows = (y) => {
    for (let k = 0; k < maxRows; k++) {
      const top = PAD + HEADER + k * ROW_H;
      if (y + 2 > top && y - 8 < top + NODE_H) return top + NODE_H + 12;
    }
    return y;
  };

  // Forward edges: cubic bezier; the label is clamped into the free corridor
  // left of the target column, its y taken from the curve at that x.
  const forward = fw.map(e => {
    const x1 = e.a.x + NODE_W + 4; const y1 = e.a.y + NODE_H / 2;
    const x2 = e.b.x; const y2 = e.b.y + NODE_H / 2;
    const midX = (x1 + x2) / 2;
    const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2 - 9} ${y2}`;
    const labelX = e.b.x - GAP / 2;
    const t = Math.min(1, Math.max(0, (labelX - x1) / (x2 - x1 || 1)));
    const curveY = y1 + (y2 - y1) * (3 * t * t - 2 * t * t * t);
    return { ...e, d, labelX, prefY: curveY - 5 };
  });

  // Intra-column loops: a short orthogonal bracket in the column's right
  // gutter, one bus lane per loop so nested loops sit side by side instead of
  // overprinting. The label rides the gutter centre — the same corridor as the
  // forward labels entering the next column — so both are staggered together.
  const byCol = new Map();
  for (const e of intra) {
    if (!byCol.has(e.cf)) byCol.set(e.cf, []);
    byCol.get(e.cf).push(e);
  }
  const intraEdges = [];
  for (const group of byCol.values()) {
    group.sort((p, q) => Math.abs(p.b.y - p.a.y) - Math.abs(q.b.y - q.a.y));
    const gx = group[0].a.x + NODE_W; // right edge of this column's boxes
    const exitSeen = new Map();
    const entrySeen = new Map();
    group.forEach((e, k) => {
      const busX = gx + BUS_INSET + k * BUS_STEP;
      const kOut = exitSeen.get(e.from) || 0; exitSeen.set(e.from, kOut + 1);
      const kIn = entrySeen.get(e.to) || 0; entrySeen.set(e.to, kIn + 1);
      const exitY = e.a.y + 10 + (kOut % 3) * 9;
      const entryY = e.b.y + NODE_H - 10 - (kIn % 3) * 9;
      const d = roundedPath([
        [gx, exitY], [busX, exitY], [busX, entryY], [gx + 4, entryY],
      ]);
      intraEdges.push({ ...e, d, busX, labelX: gx + GAP / 2, prefY: (exitY + entryY) / 2 - 5 });
    });
  }

  // Stagger labels sharing a corridor (forward + intra loops); a label keeps its
  // near-line spot only while it fits the corridor and nothing pushed it —
  // otherwise it moves into the row gap below the box band it would cross.
  const corridors = new Map();
  for (const e of [...forward, ...intraEdges]) {
    const key = Math.round(e.labelX);
    if (!corridors.has(key)) corridors.set(key, []);
    corridors.get(key).push(e);
  }
  for (const group of corridors.values()) {
    group.sort((p, q) => p.prefY - q.prefY);
    let last = -Infinity;
    for (const e of group) {
      let y = Math.max(e.prefY, last + LABEL_GAP);
      if (y > e.prefY + 2 || estimateLabelWidth(e.labelText) > GAP - 4) y = nudgeOffRows(y);
      e.labelY = y;
      last = y;
    }
  }

  // Cross-column back edges: one orthogonal lane per edge below the grid, narrow
  // loops on the lanes closest to the boxes so wider loops nest around them.
  cross.sort((p, q) => ((p.a.x + NODE_W) - p.b.x) - ((q.a.x + NODE_W) - q.b.x));
  const entrySeen = new Map();
  const exitSeen = new Map();
  const backCross = cross.map((e, i) => {
    const laneY = gridBottom + LANE_START + i * LANE_STEP;
    const xr = e.a.x + NODE_W + 5 + (i % 3) * 5;
    const xl = Math.max(3, e.b.x - 5 - (i % 3) * 5);
    const kOut = exitSeen.get(e.from) || 0;
    exitSeen.set(e.from, kOut + 1);
    const exitY = e.a.y + NODE_H - 12 + (kOut % 2) * 6;
    const kIn = entrySeen.get(e.to) || 0;
    entrySeen.set(e.to, kIn + 1);
    const entryY = Math.max(e.b.y + 8, e.b.y + NODE_H - 10 - (kIn % 3) * 7);
    const d = roundedPath([
      [e.a.x + NODE_W, exitY], [xr, exitY], [xr, laneY],
      [xl, laneY], [xl, entryY], [e.b.x - 9, entryY],
    ]);
    return { ...e, d, labelX: (xr + xl) / 2, labelY: laneY - 4 };
  });

  // The renderer draws forward + back; intra loops ride in `back` (before the
  // cross lanes) so they need no separate render pass.
  const back = [...intraEdges, ...backCross];

  // Size the svg to whatever the nodes, paths and labels actually occupy, so
  // nothing clips regardless of how the labels staggered or nudged.
  let maxX = PAD + (nCols - 1) * COL_W + NODE_W;
  let maxY = gridBottom;
  for (const e of [...forward, ...back]) {
    maxX = Math.max(maxX, e.labelX + estimateLabelWidth(e.labelText) / 2 + 2);
    maxY = Math.max(maxY, e.labelY + 2);
  }
  for (const e of intraEdges) maxX = Math.max(maxX, e.busX + 4);
  for (const e of backCross) maxX = Math.max(maxX, e.a.x + NODE_W + 5 + 10);
  return {
    stages, nodes, forward, back,
    width: maxX + PAD,
    height: maxY + PAD,
  };
}
