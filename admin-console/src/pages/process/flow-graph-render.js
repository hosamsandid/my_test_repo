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
import { routeOrthogonalEdges, roundedPathD, laneLoadByChannel } from './edge-router';

export function initFlowGraph(viewport, { onSelectNode, onConnect, onSelectEdge, actorSources, expandChildrenByDefault } = {}) {

  // ─── Constants ──────────────────────────────────────────────────────
  const NODE_W      = 320;
  const ARTIFACT_W  = 220;
  const H_GAP       = 50;
  const V_GAP       = 100;
  const ARTIFACT_H  = 70;
  const ACTOR_W     = 150;   // actor pseudo-nodes (#410) — the "outside world" column
  const ACTOR_H     = 40;
  const ACTOR_ICON  = { github: '🐙', external: '⚡', timer: '⏰' };
  // Placeholder actors (#411): in an editable process view every source is
  // offered as a drag source even before it has edges, so the first event /
  // label / webhook trigger can be wired on the canvas. @human and @timer are
  // gone: human actions are GitHub label events (folded into @github) and
  // schedules render inside the agent card instead of as an actor.
  const DEFAULT_ACTORS = [
    { id: '@github', kind: 'actor', actor: 'github', displayName: 'GitHub' },
    { id: '@external', kind: 'actor', actor: 'external', displayName: 'External system' },
  ];

  // Single source of truth for edge colours (#402). Every drawer and the legend
  // read from here so the graph and its key can never drift apart. Each entry
  // maps a semantic edge type to its stroke colour; the same hue is reused for
  // the node's matching badge/port (Issue = teal, PR = purple) so a node's
  // "opens issues/PRs" chip and the resulting channel edge read as one colour.
  const EDGE_STYLES = {
    hierarchy:  { color: 'var(--eb-border-hover)', label: 'hierarchy' },
    dependency: { color: '#ef4444', label: 'depends-on', dashed: true },
    artifact:   { color: '#22c55e', label: 'data flow' },
    label:      { color: '#3b82f6', label: 'label hand-off' },
    issue:      { color: '#14b8a6', label: 'issue' },
    pr:         { color: '#8b5cf6', label: 'pull request' },
    review:     { color: '#f59e0b', label: 'review' },
    gate:       { color: '#dc2626', label: 'human approval' },
    // Actor-sourced edges (#410): raw GitHub events, schedules, webhooks.
    event:      { color: '#f97316', label: 'GitHub event', dashed: true },
    timer:      { color: '#0ea5e9', label: 'schedule', dashed: true },
    webhook:    { color: '#eab308', label: 'webhook', dashed: true },
  };
  const ARROW_SIZE = 12; // arrowhead length in px (#402 — was 7, hard to see)

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

  // The artifact lane band (a single labelled rectangle behind the artifact row)
  // sits above the stage bands but still behind edges and nodes.
  const laneLayer = document.createElement('div');
  laneLayer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
  canvas.appendChild(laneLayer);

  const svgEdges = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEdges.style.position     = 'absolute';
  svgEdges.style.top          = '0';
  svgEdges.style.left         = '0';
  svgEdges.style.overflow     = 'visible';
  svgEdges.style.pointerEvents = 'none';
  canvas.appendChild(svgEdges);

  // Edge-label overlay — the chips/labels for hand-off & channel edges. Kept in a
  // separate SVG stacked ABOVE the node cards (z-index) so a chip is never hidden
  // behind an adjacent node. Edge *lines* stay in svgEdges (behind the cards).
  const svgLabels = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgLabels.style.position     = 'absolute';
  svgLabels.style.top          = '0';
  svgLabels.style.left         = '0';
  svgLabels.style.overflow     = 'visible';
  svgLabels.style.pointerEvents = 'none';
  svgLabels.style.zIndex       = '4';
  canvas.appendChild(svgLabels);

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
      .bp-badge-gh-pr          { background:rgba(139,92,246,0.15);  color:#a78bfa; border:1px solid rgba(139,92,246,0.4); }
      .bp-badge-gh-issue       { background:rgba(20,184,166,0.15);  color:#2dd4bf; border:1px solid rgba(20,184,166,0.4); }

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

  // Zoom control (bottom-right): − / editable % / preset menu / + — mouse-wheel
  // zoom is imprecise on touch displays, so every step is also reachable by tap.
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 3.0;
  const ZOOM_STEP = 1.25;
  const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];

  const zoomCtrlEl = document.createElement('div');
  zoomCtrlEl.style.cssText = 'position:absolute;bottom:12px;right:12px;z-index:20;display:flex;align-items:center;gap:2px;'
    + 'background:var(--eb-bg-elevated);backdrop-filter:blur(4px);border:1px solid var(--eb-border-default);border-radius:8px;padding:2px;';
  // Interacting with the control must not start a canvas pan / text-select fight.
  zoomCtrlEl.addEventListener('mousedown', (e) => e.stopPropagation());

  const mkZoomBtn = (label, title, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.style.cssText = 'width:28px;height:28px;padding:0;font-size:15px;line-height:1;border:none;border-radius:6px;'
      + 'background:none;color:var(--eb-text-secondary);cursor:pointer;';
    b.addEventListener('mouseover', () => { b.style.background = 'var(--eb-bg-app)'; b.style.color = 'var(--eb-text-primary)'; });
    b.addEventListener('mouseout',  () => { b.style.background = 'none'; b.style.color = 'var(--eb-text-secondary)'; });
    b.addEventListener('click', fn);
    return b;
  };

  const zoomInput = document.createElement('input');
  zoomInput.type = 'text';
  zoomInput.value = '100%';
  zoomInput.title = 'Zoom level — type a percentage and press Enter';
  zoomInput.setAttribute('aria-label', 'Zoom level');
  zoomInput.style.cssText = 'width:46px;height:28px;padding:0;font-size:11px;text-align:center;border:none;border-radius:6px;'
    + 'background:none;color:var(--eb-text-secondary);outline:none;';
  zoomInput.addEventListener('focus', () => { zoomInput.style.background = 'var(--eb-bg-app)'; zoomInput.select(); });
  zoomInput.addEventListener('blur',  () => { zoomInput.style.background = 'none'; applyZoomInput(); });
  zoomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); zoomInput.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); zoomInput.value = Math.round(state.zoom * 100) + '%'; zoomInput.blur(); }
  });
  function applyZoomInput() {
    const pct = parseFloat(zoomInput.value.replace(/[%\s]/g, '').replace(',', '.'));
    if (Number.isFinite(pct) && pct > 0) setZoom(pct / 100);
    else zoomInput.value = Math.round(state.zoom * 100) + '%';
  }

  // Preset menu — opens above the control, closes on outside click.
  const zoomMenuEl = document.createElement('div');
  zoomMenuEl.style.cssText = 'position:absolute;bottom:calc(100% + 6px);right:0;display:none;flex-direction:column;min-width:110px;'
    + 'background:var(--eb-bg-elevated);backdrop-filter:blur(4px);border:1px solid var(--eb-border-default);border-radius:8px;padding:4px;z-index:30;';
  const mkMenuItem = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:6px 10px;font-size:11px;text-align:left;border:none;border-radius:5px;'
      + 'background:none;color:var(--eb-text-secondary);cursor:pointer;white-space:nowrap;';
    b.addEventListener('mouseover', () => { b.style.background = 'var(--eb-bg-app)'; b.style.color = 'var(--eb-text-primary)'; });
    b.addEventListener('mouseout',  () => { b.style.background = 'none'; b.style.color = 'var(--eb-text-secondary)'; });
    b.addEventListener('click', () => { closeZoomMenu(); fn(); });
    return b;
  };
  zoomMenuEl.appendChild(mkMenuItem('Fit to view', () => { state.userTransform = false; fitToView(); }));
  for (const z of ZOOM_PRESETS) zoomMenuEl.appendChild(mkMenuItem(Math.round(z * 100) + '%', () => setZoom(z)));
  zoomCtrlEl.appendChild(zoomMenuEl);

  function closeZoomMenu() { zoomMenuEl.style.display = 'none'; }
  function onDocClickCloseZoomMenu(e) { if (!zoomCtrlEl.contains(e.target)) closeZoomMenu(); }
  document.addEventListener('click', onDocClickCloseZoomMenu);

  zoomCtrlEl.appendChild(mkZoomBtn('−', 'Zoom out', () => setZoom(state.zoom / ZOOM_STEP)));
  zoomCtrlEl.appendChild(zoomInput);
  const zoomCaretBtn = mkZoomBtn('▾', 'Zoom presets', () => {
    zoomMenuEl.style.display = zoomMenuEl.style.display === 'flex' ? 'none' : 'flex';
  });
  zoomCaretBtn.style.width = '20px';
  zoomCaretBtn.style.fontSize = '10px';
  zoomCtrlEl.appendChild(zoomCaretBtn);
  zoomCtrlEl.appendChild(mkZoomBtn('+', 'Zoom in', () => setZoom(state.zoom * ZOOM_STEP)));
  viewport.appendChild(zoomCtrlEl);

  // Toolbar (buttons wired after functions are defined below)
  const toolbarEl = document.createElement('div');
  toolbarEl.style.cssText = 'position:absolute;top:12px;left:12px;z-index:20;display:flex;gap:6px;align-items:center;';
  viewport.appendChild(toolbarEl);

  // Status legend. The edge key is derived from EDGE_STYLES so it can never
  // drift from the drawn colours; the "Sources" section (#410) doubles as a
  // per-actor filter — clicking 👤/🐙/⚡/⏰ toggles that actor's edges.
  const legendEl = document.createElement('div');
  legendEl.style.cssText = 'position:absolute;bottom:16px;left:50%;transform:translateX(-50%);background:var(--eb-bg-elevated);backdrop-filter:blur(4px);border:1px solid var(--eb-border-default);border-radius:8px;padding:6px 14px;display:flex;gap:10px;align-items:center;z-index:20;font-size:11px;white-space:nowrap;';
  const _mkSwatch = ({ color, label, dashed }) =>
    `<span style="display:flex;align-items:center;gap:4px">` +
    `<span style="width:14px;height:0;display:inline-block;border-top:2px ${dashed ? 'dashed' : 'solid'} ${color};"></span>` +
    `<span style="color:var(--eb-text-secondary)">${label}</span></span>`;
  function renderLegend() {
    const keys = ['label', 'issue', 'pr', 'review', 'gate', 'event', 'webhook', 'artifact', 'dependency', 'hierarchy'];
    const actorToggles = ['github', 'external'].map(kind => {
      const off = state.hiddenActorKinds.has(kind);
      return `<button data-actor-toggle="${kind}" title="Show/hide edges from this source" style="`
        + 'background:none;border:1px solid var(--eb-border-default);border-radius:10px;padding:0 6px;'
        + `cursor:pointer;font-size:11px;line-height:16px;opacity:${off ? 0.35 : 1};`
        + `color:var(--eb-text-secondary);">${ACTOR_ICON[kind]}</button>`;
    }).join('');
    legendEl.innerHTML =
      `<span style="color:var(--eb-text-muted);font-size:10px;margin-right:2px">Edges:</span>` +
      keys.map(k => _mkSwatch(EDGE_STYLES[k])).join('') +
      `<span style="color:var(--eb-text-muted);font-size:10px;margin:0 2px 0 6px">Sources:</span>` +
      actorToggles;
  }
  legendEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-actor-toggle]');
    if (!btn) return;
    const kind = btn.dataset.actorToggle;
    if (state.hiddenActorKinds.has(kind)) state.hiddenActorKinds.delete(kind);
    else state.hiddenActorKinds.add(kind);
    localStorage.setItem('flow-graph-hidden-actor-kinds', JSON.stringify([...state.hiddenActorKinds]));
    renderLegend();
    render();
  });
  viewport.appendChild(legendEl);

  // ─── State ──────────────────────────────────────────────────────────
  const state = {
    briefings:          [],
    byId:               {},
    roots:              [],
    contentVisible:     new Set(),
    childrenVisible:    new Set(),
    userCollapsed:      new Set(), // parents the user explicitly collapsed (with expandChildrenByDefault)
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
    actors:             [],     // actor pseudo-nodes (#410): @github/@external
    actorsById:         {},
    actorPositions:     {},
    hiddenActorKinds:   new Set(JSON.parse(localStorage.getItem('flow-graph-hidden-actor-kinds') || '[]')),
    // Per-trigger edge visibility (👁 toggle on the card's trigger rows) —
    // keys are `${nodeId}|${triggerId}`, persisted across sessions.
    hiddenTriggerEdges: new Set(JSON.parse(localStorage.getItem('flow-graph-hidden-trigger-edges') || '[]')),
    nodeTriggerEdges:   new Map(), // nodeId → external trigger edges shown in the card
    showStages:         localStorage.getItem('flow-graph-show-stages') === 'true', // #362 E stage bands
    stageOrder:         [],     // ordered stage names — drives layered layout order
    layeredInfo:        null,   // { vertical, colOf } while the layered layout is active
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
    const allNodes = Array.isArray(g.nodes) ? g.nodes : [];
    // Actor pseudo-nodes (#410) live in their own "outside world" column —
    // they never join the tree/layered layout of the agent cards. @timer and
    // legacy @human actors are dropped here: schedules render inside the card,
    // human label events come from @github.
    state.actors = allNodes.filter(n => n && n.kind === 'actor'
      && n.actor !== 'timer' && n.actor !== 'human');
    state.actorsById = {};
    state.actors.forEach(a => { state.actorsById[a.id] = a; });
    const nodes = allNodes.filter(n => !n || n.kind !== 'actor');
    // An artifact is keyed by its logical name when it has one, else its path
    // (#382) — matching the backend. The physical path becomes a display `hint`.
    const mkArt = (a, direction) => {
      if (typeof a === 'string') return { path: a, direction };
      const key = a.name || a.path;
      return {
        ...a,
        path: key,
        ...(a.name ? { hint: a.hint || a.path || '' } : {}),
        direction,
      };
    };
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
      // GitHub artifact ports (#380): produce flags → badge + output ports.
      github: (n.github && (n.github.producesPr || n.github.producesIssue)) ? n.github : null,
      channels: Array.isArray(n.channels) ? n.channels : [],
      _role: n.role,
      _isParent: n.isParent === true,
    }));
    state.byId = {};
    state.briefings.forEach(bp => { state.byId[bp.id] = bp; });

    // event/webhook edges (#410) run from an actor node; label edges may too
    // (human-set labels come from @github). Timer edges are NOT drawn as lines
    // any more — schedules render inside the agent card. True orphans
    // (from: null) are still dropped here.
    const EXTRA = new Set(['label', 'review', 'manual', 'github', 'event', 'webhook']);
    state.extraEdges = (Array.isArray(g.edges) ? g.edges : [])
      .filter(e => EXTRA.has(e.on) && e.from && e.to && e.from !== e.to);

    // The trigger rows shown inside each card: schedules (⏰, no line) plus
    // every actor-sourced trigger edge (🐙/🏷/⚡ — each with a 👁 line toggle).
    state.nodeTriggerEdges = new Map();
    (Array.isArray(g.edges) ? g.edges : []).forEach(e => {
      if (!e || !e.to) return;
      const fromActor = typeof e.from === 'string' && e.from.startsWith('@');
      if (e.on === 'timer' || (fromActor && ['event', 'webhook', 'label'].includes(e.on))) {
        if (!state.nodeTriggerEdges.has(e.to)) state.nodeTriggerEdges.set(e.to, []);
        state.nodeTriggerEdges.get(e.to).push(e);
      }
    });

    // Operator-defined stage order (drives the layered layout when set). Accept
    // either bare strings or { name } objects; ignore anything else.
    state.stageOrder = (Array.isArray(g.stages) ? g.stages : [])
      .map(s => (typeof s === 'string' ? s : (s && typeof s.name === 'string' ? s.name : null)))
      .filter(Boolean);

    recomputeRoots();
    // Process views show the whole team by default — a freshly-wired child
    // must not vanish behind its parent. Parents the user collapsed stay
    // collapsed across data refreshes; BP viewers keep collapsed-by-default.
    if (expandChildrenByDefault) {
      state.briefings.forEach(bp => {
        if (bp.children && bp.children.length > 0 && !state.userCollapsed.has(bp.id)) {
          state.childrenVisible.add(bp.id);
        }
      });
    }
    buildArtifactRegistry();
    loadingEl.style.display = 'none';
    layout();
    // Fit after the deferred edge pass so the routed-edge bounds are known.
    state.pendingFit = !state.userTransform;
    render();
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
            hint:         '',
            producers:    [],
            consumers:    [],
            acs:          [],
            descriptions: [],
          };
        }
        // The physical-path hint for a named artifact (its path varies per run).
        if (art.hint && !reg[path].hint) reg[path].hint = art.hint;

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
    if (state.contentVisible.has(id)) h += 300;
    return h;
  }

  function getArtifactNodeHeight(path) {
    const el = canvas.querySelector(`.artifact-node[data-path="${CSS.escape(path)}"]`);
    if (el) return el.offsetHeight;
    return ARTIFACT_H;
  }

  function layout() {
    const visible = getVisibleNodes();
    if (visible.length === 0) return;
    layoutLayered(visible);
    layoutActors();
  }

  // Which actor pseudo-nodes to show (#410): an actor appears when it has at
  // least one edge to a known node and its source kind is not toggled off in
  // the legend. (Editable placeholder actors for empty flows come with #411.)
  function actorHasEdges(a) {
    return (state.extraEdges || []).some(e => e.from === a.id && state.byId[e.to]);
  }
  function actorsAsSources() {
    return !!(actorSources && state.editable && onConnect);
  }
  function visibleActors() {
    // Editable process views offer every actor as a drag source (#411);
    // read-only views show only actors that actually have edges.
    const byId = new Map();
    if (actorsAsSources()) DEFAULT_ACTORS.forEach(a => byId.set(a.id, a));
    (state.actors || []).forEach(a => byId.set(a.id, a));
    return [...byId.values()]
      .filter(a => !state.hiddenActorKinds.has(a.actor))
      .filter(a => actorsAsSources() || actorHasEdges(a));
  }

  // The "outside world" sources (#410): actors sit before the first
  // stage/layer along the flow axis, so every flow gets a visible start. For a
  // left→right flow that is a column on the left; for a top→down flow a row on
  // top — matching the orthogonal router, which treats them as column 0.
  function layoutActors() {
    state.actorPositions = {};
    const shown = visibleActors();
    if (!shown.length) return;
    let minX = Infinity, minY = Infinity;
    Object.values(state.positions).forEach(p => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
    });
    if (minX === Infinity) { minX = 0; minY = 0; }
    if (state.layeredInfo && !state.layeredInfo.vertical) {
      // flow 'down' — a row above the graph
      const y = minY - ACTOR_H - 160;
      let x = minX;
      shown.forEach(a => {
        state.actorPositions[a.id] = { x, y };
        x += ACTOR_W + 28;
      });
    } else {
      // flow 'right' — a column left of the graph
      const x = minX - ACTOR_W - 160;
      let y = minY;
      shown.forEach(a => {
        state.actorPositions[a.id] = { x, y };
        y += ACTOR_H + 28;
      });
    }
  }

  // The one layout for every flow (process, draft, BP pack). Nodes are laid
  // out as an ordered layered DAG (sources → sinks, crossings reduced): the
  // directed structure comes from the hand-off / dependency edges AND the
  // parent-child hierarchy — an expanded child simply lands in a later column
  // than its parent, so hierarchical graphs get the same clean orthogonal
  // routing as flat ones (no separate tree layout any more). Columns follow
  // the flow direction (the stage order overrides them when stages are
  // assigned); within-column order and cross-axis alignment come from the pure
  // flow-layout module. Vertical orientation reads columns left→right;
  // horizontal reads them top→bottom.
  function layoutLayered(visible) {
    const vertical = state.orientation === 'vertical';
    const ids = visible.map(n => n.id);
    const idSet = new Set(ids);

    const edges = [];
    // Siblings (common children of one parent) form a group: they share a
    // column and stay contiguous, so the hierarchy reads as a clearly grouped
    // row/column next to its parent.
    const parentOf = new Map();
    (state.extraEdges || []).forEach(e => {
      if (idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to) edges.push({ from: e.from, to: e.to });
    });
    visible.forEach(n => {
      const bp = state.byId[n.id];
      (bp.depends_on || []).forEach(dep => {
        if (idSet.has(dep) && dep !== n.id) edges.push({ from: dep, to: n.id });
      });
      // Hierarchy participates in the layering: a visible child sits after its
      // parent along the flow axis and near it on the cross axis. Marked so
      // the channel gap sizing can skip it — hierarchy is drawn as a bezier
      // fan, not through the channel lanes.
      if (bp.parent && idSet.has(bp.parent) && bp.parent !== n.id) {
        edges.push({ from: bp.parent, to: n.id, hier: true });
        parentOf.set(n.id, bp.parent);
      }
    });
    const groupOf = parentOf.size > 0 ? (id => parentOf.get(id) ?? null) : null;

    // Stages partition the flow axis (each stage gets an exclusive column
    // block, see flow-layout.js) — applied whenever any visible node carries a
    // stage, with or without an operator-defined order.
    const stageOf = (id) => ((state.byId[id] || {}).stage || null);
    const { colOf, columns } = computeFlowLayout(ids, edges, {
      stageOf: visible.some(n => stageOf(n.id)) ? stageOf : null,
      stageOrder: state.stageOrder || [],
      groupOf,
    });

    const sizeOf = vertical ? (id => getNodeHeight(id)) : (() => NODE_W);
    const crossGap = vertical ? 34 : H_GAP;
    const center = assignCrossCoords(columns, edges, sizeOf, { gap: crossGap });

    // The orthogonal router (drawEdges) lays the cross runs of the edges into
    // the channel between two columns, one lane per overlapping run. Reserve
    // enough channel space for those lanes so labels and parallel runs fit.
    // Hierarchy edges don't take lanes (bezier fan) — skip them here.
    const loads = laneLoadByChannel(edges.filter(e => !e.hier), colOf);
    const laneNeed = c => 56 + Math.max(0, (loads.get(c) || 0) - 1) * 18;

    const pos = {};
    const colMain = [];
    if (vertical) {
      // Widen a column boundary when a hand-off/channel chip drawn across it is
      // wider than the default gap, so a long label (e.g. "Issue 👤✓ ready") never
      // overlaps the neighbouring cards. Only edges spanning exactly one column
      // sit in that gap; wider spans keep the default.
      const boundaryNeed = new Array(Math.max(0, columns.length - 1)).fill(0);
      (state.extraEdges || []).forEach(e => {
        if (!colOf.has(e.from) || !colOf.has(e.to)) return;
        const a = colOf.get(e.from), b = colOf.get(e.to);
        if (Math.abs(a - b) !== 1) return;
        const lo = Math.min(a, b);
        const text = e.on === 'github' ? channelChipText(e)
          : (e.on === 'label' ? labelChipText(e) : (e.label || ''));
        if (text) boundaryNeed[lo] = Math.max(boundaryNeed[lo], estChipWidth(text));
      });
      let x = 0;
      for (let c = 0; c < columns.length; c++) {
        colMain[c] = x;
        // gap = space between this card's right edge and the next card's left edge.
        const gap = Math.max(H_GAP * 2, (boundaryNeed[c] || 0) + 40, laneNeed(c));
        x += NODE_W + gap;
      }
      ids.forEach(id => {
        const c = colOf.get(id) || 0;
        pos[id] = { x: colMain[c], y: (center.get(id) || 0) - getNodeHeight(id) / 2 };
      });
    } else {
      let y = 0;
      for (let c = 0; c < columns.length; c++) {
        const maxH = Math.max(90, ...columns[c].map(getNodeHeight));
        colMain[c] = y; y += maxH + Math.max(V_GAP, laneNeed(c));
      }
      ids.forEach(id => {
        const c = colOf.get(id) || 0;
        pos[id] = { x: (center.get(id) || 0) - NODE_W / 2, y: colMain[c] };
      });
    }

    state.positions = pos;
    // Tell drawEdges to use the orthogonal channel router for this layout.
    state.layeredInfo = { vertical, colOf };
    layoutArtifacts(visible);
  }

  // Artifacts (inputs/outputs) live in a dedicated lane, oriented perpendicular
  // to the flow so producer→artifact→consumer reads as a short "triangle":
  //  - horizontal flow (state.orientation === 'vertical', columns left→right):
  //    a horizontal lane BELOW the graph; artifacts placed at the mean x of
  //    their producer(s)+consumer(s); edges route down into / up out of it.
  //  - vertical flow (state.orientation === 'horizontal', columns top→bottom):
  //    a vertical lane as a new column on the RIGHT; artifacts stacked top→
  //    bottom at the mean y of their producer(s)+consumer(s); edges route right
  //    into / left out of it.
  // Either way the pooling pass spreads overlapping artifacts apart while
  // keeping them close to that ideal position. drawArtifactEdges mirrors the
  // orientation split for the edge routing.
  function layoutArtifacts(visibleBpNodes) {
    if (state.orientation === 'vertical') {
      layoutArtifactLane(visibleBpNodes);
    } else {
      layoutArtifactColumn(visibleBpNodes);
    }
  }

  function layoutArtifactLane(visibleBpNodes) {
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

  // Right-side artifact column, used for vertical flow (columns top→bottom).
  // Mirror of layoutArtifactLane along the other axis: the column sits to the
  // right of every node column and artifacts are stacked top→bottom at the mean
  // y of their producer(s)+consumer(s), with the same pooling pass.
  function layoutArtifactColumn(visibleBpNodes) {
    const visiblePaths = getVisibleArtifactPaths();
    if (visiblePaths.size === 0) { state.artifactPositions = {}; return; }

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

    canvas.querySelectorAll('.bp-node, .artifact-node, .actor-node-src').forEach(el => el.remove());

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
      `;
      node.appendChild(header);

      // Badges
      const badgeParts = [];
      if (bp.rigor)    badgeParts.push(`<span class="bp-badge bp-badge-rigor-${esc(bp.rigor)}">${esc(bp.rigor)}</span>`);
      if (bp.revision && parseInt(bp.revision) > 1)
        badgeParts.push(`<span class="bp-badge bp-badge-revision" title="Revised">Rev ${esc(String(bp.revision))}</span>`);
      // GitHub produce badges (#380) — visible before any wiring.
      if (bp.github && bp.github.producesPr)
        badgeParts.push(`<span class="bp-badge bp-badge-gh-pr" title="Opens pull requests">⇅ PR</span>`);
      if (bp.github && bp.github.producesIssue)
        badgeParts.push(`<span class="bp-badge bp-badge-gh-issue" title="Opens issues">◉ Issue</span>`);
      if (badgeParts.length > 0) {
        const badges = document.createElement('div');
        badges.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;';
        badges.innerHTML = badgeParts.join('');
        node.appendChild(badges);
      }

      // External triggers inside the card: schedules (⏰ — they have no line on
      // the canvas any more) and actor-sourced wakes (🐙 events / 🏷 labels /
      // ⚡ webhooks). Clicking a row opens the trigger's edit dialog; the 👁
      // button shows/hides the trigger's line so dense graphs stay readable.
      const trigEdges = state.nodeTriggerEdges.get(n.id) || [];
      if (trigEdges.length > 0) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin:2px 0 4px;';
        trigEdges.forEach(e => {
          const meta = triggerRowMeta(e);
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:10px;min-width:0;';
          const lbl = document.createElement('span');
          lbl.style.cssText = `display:inline-flex;align-items:center;gap:4px;min-width:0;flex:1;color:${meta.color};`
            + (onSelectEdge ? 'cursor:pointer;' : '');
          lbl.title = onSelectEdge ? `${meta.title} — click to edit` : meta.title;
          lbl.innerHTML = `<span style="flex-shrink:0">${meta.icon}</span>`
            + `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600">${esc(meta.text)}</span>`;
          if (onSelectEdge) {
            lbl.addEventListener('click', (ev) => {
              ev.stopPropagation();
              onSelectEdge({
                from: e.from, to: e.to, on: e.on, kind: e.on, label: e.label,
                triggerId: e.triggerId, gate: e.gate,
                ...(e.events ? { events: e.events } : {}),
                ...(e.schedule ? { schedule: e.schedule } : {}),
              });
            });
          }
          row.appendChild(lbl);
          if (e.on !== 'timer' && e.triggerId) {
            const hidden = state.hiddenTriggerEdges.has(`${n.id}|${e.triggerId}`);
            const eye = document.createElement('button');
            eye.textContent = '👁';
            eye.title = hidden ? 'Show this trigger’s line' : 'Hide this trigger’s line';
            eye.style.cssText = 'background:none;border:none;padding:0 2px;cursor:pointer;'
              + `font-size:11px;line-height:1;flex-shrink:0;opacity:${hidden ? 0.3 : 0.85};`
              + (hidden ? 'filter:grayscale(1);' : '');
            eye.addEventListener('click', (ev) => {
              ev.stopPropagation();
              toggleTriggerEdgeHidden(n.id, e.triggerId);
            });
            row.appendChild(eye);
          }
          wrap.appendChild(row);
        });
        node.appendChild(wrap);
      }

      // Action buttons
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;';

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

      // Only append the actions row when it carries something (children /
      // artifact toggles). The Agent Prompt is a separate disclosure below.
      if (actions.childElementCount > 0) node.appendChild(actions);

      // Agent Prompt — a collapsible disclosure (not a named button). Expanding
      // reveals the read-only prompt/content; editing happens in the inspector.
      if (bp.body) {
        const promptToggle = makeDisclosure('Agent Prompt', state.contentVisible.has(n.id));
        promptToggle.addEventListener('click', () => toggleContent(n.id));
        node.appendChild(promptToggle);
      }

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

      // NOTE (#411): the separate PR/Issue drag pills are gone — the header
      // badges above keep the "opens PRs/issues" information visible, and the
      // single ● port creates every connection type (the create dialog ranks
      // the PR/Issue channel first for producers).

      // Agent Prompt panel — the node's prompt/content, read-only markdown.
      // Editing (prompt, stage, links) is in the right-side inspector.
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

    // Actor pseudo-nodes (#410)
    renderActorNodes();

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
      canvas.querySelectorAll('.actor-node-src').forEach(el => {
        const pos = state.actorPositions[el.dataset.actorId];
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
      drawArtifactLane();
      if (state.pendingFit) {
        state.pendingFit = false;
        if (!state.userTransform) fitToView();
      }
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

  // Artifact lane band: a single faint, labelled rectangle behind the artifacts
  // so the generated files read as a dedicated lane. It hugs the artifact
  // bounding box and is extended along the flow axis to span the node columns:
  // a horizontal band below the graph for horizontal flow, a vertical band to
  // the right for vertical flow (matches drawArtifactEdges).
  function drawArtifactLane() {
    laneLayer.innerHTML = '';
    const paths = Object.keys(state.artifactPositions);
    if (paths.length === 0) return;
    const vertical = state.orientation === 'vertical';

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    paths.forEach(path => {
      const pos = state.artifactPositions[path];
      if (!pos) return;
      const el = canvas.querySelector(`.artifact-node[data-path="${CSS.escape(path)}"]`);
      const h  = el ? el.offsetHeight : ARTIFACT_H;
      minX = Math.min(minX, pos.x);
      maxX = Math.max(maxX, pos.x + ARTIFACT_W);
      minY = Math.min(minY, pos.y);
      maxY = Math.max(maxY, pos.y + h);
    });
    if (minX === Infinity) return;

    // Extend the band along the flow axis so it spans the node arrangement: the
    // width (x) for a below-lane, the height (y) for a right-column.
    getVisibleNodes().forEach(n => {
      const pos = state.positions[n.id];
      if (!pos) return;
      if (vertical) {
        minX = Math.min(minX, pos.x);
        maxX = Math.max(maxX, pos.x + NODE_W);
      } else {
        minY = Math.min(minY, pos.y);
        maxY = Math.max(maxY, pos.y + getNodeHeight(n.id));
      }
    });

    const PAD = 20;
    const band = document.createElement('div');
    band.style.cssText = `position:absolute;left:${minX - PAD}px;top:${minY - PAD - 18}px;`
      + `width:${maxX - minX + PAD * 2}px;height:${maxY - minY + PAD * 2 + 18}px;`
      + `background:rgba(148,163,184,0.06);`
      + `border:1px dashed var(--eb-border-default);border-radius:10px;`;
    const label = document.createElement('div');
    label.textContent = 'Artifacts';
    label.style.cssText = `position:absolute;left:8px;top:2px;font-size:10px;font-weight:700;`
      + `letter-spacing:0.04em;text-transform:uppercase;color:var(--eb-text-muted);`;
    band.appendChild(label);
    laneLayer.appendChild(band);
  }

  // The actor cards (#410): rounded, dashed, muted — visually distinct from the
  // agent cards. They are not `.bp-node`, so a connect-drag can't drop on them.
  function renderActorNodes() {
    visibleActors().forEach(a => {
      const pos = state.actorPositions[a.id];
      if (!pos) return;
      const el = document.createElement('div');
      el.className = 'actor-node-src';
      el.dataset.actorId = a.id;
      el.style.cssText = `position:absolute;left:${pos.x}px;top:${pos.y}px;width:${ACTOR_W}px;`
        + `height:${ACTOR_H}px;box-sizing:border-box;`
        + 'background:var(--eb-bg-elevated);border:1px dashed var(--eb-border-hover);border-radius:20px;'
        + 'padding:0 14px;font-size:12px;color:var(--eb-text-secondary);'
        + 'display:flex;align-items:center;gap:8px;';
      el.innerHTML = `<span style="font-size:15px;line-height:1">${ACTOR_ICON[a.actor] || '•'}</span>`
        + `<span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.displayName || a.id)}</span>`;
      el.addEventListener('mousedown', e => e.stopPropagation());
      // The same ● connect handle agents carry (#411): drag onto an agent to
      // create a trigger from this source (schedule, human label, event, hook).
      if (actorsAsSources()) {
        const port = document.createElement('div');
        port.title = 'Drag to an agent: it gets a trigger from this source';
        port.style.cssText = 'position:absolute;right:-7px;top:calc(50% - 7px);width:14px;height:14px;border-radius:50%;background:var(--eb-accent-primary);border:2px solid var(--eb-bg-surface);cursor:crosshair;z-index:3;';
        port.addEventListener('mousedown', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          startConnect(a.id);
        });
        el.appendChild(port);
      }
      canvas.appendChild(el);
    });
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

      // Named artifact: show the physical-path hint (resolved from the manifest
      // at runtime) so the logical name isn't the only locator.
      if (reg.hint) {
        const hintEl = document.createElement('div');
        hintEl.style.cssText = 'font-size:10px;color:var(--eb-text-muted);margin-bottom:4px;word-break:break-all;font-style:italic;';
        hintEl.textContent = `~ ${reg.hint}`;
        node.appendChild(hintEl);
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

  // A collapsible disclosure row (caret + label). Used for the read-only
  // Agent Prompt panel — reads as a dropdown, not a named action button.
  function makeDisclosure(label, active) {
    const btn = document.createElement('button');
    btn.style.cssText = `
      display:flex;align-items:center;gap:6px;width:100%;margin-top:6px;
      padding:2px 0;font-size:11px;font-family:inherit;
      background:transparent;border:none;
      color:${active ? '#3b82f6' : 'var(--eb-text-secondary)'};
      cursor:pointer;text-align:left;
    `;
    const caret = document.createElement('span');
    caret.textContent = active ? '▾' : '▸';
    caret.style.cssText = 'font-size:9px;line-height:1;';
    const text = document.createElement('span');
    text.textContent = label;
    btn.appendChild(caret);
    btn.appendChild(text);
    return btn;
  }

  // ─── Edge Drawing ────────────────────────────────────────────────────

  function drawEdges() {
    svgEdges.innerHTML = '';
    svgLabels.innerHTML = '';
    state.edgeBounds = null;

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
    svgLabels.setAttribute('width',  svgMaxX);
    svgLabels.setAttribute('height', svgMaxY);

    const visible    = getVisibleNodes();
    const visibleIds = new Set(visible.map(n => n.id));
    const vertical   = state.orientation === 'vertical';

    // Edge-label declutter (#401). Chips/labels are drawn at an edge's midpoint,
    // which for a cross-column hand-off often lands on top of a card or another
    // chip. Collect the visible cards as obstacles and nudge each label off them
    // (and off already-placed labels) before drawing, so complex graphs stay
    // readable. Coordinates share the node/edge space, so a plain rect test works.
    const labelObstacles = [];
    visible.forEach(n => {
      const p = state.positions[n.id];
      if (!p) return;
      const el = canvas.querySelector(`.bp-node[data-id="${n.id}"]`);
      labelObstacles.push({ x: p.x, y: p.y, w: NODE_W, h: el ? el.offsetHeight : 90 });
    });
    const placedLabels = [];
    const rectsOverlap = (a, b) =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    // Return a {cx,cy} near (cx,cy) whose w×h box clears cards + prior labels.
    // Searches increasing perpendicular/parallel offsets; falls back to the
    // midpoint if nothing clears (never worse than today).
    function placeClearLabel(cx, cy, w, h) {
      const pad = 2;
      const box = (x, y) => ({ x: x - w / 2 - pad, y: y - h / 2 - pad, w: w + 2 * pad, h: h + 2 * pad });
      const collides = (r) =>
        labelObstacles.some(o => rectsOverlap(r, o)) || placedLabels.some(o => rectsOverlap(r, o));
      if (!collides(box(cx, cy))) { placedLabels.push(box(cx, cy)); return { cx, cy }; }
      // Nudge primarily along the cross axis of the flow (where the gaps are):
      // vertical flow → move horizontally; horizontal flow → move vertically.
      const stepY = h + 5, stepX = w * 0.6 + 8;
      for (let s = 1; s <= 16; s++) {
        const offs = vertical
          ? [[0, -s * stepY], [0, s * stepY], [-s * stepX, 0], [s * stepX, 0]]
          : [[-s * stepX, 0], [s * stepX, 0], [0, -s * stepY], [0, s * stepY]];
        for (const [dx, dy] of offs) {
          if (!collides(box(cx + dx, cy + dy))) {
            placedLabels.push(box(cx + dx, cy + dy));
            return { cx: cx + dx, cy: cy + dy };
          }
        }
      }
      placedLabels.push(box(cx, cy));
      return { cx, cy };
    }

    // The inter-node wiring (hierarchy + dependencies + label/review/github
    // edges + actor-sourced triggers) all goes through the orthogonal channel
    // router (drawRoutedProcessEdges): distributed ports, node-free channel
    // lanes, side gutters for long/backward edges, labels on the edge.
    const EXTRA_COLOR = { label: EDGE_STYLES.label.color, review: EDGE_STYLES.review.color, manual: EDGE_STYLES.label.color };
    const GH_COLOR = { pr: EDGE_STYLES.pr.color, issue: EDGE_STYLES.issue.color };

    function drawRoutedProcessEdges() {
      const nodes = [];
      visible.forEach(n => {
        const p = state.positions[n.id];
        if (!p) return;
        const el = canvas.querySelector(`.bp-node[data-id="${n.id}"]`);
        nodes.push({ id: n.id, x: p.x, y: p.y, w: NODE_W, h: el ? el.offsetHeight : getNodeHeight(n.id) });
      });

      // Actor pseudo-nodes join the routed graph as column 0 (their placement
      // matches: a column left of / a row above the first layer), so their
      // edges run through the same orthogonal channels as the agent wiring —
      // no more bezier curves cutting across the cards. Agent columns shift +1.
      const actorIds = [];
      Object.entries(state.actorPositions).forEach(([id, p]) => {
        nodes.push({ id, x: p.x, y: p.y, w: ACTOR_W, h: ACTOR_H });
        actorIds.push(id);
      });
      const colOf = new Map();
      const shift = actorIds.length ? 1 : 0;
      state.layeredInfo.colOf.forEach((c, id) => colOf.set(id, c + shift));
      actorIds.forEach(id => colOf.set(id, 0));

      const list = [];
      (state.extraEdges || []).forEach(e => {
        // Actor-sourced trigger edges (events, webhooks, human-set labels).
        const actor = state.actorsById[e.from];
        if (actor) {
          if (state.hiddenActorKinds.has(actor.actor)) return;
          if (isTriggerEdgeHidden(e)) return;
          if (!visibleIds.has(e.to) || !state.actorPositions[e.from]) return;
          const style = EDGE_STYLES[e.on] || {};
          const gate = e.gate === 'human';
          list.push({
            from: e.from, to: e.to,
            color: actorEdgeColor(e), width: 1.5,
            dash: style.dashed ? '6 4' : '', opacity: 1,
            labelText: gate ? `👤✓ ${labelChipText(e)}` : actorEdgeText(e),
            chip: gate, gate,
            hit: { from: e.from, to: e.to, on: e.on, kind: e.on, label: e.label,
              triggerId: e.triggerId, gate: e.gate,
              ...(e.events ? { events: e.events } : {}),
              ...(e.schedule ? { schedule: e.schedule } : {}) },
          });
          return;
        }
        if (!visibleIds.has(e.from) || !visibleIds.has(e.to)) return;
        const isGithub = e.on === 'github';
        const artifact = e.artifact === 'issue' ? 'issue' : 'pr';
        list.push({
          from: e.from, to: e.to,
          color: isGithub ? GH_COLOR[artifact] : (EXTRA_COLOR[e.on] || EDGE_STYLES.label.color),
          width: isGithub ? 2 : 1.5,
          dash: '',
          opacity: 1,
          labelText: isGithub ? channelChipText(e)
            : (e.on === 'label' ? labelChipText(e) : (e.label || '')),
          chip: isGithub,
          gate: e.gate === 'human',
          hit: { from: e.from, to: e.to, label: e.label, on: e.on, kind: e.on,
            artifact: isGithub ? artifact : undefined, gate: e.gate, triggerId: e.triggerId },
        });
      });
      visible.forEach(n => {
        const bp = state.byId[n.id];
        if (!bp || !bp.depends_on) return;
        bp.depends_on.forEach(depId => {
          if (!visibleIds.has(depId)) return;
          list.push({
            from: depId, to: n.id,
            color: EDGE_STYLES.dependency.color, width: 1.5, dash: '6 4', opacity: 0.7,
            labelText: '', chip: false, gate: false,
            hit: { from: depId, to: n.id, on: 'dependency' },
          });
        });
      });
      if (list.length === 0) return;

      const routed = routeOrthogonalEdges({
        nodes,
        edges: list,
        colOf,
        flow: state.layeredInfo.vertical ? 'right' : 'down',
        labelWidths: list.map(e => e.labelText ? estChipWidth(e.labelText) : 0),
      });

      // Gutter runs live outside the node bounding box — record their extent so
      // fitToView keeps them (and their labels) inside the frame.
      const eb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      routed.forEach(r => {
        if (!r) return;
        r.points.forEach(p => {
          eb.minX = Math.min(eb.minX, p.x); eb.maxX = Math.max(eb.maxX, p.x);
          eb.minY = Math.min(eb.minY, p.y); eb.maxY = Math.max(eb.maxY, p.y);
        });
      });
      state.edgeBounds = eb.minX === Infinity ? null : eb;

      routed.forEach((r, i) => {
        if (!r) return;
        const e = list[i];
        const d = roundedPathD(r.points);
        if (!d) return;
        const path = makeSvgPath(d);
        path.setAttribute('stroke', e.color);
        path.setAttribute('stroke-width', String(e.width));
        if (e.dash) path.setAttribute('stroke-dasharray', e.dash);
        if (e.opacity !== 1) path.setAttribute('opacity', String(e.opacity));
        path.setAttribute('fill', 'none');
        drawArrowHead(r.arrow.x, r.arrow.y, r.arrow.angle, e.color);
        addEdgeHit(d, e.hit);
        if (!e.labelText) return;
        const p = placeClearLabel(r.label.x, r.label.y, estChipWidth(e.labelText), e.chip ? 17 : 15);
        if (e.chip) drawEdgeChip(p.cx, p.cy, e.labelText, e.color, e.gate);
        else drawEdgeLabelText(p.cx, p.cy, e.labelText, e.color);
      });
    }

    // Hierarchy edges — a quiet bezier fan from the parent to its children.
    // Deliberately NOT routed through the orthogonal channels: they carry no
    // label, the sibling group sits in the column right next to its parent
    // (so the curves cross nothing), and the soft, arrowless curve visually
    // separates structure (containment) from work hand-offs. Drawn before the
    // routed edges so they sit beneath the process wiring.
    visible.forEach(n => {
      const bp = state.byId[n.id];
      if (!bp || !bp.parent || !visibleIds.has(bp.parent) || bp.parent === n.id) return;
      const pPos = state.positions[bp.parent];
      const cPos = state.positions[n.id];
      if (!pPos || !cPos) return;
      const pEl = canvas.querySelector(`.bp-node[data-id="${bp.parent}"]`);
      const cEl = canvas.querySelector(`.bp-node[data-id="${n.id}"]`);
      const pH = pEl ? pEl.offsetHeight : getNodeHeight(bp.parent);
      const cH = cEl ? cEl.offsetHeight : getNodeHeight(n.id);
      const d = vertical
        // flow left→right: parent's right face → child's left face
        ? drawBezierEdge(pPos.x + NODE_W, pPos.y + pH / 2, cPos.x, cPos.y + cH / 2,
            EDGE_STYLES.hierarchy.color, 2, '', false, 'horizontal')
        // flow top→down: parent's bottom face → child's top face
        : drawBezierEdge(pPos.x + NODE_W / 2, pPos.y + pH, cPos.x + NODE_W / 2, cPos.y,
            EDGE_STYLES.hierarchy.color, 2, '', false, 'vertical');
      addEdgeHit(d, { from: bp.parent, to: n.id, on: 'parent' });
    });

    drawRoutedProcessEdges();
    drawArtifactEdges(visibleIds);
  }

  // A text edge-label with a canvas-coloured halo so it reads over crossing
  // lines. Drawn on the overlay layer (above the cards), centred at (cx,cy).
  function drawEdgeLabelText(cx, cy, text, color) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.textContent = text;
    t.setAttribute('x', cx);
    t.setAttribute('y', cy + 3);
    t.setAttribute('fill', color);
    t.setAttribute('font-size', '10');
    t.setAttribute('font-weight', '600');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('paint-order', 'stroke');
    t.style.stroke = 'var(--eb-bg-app)';        // halo so text reads over lines
    t.setAttribute('stroke-width', '3');
    svgLabels.appendChild(t);
  }

  // Solid arrowhead at (x,y) pointing along `angle` (radians). Same geometry
  // as the bezier drawer's head so both edge styles read identically.
  function drawArrowHead(x, y, angle, color) {
    const size = ARROW_SIZE;
    const ax1 = x - size * Math.cos(angle - 0.5);
    const ay1 = y - size * Math.sin(angle - 0.5);
    const ax2 = x - size * Math.cos(angle + 0.5);
    const ay2 = y - size * Math.sin(angle + 0.5);
    const tri = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    tri.setAttribute('points', `${x},${y} ${ax1},${ay1} ${ax2},${ay2}`);
    tri.setAttribute('fill', color);
    svgEdges.appendChild(tri);
  }

  // Colour + label for an actor-sourced edge (#410).
  function actorEdgeColor(e) {
    if (e.gate === 'human') return EDGE_STYLES.gate.color;
    if (EDGE_STYLES[e.on]) return EDGE_STYLES[e.on].color;
    return EDGE_STYLES.label.color;
  }
  function actorEdgeText(e) {
    if (e.on === 'event') return (e.events || []).join(', ');
    if (e.on === 'timer') return e.schedule && e.schedule.cron ? `⏱ ${e.schedule.cron}` : `once ${e.label || ''}`.trim();
    if (e.on === 'webhook') return e.label || 'webhook';
    if (e.on === 'label') return labelChipText(e);
    return e.label || '';
  }

  // Human-readable cron description for the in-card schedule rows.
  function cronText(expr) {
    const p = String(expr || '').trim().split(/\s+/);
    if (p.length !== 5) return expr || 'cron';
    const [min, hr, dom, mon, dow] = p;
    const DAYS = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };
    const two = (s) => String(s).padStart(2, '0');
    if (/^\d+$/.test(min) && /^\d+$/.test(hr)) {
      const time = `${two(hr)}:${two(min)}`;
      if (dom === '*' && mon === '*' && dow === '*') return `daily ${time}`;
      if (dom === '*' && mon === '*' && DAYS[dow]) return `${DAYS[dow]} ${time}`;
      if (/^\d+$/.test(dom) && mon === '*' && dow === '*') return `day ${dom}, ${time}`;
    }
    if (/^\*\/\d+$/.test(min) && hr === '*') return `every ${min.slice(2)} min`;
    if (min === '0' && /^\*\/\d+$/.test(hr)) return `every ${hr.slice(2)} h`;
    return expr;
  }

  // Icon / text / colour of a card trigger row (schedules + actor wakes).
  function triggerRowMeta(e) {
    if (e.on === 'timer') {
      const text = e.schedule && e.schedule.cron ? cronText(e.schedule.cron)
        : (e.schedule && e.schedule.at ? `once ${e.schedule.at}` : (e.label || 'schedule'));
      return { icon: '⏰', text, color: EDGE_STYLES.timer.color, title: 'Schedule' };
    }
    if (e.on === 'event') {
      return { icon: '🐙', text: (e.events || []).join(', '), color: EDGE_STYLES.event.color, title: 'GitHub trigger' };
    }
    if (e.on === 'webhook') {
      return { icon: '⚡', text: e.label || 'webhook', color: EDGE_STYLES.webhook.color, title: 'Webhook' };
    }
    // Label listener sourced from GitHub (incl. human-set labels and gates).
    const gate = e.gate === 'human';
    const evs = Array.isArray(e.events) && e.events.length ? ` (${e.events.join(', ')})` : '';
    return {
      icon: gate ? '👤✓' : '🏷',
      text: labelChipText(e),
      color: gate ? EDGE_STYLES.gate.color : EDGE_STYLES.label.color,
      title: (gate ? 'Human approval gate (GitHub label)' : 'GitHub label trigger') + evs,
    };
  }

  function isTriggerEdgeHidden(e) {
    return !!(e.triggerId && state.hiddenTriggerEdges.has(`${e.to}|${e.triggerId}`));
  }
  function toggleTriggerEdgeHidden(nodeId, triggerId) {
    const key = `${nodeId}|${triggerId}`;
    if (state.hiddenTriggerEdges.has(key)) state.hiddenTriggerEdges.delete(key);
    else state.hiddenTriggerEdges.add(key);
    localStorage.setItem('flow-graph-hidden-trigger-edges', JSON.stringify([...state.hiddenTriggerEdges]));
    render();
  }

  // Compact tag for the label events a listener trigger carries: which artifact
  // (Issue/PR) and direction (+ added / − removed) wakes it. One trigger now
  // carries exactly one event; legacy multi-event triggers join their tags.
  const LABEL_EVENT_TAGS = {
    'issues.labeled': 'Issue+',
    'issues.unlabeled': 'Issue−',
    'pull_request.labeled': 'PR+',
    'pull_request.unlabeled': 'PR−',
  };
  function labelEventTag(events) {
    const tags = [...new Set((Array.isArray(events) ? events : [])
      .map(ev => LABEL_EVENT_TAGS[ev]).filter(Boolean))];
    return tags.join('/');
  }
  // The text for a label hand-off edge: the label plus the Issue/PR ± tag, so
  // the canvas shows WHICH label change (issue vs PR, added vs removed) fires.
  function labelChipText(e) {
    const tag = labelEventTag(e.events);
    return tag ? `${e.label || ''} · ${tag}` : (e.label || '');
  }

  // The chip text for a GitHub-channel edge (#380): artifact + optional human-gate
  // glyph + optional routing label. Shared with the layout so widths line up.
  function channelChipText(e) {
    const parts = [e.artifact === 'issue' ? 'Issue' : 'PR'];
    if (e.gate === 'human') parts.push('👤✓');
    if (e.label) parts.push(e.label);
    return parts.join(' ');
  }
  // Rough rendered-width estimate matching drawEdgeChip. Emoji/wide glyphs count
  // ~1.7×. Used both to size the chip and to widen the column gap so it fits.
  function estChipWidth(text) {
    let n = 0;
    for (const ch of String(text || '')) n += /[ -ÿ]/.test(ch) ? 1 : 1.7;
    return Math.max(24, n * 6.4 + 16);
  }

  // A filled rounded-rect chip centred at (cx,cy) — used for GitHub-channel edges
  // (#380). Drawn on the overlay layer (svgLabels) so it floats above the cards; a
  // human-approval gate gets a red fill + white outline so it reads as a gate.
  function drawEdgeChip(cx, cy, text, color, human) {
    const w = estChipWidth(text);
    const h = 17;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', cx - w / 2); rect.setAttribute('y', cy - h / 2);
    rect.setAttribute('width', w); rect.setAttribute('height', h);
    rect.setAttribute('rx', '8');
    rect.setAttribute('fill', human ? EDGE_STYLES.gate.color : color);
    if (human) rect.setAttribute('stroke', '#fff');
    else rect.style.stroke = 'var(--eb-bg-app)';  // blends the pill into the canvas
    rect.setAttribute('stroke-width', human ? '1.5' : '2');
    svgLabels.appendChild(rect);
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.textContent = text;
    t.setAttribute('x', cx); t.setAttribute('y', cy + 3.5);
    t.setAttribute('fill', '#fff');
    t.setAttribute('font-size', '10');
    t.setAttribute('font-weight', '600');
    t.setAttribute('text-anchor', 'middle');
    t.style.pointerEvents = 'none';
    svgLabels.appendChild(t);
  }

  function drawArtifactEdges(visibleBpIds) {
    const visiblePaths = getVisibleArtifactPaths();
    const vertical     = state.orientation === 'vertical';

    // The lane is perpendicular to the flow, so producer→artifact→consumer
    // reads as a triangle. Both arms attach to the artifact edge facing the
    // graph — its TOP for the below-lane (horizontal flow), its LEFT for the
    // right-column (vertical flow) — fanned toward each node so the two arms
    // stay distinct.
    const ANCHOR_MARGIN = 16;
    const artEl = path => canvas.querySelector(`.artifact-node[data-path="${CSS.escape(path)}"]`);
    const topAnchorX = (artPos, nodeCx) =>
      Math.max(artPos.x + ANCHOR_MARGIN,
        Math.min(artPos.x + ARTIFACT_W - ANCHOR_MARGIN, nodeCx));
    const leftAnchorY = (artPos, artH, nodeCy) =>
      Math.max(artPos.y + ANCHOR_MARGIN,
        Math.min(artPos.y + artH - ANCHOR_MARGIN, nodeCy));

    visiblePaths.forEach(path => {
      const reg    = state.artifactRegistry[path];
      const artPos = state.artifactPositions[path];
      if (!reg || !artPos) return;
      const el   = artEl(path);
      const artH = el ? el.offsetHeight : ARTIFACT_H;

      // Output edges: BP → artifact (green), into the lane.
      reg.producers.forEach(bpId => {
        if (!visibleBpIds.has(bpId)) return;
        const bpPos = state.positions[bpId];
        const bpEl  = canvas.querySelector(`.bp-node[data-id="${bpId}"]`);
        if (!bpPos || !bpEl) return;

        const bpH  = bpEl.offsetHeight;
        const bpCx = bpPos.x + NODE_W / 2;
        const bpCy = bpPos.y + bpH / 2;
        const d = vertical
          // below-lane: producer bottom → artifact top (down)
          ? drawBezierEdge(
              bpCx, bpPos.y + bpH,
              topAnchorX(artPos, bpCx), artPos.y,
              EDGE_STYLES.artifact.color, 1.5, '', true, 'vertical')
          // right-column: producer right → artifact left (rightward)
          : drawBezierEdge(
              bpPos.x + NODE_W, bpCy,
              artPos.x, leftAnchorY(artPos, artH, bpCy),
              EDGE_STYLES.artifact.color, 1.5, '', true, 'horizontal');
        addEdgeHit(d, { on: 'artifact', from: bpId, direction: 'output', path });
      });

      // Input edges: artifact → BP (data-flow green, dashed to read as the
      // consumer arm), back out of the lane.
      reg.consumers.forEach(bpId => {
        if (!visibleBpIds.has(bpId)) return;
        const bpPos = state.positions[bpId];
        const bpEl  = canvas.querySelector(`.bp-node[data-id="${bpId}"]`);
        if (!bpPos || !bpEl) return;

        const bpH  = bpEl.offsetHeight;
        const bpCx = bpPos.x + NODE_W / 2;
        const bpCy = bpPos.y + bpH / 2;
        const d = vertical
          // below-lane: artifact top → consumer bottom (up)
          ? drawBezierEdge(
              topAnchorX(artPos, bpCx), artPos.y,
              bpCx, bpPos.y + bpH,
              EDGE_STYLES.artifact.color, 1.5, '4 3', true, 'vertical')
          // right-column: artifact left → consumer right (leftward)
          : drawBezierEdge(
              artPos.x, leftAnchorY(artPos, artH, bpCy),
              bpPos.x + NODE_W, bpCy,
              EDGE_STYLES.artifact.color, 1.5, '4 3', true, 'horizontal');
        addEdgeHit(d, { on: 'artifact', from: bpId, direction: 'input', path });
      });
    });
  }

  function drawBezierEdge(x1, y1, x2, y2, stroke, width, dash, arrow, flow = 'vertical') {
    let d, dx, dy;
    if (flow === 'loop-right') {
      // Same-column feedback loop: both anchors on the right, bulge out rightward
      // so the edge never crosses the stacked cards. Arrow enters the right side.
      const cx = Math.max(x1, x2) + 46 + Math.abs(y2 - y1) * 0.12;
      d  = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
      dx = x2 - cx;
      dy = 0;
    } else if (flow === 'loop-down') {
      // Same-row feedback loop: both anchors on the bottom, bulge downward.
      const cy = Math.max(y1, y2) + 46 + Math.abs(x2 - x1) * 0.12;
      d  = `M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`;
      dx = 0;
      dy = y2 - cy;
    } else if (flow === 'horizontal') {
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
      // Bigger, solid arrowhead (#402) so direction reads clearly even where the
      // tip lands on a node's connection dot. Half-angle 0.5 rad → a chunkier head.
      const angle = Math.atan2(dy, dx);
      const size  = ARROW_SIZE;
      const ax1   = x2 - size * Math.cos(angle - 0.5);
      const ay1   = y2 - size * Math.sin(angle - 0.5);
      const ax2   = x2 - size * Math.cos(angle + 0.5);
      const ay2   = y2 - size * Math.sin(angle + 0.5);
      const tri   = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      tri.setAttribute('points', `${x2},${y2} ${ax1},${ay1} ${ax2},${ay2}`);
      tri.setAttribute('fill', stroke);
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
      state.userCollapsed.delete(id);
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
    state.userCollapsed.add(id);
    const bp = state.byId[id];
    if (bp && bp.children) {
      bp.children.forEach(cid => collapseSubtree(cid));
    }
  }

  function expandAll() {
    state.userCollapsed.clear();
    state.briefings.forEach(bp => {
      if (bp.children && bp.children.length > 0) {
        state.childrenVisible.add(bp.id);
      }
    });
    render();
  }

  function collapseAll() {
    state.childrenVisible.clear();
    state.briefings.forEach(bp => {
      if (bp.children && bp.children.length > 0) state.userCollapsed.add(bp.id);
    });
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

    // Actor column (#410) sits left of the graph — keep it in the frame.
    for (const pos of Object.values(state.actorPositions)) {
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + ACTOR_W);
      maxY = Math.max(maxY, pos.y + ACTOR_H);
    }

    // Routed edges may swing around the graph through the side gutters — keep
    // them (and the virtual top channel) inside the fitted frame.
    if (state.edgeBounds) {
      minX = Math.min(minX, state.edgeBounds.minX);
      minY = Math.min(minY, state.edgeBounds.minY);
      maxX = Math.max(maxX, state.edgeBounds.maxX);
      maxY = Math.max(maxY, state.edgeBounds.maxY);
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
    const fromId = state.connecting.fromId;
    // The drag source is an agent card or an actor node (#411).
    let x1, y1;
    const actorPos = state.actorPositions[fromId];
    if (actorPos) {
      x1 = actorPos.x + ACTOR_W;
      y1 = actorPos.y + ACTOR_H / 2;
    } else {
      const pos = state.positions[fromId];
      const el = canvas.querySelector(`.bp-node[data-id="${fromId}"]`);
      if (!pos || !el) return;
      x1 = pos.x + NODE_W;
      y1 = pos.y + el.offsetHeight / 2;
    }
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
    // Only agent cards are valid drop targets — actor nodes are sources only.
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const nodeEl = el && el.closest ? el.closest('.bp-node') : null;
    const toId = nodeEl && nodeEl.dataset ? nodeEl.dataset.id : null;
    if (!toId || toId === fromId) return;
    if (onConnect) onConnect(fromId, toId);
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    setZoom(state.zoom * (e.deltaY > 0 ? 0.9 : 1.1), e.clientX - rect.left, e.clientY - rect.top);
  }

  // Zoom to an absolute factor, keeping the viewport point (cx, cy) fixed —
  // defaults to the viewport centre for button / preset / typed-input zooming.
  function setZoom(newZoom, cx, cy) {
    state.userTransform = true;
    const oldZoom = state.zoom;
    state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
    if (state.zoom !== oldZoom) {
      const mx = cx !== undefined ? cx : viewport.clientWidth / 2;
      const my = cy !== undefined ? cy : viewport.clientHeight / 2;
      state.pan.x = mx - (mx - state.pan.x) * (state.zoom / oldZoom);
      state.pan.y = my - (my - state.pan.y) * (state.zoom / oldZoom);
    }
    applyTransform();
  }

  function applyTransform() {
    canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
    if (document.activeElement !== zoomInput) zoomInput.value = Math.round(state.zoom * 100) + '%';
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
    btn.textContent        = active ? 'Flow →' : 'Flow ↓';
    btn.title              = 'Toggle flow direction (' +
      (active ? 'left to right' : 'top to bottom') + ')';
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

  renderLegend();
  setupPanZoom();
  // No auto-fetch — the React wrapper loads /api/flows/graph and calls setData.

  // ─── Public API ─────────────────────────────────────────────────────────

  function cleanup() {
    viewport.removeEventListener('mousedown', onMousedown);
    window.removeEventListener('mousemove', onMousemove);
    window.removeEventListener('mouseup', onMouseup);
    viewport.removeEventListener('wheel', onWheel);
    document.removeEventListener('click', onDocClickCloseZoomMenu);
    resizeObserver.disconnect();
    // Remove injected DOM
    while (viewport.firstChild) viewport.removeChild(viewport.firstChild);
  }

  return {
    setData,
    fit: () => { state.userTransform = false; fitToView(); },
    setSelected: (id) => { state.selectedId = id; render(); },
    setEditable: (v) => { if (state.editable !== !!v) { state.editable = !!v; render(); } },
    setZoom,
    getZoom: () => state.zoom,
    zoomIn:  () => setZoom(state.zoom * ZOOM_STEP),
    zoomOut: () => setZoom(state.zoom / ZOOM_STEP),
    cleanup,
  };
}
