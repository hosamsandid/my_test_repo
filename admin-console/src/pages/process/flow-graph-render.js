// flow-graph-render.js — ES Module (Unified Orchestration #362, UI rework Phase B)
//
// The rich, BP-Explorer-style graph renderer (originally bp-graph.js), now
// generalized to consume the unified graph from /api/flows/graph instead of raw
// BriefingPack objects. It keeps the look the operators preferred — expandable
// node cards, parent-child hierarchy, the Content/prompt panel, and the data-flow
// (input/output artifact) view — and additionally draws the process-linking edges
// (label / review / manual) on top.
//
//   const g = initFlowGraph(viewportEl, { onSelectNode });
//   g.setData(unifiedGraph);   // { nodes, edges, lints } from /api/flows/graph
//   g.fit(); g.cleanup();

import { computeFlowLayout, assignCrossCoords } from './flow-layout';

export function initFlowGraph(viewport, { onSelectNode, onConnect, onSelectEdge } = {}) {

  // ─── Constants ──────────────────────────────────────────────────────
  const NODE_W      = 320;
  const ARTIFACT_W  = 220;
  const H_GAP       = 50;
  const V_GAP       = 100;
  const ARTIFACT_H  = 70;

  // ─── DOM structure ──────────────────────────────────────────────────
  // Build canvas-viewport → canvas → svg#edges structure inside the
  // supplied viewport element.
  viewport.style.position = 'relative';
  viewport.style.overflow = 'hidden';
  viewport.style.width    = '100%';
  viewport.style.height   = '100%';
  viewport.style.cursor   = 'grab';

  const canvas = document.createElement('div');
  canvas.style.position       = 'absolute';
  canvas.style.top            = '0';
  canvas.style.left           = '0';
  canvas.style.transformOrigin = '0 0';
  canvas.style.userSelect     = 'none';
  viewport.appendChild(canvas);

  // Stage bands sit behind everything (#362 E). One <div> per stage group.
  const stageLayer = document.createElement('div');
  stageLayer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
  canvas.appendChild(stageLayer);

  const svgEdges = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEdges.style.position     = 'absolute';
  svgEdges.style.top          = '0';
  svgEdges.style.left         = '0';
  svgEdges.style.overflow     = 'visible';
  svgEdges.style.pointerEvents = 'none';
  canvas.appendChild(svgEdges);

  // Inject shared styles once (animations + badge colours)
  if (!document.getElementById('bp-graph-styles')) {
    const style = document.createElement('style');
    style.id = 'bp-graph-styles';
    style.textContent = `
      @keyframes bp-node-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4); }
        70%  { box-shadow: 0 0 0 8px rgba(59, 130, 246, 0); }
        100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
      }
      .bp-badge { display:inline-block; padding:1px 6px; border-radius:3px; font-size:10px; font-weight:500; }
      .bp-badge-rigor-high     { background:rgba(249,115,22,0.15); color:#f97316; border:1px solid rgba(249,115,22,0.4); }
      .bp-badge-rigor-standard { background:rgba(107,114,128,0.15); color:#9ca3af; border:1px solid rgba(107,114,128,0.4); }
      .bp-badge-revision       { background:rgba(99,102,241,0.15);  color:#818cf8; border:1px solid rgba(99,102,241,0.4); }

      /* ── Status backgrounds (dark, default) ─────────────────────────── */
      .bp-node-status-draft      { background: #1e1318; }
      .bp-node-status-ready      { background: #1c1810; }
      .bp-node-status-dispatched { background: #111827; }
      .bp-node-status-claimed    { background: #13111e; }
      .bp-node-status-completed  { background: #0f1e13; }
      .bp-node-status-reviewed   { background: #0e1c19; }
      .bp-node-status-stale      { background: #1a1028; }

      /* ── Status backgrounds (light mode) ────────────────────────────── */
      :root[data-theme="admin-light"] .bp-node-status-draft      { background: #fff5f5 !important; }
      :root[data-theme="admin-light"] .bp-node-status-ready      { background: #fffbeb !important; }
      :root[data-theme="admin-light"] .bp-node-status-dispatched { background: #eff6ff !important; }
      :root[data-theme="admin-light"] .bp-node-status-claimed    { background: #f5f3ff !important; }
      :root[data-theme="admin-light"] .bp-node-status-completed  { background: #f0fdf4 !important; }
      :root[data-theme="admin-light"] .bp-node-status-reviewed   { background: #ecfdf5 !important; }
      :root[data-theme="admin-light"] .bp-node-status-stale      { background: #faf5ff !important; }

      /* ── Stale stripe pattern: lower opacity for light backgrounds ───── */
      :root[data-theme="admin-light"] .bp-node-status-stale {
        background-image: repeating-linear-gradient(-45deg,transparent,transparent 4px,rgba(168,85,247,0.06) 4px,rgba(168,85,247,0.06) 8px) !important;
      }

      /* ── Badge text: darker shades for light backgrounds ────────────── */
      :root[data-theme="admin-light"] .bp-badge-rigor-high     { color:#c2410c; border-color:rgba(194,65,12,0.4); }
      :root[data-theme="admin-light"] .bp-badge-rigor-standard { color:#4b5563; border-color:rgba(75,85,99,0.4); }
      :root[data-theme="admin-light"] .bp-badge-revision       { color:#4338ca; border-color:rgba(67,56,202,0.4); }
    `;
    document.head.appendChild(style);
  }

  // Loading indicator
  const loadingEl = document.createElement('div');
  loadingEl.textContent = 'Loading briefings…';
  loadingEl.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--eb-text-muted);font-size:14px;pointer-events:none;';
  viewport.appendChild(loadingEl);

  // Zoom display
  const zoomEl = document.createElement('div');
  zoomEl.textContent = '100%';
  zoomEl.style.cssText = 'position:absolute;bottom:8px;right:12px;font-size:11px;color:var(--eb-text-muted);pointer-events:none;z-index:20;';
  viewport.appendChild(zoomEl);

  // Toolbar (buttons wired after functions are defined below)
  const toolbarEl = document.createElement('div');
  toolbarEl.style.cssText = 'position:absolute;top:12px;left:12px;z-index:20;display:flex;gap:6px;align-items:center;';
  viewport.appendChild(toolbarEl);

  // Status legend
  const legendEl = document.createElement('div');
  legendEl.style.cssText = 'position:absolute;bottom:16px;left:50%;transform:translateX(-50%);background:var(--eb-bg-elevated);backdrop-filter:blur(4px);border:1px solid var(--eb-border-default);border-radius:8px;padding:6px 14px;display:flex;gap:10px;align-items:center;z-index:20;pointer-events:none;font-size:11px;white-space:nowrap;';
  const _mkSwatch = (bg, label, dashed) =>
    `<span style="display:flex;align-items:center;gap:4px">` +
    `<span style="width:10px;height:10px;border-radius:2px;display:inline-block;background:${bg};` +
    (dashed ? `border:1px dashed ${bg};background-image:repeating-linear-gradient(-45deg,transparent,transparent 2px,rgba(168,85,247,0.2) 2px,rgba(168,85,247,0.2) 4px);` : '') +
    `"></span><span style="color:var(--eb-text-secondary)">${label}</span></span>`;
  legendEl.innerHTML =
    `<span style="color:var(--eb-text-muted);font-size:10px;margin-right:2px">Edges:</span>` +
    _mkSwatch('var(--eb-border-hover)', 'hierarchy') +
    _mkSwatch('#ef4444', 'depends-on', true) +
    _mkSwatch('#22c55e', 'data flow') +
    _mkSwatch('#3b82f6', 'link') +
    _mkSwatch('#f59e0b', 'review');
  viewport.appendChild(legendEl);

  // ─── State ──────────────────────────────────────────────────────────
  const state = {
    briefings:          [],
    byId:               {},
    roots:              [],
    expanded:           new Set(),
    contentVisible:     new Set(),
    childrenVisible:    new Set(),
    outputsVisible:     new Set(),
    inputsVisible:      new Set(),
    positions:          {},
    artifactPositions:  {},
    numberLabels:       {},
    artifactRegistry:   {},
    pan:                { x: 0, y: 0 },
    zoom:               1.0,
    userTransform:      false,
    dragging:           false,
    dragStart:          { x: 0, y: 0 },
    panStart:           { x: 0, y: 0 },
    showArchived:       localStorage.getItem('ace-graph-show-archived') === 'true',
    orientation:        localStorage.getItem('ace-graph-orientation') === 'vertical' ? 'vertical' : 'horizontal',
    selectedId:         null,   // #362 UI rework Phase C: node selection
    editable:           false,  // structural editing (connect-to-wire, edges)
    connecting:         null,   // { fromId } while dragging a new edge
    showStages:         localStorage.getItem('flow-graph-show-stages') === 'true', // #362 E stage bands
    stageOrder:         [],     // ordered stage names — drives layered layout order
  };

  // ─── Data Loading ────────────────────────────────────────────────────

  function recomputeRoots() {
    state.roots = state.briefings
      .filter(bp => !bp.parent && (state.showArchived || !bp.archived))
      .map(bp => bp.id);
  }

  // Feed the renderer a unified graph ({ nodes, edges, lints }) from
  // /api/flows/graph. Unified nodes are converted to the BP record shape this
  // renderer already understands (hierarchy via parent/children, data flow via
  // artifacts, the expandable Content panel via `body` = node.content). The
  // process-linking edges (label / review / manual) are kept aside as
  // `state.extraEdges` and drawn on top of the BP structure.
  function setData(graph) {
    const g = graph || {};
    const nodes = Array.isArray(g.nodes) ? g.nodes : [];
    const mkArt = (a, direction) =>
      (typeof a === 'string' ? { path: a, direction } : { ...a, direction });
    state.briefings = nodes.map(n => ({
      id: n.id,
      title: n.displayName || n.id,
      slug: '',
      status: '',                       // status dropped (decision 2)
      body: typeof n.content === 'string' ? n.content : '',
      parent: n.parent || null,
      children: Array.isArray(n.children) ? n.children : [],
      depends_on: Array.isArray(n.dependsOn) ? n.dependsOn : [],
      artifacts: [
        ...(Array.isArray(n.inputs) ? n.inputs.map(a => mkArt(a, 'input')) : []),
        ...(Array.isArray(n.outputs) ? n.outputs.map(a => mkArt(a, 'output')) : []),
      ],
      archived: false,
      rigor: n.rigor || '',
      // Bands group by the effective (inherited) stage; fall back to own.
      stage: (typeof n.effectiveStage === 'string' && n.effectiveStage)
        || (typeof n.stage === 'string' ? n.stage : ''),
      _role: n.role,
      _isParent: n.isParent === true,
    }));
    state.byId = {};
    state.briefings.forEach(bp => { state.byId[bp.id] = bp; });

    const EXTRA = new Set(['label', 'review', 'manual']);
    state.extraEdges = (Array.isArray(g.edges) ? g.edges : [])
      .filter(e => EXTRA.has(e.on) && e.from && e.to && e.from !== e.to);

    // Operator-defined stage order (drives the layered layout when set). Accept
    // either bare strings or { name } objects; ignore anything else.
    state.stageOrder = (Array.isArray(g.stages) ? g.stages : [])
      .map(s => (typeof s === 'string' ? s : (s && typeof s.name === 'string' ? s.name : null)))
      .filter(Boolean);

    recomputeRoots();
    buildArtifactRegistry();
    loadingEl.style.display = 'none';
    layout();
    render();
    if (!state.userTransform) fitToView();
  }

  function buildArtifactRegistry() {
    const reg = {};

    state.briefings.forEach(bp => {
      if (!bp.artifacts) return;
      bp.artifacts.forEach(art => {
        const path = art.path;
        if (!reg[path]) {
          const parts = path.replace(/\/$/, '').split('/');
          const filename = parts[parts.length - 1];
          const dir = parts.slice(0, -1).join('/');
          reg[path] = {
            path,
            filename,
            dir: dir || '',
            producers:    [],
            consumers:    [],
            acs:          [],
            descriptions: [],
          };
        }

        if (art.direction === 'output') {
          if (!reg[path].producers.includes(bp.id)) reg[path].producers.push(bp.id);
          if (art.ac && !reg[path].acs.includes(art.ac)) reg[path].acs.push(art.ac);
        } else if (art.direction === 'input') {
          if (!reg[path].consumers.includes(bp.id)) reg[path].consumers.push(bp.id);
        }

        if (art.description && !reg[path].descriptions.includes(art.description)) {
          reg[path].descriptions.push(art.description);
        }
      });
    });

    state.artifactRegistry = reg;
  }

  // ─── Layout ──────────────────────────────────────────────────────────

  function topoSort(ids) {
    const idSet = new Set(ids);
    const result = [];
    const visited = new Set();

    function visit(id) {
      if (visited.has(id)) return;
      visited.add(id);
      const bp = state.byId[id];
      if (!bp) return;
      (bp.depends_on || []).forEach(depId => {
        if (idSet.has(depId)) visit(depId);
      });
      result.push(id);
    }

    ids.forEach(id => visit(id));
    return result;
  }

  function collectDescendants(id, result) {
    const bp = state.byId[id];
    if (!bp || !bp.children) return;
    bp.children.forEach(cid => {
      result.add(cid);
      collectDescendants(cid, result);
    });
  }

  function topoSortRoots(rootIds) {
    const treeMembers = {};
    rootIds.forEach(rootId => {
      const members = new Set([rootId]);
      collectDescendants(rootId, members);
      treeMembers[rootId] = members;
    });

    const idToRoot = {};
    rootIds.forEach(rootId => {
      treeMembers[rootId].forEach(memberId => {
        idToRoot[memberId] = rootId;
      });
    });

    const rootDeps = {};
    rootIds.forEach(rootId => { rootDeps[rootId] = new Set(); });

    rootIds.forEach(rootId => {
      treeMembers[rootId].forEach(memberId => {
        const bp = state.byId[memberId];
        if (!bp) return;
        (bp.depends_on || []).forEach(depId => {
          const depRoot = idToRoot[depId];
          if (depRoot && depRoot !== rootId) {
            rootDeps[rootId].add(depRoot);
          }
        });
      });
    });

    const rootSet = new Set(rootIds);
    const result  = [];
    const visited = new Set();

    function visit(id) {
      if (visited.has(id)) return;
      visited.add(id);
      (rootDeps[id] || new Set()).forEach(depId => {
        if (rootSet.has(depId)) visit(depId);
      });
      result.push(id);
    }

    rootIds.forEach(id => visit(id));
    return result;
  }

  function getVisibleNodes() {
    const visible = [];
    const visited = new Set();
    state.numberLabels = {};

    function walk(id, depth, prefix) {
      if (visited.has(id)) return;
      visited.add(id);
      const bp = state.byId[id];
      if (!bp) return;
      visible.push({ id, depth });
      state.numberLabels[id] = prefix;

      if (state.childrenVisible.has(id) && bp.children && bp.children.length > 0) {
        const sorted = topoSort(bp.children);
        sorted.forEach((childId, i) => walk(childId, depth + 1, prefix + '.' + (i + 1)));
      }
    }

    const sortedRoots = topoSortRoots(state.roots);
    sortedRoots.forEach((id, i) => walk(id, 0, String(i + 1)));
    return visible;
  }

  function getVisibleArtifactPaths() {
    const paths = new Set();
    state.outputsVisible.forEach(bpId => {
      const bp = state.byId[bpId];
      if (!bp || !bp.artifacts) return;
      bp.artifacts.filter(a => a.direction === 'output').forEach(a => paths.add(a.path));
    });
    state.inputsVisible.forEach(bpId => {
      const bp = state.byId[bpId];
      if (!bp || !bp.artifacts) return;
      bp.artifacts.filter(a => a.direction === 'input').forEach(a => paths.add(a.path));
    });
    return paths;
  }

  function getNodeHeight(id) {
    const el = canvas.querySelector(`.bp-node[data-id="${id}"]`);
    if (el) return el.offsetHeight;
    let h = 90;
    if (state.expanded.has(id))      h += 150;
    if (state.contentVisible.has(id)) h += 300;
    return h;
  }

  function getArtifactNodeHeight(path) {
    const el = canvas.querySelector(`.artifact-node[data-path="${CSS.escape(path)}"]`);
    if (el) return el.offsetHeight;
    return ARTIFACT_H;
  }

  // When stage bands are on, group root nodes by their (manual) stage so each
  // stage's subtrees are contiguous along the main axis → clean, non-overlapping
  // bands. Stable within a stage; unstaged roots come last (#362 E).
  function orderRootsByStage(ids) {
    if (!state.showStages) return ids;
    const groups = new Map();
    const order = [];
    ids.forEach(id => {
      const s = (state.byId[id] && state.byId[id].stage) || '';
      if (!groups.has(s)) { groups.set(s, []); order.push(s); }
      groups.get(s).push(id);
    });
    order.sort((a, b) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0)); // unstaged last
    return order.flatMap(s => groups.get(s));
  }

  function layout() {
    const visible = getVisibleNodes();
    if (visible.length === 0) return;
    if (useLayeredLayout(visible)) {
      layoutLayered(visible);
    } else if (state.orientation === 'vertical') {
      layoutVertical(visible);
    } else {
      layoutHorizontal(visible);
    }
  }

  // Flat process/draft flows have no parent-child hierarchy — their whole
  // structure is the directed hand-off / dependency edges. The tree layout piles
  // those into a single column, so we lay them out as an ordered layered DAG
  // instead (sources → sinks, crossings reduced). Hierarchical graphs (BP packs,
  // team-member trees) keep the tree layout.
  function useLayeredLayout(visible) {
    const anyHierarchy = state.briefings.some(bp => bp.parent || (bp.children && bp.children.length));
    if (anyHierarchy) return false;
    const hasExtra = (state.extraEdges || []).length > 0;
    const hasStageOrder = (state.stageOrder || []).length > 0;
    const hasDeps = visible.some(n => ((state.byId[n.id] || {}).depends_on || []).length > 0);
    return hasExtra || hasStageOrder || hasDeps;
  }

  // Layered layout for a flat flow. Columns follow the flow direction (the
  // stage order overrides them when stages are assigned); within-column order
  // and cross-axis alignment come from the pure flow-layout module. Vertical
  // orientation reads columns left→right; horizontal reads them top→bottom.
  function layoutLayered(visible) {
    const vertical = state.orientation === 'vertical';
    const ids = visible.map(n => n.id);
    const idSet = new Set(ids);

    const edges = [];
    (state.extraEdges || []).forEach(e => {
      if (idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to) edges.push({ from: e.from, to: e.to });
    });
    visible.forEach(n => {
      const bp = state.byId[n.id];
      (bp.depends_on || []).forEach(dep => {
        if (idSet.has(dep) && dep !== n.id) edges.push({ from: dep, to: n.id });
      });
    });

    const order = state.stageOrder || [];
    const rankMap = new Map(order.map((s, i) => [s, i]));
    const useStages = order.length > 0 && visible.some(n => rankMap.has((state.byId[n.id] || {}).stage));
    const stageRankOf = useStages
      ? (id => { const s = (state.byId[id] || {}).stage; return rankMap.has(s) ? rankMap.get(s) : null; })
      : null;

    const { colOf, columns } = computeFlowLayout(ids, edges, { stageRankOf, stageCount: order.length });

    const sizeOf = vertical ? (id => getNodeHeight(id)) : (() => NODE_W);
    const crossGap = vertical ? 34 : H_GAP;
    const center = assignCrossCoords(columns, edges, sizeOf, { gap: crossGap });

    const pos = {};
    const colMain = [];
    if (vertical) {
      let x = 0;
      for (let c = 0; c < columns.length; c++) { colMain[c] = x; x += NODE_W + H_GAP * 2; }
      ids.forEach(id => {
        const c = colOf.get(id) || 0;
        pos[id] = { x: colMain[c], y: (center.get(id) || 0) - getNodeHeight(id) / 2 };
      });
    } else {
      let y = 0;
      for (let c = 0; c < columns.length; c++) {
        const maxH = Math.max(90, ...columns[c].map(getNodeHeight));
        colMain[c] = y; y += maxH + V_GAP;
      }
      ids.forEach(id => {
        const c = colOf.get(id) || 0;
        pos[id] = { x: (center.get(id) || 0) - NODE_W / 2, y: colMain[c] };
      });
    }

    state.positions = pos;
    layoutArtifacts(visible);
  }

  function layoutHorizontal(visible) {
    const visibleIds = new Set(visible.map(n => n.id));
    const childrenOf = {};
    visible.forEach(n => {
      const bp  = state.byId[n.id];
      const kids = (bp.children || []).filter(cid => visibleIds.has(cid));
      childrenOf[n.id] = topoSort(kids);
    });

    const subtreeW = {};
    const maxDepth = Math.max(...visible.map(n => n.depth));

    for (let d = maxDepth; d >= 0; d--) {
      visible.filter(n => n.depth === d).forEach(n => {
        const kids = childrenOf[n.id] || [];
        if (kids.length === 0) {
          subtreeW[n.id] = NODE_W;
        } else {
          const childrenW = kids.reduce((sum, cid) => sum + subtreeW[cid], 0)
            + H_GAP * (kids.length - 1);
          subtreeW[n.id] = Math.max(NODE_W, childrenW);
        }
      });
    }

    const pos = {};

    function assignX(id, xStart) {
      const kids = childrenOf[id] || [];
      if (kids.length === 0) {
        pos[id] = { x: xStart, y: 0 };
      } else {
        let cx = xStart;
        kids.forEach(cid => {
          assignX(cid, cx);
          cx += subtreeW[cid] + H_GAP;
        });
        const firstChild = pos[kids[0]];
        const lastChild  = pos[kids[kids.length - 1]];
        pos[id] = {
          x: (firstChild.x + lastChild.x) / 2,
          y: 0,
        };
      }
    }

    let xCursor = 0;
    const sortedRoots = orderRootsByStage(topoSortRoots(state.roots).filter(id => visibleIds.has(id)));
    sortedRoots.forEach(id => {
      assignX(id, xCursor);
      xCursor += subtreeW[id] + H_GAP * 2;
    });

    const depthNodes = {};
    visible.forEach(n => {
      if (!depthNodes[n.depth]) depthNodes[n.depth] = [];
      depthNodes[n.depth].push(n.id);
    });

    let yOffset = 0;
    for (let d = 0; d <= maxDepth; d++) {
      const ids = depthNodes[d] || [];
      ids.forEach(id => { pos[id].y = yOffset; });
      const maxH = Math.max(...ids.map(id => getNodeHeight(id)), 90);
      yOffset += maxH + V_GAP;
    }

    state.positions = pos;
    layoutArtifacts(visible);
  }

  function layoutVertical(visible) {
    const visibleIds = new Set(visible.map(n => n.id));
    const childrenOf = {};
    visible.forEach(n => {
      const bp  = state.byId[n.id];
      const kids = (bp.children || []).filter(cid => visibleIds.has(cid));
      childrenOf[n.id] = topoSort(kids);
    });

    // Sibling gap (vertical) — give a bit of breathing room between stacked nodes
    const SIBLING_V_GAP = 30;

    const subtreeH = {};
    const maxDepth = Math.max(...visible.map(n => n.depth));

    for (let d = maxDepth; d >= 0; d--) {
      visible.filter(n => n.depth === d).forEach(n => {
        const kids = childrenOf[n.id] || [];
        const selfH = getNodeHeight(n.id);
        if (kids.length === 0) {
          subtreeH[n.id] = selfH;
        } else {
          const childrenH = kids.reduce((sum, cid) => sum + subtreeH[cid], 0)
            + SIBLING_V_GAP * (kids.length - 1);
          subtreeH[n.id] = Math.max(selfH, childrenH);
        }
      });
    }

    const pos = {};

    function assignY(id, yStart) {
      const kids = childrenOf[id] || [];
      const selfH = getNodeHeight(id);
      if (kids.length === 0) {
        pos[id] = { x: 0, y: yStart };
      } else {
        let cy = yStart;
        kids.forEach(cid => {
          assignY(cid, cy);
          cy += subtreeH[cid] + SIBLING_V_GAP;
        });
        const firstId = kids[0];
        const lastId  = kids[kids.length - 1];
        const firstH  = getNodeHeight(firstId);
        const lastH   = getNodeHeight(lastId);
        // Center parent's vertical midpoint between first child's and last child's midpoints
        const centerY = ((pos[firstId].y + firstH / 2) + (pos[lastId].y + lastH / 2)) / 2;
        pos[id] = {
          x: 0,
          y: centerY - selfH / 2,
        };
      }
    }

    let yCursor = 0;
    const sortedRoots = orderRootsByStage(topoSortRoots(state.roots).filter(id => visibleIds.has(id)));
    sortedRoots.forEach(id => {
      assignY(id, yCursor);
      yCursor += subtreeH[id] + V_GAP;
    });

    // Assign X per depth column — all nodes have the same width
    let xOffset = 0;
    for (let d = 0; d <= maxDepth; d++) {
      const ids = (visible.filter(n => n.depth === d) || []).map(n => n.id);
      ids.forEach(id => { pos[id].x = xOffset; });
      xOffset += NODE_W + H_GAP * 2;
    }

    state.positions = pos;
    layoutArtifacts(visible);
  }

  function layoutArtifacts(visibleBpNodes) {
    if (state.orientation === 'vertical') {
      layoutArtifactsVertical(visibleBpNodes);
    } else {
      layoutArtifactsHorizontal(visibleBpNodes);
    }
  }

  function layoutArtifactsHorizontal(visibleBpNodes) {
    const visiblePaths = getVisibleArtifactPaths();
    if (visiblePaths.size === 0) { state.artifactPositions = {}; return; }

    let maxY = 0;
    visibleBpNodes.forEach(n => {
      const pos = state.positions[n.id];
      if (!pos) return;
      const h = getNodeHeight(n.id);
      maxY = Math.max(maxY, pos.y + h);
    });
    const artifactRowY = maxY + V_GAP;

    const visibleBpIds = new Set(visibleBpNodes.map(n => n.id));

    const items = [];
    visiblePaths.forEach(path => {
      const reg = state.artifactRegistry[path];
      if (!reg) return;

      let sum  = 0;
      let count = 0;
      let bpMin = Infinity;
      let bpMax = -Infinity;
      const consider = (id, toggleSet) => {
        if (!visibleBpIds.has(id) || !toggleSet.has(id)) return;
        const pos = state.positions[id];
        if (!pos) return;
        const center = pos.x + NODE_W / 2;
        sum += center;
        count++;
        if (center < bpMin) bpMin = center;
        if (center > bpMax) bpMax = center;
      };
      reg.producers.forEach(id => consider(id, state.outputsVisible));
      reg.consumers.forEach(id => consider(id, state.inputsVisible));
      if (count === 0) return;

      items.push({
        path,
        idealX: sum / count - ARTIFACT_W / 2,
        bpMin:  bpMin - ARTIFACT_W / 2,
        bpMax:  bpMax - ARTIFACT_W / 2,
      });
    });

    items.sort((a, b) => a.idealX - b.idealX);
    const SPACING = ARTIFACT_W + 12;
    const blocks  = [];
    for (let i = 0; i < items.length; i++) {
      let start = i;
      let count = 1;
      let sum   = items[i].idealX - i * SPACING;
      let value = sum;
      while (blocks.length > 0 && blocks[blocks.length - 1].value > value) {
        const prev = blocks.pop();
        start  = prev.start;
        count += prev.count;
        sum   += prev.sum;
        value  = sum / count;
      }
      blocks.push({ start, end: i, count, sum, value });
    }

    blocks.forEach(b => {
      for (let i = b.start; i <= b.end; i++) {
        items[i].x = b.value + i * SPACING;
      }
    });

    let prevRight = -Infinity;
    blocks.forEach((b, bIdx) => {
      const minSpan = (b.count - 1) * SPACING;

      if (b.count < 2) {
        prevRight = items[b.start].x;
        return;
      }

      let unionMin = Infinity;
      let unionMax = -Infinity;
      for (let i = b.start; i <= b.end; i++) {
        if (items[i].bpMin < unionMin) unionMin = items[i].bpMin;
        if (items[i].bpMax > unionMax) unionMax = items[i].bpMax;
      }
      const desiredSpan = unionMax - unionMin;
      if (desiredSpan <= minSpan) {
        prevRight = items[b.end].x;
        return;
      }

      const leftLimit  = bIdx > 0 ? prevRight + SPACING : -Infinity;
      const rightLimit = bIdx < blocks.length - 1
        ? blocks[bIdx + 1].value + blocks[bIdx + 1].start * SPACING - SPACING
        : Infinity;

      const centroid = b.value + ((b.start + b.end) / 2) * SPACING;
      let blockStart = centroid - desiredSpan / 2;
      let blockEnd   = centroid + desiredSpan / 2;
      if (blockStart < leftLimit) {
        blockEnd  += leftLimit - blockStart;
        blockStart = leftLimit;
      }
      if (blockEnd > rightLimit) {
        blockStart -= blockEnd - rightLimit;
        blockEnd   = rightLimit;
        if (blockStart < leftLimit) blockStart = leftLimit;
      }
      let span = blockEnd - blockStart;
      if (span < minSpan) span = minSpan;

      const step = span / (b.count - 1);
      for (let i = b.start; i <= b.end; i++) {
        items[i].x = blockStart + step * (i - b.start);
      }
      prevRight = items[b.end].x;
    });

    const artPos = {};
    items.forEach(it => { artPos[it.path] = { x: it.x, y: artifactRowY }; });
    state.artifactPositions = artPos;
  }

  function layoutArtifactsVertical(visibleBpNodes) {
    const visiblePaths = getVisibleArtifactPaths();
    if (visiblePaths.size === 0) { state.artifactPositions = {}; return; }

    // Artifact column lives to the right of all BP columns
    let maxX = 0;
    visibleBpNodes.forEach(n => {
      const pos = state.positions[n.id];
      if (!pos) return;
      maxX = Math.max(maxX, pos.x + NODE_W);
    });
    const artifactColX = maxX + H_GAP * 2;

    const visibleBpIds = new Set(visibleBpNodes.map(n => n.id));

    const items = [];
    visiblePaths.forEach(path => {
      const reg = state.artifactRegistry[path];
      if (!reg) return;

      let sum  = 0;
      let count = 0;
      let bpMin = Infinity;
      let bpMax = -Infinity;
      const consider = (id, toggleSet) => {
        if (!visibleBpIds.has(id) || !toggleSet.has(id)) return;
        const pos = state.positions[id];
        if (!pos) return;
        const h = getNodeHeight(id);
        const center = pos.y + h / 2;
        sum += center;
        count++;
        if (center < bpMin) bpMin = center;
        if (center > bpMax) bpMax = center;
      };
      reg.producers.forEach(id => consider(id, state.outputsVisible));
      reg.consumers.forEach(id => consider(id, state.inputsVisible));
      if (count === 0) return;

      items.push({
        path,
        idealY: sum / count - ARTIFACT_H / 2,
        bpMin:  bpMin - ARTIFACT_H / 2,
        bpMax:  bpMax - ARTIFACT_H / 2,
      });
    });

    items.sort((a, b) => a.idealY - b.idealY);
    const SPACING = ARTIFACT_H + 16;
    const blocks  = [];
    for (let i = 0; i < items.length; i++) {
      let start = i;
      let count = 1;
      let sum   = items[i].idealY - i * SPACING;
      let value = sum;
      while (blocks.length > 0 && blocks[blocks.length - 1].value > value) {
        const prev = blocks.pop();
        start  = prev.start;
        count += prev.count;
        sum   += prev.sum;
        value  = sum / count;
      }
      blocks.push({ start, end: i, count, sum, value });
    }

    blocks.forEach(b => {
      for (let i = b.start; i <= b.end; i++) {
        items[i].y = b.value + i * SPACING;
      }
    });

    let prevBottom = -Infinity;
    blocks.forEach((b, bIdx) => {
      const minSpan = (b.count - 1) * SPACING;

      if (b.count < 2) {
        prevBottom = items[b.start].y;
        return;
      }

      let unionMin = Infinity;
      let unionMax = -Infinity;
      for (let i = b.start; i <= b.end; i++) {
        if (items[i].bpMin < unionMin) unionMin = items[i].bpMin;
        if (items[i].bpMax > unionMax) unionMax = items[i].bpMax;
      }
      const desiredSpan = unionMax - unionMin;
      if (desiredSpan <= minSpan) {
        prevBottom = items[b.end].y;
        return;
      }

      const topLimit    = bIdx > 0 ? prevBottom + SPACING : -Infinity;
      const bottomLimit = bIdx < blocks.length - 1
        ? blocks[bIdx + 1].value + blocks[bIdx + 1].start * SPACING - SPACING
        : Infinity;

      const centroid = b.value + ((b.start + b.end) / 2) * SPACING;
      let blockStart = centroid - desiredSpan / 2;
      let blockEnd   = centroid + desiredSpan / 2;
      if (blockStart < topLimit) {
        blockEnd  += topLimit - blockStart;
        blockStart = topLimit;
      }
      if (blockEnd > bottomLimit) {
        blockStart -= blockEnd - bottomLimit;
        blockEnd    = bottomLimit;
        if (blockStart < topLimit) blockStart = topLimit;
      }
      let span = blockEnd - blockStart;
      if (span < minSpan) span = minSpan;

      const step = span / (b.count - 1);
      for (let i = b.start; i <= b.end; i++) {
        items[i].y = blockStart + step * (i - b.start);
      }
      prevBottom = items[b.end].y;
    });

    const artPos = {};
    items.forEach(it => { artPos[it.path] = { x: artifactColX, y: it.y }; });
    state.artifactPositions = artPos;
  }

  // ─── Rendering ───────────────────────────────────────────────────────

  function render() {
    layout();

    const visible    = getVisibleNodes();
    const visibleIds = new Set(visible.map(n => n.id));

    canvas.querySelectorAll('.bp-node, .artifact-node').forEach(el => el.remove());

    visible.forEach(n => {
      const bp  = state.byId[n.id];
      const pos = state.positions[n.id];
      if (!bp || !pos) return;

      const node = document.createElement('div');
      const selected = state.selectedId === n.id;
      node.className = 'bp-node' + (bp.status ? ` bp-node-status-${bp.status}` : '');
      node.dataset.id = n.id;
      node.style.cssText = `
        position:absolute;
        left:${pos.x}px;
        top:${pos.y}px;
        width:${NODE_W}px;
        background:var(--eb-bg-surface);
        border:${selected ? '2px solid var(--eb-accent-primary)' : '1px solid var(--eb-border-default)'};
        border-radius:8px;
        padding:10px 12px;
        box-sizing:border-box;
        font-size:12px;
        color:var(--eb-text-primary);
        box-shadow:var(--eb-shadow-sm);
        cursor:pointer;
      `;
      applyStatusBorderColor(node, bp.status);
      node.addEventListener('mousedown', e => e.stopPropagation());
      // Select on click — but not when interacting with a button, link or the
      // inline editor inputs inside the card.
      node.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, textarea')) return;
        state.selectedId = n.id;
        if (onSelectNode) onSelectNode(n.id);
        render();
      });

      // Header
      const header = document.createElement('div');
      header.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;';
      header.innerHTML = `
        <span style="flex:1;line-height:1.4;">${esc(bp.title)}</span>
        ${bpIdLabel(bp.id, bp.id.slice(0, 6), 'bp-id-copy')}
      `;
      node.appendChild(header);

      // Badges
      const badgeParts = [];
      if (bp.rigor)    badgeParts.push(`<span class="bp-badge bp-badge-rigor-${esc(bp.rigor)}">${esc(bp.rigor)}</span>`);
      if (bp.revision && parseInt(bp.revision) > 1)
        badgeParts.push(`<span class="bp-badge bp-badge-revision" title="Revised">Rev ${esc(String(bp.revision))}</span>`);
      if (badgeParts.length > 0) {
        const badges = document.createElement('div');
        badges.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;';
        badges.innerHTML = badgeParts.join('');
        node.appendChild(badges);
      }

      // Action buttons
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;';

      const detailBtn = makeBtn('Details', state.expanded.has(n.id));
      detailBtn.addEventListener('click', () => toggleDetails(n.id));
      actions.appendChild(detailBtn);

      if (bp.children && bp.children.length > 0) {
        const childBtn = makeBtn(`Children (${bp.children.length})`, state.childrenVisible.has(n.id));
        childBtn.addEventListener('click', () => toggleChildren(n.id));
        actions.appendChild(childBtn);
      }

      if (bp.artifacts && bp.artifacts.length > 0) {
        const outCount = bp.artifacts.filter(a => a.direction === 'output').length;
        const inCount  = bp.artifacts.filter(a => a.direction === 'input').length;

        if (inCount > 0) {
          const inBtn = makeBtn(`In (${inCount})`, state.inputsVisible.has(n.id));
          inBtn.addEventListener('click', () => toggleInputs(n.id));
          actions.appendChild(inBtn);
        }
        if (outCount > 0) {
          const outBtn = makeBtn(`Out (${outCount})`, state.outputsVisible.has(n.id));
          outBtn.addEventListener('click', () => toggleOutputs(n.id));
          actions.appendChild(outBtn);
        }
      }

      const contentBtn = makeBtn('Content', state.contentVisible.has(n.id));
      contentBtn.addEventListener('click', () => toggleContent(n.id));
      actions.appendChild(contentBtn);

      node.appendChild(actions);

      // Connect-to-wire port (#362 Phase C2): drag to another node to wire a
      // hand-off / link. Only when editable and a handler is wired.
      if (state.editable && onConnect) {
        const port = document.createElement('div');
        port.title = 'Drag to another node to connect them';
        port.style.cssText = 'position:absolute;right:-7px;top:calc(50% - 7px);width:14px;height:14px;border-radius:50%;background:var(--eb-accent-primary);border:2px solid var(--eb-bg-surface);cursor:crosshair;z-index:3;';
        port.addEventListener('mousedown', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          startConnect(n.id);
        });
        node.appendChild(port);
      }

      // Details panel
      if (state.expanded.has(n.id)) {
        const details = document.createElement('div');
        details.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid var(--eb-border-default);font-size:11px;';

        const rows = [];
        rows.push(detailRow('Created', bp.created));
        rows.push(detailRow('Slug', bp.slug));
        if (bp.loopscript) rows.push(detailRow('Loopscript', bp.loopscript));
        if (bp.parent) {
          const parentBp = state.byId[bp.parent];
          rows.push(detailRow('Parent', parentBp ? parentBp.slug : bp.parent));
        }
        if (bp.depends_on && bp.depends_on.length > 0) {
          rows.push(detailRow('Depends on', bp.depends_on.map(did => {
            const dep = state.byId[did];
            return dep ? dep.slug : did;
          }).join(', ')));
        }
        if (bp.execution_order && bp.execution_order.length > 0) {
          const list = bp.execution_order.map(item => {
            if (typeof item === 'string') {
              return `<li>${esc(item)}</li>`;
            } else {
              const note = item.note ? `<span style="color:var(--eb-text-muted);margin-left:4px">${esc(item.note)}</span>` : '';
              return `<li>${esc(item.slug || item.id || JSON.stringify(item))}${note}</li>`;
            }
          }).join('');
          rows.push(`<div style="margin:4px 0 2px;color:var(--eb-text-muted)">Execution Order</div>
            <ol style="text-align:left;padding-left:16px;margin:0 0 4px;">${list}</ol>`);
        }
        if (bp.mentorscripts && bp.mentorscripts.length > 0) {
          rows.push(detailRow('Mentorscripts', bp.mentorscripts.join(', ')));
        }

        details.innerHTML = rows.join('');
        node.appendChild(details);
      }

      // Content panel — the node's prompt/brief, read-only markdown. Editing
      // (prompt, stage, links) is in the right-side inspector (#362 unification).
      if (state.contentVisible.has(n.id) && bp.body) {
        const body = document.createElement('div');
        body.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid var(--eb-border-default);font-size:11px;max-height:300px;overflow-y:auto;line-height:1.5;';
        body.innerHTML = renderMarkdown(bp.body);
        body.addEventListener('wheel', e => e.stopPropagation());
        node.appendChild(body);
      }

      canvas.appendChild(node);
    });

    // Artifact nodes
    renderArtifactNodes();

    // Re-layout with actual DOM heights, then reposition
    requestAnimationFrame(() => {
      layout();
      canvas.querySelectorAll('.bp-node').forEach(el => {
        const id  = el.dataset.id;
        const pos = state.positions[id];
        if (pos) {
          el.style.left = pos.x + 'px';
          el.style.top  = pos.y + 'px';
        }
      });
      canvas.querySelectorAll('.artifact-node').forEach(el => {
        const path = el.dataset.path;
        const pos  = state.artifactPositions[path];
        if (pos) {
          el.style.left = pos.x + 'px';
          el.style.top  = pos.y + 'px';
        }
      });
      drawEdges();
      drawStages();
    });
  }

  // Stage bands (#362 E): a faint labeled rectangle behind the nodes that share
  // a (manual) stage. Computed from actual node positions, so it follows the
  // layout; root grouping by stage keeps each band contiguous.
  function drawStages() {
    stageLayer.innerHTML = '';
    if (!state.showStages) return;
    const visible = getVisibleNodes();
    const boxes = new Map(); // stage -> {minX,minY,maxX,maxY}
    visible.forEach(n => {
      const bp = state.byId[n.id];
      const stage = bp && bp.stage;
      const pos = state.positions[n.id];
      if (!stage || !pos) return;
      const h = getNodeHeight(n.id);
      const b = boxes.get(stage) || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      b.minX = Math.min(b.minX, pos.x);
      b.minY = Math.min(b.minY, pos.y);
      b.maxX = Math.max(b.maxX, pos.x + NODE_W);
      b.maxY = Math.max(b.maxY, pos.y + h);
      boxes.set(stage, b);
    });
    const PAD = 18;
    let i = 0;
    const hues = [210, 280, 150, 30, 330, 90];
    for (const [stage, b] of boxes) {
      const hue = hues[i % hues.length];
      i += 1;
      const band = document.createElement('div');
      band.style.cssText = `position:absolute;left:${b.minX - PAD}px;top:${b.minY - PAD - 18}px;`
        + `width:${b.maxX - b.minX + PAD * 2}px;height:${b.maxY - b.minY + PAD * 2 + 18}px;`
        + `background:hsla(${hue},70%,50%,0.06);border:1px dashed hsla(${hue},60%,55%,0.5);`
        + `border-radius:10px;`;
      const label = document.createElement('div');
      label.textContent = stage;
      label.style.cssText = `position:absolute;left:8px;top:2px;font-size:10px;font-weight:700;`
        + `letter-spacing:0.04em;text-transform:uppercase;color:hsla(${hue},60%,55%,0.95);`;
      band.appendChild(label);
      stageLayer.appendChild(band);
    }
  }

  function renderArtifactNodes() {
    const visiblePaths = getVisibleArtifactPaths();
    const rendered     = new Set();

    visiblePaths.forEach(path => {
      if (rendered.has(path)) return;
      rendered.add(path);

      const reg = state.artifactRegistry[path];
      const pos = state.artifactPositions[path];
      if (!reg || !pos) return;

      const node = document.createElement('div');
      node.className  = 'artifact-node';
      node.dataset.path = path;
      node.style.cssText = `
        position:absolute;
        left:${pos.x}px;
        top:${pos.y}px;
        width:${ARTIFACT_W}px;
        background:var(--eb-bg-surface);
        border:1px solid var(--eb-border-default);
        border-radius:6px;
        padding:8px 10px;
        box-sizing:border-box;
        font-size:11px;
        color:var(--eb-text-primary);
        box-shadow:var(--eb-shadow-xs);
      `;
      node.addEventListener('mousedown', e => e.stopPropagation());

      const fnEl = document.createElement('div');
      fnEl.style.cssText = 'font-weight:600;font-size:12px;margin-bottom:2px;word-break:break-all;';
      fnEl.textContent = reg.filename;
      node.appendChild(fnEl);

      if (reg.dir) {
        const dirEl = document.createElement('div');
        dirEl.style.cssText = 'font-size:10px;color:var(--eb-text-muted);margin-bottom:4px;word-break:break-all;';
        dirEl.textContent = reg.dir + '/';
        node.appendChild(dirEl);
      }

      const meta = document.createElement('div');
      meta.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;';

      const visibleProducers = reg.producers.filter(id => state.outputsVisible.has(id));
      const visibleConsumers = reg.consumers.filter(id => state.inputsVisible.has(id));
      const isOutput = visibleProducers.length > 0;
      const isInput  = visibleConsumers.length > 0;
      let dirColor, dirLabel;
      if (isOutput && isInput) { dirColor = '#a78bfa'; dirLabel = 'output + input'; }
      else if (isOutput)       { dirColor = '#34d399'; dirLabel = 'output'; }
      else                     { dirColor = '#60a5fa'; dirLabel = 'input'; }
      meta.innerHTML = `<span style="background:${dirColor}22;color:${dirColor};border:1px solid ${dirColor}55;border-radius:3px;padding:1px 5px;font-size:10px;">${dirLabel}</span>`;

      reg.acs.forEach(ac => {
        meta.innerHTML += `<span style="background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b55;border-radius:3px;padding:1px 5px;font-size:10px;">${esc(ac)}</span>`;
      });

      node.appendChild(meta);

      const desc = reg.descriptions.find(d => d && !d.startsWith('From bp:')) || reg.descriptions[0];
      if (desc) {
        const descEl = document.createElement('div');
        descEl.style.cssText = 'font-size:10px;color:var(--eb-text-secondary);margin-top:4px;line-height:1.4;';
        descEl.textContent = desc.replace(/^From bp:\w+ — /, '');
        node.appendChild(descEl);
      }

      canvas.appendChild(node);
    });
  }

  function applyStatusBorderColor(node, status) {
    const colors = {
      draft:      '#e05d6f',
      ready:      '#f59e0b',
      dispatched: '#3b82f6',
      claimed:    '#3b82f6',
      completed:  '#22c55e',
      reviewed:   '#34d399',
      stale:      '#a855f7',
    };
    if (!status || !colors[status]) return;

    node.style.borderColor = colors[status];
    node.style.borderWidth = '2px';
    // Background is handled by CSS class .bp-node-status-<status> with theme overrides.

    if (status === 'stale') {
      node.style.borderStyle = 'dashed';
      // Dark default stripe; light-mode override is in bp-graph-styles CSS.
      node.style.backgroundImage = 'repeating-linear-gradient(-45deg,transparent,transparent 4px,rgba(168,85,247,0.08) 4px,rgba(168,85,247,0.08) 8px)';
    }
    if (status === 'dispatched') {
      node.style.animation = 'bp-node-pulse 2.5s ease-in-out infinite';
    }
  }

  function makeBtn(label, active) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = `
      padding:2px 8px;
      font-size:11px;
      border-radius:4px;
      border:1px solid ${active ? '#3b82f6' : 'var(--eb-border-default)'};
      background:${active ? 'rgba(59,130,246,0.2)' : 'transparent'};
      color:${active ? '#3b82f6' : 'var(--eb-text-secondary)'};
      cursor:pointer;
    `;
    return btn;
  }

  function detailRow(label, value) {
    return `<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:3px;">
      <span style="color:var(--eb-text-muted);flex-shrink:0;">${esc(label)}</span>
      <span style="word-break:break-all;text-align:right;">${esc(String(value || '—'))}</span>
    </div>`;
  }

  // ─── Edge Drawing ────────────────────────────────────────────────────

  function drawEdges() {
    svgEdges.innerHTML = '';

    // Resize SVG to cover all content so paths at large coordinates are rendered
    let svgMaxX = 100, svgMaxY = 100;
    Object.values(state.positions).forEach(pos => {
      svgMaxX = Math.max(svgMaxX, pos.x + NODE_W + 100);
      svgMaxY = Math.max(svgMaxY, pos.y + 300);
    });
    Object.values(state.artifactPositions).forEach(pos => {
      svgMaxX = Math.max(svgMaxX, pos.x + ARTIFACT_W + 100);
      svgMaxY = Math.max(svgMaxY, pos.y + 200);
    });
    svgEdges.setAttribute('width',  svgMaxX);
    svgEdges.setAttribute('height', svgMaxY);

    const visible    = getVisibleNodes();
    const visibleIds = new Set(visible.map(n => n.id));
    const vertical   = state.orientation === 'vertical';

    // 1. Hierarchy edges (gray solid)
    visible.forEach(n => {
      const bp = state.byId[n.id];
      if (!bp || !state.childrenVisible.has(n.id)) return;

      const parentPos = state.positions[n.id];
      const parentEl  = canvas.querySelector(`.bp-node[data-id="${n.id}"]`);
      if (!parentPos || !parentEl) return;

      const parentH = parentEl.offsetHeight;

      (bp.children || []).forEach(childId => {
        if (!visibleIds.has(childId)) return;
        const childPos = state.positions[childId];
        const childEl  = canvas.querySelector(`.bp-node[data-id="${childId}"]`);
        if (!childPos) return;
        const childH = childEl ? childEl.offsetHeight : getNodeHeight(childId);

        let x1, y1, x2, y2, flow;
        if (vertical) {
          x1 = parentPos.x + NODE_W;
          y1 = parentPos.y + parentH / 2;
          x2 = childPos.x;
          y2 = childPos.y + childH / 2;
          flow = 'horizontal';
        } else {
          x1 = parentPos.x + NODE_W / 2;
          y1 = parentPos.y + parentH;
          x2 = childPos.x + NODE_W / 2;
          y2 = childPos.y;
          flow = 'vertical';
        }

        const d = drawBezierEdge(x1, y1, x2, y2, 'var(--eb-border-hover)', 2, '', false, flow);
        addEdgeHit(d, { from: n.id, to: childId, on: 'parent' });
      });
    });

    // 2. Dependency edges (red dashed)
    visible.forEach(n => {
      const bp = state.byId[n.id];
      if (!bp || !bp.depends_on) return;

      bp.depends_on.forEach(depId => {
        if (!visibleIds.has(depId)) return;
        const fromPos = state.positions[depId];
        const toPos   = state.positions[n.id];
        const fromEl  = canvas.querySelector(`.bp-node[data-id="${depId}"]`);
        if (!fromPos || !toPos || !fromEl) return;

        const fromH = fromEl.offsetHeight;

        let x1, y1, x2, y2, pathD, arrowPoints;
        if (vertical) {
          // Deps flow top → bottom (dependent BP sits below the producer in the column)
          x1 = fromPos.x + NODE_W / 2;
          y1 = fromPos.y + fromH;
          x2 = toPos.x + 45;
          y2 = toPos.y;
          const my = (y1 + y2) / 2;
          pathD = `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
          // arrowhead points down (toward target's top)
          arrowPoints = `${x2},${y2} ${x2-4},${y2-8} ${x2+4},${y2-8}`;
        } else {
          x1 = fromPos.x + NODE_W;
          y1 = fromPos.y + fromH / 2;
          x2 = toPos.x;
          y2 = toPos.y + 45;
          const mx = (x1 + x2) / 2;
          pathD = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
          // arrowhead points right (toward target's left)
          arrowPoints = `${x2},${y2} ${x2-8},${y2-4} ${x2-8},${y2+4}`;
        }

        const path = makeSvgPath(pathD);
        path.setAttribute('stroke', '#ef4444');
        path.setAttribute('stroke-width', '1.5');
        path.setAttribute('stroke-dasharray', '6 4');
        path.setAttribute('fill', 'none');
        path.setAttribute('opacity', '0.5');

        const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        arrow.setAttribute('points', arrowPoints);
        arrow.setAttribute('fill', '#ef4444');
        arrow.setAttribute('opacity', '0.5');
        svgEdges.appendChild(arrow);

        addEdgeHit(pathD, { from: depId, to: n.id, on: 'dependency' });
      });
    });

    // 3. Artifact edges
    drawArtifactEdges(visibleIds);

    // 4. Process-linking edges (label / review / manual) — the extra wiring
    //    from the process view, drawn on top of the BP structure.
    const EXTRA_COLOR = { label: '#3b82f6', review: '#f59e0b', manual: '#3b82f6' };
    (state.extraEdges || []).forEach(e => {
      if (!visibleIds.has(e.from) || !visibleIds.has(e.to)) return;
      const fromPos = state.positions[e.from];
      const toPos   = state.positions[e.to];
      const fromEl  = canvas.querySelector(`.bp-node[data-id="${e.from}"]`);
      if (!fromPos || !toPos || !fromEl) return;
      const fromH = fromEl.offsetHeight;
      const color = EXTRA_COLOR[e.on] || '#3b82f6';

      let x1, y1, x2, y2, flow;
      if (vertical) {
        x1 = fromPos.x + NODE_W; y1 = fromPos.y + fromH / 2;
        x2 = toPos.x;            y2 = toPos.y + 20; flow = 'horizontal';
      } else {
        x1 = fromPos.x + NODE_W / 2; y1 = fromPos.y + fromH;
        x2 = toPos.x + NODE_W / 2;   y2 = toPos.y;  flow = 'vertical';
      }
      const d = drawBezierEdge(x1, y1, x2, y2, color, 1.5, '', true, flow);
      // Clickable hit-area so the edge can be edited/removed (#362 Phase C2).
      addEdgeHit(d, { from: e.from, to: e.to, label: e.label, on: e.on, kind: e.on, triggerId: e.triggerId });
      if (e.label) {
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.textContent = e.label;
        t.setAttribute('x', (x1 + x2) / 2);
        t.setAttribute('y', (y1 + y2) / 2);
        t.setAttribute('fill', color);
        t.setAttribute('font-size', '10');
        t.setAttribute('text-anchor', 'middle');
        svgEdges.appendChild(t);
      }
    });
  }

  function drawArtifactEdges(visibleBpIds) {
    const visiblePaths = getVisibleArtifactPaths();
    const vertical     = state.orientation === 'vertical';

    visiblePaths.forEach(path => {
      const reg    = state.artifactRegistry[path];
      const artPos = state.artifactPositions[path];
      if (!reg || !artPos) return;

      const artEl = canvas.querySelector(`.artifact-node[data-path="${CSS.escape(path)}"]`);
      const artH  = artEl ? artEl.offsetHeight : ARTIFACT_H;

      // Output edges: BP → artifact (green)
      reg.producers.forEach(bpId => {
        if (!visibleBpIds.has(bpId)) return;
        const bpPos = state.positions[bpId];
        const bpEl  = canvas.querySelector(`.bp-node[data-id="${bpId}"]`);
        if (!bpPos || !bpEl) return;

        const bpH = bpEl.offsetHeight;
        const d = vertical
          ? drawBezierEdge(
              bpPos.x + NODE_W, bpPos.y + bpH / 2,
              artPos.x,         artPos.y + artH / 2,
              '#34d399', 1.5, '', true, 'horizontal')
          : drawBezierEdge(
              bpPos.x + NODE_W / 2, bpPos.y + bpH,
              artPos.x + ARTIFACT_W / 2, artPos.y,
              '#34d399', 1.5, '', true, 'vertical');
        addEdgeHit(d, { on: 'artifact', from: bpId, direction: 'output', path });
      });

      // Input edges: artifact → BP (blue dashed)
      reg.consumers.forEach(bpId => {
        if (!visibleBpIds.has(bpId)) return;
        const bpPos = state.positions[bpId];
        const bpEl  = canvas.querySelector(`.bp-node[data-id="${bpId}"]`);
        if (!bpPos || !bpEl) return;

        const bpH = bpEl.offsetHeight;
        const d = vertical
          // artifact feeds INTO bp — route from the artifact's edge into the BP.
          ? drawBezierEdge(
              artPos.x,         artPos.y + artH / 2,
              bpPos.x + NODE_W, bpPos.y + bpH / 2,
              '#60a5fa', 1.5, '4 3', true, 'horizontal')
          : drawBezierEdge(
              artPos.x + ARTIFACT_W / 2, artPos.y,
              bpPos.x + NODE_W / 2, bpPos.y + bpH,
              '#60a5fa', 1.5, '4 3', true, 'vertical');
        addEdgeHit(d, { on: 'artifact', from: bpId, direction: 'input', path });
      });
    });
  }

  function drawBezierEdge(x1, y1, x2, y2, stroke, width, dash, arrow, flow = 'vertical') {
    let d, dx, dy;
    if (flow === 'horizontal') {
      const cx1 = x1 + (x2 - x1) * 0.4;
      const cx2 = x2 - (x2 - x1) * 0.4;
      d  = `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`;
      dx = x2 - cx2;
      dy = 0;
    } else {
      const cy1 = y1 + (y2 - y1) * 0.4;
      const cy2 = y2 - (y2 - y1) * 0.4;
      d  = `M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`;
      dx = 0;
      dy = y2 - cy2;
    }
    const p = makeSvgPath(d);
    p.setAttribute('stroke', stroke);
    p.setAttribute('stroke-width', String(width));
    if (dash) p.setAttribute('stroke-dasharray', dash);
    p.setAttribute('fill', 'none');

    if (arrow) {
      const angle = Math.atan2(dy, dx);
      const size  = 7;
      const ax1   = x2 - size * Math.cos(angle - 0.4);
      const ay1   = y2 - size * Math.sin(angle - 0.4);
      const ax2   = x2 - size * Math.cos(angle + 0.4);
      const ay2   = y2 - size * Math.sin(angle + 0.4);
      const tri   = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      tri.setAttribute('points', `${x2},${y2} ${ax1},${ay1} ${ax2},${ay2}`);
      tri.setAttribute('fill', stroke);
      tri.setAttribute('opacity', '0.7');
      svgEdges.appendChild(tri);
    }
    return d;
  }

  function makeSvgPath(d) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svgEdges.appendChild(p);
    return p;
  }

  // Transparent thick overlay that makes an already-drawn edge clickable so it
  // can be edited / removed. No-op unless the host wired onSelectEdge (the BP
  // viewer doesn't — it removes links from the node inspector instead).
  function addEdgeHit(pathD, payload) {
    if (!onSelectEdge || !pathD) return;
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', pathD);
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', '14');
    hit.setAttribute('fill', 'none');
    hit.style.pointerEvents = 'stroke';
    hit.style.cursor = 'pointer';
    hit.addEventListener('mousedown', (ev) => ev.stopPropagation());
    hit.addEventListener('click', (ev) => { ev.stopPropagation(); onSelectEdge(payload); });
    svgEdges.appendChild(hit);
  }

  // ─── Interactions ────────────────────────────────────────────────────

  function toggleDetails(id) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    render();
  }

  function toggleContent(id) {
    if (state.contentVisible.has(id)) state.contentVisible.delete(id);
    else state.contentVisible.add(id);
    render();
  }

  function toggleChildren(id) {
    if (state.childrenVisible.has(id)) {
      collapseSubtree(id);
    } else {
      state.childrenVisible.add(id);
    }
    render();
  }

  function toggleOutputs(id) {
    if (state.outputsVisible.has(id)) state.outputsVisible.delete(id);
    else state.outputsVisible.add(id);
    render();
  }

  function toggleInputs(id) {
    if (state.inputsVisible.has(id)) state.inputsVisible.delete(id);
    else state.inputsVisible.add(id);
    render();
  }

  function collapseSubtree(id) {
    state.childrenVisible.delete(id);
    const bp = state.byId[id];
    if (bp && bp.children) {
      bp.children.forEach(cid => collapseSubtree(cid));
    }
  }

  function expandAll() {
    state.briefings.forEach(bp => {
      if (bp.children && bp.children.length > 0) {
        state.childrenVisible.add(bp.id);
      }
    });
    render();
  }

  function collapseAll() {
    state.childrenVisible.clear();
    state.expanded.clear();
    state.contentVisible.clear();
    state.outputsVisible.clear();
    state.inputsVisible.clear();
    render();
  }

  function fitToView() {
    state.userTransform = false;
    const visible = getVisibleNodes();
    if (visible.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    visible.forEach(n => {
      const pos = state.positions[n.id];
      if (!pos) return;
      const el = canvas.querySelector(`.bp-node[data-id="${n.id}"]`);
      const h  = el ? el.offsetHeight : 90;
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + NODE_W);
      maxY = Math.max(maxY, pos.y + h);
    });

    for (const [path, pos] of Object.entries(state.artifactPositions)) {
      const el = canvas.querySelector(`.artifact-node[data-path="${CSS.escape(path)}"]`);
      const h  = el ? el.offsetHeight : ARTIFACT_H;
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + ARTIFACT_W);
      maxY = Math.max(maxY, pos.y + h);
    }

    const vw       = viewport.clientWidth;
    const vh       = viewport.clientHeight;
    const contentW = maxX - minX + 100;
    const contentH = maxY - minY + 100;

    const scaleX = vw / contentW;
    const scaleY = vh / contentH;
    state.zoom = Math.min(scaleX, scaleY, 1.5);
    state.zoom = Math.max(state.zoom, 0.1);

    state.pan.x = (vw - contentW * state.zoom) / 2 - minX * state.zoom + 50 * state.zoom;
    state.pan.y = (vh - contentH * state.zoom) / 2 - minY * state.zoom + 50 * state.zoom;

    applyTransform();
  }

  // ─── Pan & Zoom ───────────────────────────────────────────────────────

  function setupPanZoom() {
    viewport.addEventListener('mousedown', onMousedown);
    window.addEventListener('mousemove', onMousemove);
    window.addEventListener('mouseup', onMouseup);
    viewport.addEventListener('wheel', onWheel, { passive: false });
  }

  function onMousedown(e) {
    if (e.button !== 0) return;
    state.dragging    = true;
    state.userTransform = true;
    state.dragStart   = { x: e.clientX, y: e.clientY };
    state.panStart    = { ...state.pan };
    viewport.style.cursor = 'grabbing';
  }

  function onMousemove(e) {
    if (state.connecting) { updateTempEdge(e.clientX, e.clientY); return; }
    if (!state.dragging) return;
    state.pan.x = state.panStart.x + (e.clientX - state.dragStart.x);
    state.pan.y = state.panStart.y + (e.clientY - state.dragStart.y);
    applyTransform();
  }

  function onMouseup(e) {
    if (state.connecting) { finishConnect(e); return; }
    state.dragging = false;
    viewport.style.cursor = 'grab';
  }

  // ── Connect-to-wire (#362 UI rework Phase C2) ──────────────────────────────
  let tempEdge = null;
  function toCanvas(clientX, clientY) {
    const r = viewport.getBoundingClientRect();
    return {
      x: (clientX - r.left - state.pan.x) / state.zoom,
      y: (clientY - r.top - state.pan.y) / state.zoom,
    };
  }
  function startConnect(fromId) {
    state.connecting = { fromId };
    viewport.style.cursor = 'crosshair';
    tempEdge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tempEdge.setAttribute('stroke', 'var(--eb-accent-primary)');
    tempEdge.setAttribute('stroke-width', '2');
    tempEdge.setAttribute('stroke-dasharray', '5 4');
    tempEdge.setAttribute('fill', 'none');
    svgEdges.appendChild(tempEdge);
  }
  function updateTempEdge(clientX, clientY) {
    if (!tempEdge) return;
    const pos = state.positions[state.connecting.fromId];
    const el = canvas.querySelector(`.bp-node[data-id="${state.connecting.fromId}"]`);
    if (!pos || !el) return;
    const x1 = pos.x + NODE_W;
    const y1 = pos.y + el.offsetHeight / 2;
    const p = toCanvas(clientX, clientY);
    const cx = x1 + (p.x - x1) * 0.4;
    const cx2 = p.x - (p.x - x1) * 0.4;
    tempEdge.setAttribute('d', `M ${x1} ${y1} C ${cx} ${y1}, ${cx2} ${p.y}, ${p.x} ${p.y}`);
  }
  function finishConnect(e) {
    const fromId = state.connecting.fromId;
    state.connecting = null;
    viewport.style.cursor = 'grab';
    if (tempEdge) { tempEdge.remove(); tempEdge = null; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const nodeEl = el && el.closest ? el.closest('.bp-node') : null;
    const toId = nodeEl && nodeEl.dataset ? nodeEl.dataset.id : null;
    if (toId && toId !== fromId && onConnect) onConnect(fromId, toId);
  }

  function onWheel(e) {
    e.preventDefault();
    state.userTransform = true;
    const delta   = e.deltaY > 0 ? 0.9 : 1.1;
    const oldZoom = state.zoom;
    state.zoom    = Math.max(0.1, Math.min(3.0, state.zoom * delta));

    const rect = viewport.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;

    state.pan.x = mx - (mx - state.pan.x) * (state.zoom / oldZoom);
    state.pan.y = my - (my - state.pan.y) * (state.zoom / oldZoom);

    applyTransform();
  }

  function applyTransform() {
    canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
    zoomEl.textContent     = Math.round(state.zoom * 100) + '%';
  }

  // ─── Markdown Renderer ────────────────────────────────────────────────

  function renderMarkdown(text) {
    if (!text) return '';

    let html = esc(text);

    const codeBlocks = [];
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      let rendered = code.replace(/\n$/, '').split('\n').map(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) return `<span style="color:#34d399">${line}</span>`;
        if (line.startsWith('-') && !line.startsWith('---')) return `<span style="color:#f87171">${line}</span>`;
        return line;
      }).join('\n');
      const placeholder = `\x00CB${codeBlocks.length}\x00`;
      codeBlocks.push(`<pre style="background:var(--eb-bg-app);border:1px solid var(--eb-border-default);padding:8px;border-radius:4px;overflow-x:auto;"><code${lang ? ` data-lang="${lang}"` : ''}>${rendered}</code></pre>`);
      return placeholder;
    });

    const inlineCodes = [];
    html = html.replace(/`([^`]+)`/g, (_, code) => {
      const placeholder = `\x00IC${inlineCodes.length}\x00`;
      inlineCodes.push(`<code style="background:var(--eb-bg-app);border:1px solid var(--eb-border-default);padding:1px 4px;border-radius:3px;">${code}</code>`);
      return placeholder;
    });

    {
      const lines  = html.split('\n');
      const result = [];
      for (let i = 0; i < lines.length; i++) {
        const prev = result.length > 0 ? result[result.length - 1] : '';
        if (/^\s+\S/.test(lines[i]) && !/^\s*- /.test(lines[i]) && /^\s*- /.test(prev)) {
          result[result.length - 1] += ' ' + lines[i].trim();
        } else {
          result.push(lines[i]);
        }
      }
      html = result.join('\n');
    }

    html = html.replace(/^(\|.+\|)\n(\|[-: |]+\|)\n((?:\|.+\|\n?)*)/gm, (match, header, sep, body) => {
      const stripOuter = parts => { let a = parts; if (!a[0].trim()) a = a.slice(1); if (!a[a.length-1].trim()) a = a.slice(0,-1); return a; };
      const sepCells = stripOuter(sep.split('|'));
      const aligns = sepCells.map(c => {
        const t = c.trim();
        if (t.startsWith(':') && t.endsWith(':')) return 'center';
        if (t.endsWith(':')) return 'right';
        return 'left';
      });
      const ths = stripOuter(header.split('|')).map((c, i) =>
        `<th style="text-align:${aligns[i] || 'left'};padding:4px 8px;border:1px solid var(--eb-border-default);">${c.trim()}</th>`
      ).join('');
      const rows = body.trim().split('\n').filter(r => r.trim()).map(row => {
        const tds = stripOuter(row.split('|')).map((c, i) =>
          `<td style="text-align:${aligns[i] || 'left'};padding:4px 8px;border:1px solid var(--eb-border-default);">${c.trim()}</td>`
        ).join('');
        return `<tr>${tds}</tr>`;
      }).join('');
      return `<table style="border-collapse:collapse;width:100%;"><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
    });

    html = html.replace(/(^&gt; .+(\n&gt; .+)*)/gm, (match) => {
      const content = match.replace(/^&gt; ?/gm, '');
      return `<blockquote style="border-left:3px solid var(--eb-border-default);padding-left:8px;color:var(--eb-text-secondary);margin:4px 0;">${content}</blockquote>`;
    });

    html = html.replace(/^#### (.+)$/gm, '<h4 style="margin:6px 0 2px;">$1</h4>');
    html = html.replace(/^### (.+)$/gm,  '<h3 style="margin:6px 0 2px;">$1</h3>');
    html = html.replace(/^## (.+)$/gm,   '<h2 style="margin:6px 0 2px;">$1</h2>');
    html = html.replace(/^# (.+)$/gm,    '<h1 style="margin:6px 0 2px;">$1</h1>');
    html = html.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--eb-border-default);">');

    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g,     '<em>$1</em>');

    html = html.replace(/^- \[ \] (.+)$/gm, '<li style="list-style:none">&#9744; $1</li>');
    html = html.replace(/^- \[x\] (.+)$/gm, '<li style="list-style:none">&#9745; $1</li>');
    html = html.replace(/^\s*- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');

    html = html.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul style="padding-left:16px;margin:4px 0;">$1</ul>');
    html = html.replace(/((?:<oli>.*<\/oli>\n?)+)/g, (m) => {
      return '<ol style="padding-left:16px;margin:4px 0;">' + m.replace(/<\/?oli>/g, t => t.replace('oli', 'li')) + '</ol>';
    });

    html = html.replace(/\n\n+/g, '</p><p>');
    html = '<p style="margin:0 0 4px;">' + html + '</p>';

    const blocks = ['h[1234]', 'table', 'ul', 'ol', 'pre', 'hr', 'blockquote'];
    html = html.replace(/<p[^>]*>\s*<\/p>/g, '');
    blocks.forEach(tag => {
      html = html.replace(new RegExp(`<p[^>]*>\\s*(<${tag}[> ])`, 'g'), '$1');
      html = html.replace(new RegExp(`<p[^>]*>\\s*(<${tag}>)`, 'g'), '$1');
      html = html.replace(new RegExp(`(</${tag}>)\\s*</p>`, 'g'), '$1');
    });

    codeBlocks.forEach((block, i) => {
      html = html.replace(`\x00CB${i}\x00`, block);
    });
    inlineCodes.forEach((code, i) => {
      html = html.replace(`\x00IC${i}\x00`, code);
    });

    return html;
  }

  // ─── Utilities ────────────────────────────────────────────────────────

  function esc(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  }

  function bpIdLabel(fullId, displayText, extraClass) {
    if (!fullId) return esc(displayText || '');
    const text = (displayText !== undefined && displayText !== null) ? displayText : fullId;
    const cls  = extraClass ? extraClass : '';
    return `<span class="${cls}" data-bp-id="${esc(fullId)}" title="Click to copy ${esc(fullId)}" style="font-size:10px;color:var(--eb-text-muted);cursor:pointer;font-family:monospace;flex-shrink:0;" onclick="(function(e){e.stopPropagation();var el=e.currentTarget;var id=el.dataset.bpId||el.textContent.trim();if(navigator.clipboard)navigator.clipboard.writeText(id).catch(()=>{});el.style.color='#3b82f6';setTimeout(()=>el.style.color='var(--eb-text-muted)',1000);})(event)">${esc(text)}</span>`;
  }

  // ─── Resize observer ─────────────────────────────────────────────────

  function onResize() {
    layout();
    render();
  }

  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(viewport);

  // ─── Toolbar setup ────────────────────────────────────────────────────

  function makeToolBtn(label, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:4px 10px;font-size:11px;border-radius:4px;border:1px solid var(--eb-border-default);background:var(--eb-bg-elevated);backdrop-filter:blur(4px);color:var(--eb-text-secondary);cursor:pointer;transition:border-color 0.1s,color 0.1s;';
    b.addEventListener('mouseover', () => { b.style.borderColor = 'var(--eb-border-hover)'; b.style.color = 'var(--eb-text-primary)'; });
    b.addEventListener('mouseout',  () => {
      b.style.borderColor = b._active ? '#3b82f6' : 'var(--eb-border-default)';
      b.style.color       = b._active ? '#3b82f6' : 'var(--eb-text-secondary)';
    });
    b.addEventListener('click', fn);
    return b;
  }

  function updateArchivedBtn(btn) {
    btn._active            = state.showArchived;
    btn.style.borderColor  = state.showArchived ? '#3b82f6' : 'var(--eb-border-default)';
    btn.style.color        = state.showArchived ? '#3b82f6' : 'var(--eb-text-secondary)';
    btn.style.background   = state.showArchived ? 'rgba(59,130,246,0.15)' : 'var(--eb-bg-elevated)';
  }

  toolbarEl.appendChild(makeToolBtn('Fit',          () => { state.userTransform = false; fitToView(); }));
  toolbarEl.appendChild(makeToolBtn('Expand All',   () => expandAll()));
  toolbarEl.appendChild(makeToolBtn('Collapse All', () => collapseAll()));

  function updateOrientationBtn(btn) {
    const active = state.orientation === 'vertical';
    btn._active            = active;
    btn.textContent        = active ? 'Vertical' : 'Horizontal';
    btn.title              = 'Toggle layout orientation (roots flow ' +
      (active ? 'top to bottom; children flow left to right' : 'left to right; children flow top to bottom') + ')';
    btn.style.borderColor  = active ? '#3b82f6' : 'var(--eb-border-default)';
    btn.style.color        = active ? '#3b82f6' : 'var(--eb-text-secondary)';
    btn.style.background   = active ? 'rgba(59,130,246,0.15)' : 'var(--eb-bg-elevated)';
  }

  const orientationBtn = makeToolBtn('Horizontal', () => {
    state.orientation = state.orientation === 'vertical' ? 'horizontal' : 'vertical';
    localStorage.setItem('ace-graph-orientation', state.orientation);
    updateOrientationBtn(orientationBtn);
    state.userTransform = false;
    render();
    requestAnimationFrame(() => fitToView());
  });
  updateOrientationBtn(orientationBtn);
  toolbarEl.appendChild(orientationBtn);

  const archivedBtn = makeToolBtn('Archived', () => {
    state.showArchived = !state.showArchived;
    localStorage.setItem('ace-graph-show-archived', state.showArchived);
    updateArchivedBtn(archivedBtn);
    recomputeRoots();
    render();
  });
  updateArchivedBtn(archivedBtn);
  toolbarEl.appendChild(archivedBtn);

  // Stages toggle (#362 E): group + band nodes by their manual stage.
  const updateStagesBtn = (btn) => {
    btn.textContent = state.showStages ? 'Stages: on' : 'Stages';
    btn.style.color = state.showStages ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)';
  };
  const stagesBtn = makeToolBtn('Stages', () => {
    state.showStages = !state.showStages;
    localStorage.setItem('flow-graph-show-stages', state.showStages);
    updateStagesBtn(stagesBtn);
    state.userTransform = false;
    render();
  });
  updateStagesBtn(stagesBtn);
  toolbarEl.appendChild(stagesBtn);

  // ─── Init ─────────────────────────────────────────────────────────────

  setupPanZoom();
  // No auto-fetch — the React wrapper loads /api/flows/graph and calls setData.

  // ─── Public API ─────────────────────────────────────────────────────────

  function cleanup() {
    viewport.removeEventListener('mousedown', onMousedown);
    window.removeEventListener('mousemove', onMousemove);
    window.removeEventListener('mouseup', onMouseup);
    viewport.removeEventListener('wheel', onWheel);
    resizeObserver.disconnect();
    // Remove injected DOM
    while (viewport.firstChild) viewport.removeChild(viewport.firstChild);
  }

  return {
    setData,
    fit: () => { state.userTransform = false; fitToView(); },
    setSelected: (id) => { state.selectedId = id; render(); },
    setEditable: (v) => { if (state.editable !== !!v) { state.editable = !!v; render(); } },
    cleanup,
  };
}
