/* graph-layout.js — pure auto-layout for the Project Plan graph canvas.
 *
 * The board's model stores NO x/y (plan-doc.js §5): a graph panel is only
 * `bands[]` (phase rows, ordered), `nodes[]` (each with a `bandId` + display
 * `order`) and directed `edges[]` (from → to, meaning "from feeds to" / "to
 * depends on from"). This module turns that into pixel positions so the served
 * canvas can draw it — and re-derive it after every mutation, so the user never
 * positions a node.
 *
 *   • X (columns): break dependency cycles (DFS back-edge drop), then longest-
 *     path layering over the feeds-edges → a column index (a visible left-to-
 *     right "step 1..n", the reference's step axis).
 *   • Y (rows): a node lives inside its BAND's horizontal region; bands are
 *     stacked top-to-bottom by `band.order` (the reference's phase zones). Nodes
 *     that share a (band, column) cell stack into sub-rows; a band is exactly as
 *     tall as its fullest column needs.
 *   • Edges: anchored from a node's right face to the downstream node's left
 *     face; the renderer turns the anchor points into a bezier.
 *
 * Concept lifted from admin-console/src/pages/process/flow-layout.js, but pure
 * and dependency-free so it runs as a browser <script> (attaches
 * window.PlanLayout) AND as a Node module (module.exports) for `node --test`.
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') window.PlanLayout = mod;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    nodeW: 158,
    nodeH: 64,
    colGap: 66,
    rowGap: 18,
    bandPad: 18,
    bandGap: 12,
    gutter: 184, // left label lane for band (phase) names
    pad: 32,
    minBandH: 104,
  };

  var UNBANDED = { id: '', name: 'Unassigned', color: '#94a3b8' };

  // ── graph helpers (from → to means "from feeds to"; to is downstream) ─────────

  function buildOut(ids, edges) {
    var idSet = {};
    ids.forEach(function (id) { idSet[id] = true; });
    var out = {};
    ids.forEach(function (id) { out[id] = []; });
    (edges || []).forEach(function (e) {
      if (!e || e.from === e.to) return;
      if (!idSet[e.from] || !idSet[e.to]) return;
      out[e.from].push(e.to);
    });
    return out;
  }

  // Keep only the acyclic subset of edges (DFS grey-node rule drops back-edges),
  // so layering always terminates. Deterministic given a stable node order.
  function breakCycles(ids, edges) {
    var out = buildOut(ids, edges);
    var WHITE = 0, GREY = 1, BLACK = 2;
    var color = {};
    ids.forEach(function (id) { color[id] = WHITE; });
    var keep = [];
    function visit(u) {
      color[u] = GREY;
      (out[u] || []).forEach(function (v) {
        var c = color[v];
        if (c === WHITE) { keep.push({ from: u, to: v }); visit(v); }
        else if (c === GREY) { /* back-edge → drop */ }
        else { keep.push({ from: u, to: v }); }
      });
      color[u] = BLACK;
    }
    ids.forEach(function (id) { if (color[id] === WHITE) visit(id); });
    return keep;
  }

  // Longest-path layering over an acyclic edge set: a source (no kept incoming
  // feed) lands on column 0; every other node sits one past its deepest feeder.
  function longestPathLayers(ids, keptEdges) {
    var out = buildOut(ids, keptEdges);
    var indeg = {};
    ids.forEach(function (id) { indeg[id] = 0; });
    keptEdges.forEach(function (e) { if (indeg[e.to] != null) indeg[e.to] += 1; });

    var queue = ids.filter(function (id) { return indeg[id] === 0; });
    var topo = [];
    var seen = {};
    while (queue.length) {
      var u = queue.shift();
      if (seen[u]) continue;
      seen[u] = true;
      topo.push(u);
      (out[u] || []).forEach(function (v) {
        indeg[v] -= 1;
        if (indeg[v] === 0) queue.push(v);
      });
    }
    // Any node not reached (a residual cycle the break missed) is appended so it
    // still lays out rather than vanishing.
    ids.forEach(function (id) { if (!seen[id]) topo.push(id); });

    var layer = {};
    ids.forEach(function (id) { layer[id] = 0; });
    topo.forEach(function (u) {
      (out[u] || []).forEach(function (v) {
        if (layer[v] < layer[u] + 1) layer[v] = layer[u] + 1;
      });
    });
    return layer;
  }

  // Public: id → column index for a set of nodes and feed-edges.
  function columnsOf(ids, edges) {
    if (!ids.length) return {};
    return longestPathLayers(ids, breakCycles(ids, edges));
  }

  function byOrder(a, b) {
    var ao = typeof a.order === 'number' ? a.order : 0;
    var bo = typeof b.order === 'number' ? b.order : 0;
    if (ao !== bo) return ao - bo;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  }

  /**
   * Compute the full pixel layout of a graph panel.
   *
   * @param {object} panel  a plan-doc graph panel { bands, nodes, edges }
   * @param {object} [options]  geometry overrides (see DEFAULTS)
   * @returns {{
   *   bands:  Array<{id,name,color,order,synthetic,top,height}>,
   *   nodes:  Array<{id,node,col,subrow,x,y,w,h}>,
   *   edges:  Array<{id,from,to,type,x1,y1,x2,y2,backward}>,
   *   width:number, height:number, columnCount:number, gutter:number, opts:object
   * }}
   */
  function compute(panel, options) {
    var opts = {};
    Object.keys(DEFAULTS).forEach(function (k) { opts[k] = DEFAULTS[k]; });
    if (options) Object.keys(options).forEach(function (k) {
      if (options[k] != null) opts[k] = options[k];
    });

    var rawNodes = (panel && Array.isArray(panel.nodes)) ? panel.nodes : [];
    var rawBands = (panel && Array.isArray(panel.bands)) ? panel.bands.slice() : [];
    var rawEdges = (panel && Array.isArray(panel.edges)) ? panel.edges : [];
    rawBands.sort(byOrder);

    // columns
    var ids = rawNodes.map(function (n) { return n.id; });
    var colOf = columnsOf(ids, rawEdges);
    var columnCount = 0;
    ids.forEach(function (id) { if ((colOf[id] || 0) + 1 > columnCount) columnCount = (colOf[id] || 0) + 1; });

    // bands: real bands (ordered) + a synthetic "Unassigned" band iff any node
    // has no (valid) band, so an unbanded node always has a home to render in.
    var bandIds = {};
    rawBands.forEach(function (b) { bandIds[b.id] = true; });
    var hasUnbanded = rawNodes.some(function (n) { return !n.bandId || !bandIds[n.bandId]; });
    var bands = rawBands.map(function (b, i) {
      return { id: b.id, name: b.name, color: b.color, order: typeof b.order === 'number' ? b.order : i, synthetic: false };
    });
    if (hasUnbanded) {
      bands.push({ id: UNBANDED.id, name: UNBANDED.name, color: UNBANDED.color, order: bands.length, synthetic: true });
    }

    // bucket nodes by band
    var nodesByBand = {};
    bands.forEach(function (b) { nodesByBand[b.id] = []; });
    rawNodes.forEach(function (n) {
      var bid = (n.bandId && bandIds[n.bandId]) ? n.bandId : UNBANDED.id;
      if (!nodesByBand[bid]) nodesByBand[bid] = [];
      nodesByBand[bid].push(n);
    });

    var colPitch = opts.nodeW + opts.colGap;
    var rowPitch = opts.nodeH + opts.rowGap;
    function xForCol(c) { return opts.gutter + opts.pad + c * colPitch; }

    var outNodes = [];
    var outBands = [];
    var top = opts.pad;

    bands.forEach(function (b) {
      var list = nodesByBand[b.id] || [];
      // group this band's nodes by column, ordered within a cell by display order
      var byCol = {};
      list.forEach(function (n) {
        var c = colOf[n.id] || 0;
        (byCol[c] = byCol[c] || []).push(n);
      });
      var maxRows = 1;
      Object.keys(byCol).forEach(function (c) {
        byCol[c].sort(byOrder);
        if (byCol[c].length > maxRows) maxRows = byCol[c].length;
      });
      var height = Math.max(opts.minBandH, opts.bandPad * 2 + maxRows * rowPitch - opts.rowGap);

      Object.keys(byCol).forEach(function (c) {
        byCol[c].forEach(function (n, subrow) {
          outNodes.push({
            id: n.id,
            node: n,
            col: Number(c),
            subrow: subrow,
            x: xForCol(Number(c)),
            y: top + opts.bandPad + subrow * rowPitch,
            w: opts.nodeW,
            h: opts.nodeH,
          });
        });
      });

      outBands.push({
        id: b.id, name: b.name, color: b.color, order: b.order,
        synthetic: b.synthetic, top: top, height: height,
      });
      top += height + opts.bandGap;
    });

    var posById = {};
    outNodes.forEach(function (p) { posById[p.id] = p; });

    var contentRight = opts.gutter + opts.pad + Math.max(1, columnCount) * colPitch - opts.colGap + opts.pad;
    var width = Math.max(contentRight, opts.gutter + 360);
    var height = Math.max(top - opts.bandGap + opts.pad, opts.pad * 2 + opts.minBandH);

    var outEdges = [];
    rawEdges.forEach(function (e) {
      var f = posById[e.from];
      var t = posById[e.to];
      if (!f || !t) return;
      outEdges.push({
        id: e.id, from: e.from, to: e.to, type: e.type,
        x1: f.x + f.w, y1: f.y + f.h / 2,
        x2: t.x, y2: t.y + t.h / 2,
        backward: t.x <= f.x,
      });
    });

    return {
      bands: outBands,
      nodes: outNodes,
      edges: outEdges,
      width: width,
      height: height,
      columnCount: columnCount,
      gutter: opts.gutter,
      opts: opts,
    };
  }

  return {
    compute: compute,
    columnsOf: columnsOf,
    breakCycles: breakCycles,
    longestPathLayers: longestPathLayers,
    DEFAULTS: DEFAULTS,
  };
}));
