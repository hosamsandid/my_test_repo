// flow-graph-render.js — ES Module (Unified Orchestration #362, UI rework Phase B)
//
// The rich graph renderer (originally bp-graph.js, ported from the BP-Explorer
// viewer), generalized to consume the unified graph from /api/flows/graph. It
// keeps the look the operators preferred — expandable node cards, parent-child
// hierarchy, the Content/prompt panel, and the data-flow (input/output
// artifact) view — and additionally draws the process-linking edges (label /
// review / manual) on top.
//
// That provenance is why the `.bp-*` class names below read as they do: they
// are the ORIGINAL viewer's, kept when the module was generalized, and they
// have applied to every node in the flow editor ever since — not only to
// BriefingPack ones. They are a naming legacy, deliberately left alone by the
// BriefingPack removal (#1965); the e2e flow journeys select on them
// (`e2e/steps/flows.js`), so a rename is a change to both files at once.
//
//   const g = initFlowGraph(viewportEl, { onSelectNode });
//   g.setData(unifiedGraph);   // { nodes, edges, lints } from /api/flows/graph
//   g.fit(); g.cleanup();

import { computeFlowLayout, assignCrossCoords, wrapColumns } from './flow-layout';
import { routeOrthogonalEdges, roundedPathD, laneLoadByChannel } from './edge-router';
import { outcomeCardMinHeight, OUTCOME_COL_BOTTOM, OUTCOME_GROW_MIN } from './outcome-port-layout';
import { previewStrokeColor, portRectAnchor, screenPointToCanvas } from './drag-preview-anchor';
import { summarizeLoopEdge, summarizeClaimEdge, claimTooltip } from '../agent-chat/trigger-summary';
import { clampPan } from './pan-clamp';
import { attachTooltip } from '../../components/tooltip-dom';
import { CANVAS_TITLES, orientationTitle, archivedTitle, stagesTitle } from './flow-canvas-hints';
import {
  WAKE_EDGE_COLOR, WAKE_EDGE_LEGEND, wakeChipText, wakeEdgeIsAmbiguous,
} from './wake-edge-view';

// Single source of truth for edge colours and legend names (#402, #1009).
// Every drawer, the canvas legend AND the Team-Setup wizard's mini preview
// read from here so the graph and its keys can never drift apart. Each entry
// maps a semantic edge type to its stroke colour; the same hue is reused for
// the node's matching badge/port (Issue = teal, PR = purple) so a node's
// "opens issues/PRs" chip and the resulting channel edge read as one colour.
export const EDGE_STYLES = {
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
  // A loop self-edge (#936): an agent re-arming itself. Distinct fuchsia so
  // the stop-contract badge never reads as a schedule (⏰) or a PR edge.
  loop:       { color: '#d946ef', label: 'loop' },
  // Brake hand-off to a human (#981): the flow pauses pending a human
  // decision. Rose + dashed so "waiting on a person" never reads as a
  // gate listener (solid red) or a plain label hand-off (blue).
  handoff:    { color: '#e11d48', label: 'human decision', dashed: true },
  // Direct agent-to-agent hand-off (#2031): a `wakeAgent` outcome wakes a wired
  // same-team role inside the platform. Indigo + SOLID — dotted already means
  // "internal transport of a label", and this is not a label at all. The hue
  // sits close to label-blue on purpose-of-necessity, so the chip's `↪` glyph is
  // what carries the distinction. See wake-edge-view.js for the full rationale.
  wake:       { color: WAKE_EDGE_COLOR, label: WAKE_EDGE_LEGEND },
};

export function initFlowGraph(viewport, { onSelectNode, onConnect, onConnectOutcome, onSelectEdge, actorSources, expandChildrenByDefault } = {}) {

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
  // label / webhook trigger can be wired on the canvas. @timer is gone
  // (schedules render inside the agent card instead of as an actor). @human
  // (#981) is NOT a drag source either — it appears exactly when the graph
  // derives a human touchpoint (gate/brake labels, artifact audience).
  const DEFAULT_ACTORS = [
    { id: '@github', kind: 'actor', actor: 'github', displayName: 'GitHub' },
    { id: '@external', kind: 'actor', actor: 'external', displayName: 'External system' },
  ];

  const ARROW_SIZE = 12; // arrowhead length in px (#402 — was 7, hard to see)

  // How far a single column may run along the CROSS axis before it wraps into
  // stacked sub-rows (see wrapColumns in flow-layout.js). One column is one
  // layer of the flow, which for a hierarchy is every sibling of one parent — the
  // hierarchy that forced this (a BriefingPack pack with a 270-child root) laid
  // 270 cards out in a single line, giving a canvas ~100 000px wide that "Fit to
  // view" could not fit even at the 10% zoom floor. The budget is not specific to
  // that source and outlives it. 6 000px is ~16 cards across: wide enough that every
  // hand-authored flow is unaffected, narrow enough that a wrapped block fits a
  // normal viewport at a readable zoom.
  const WRAP_MAX_CROSS = 6000;
  // Sub-rows of ONE column sit closer together than two different columns do:
  // no edge channel runs between them (they are the same layer), and the tight
  // spacing is what makes the block read as one group of siblings.
  const WRAP_ROW_GAP = 40;

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
      .bp-badge-outcome        { background:rgba(234,179,8,0.15);   color:#eab308; border:1px solid rgba(234,179,8,0.45); }

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
      :root[data-theme="admin-light"] .bp-badge-outcome        { color:#a16207; border-color:rgba(161,98,7,0.45); }
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
  // Bottom-left (the zoom control owns bottom-right), wrapping when narrow,
  // and collapsible to a small pill (state persisted across sessions).
  const legendEl = document.createElement('div');
  legendEl.style.cssText = 'position:absolute;bottom:12px;left:12px;max-width:calc(100% - 240px);background:var(--eb-bg-elevated);backdrop-filter:blur(4px);border:1px solid var(--eb-border-default);border-radius:8px;padding:6px 14px;display:flex;gap:6px 10px;align-items:center;flex-wrap:wrap;z-index:20;font-size:11px;';
  legendEl.addEventListener('mousedown', (e) => e.stopPropagation());
  const _mkSwatch = ({ color, label, dashed }) =>
    `<span style="display:flex;align-items:center;gap:4px;white-space:nowrap">` +
    `<span style="width:14px;height:0;display:inline-block;border-top:2px ${dashed ? 'dashed' : 'solid'} ${color};"></span>` +
    `<span style="color:var(--eb-text-secondary)">${label}</span></span>`;
  // Node-kind swatches (#1121): a miniature of the actual card border so the
  // canvas's distinct node shapes (solid agent card vs dashed purple human
  // role) are named, not just its edge colours. Borders mirror the card
  // rendering above (agent: 1px solid --eb-border-default; human: 1px dashed
  // #7c3aed on a tinted surface).
  const _mkNodeSwatch = ({ border, bg, icon, label }) =>
    `<span style="display:flex;align-items:center;gap:4px;white-space:nowrap">` +
    `<span style="width:14px;height:10px;display:inline-block;border:${border};background:${bg};border-radius:3px;box-sizing:border-box;"></span>` +
    `<span style="color:var(--eb-text-secondary)">${icon ? icon + ' ' : ''}${label}</span></span>`;
  const _legendToggleBtn = (collapsed) =>
    `<button data-legend-toggle title="${collapsed ? 'Show legend' : 'Hide legend'}" style="`
    + 'background:none;border:none;padding:0;cursor:pointer;font-size:11px;white-space:nowrap;'
    + `color:var(--eb-text-muted);">Legend ${collapsed ? '▸' : '▾'}</button>`;
  function renderLegend() {
    if (state.legendCollapsed) {
      legendEl.innerHTML = _legendToggleBtn(true);
      return;
    }
    // A FIXED key list, not derived from EDGE_STYLES — so an edge type absent
    // here draws with no legend entry at all. `wake` (#2031) sits next to
    // `label`: they are the two agent→agent hand-off mechanisms and read as a
    // pair (one carries a label a human can see, the other does not).
    const keys = ['label', 'wake', 'issue', 'pr', 'review', 'gate', 'handoff', 'event', 'webhook', 'artifact', 'dependency', 'hierarchy'];
    const actorToggles = ['github', 'external'].map(kind => {
      const off = state.hiddenActorKinds.has(kind);
      return `<button data-actor-toggle="${kind}" title="Show/hide edges from this source" style="`
        + 'background:none;border:1px solid var(--eb-border-default);border-radius:10px;padding:0 6px;'
        + `cursor:pointer;font-size:11px;line-height:16px;opacity:${off ? 0.35 : 1};`
        + `color:var(--eb-text-secondary);">${ACTOR_ICON[kind]}</button>`;
    }).join('');
    const nodeSwatches = [
      _mkNodeSwatch({ border: '1px solid var(--eb-border-default)', bg: 'var(--eb-bg-surface)', label: 'agent' }),
      _mkNodeSwatch({ border: '1px dashed #7c3aed', bg: 'rgba(124,58,237,0.06)', icon: '👤', label: 'human role' }),
    ].join('');
    legendEl.innerHTML =
      _legendToggleBtn(false) +
      `<span style="color:var(--eb-text-muted);font-size:10px;margin-left:4px">Nodes:</span>` +
      nodeSwatches +
      `<span style="color:var(--eb-text-muted);font-size:10px;margin:0 2px 0 6px">Edges:</span>` +
      keys.map(k => _mkSwatch(EDGE_STYLES[k])).join('') +
      `<span style="color:var(--eb-text-muted);font-size:10px;margin:0 2px 0 6px">Sources:</span>` +
      actorToggles;
  }
  legendEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-legend-toggle]')) {
      state.legendCollapsed = !state.legendCollapsed;
      localStorage.setItem('flow-graph-legend-collapsed', state.legendCollapsed);
      renderLegend();
      return;
    }
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
    legendCollapsed:    localStorage.getItem('flow-graph-legend-collapsed') === 'true',
    // Per-trigger edge visibility (👁 toggle on the card's trigger rows) —
    // keys are `${nodeId}|${triggerId}`, persisted across sessions.
    hiddenTriggerEdges: new Set(JSON.parse(localStorage.getItem('flow-graph-hidden-trigger-edges') || '[]')),
    nodeTriggerEdges:   new Map(), // nodeId → external trigger edges shown in the card
    showStages:         localStorage.getItem('flow-graph-show-stages') === 'true', // #362 E stage bands
    stageOrder:         [],     // ordered stage names — drives layered layout order
    layeredInfo:        null,   // { vertical, colOf } while the layered layout is active
    // ── Measured card / artifact heights, keyed by id ──────────────────────
    // The layout needs a height for every node on every pass. Reading it back
    // off the DOM each time cost one `canvas.querySelector` per node per call —
    // and `assignCrossCoords` calls it ~28× per node — so a real pack spent
    // thousands of selector matches, plus a forced reflow, on numbers that had
    // not changed. The cards are measured once per render pass instead (see
    // measureHeights) and every consumer reads the cache.
    nodeHeights:        new Map(), // nodeId → measured px
    artifactHeights:    new Map(), // artifact path → measured px
    // Cached extent of the drawn graph; null = needs recomputing.
    contentBounds:      null,
    // Cached viewport size. Reading clientWidth/clientHeight forces a synchronous
    // layout flush, and the pan clamp needs it on every mousemove — ~400 per
    // second during a drag, each one a reflow over 81 cards and 500 SVG nodes.
    // The ResizeObserver below is the authority on when it changes.
    viewportSize:       { w: 0, h: 0 },
    rafScheduled:       false,         // dedup guard: one rAF in flight at most
  };

  function viewportSize() {
    const s = state.viewportSize;
    if (s.w <= 0 || s.h <= 0) { s.w = viewport.clientWidth; s.h = viewport.clientHeight; }
    return s;
  }

  const DEFAULT_NODE_H = 90;

  // ─── Pan / zoom frame coalescing ──────────────────────────────────────
  // Pan and zoom are a single CSS transform on `canvas`, and a wheel gesture
  // does NOT arrive as one event: a notched wheel delivers 10–20 and a
  // precision wheel or trackpad hundreds. Writing the transform per event asks
  // the compositor to re-tile and re-raster the whole canvas that many times in
  // one gesture — on a large hierarchy the canvas is tens of thousands of
  // pixels wide, so the pipeline never catches up. The pointer maths stays
  // per-event (so the zoom lands exactly where today's does); only the DOM write
  // is coalesced to at most one per animation frame.
  let viewFrame = 0;
  function scheduleTransform() {
    if (viewFrame) return;
    viewFrame = requestAnimationFrame(() => {
      viewFrame = 0;
      applyTransform();
    });
  }

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
    // they never join the tree/layered layout of the agent cards. @timer is
    // dropped here (schedules render inside the card); @human is back (#981)
    // as the explicit source/sink of gate labels, brake hand-offs, and
    // human-audience artifact deliveries.
    state.actors = allNodes.filter(n => n && n.kind === 'actor' && n.actor !== 'timer');
    state.actorsById = {};
    state.actors.forEach(a => { state.actorsById[a.id] = a; });
    // #1197: a human's label consume renders as a brake decision only when the
    // label is flagged `brake`; an unflagged label is a plain notification (they
    // are told when it is set). Flag-based, never name-based (#928).
    state.brakeLabels = new Set((Array.isArray(g.labels) ? g.labels : [])
      .filter(l => l && l.brake).map(l => l.name));
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
      // Structured outcomes port (#828): drives the ◇ switch badge + per-outcome
      // output ports. Only authored ports reach the graph (see process-graph.js).
      outcomes: (n.outcomes && Array.isArray(n.outcomes.options) && n.outcomes.options.length) ? n.outcomes : null,
      _role: n.role,
      _isParent: n.isParent === true,
      // Named human role (#987): a first-class, purely-declarative person node.
      // Rendered as a distinct card (person icon, no trigger/session rows, no
      // produce badges) and its emits/consumes drive the inspector.
      _isHuman: n.kind === 'human' || n.role === 'human',
      _emits: Array.isArray(n.emits) ? n.emits : [],
      _consumes: Array.isArray(n.consumes) ? n.consumes : [],
      _description: typeof n.description === 'string' ? n.description : '',
    }));
    state.byId = {};
    state.briefings.forEach(bp => { state.byId[bp.id] = bp; });

    // event/webhook edges (#410) run from an actor node; label edges may too
    // (human-set labels come from @github). Timer edges are NOT drawn as lines
    // any more — schedules render inside the agent card. True orphans
    // (from: null) are still dropped here.
    // `wake` (#2031) is agent→agent and always has both endpoints resolved (the
    // graph builder withholds the edge otherwise), so it needs no special case
    // beyond admission here — an `on` missing from this set never gets a line.
    const EXTRA = new Set(['label', 'review', 'manual', 'github', 'event', 'webhook', 'wake']);
    state.extraEdges = (Array.isArray(g.edges) ? g.edges : [])
      .filter(e => EXTRA.has(e.on) && e.from && e.to && e.from !== e.to);

    // The trigger rows shown inside each card: schedules (⏰, no line), loop
    // self-edges (↻, no line — #936) plus every actor-sourced trigger edge
    // (🐙/🏷/⚡ — each with a 👁 line toggle).
    state.nodeTriggerEdges = new Map();
    (Array.isArray(g.edges) ? g.edges : []).forEach(e => {
      if (!e || !e.to) return;
      const fromActor = typeof e.from === 'string' && e.from.startsWith('@');
      if (e.on === 'timer' || e.on === 'loop' || (fromActor && ['event', 'webhook', 'label'].includes(e.on))) {
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
          // Audience (#981): a person consumes this output — badge + @human edge.
          if (art.audience === 'human') reg[path].humanAudience = true;
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

  // A node's card height — the measurement cached by measureHeights(), or the
  // default before the first pass has run (which is what the DOM lookup used to
  // fall back to anyway, since `render()` lays out before it mounts the cards).
  function getNodeHeight(id) {
    const h = state.nodeHeights.get(id);
    return h > 0 ? h : DEFAULT_NODE_H;
  }

  function getArtifactHeight(path) {
    const h = state.artifactHeights.get(path);
    return h > 0 ? h : ARTIFACT_H;
  }

  // Re-read the real heights of every mounted card / artifact. One forced
  // reflow per render pass, from which every later read is served.
  function measureHeights() {
    canvas.querySelectorAll('.bp-node').forEach(el => {
      const h = el.offsetHeight;
      if (h > 0) state.nodeHeights.set(el.dataset.id, h);
    });
    canvas.querySelectorAll('.artifact-node').forEach(el => {
      const h = el.offsetHeight;
      if (h > 0) state.artifactHeights.set(el.dataset.path, h);
    });
  }

  function layout() {
    const visible = getVisibleNodes();
    if (visible.length === 0) return;
    layoutLayered(visible);
    layoutActors();
    state.contentBounds = null;   // positions moved — the cached extent is stale
  }

  // Which actor pseudo-nodes to show (#410): an actor appears when it has at
  // least one edge to a known node and its source kind is not toggled off in
  // the legend. (Editable placeholder actors for empty flows come with #411.)
  function actorHasEdges(a) {
    // Actors source edges (@github events) or receive webhooks (@external). The
    // generic @human hub is gone (#987) — human touchpoints are named role nodes.
    return (state.extraEdges || []).some(e =>
      (e.from === a.id && state.byId[e.to]) || (e.to === a.id && state.byId[e.from]));
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

    // Wrap over-wide columns into sub-rows BEFORE assigning cross coordinates,
    // so each sub-row gets its own overlap-free line. `colOf` is deliberately
    // left alone: a wrapped column is still one column to the layering, the
    // crossing reduction and the channel/lane router — only its pixels move.
    const wrapped = wrapColumns(columns, {
      crossExtentOf: col => (vertical
        ? Math.max(DEFAULT_NODE_H, ...col.map(getNodeHeight)) + crossGap
        : NODE_W + crossGap),
      maxCrossExtent: WRAP_MAX_CROSS,
    });
    const lines = wrapped.flat();
    const center = assignCrossCoords(lines, edges, sizeOf, { gap: crossGap });

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
      const mainOf = new Map();
      for (let c = 0; c < wrapped.length; c++) {
        colMain[c] = x;
        // gap = space between this card's right edge and the next card's left edge.
        const gap = Math.max(H_GAP * 2, (boundaryNeed[c] || 0) + 40, laneNeed(c));
        const rows = wrapped[c];
        rows.forEach((row, r) => {
          row.forEach(id => mainOf.set(id, x));
          // Only the LAST sub-row is followed by the channel gap — that is where
          // this column's outgoing edges actually run.
          x += NODE_W + (r < rows.length - 1 ? WRAP_ROW_GAP : gap);
        });
      }
      ids.forEach(id => {
        const main = mainOf.has(id) ? mainOf.get(id) : (colMain[colOf.get(id) || 0] || 0);
        pos[id] = { x: main, y: (center.get(id) || 0) - getNodeHeight(id) / 2 };
      });
    } else {
      let y = 0;
      const mainOf = new Map();
      for (let c = 0; c < wrapped.length; c++) {
        colMain[c] = y;
        const rows = wrapped[c];
        rows.forEach((row, r) => {
          const maxH = Math.max(DEFAULT_NODE_H, ...row.map(getNodeHeight));
          row.forEach(id => mainOf.set(id, y));
          // Only the LAST sub-row is followed by the channel gap — that is where
          // this column's outgoing edges actually run.
          y += maxH + (r < rows.length - 1 ? WRAP_ROW_GAP : Math.max(V_GAP, laneNeed(c)));
        });
      }
      ids.forEach(id => {
        const main = mainOf.has(id) ? mainOf.get(id) : (colMain[colOf.get(id) || 0] || 0);
        pos[id] = { x: (center.get(id) || 0) - NODE_W / 2, y: main };
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
      const isHuman = bp._isHuman === true;
      node.className = 'bp-node' + (bp.status ? ` bp-node-status-${bp.status}` : '') + (isHuman ? ' bp-node-human' : '');
      node.dataset.id = n.id;
      // A human role reads as a person, not an agent: a dashed accent border and
      // a tinted surface set it apart from the solid agent cards (#987).
      const humanBorder = selected ? '2px solid #7c3aed' : '1px dashed #7c3aed';
      node.style.cssText = `
        position:absolute;
        left:${pos.x}px;
        top:${pos.y}px;
        width:${NODE_W}px;
        background:${isHuman ? 'rgba(124,58,237,0.06)' : 'var(--eb-bg-surface)'};
        border:${isHuman ? humanBorder : (selected ? '2px solid var(--eb-accent-primary)' : '1px solid var(--eb-border-default)')};
        border-radius:8px;
        padding:10px 12px;
        box-sizing:border-box;
        font-size:12px;
        color:var(--eb-text-primary);
        box-shadow:var(--eb-shadow-sm);
        cursor:pointer;
      `;
      if (!isHuman) applyStatusBorderColor(node, bp.status);
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
        <span style="flex:1;line-height:1.4;">${isHuman ? '👤 ' : ''}${esc(bp.title)}</span>
      `;
      node.appendChild(header);

      // Human role subtitle + its emits/consumes chips (#987). A human role has
      // no triggers, session policy, produce badges or outcome ports — its whole
      // model is "which labels this person applies, and what lands with them".
      if (isHuman) {
        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:10px;color:#7c3aed;font-weight:600;letter-spacing:0.03em;text-transform:uppercase;margin-bottom:4px;';
        sub.textContent = 'Human role';
        node.appendChild(sub);
        if (bp._description) {
          const desc = document.createElement('div');
          desc.style.cssText = 'font-size:11px;color:var(--eb-text-secondary);line-height:1.4;margin-bottom:6px;';
          desc.textContent = bp._description;
          node.appendChild(desc);
        }
        const chip = (text, title, color) =>
          `<span title="${esc(title)}" style="font-size:9px;color:${color};background:rgba(124,58,237,0.10);border:1px solid rgba(124,58,237,0.35);border-radius:3px;padding:0 4px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(text)}</span>`;
        const parts = [];
        for (const e of bp._emits) parts.push(chip(`↦ ${e}`, `applies label “${e}” (a gate)`, '#6d28d9'));
        for (const c of bp._consumes) {
          if (c && c.label) {
            const isBrake = state.brakeLabels && state.brakeLabels.has(c.label);
            parts.push(isBrake
              ? chip(`⏸ ${c.label}`, `decides on brake “${c.label}”`, '#6d28d9')
              : chip(`⇤ ${c.label}`, `notified when “${c.label}” is set`, '#6d28d9'));
          }
          else if (c && (c.artifact === 'pr' || c.artifact === 'issue')) parts.push(chip(`⇤ ${c.artifact} · ${c.from}`, `reviews ${c.artifact} from ${c.from}`, '#6d28d9'));
          else if (c && c.artifact === 'file') parts.push(chip(`⇤ ${c.name}`, `reads output ${c.name}`, '#6d28d9'));
        }
        if (parts.length) {
          const chips = document.createElement('div');
          chips.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;';
          chips.innerHTML = parts.join('');
          node.appendChild(chips);
        }
      }

      // Badges
      const badgeParts = [];
      if (bp.rigor)    badgeParts.push(`<span class="bp-badge bp-badge-rigor-${esc(bp.rigor)}">${esc(bp.rigor)}</span>`);
      if (bp.revision && parseInt(bp.revision) > 1)
        badgeParts.push(`<span class="bp-badge bp-badge-revision" title="Revised">Rev ${esc(String(bp.revision))}</span>`);
      // GitHub produce badges (#380) — visible before any wiring. Draggable
      // outcome ports again (#1005 heals the #411 amputation): dragging a badge
      // onto another node opens the channel form pre-typed by the artifact.
      const draggableBadges = [];
      const badgeDraggable = state.editable && !!onConnectOutcome;
      if (bp.github && bp.github.producesPr) {
        draggableBadges.push({ cls: 'bp-badge bp-badge-gh-pr', text: '⇅ PR', artifact: 'pr',
          title: badgeDraggable ? 'Opens pull requests — drag to the agent that reacts to them' : 'Opens pull requests' });
      }
      if (bp.github && bp.github.producesIssue) {
        draggableBadges.push({ cls: 'bp-badge bp-badge-gh-issue', text: '◉ Issue', artifact: 'issue',
          title: badgeDraggable ? 'Opens issues — drag to the agent that reacts to them' : 'Opens issues' });
      }
      // Switch badge (#828): an exactlyOne outcomes port picks exactly one branch
      // per run — render the ◇ glyph so the node reads as a switch.
      if (bp.outcomes && bp.outcomes.mode === 'exactlyOne')
        badgeParts.push(`<span class="bp-badge bp-badge-outcome" title="Switch — exactly one outcome per run">◇ switch</span>`);
      if (badgeParts.length > 0 || draggableBadges.length > 0) {
        const badges = document.createElement('div');
        badges.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;';
        for (const b of draggableBadges) {
          const el = document.createElement('span');
          el.className = b.cls;
          el.textContent = b.text;
          el.title = b.title;
          if (badgeDraggable) {
            el.style.cursor = 'crosshair';
            el.addEventListener('mousedown', (ev) => {
              ev.stopPropagation();
              ev.preventDefault();
              startConnect(n.id, { artifact: b.artifact }, { el, kind: 'artifact' });
            });
          }
          badges.appendChild(el);
        }
        if (badgeParts.length > 0) {
          const rest = document.createElement('span');
          rest.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
          rest.innerHTML = badgeParts.join('');
          badges.appendChild(rest);
        }
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
                ...(e.loop ? { loop: e.loop } : {}),
              });
            });
          }
          row.appendChild(lbl);
          // ⏰ schedules and ↻ loop self-edges (#936) draw no line on the canvas,
          // so they have no line to toggle — skip the 👁 button for them.
          if (e.on !== 'timer' && e.on !== 'loop' && e.triggerId) {
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
      // artifact toggles).
      if (actions.childElementCount > 0) node.appendChild(actions);

      // Connect-to-wire port (#362 Phase C2): drag to another node to wire a
      // hand-off / link. Only when editable and a handler is wired. A human role
      // carries the same port (#987): dragging FROM it onto an agent wires a
      // human gate (the person applies a label the agent waits on); dropping an
      // agent's port ONTO a human box wires a delivery — both handled by the
      // human-aware CreateEdgeDialog.
      if (state.editable && onConnect) {
        const port = document.createElement('div');
        port.title = 'Drag to another node to connect them';
        port.style.cssText = 'position:absolute;right:-7px;top:calc(50% - 7px);width:14px;height:14px;border-radius:50%;background:var(--eb-accent-primary);border:2px solid var(--eb-bg-surface);cursor:crosshair;z-index:3;';
        port.addEventListener('mousedown', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          startConnect(n.id, null, { el: port, kind: 'handoff' });
        });
        node.appendChild(port);
      }

      // Outcome output ports (#828): one small square port per outcome option on
      // an authored outcomes port. Dragging one onto another node opens the label
      // hand-off dialog pre-filled with that outcome's label (onConnectOutcome).
      // Stacked as a labelled column on the node's right edge, below the ● port.
      if (state.editable && onConnectOutcome && bp.outcomes && Array.isArray(bp.outcomes.options) && bp.outcomes.options.length) {
        const outCount = bp.outcomes.options.length;
        // With 2+ outcomes the column is pinned to the card's bottom and the card
        // is grown via min-height (below) so every row stays inside the borders
        // and clears the centred ● connect port (#857). A single outcome keeps the
        // original centre-anchored placement so 0/1-outcome nodes are unchanged.
        const grow = outCount >= OUTCOME_GROW_MIN;
        const col = document.createElement('div');
        col.style.cssText = grow
          ? `position:absolute;right:-9px;bottom:${OUTCOME_COL_BOTTOM}px;display:flex;flex-direction:column;gap:5px;z-index:3;align-items:flex-end;`
          : 'position:absolute;right:-9px;top:calc(50% + 14px);display:flex;flex-direction:column;gap:5px;z-index:3;align-items:flex-end;';
        bp.outcomes.options.forEach((o) => {
          const title = o.title || o.id;
          const setLabelAction = (o.actions || []).find(a => a.type === 'setLabel' && a.label);
          // Open-end markers (#1004): a declared endpoint renders as a proper
          // terminus glyph on the port tag instead of looking unfinished.
          const marker = o.terminal === true ? 'terminal' : (o.external ? 'external' : null);
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:4px;';
          const tag = document.createElement('span');
          tag.textContent = marker === 'terminal' ? `⏹ ${title}` : marker === 'external' ? `↗ ${title}` : title;
          if (marker) {
            tag.title = marker === 'terminal'
              ? 'Terminal by design — the end product'
              : `External consumer${o.external && o.external.note ? `: ${o.external.note}` : ' — consumed outside this flow'}`;
          }
          tag.style.cssText = 'font-size:9px;color:#a16207;background:rgba(234,179,8,0.12);border:1px solid rgba(234,179,8,0.4);border-radius:3px;padding:0 4px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          const dot = document.createElement('div');
          dot.title = `Outcome “${title}” — drag to the agent it routes to`;
          dot.style.cssText = 'width:12px;height:12px;border-radius:2px;background:#eab308;border:2px solid var(--eb-bg-surface);cursor:crosshair;flex-shrink:0;';
          dot.addEventListener('mousedown', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            // Pre-typed drag (#1005): the outcome's action determines the form —
            // `artifact` set → channel dialog, else the label hand-off.
            const opensPr = (o.actions || []).some(a => a && a.type === 'openPr');
            const opensIssue = (o.actions || []).some(a => a && a.type === 'openIssue');
            startConnect(n.id, {
              id: o.id, title,
              label: setLabelAction ? setLabelAction.label : '',
              artifact: setLabelAction ? null : (opensPr ? 'pr' : (opensIssue ? 'issue' : null)),
            }, { el: dot, kind: 'outcome' });
          });
          row.appendChild(tag);
          row.appendChild(dot);
          col.appendChild(row);
        });
        node.appendChild(col);
        // Grow the card so the bottom-pinned column is fully contained and the
        // added height is reflected in layout + edge anchoring (all driven by the
        // node's measured offsetHeight — see getNodeHeight / drawRoutedProcessEdges).
        const minH = outcomeCardMinHeight(outCount);
        if (minH) node.style.minHeight = minH + 'px';
      }

      // NOTE (#411): the separate PR/Issue drag pills are gone — the header
      // badges above keep the "opens PRs/issues" information visible, and the
      // single ● port creates every connection type (the create dialog ranks
      // the PR/Issue channel first for producers).

      canvas.appendChild(node);
    });

    // Artifact nodes
    renderArtifactNodes();

    // Actor pseudo-nodes (#410)
    renderActorNodes();

    // Re-layout with actual DOM heights, then reposition. The heights are read
    // into the cache FIRST, because the layout no longer touches the DOM for
    // them. Guard prevents multiple rapid render() calls from piling up rAF callbacks.
    if (state.rafScheduled) return;
    state.rafScheduled = true;
    requestAnimationFrame(() => {
      state.rafScheduled = false;
      measureHeights();
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
      state.contentBounds = null;   // drawEdges filled in state.edgeBounds
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
      const h  = getArtifactHeight(path);
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
      // @human (#981) is display-only — its edges are authored via the label
      // registry (gate/brake flags) and the artifact-audience checkboxes, so it
      // gets no drag port.
      if (actorsAsSources() && a.actor !== 'human') {
        const port = document.createElement('div');
        port.title = 'Drag to an agent: it gets a trigger from this source';
        port.style.cssText = 'position:absolute;right:-7px;top:calc(50% - 7px);width:14px;height:14px;border-radius:50%;background:var(--eb-accent-primary);border:2px solid var(--eb-bg-surface);cursor:crosshair;z-index:3;';
        port.addEventListener('mousedown', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          startConnect(a.id, null, { el: port, kind: 'handoff' });
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

      // Human audience (#981): a person consumes this artifact.
      if (reg.humanAudience) {
        meta.innerHTML += `<span title="A person consumes this artifact" style="background:#e11d4822;color:#e11d48;border:1px solid #e11d4855;border-radius:3px;padding:1px 5px;font-size:10px;">👤 for a person</span>`;
      }

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
      labelObstacles.push({ x: p.x, y: p.y, w: NODE_W, h: getNodeHeight(n.id) });
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
    const OUTCOME_EDGE_COLOR = '#eab308';  // amber — matches the ◇ switch badge (#828)

    function drawRoutedProcessEdges() {
      const nodes = [];
      visible.forEach(n => {
        const p = state.positions[n.id];
        if (!p) return;
        nodes.push({ id: n.id, x: p.x, y: p.y, w: NODE_W, h: getNodeHeight(n.id) });
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
        // Edges INTO an actor (#981): brake hand-offs and human-audience
        // artifact deliveries terminate on @human. Advisory display only —
        // no hit payload, so clicking cannot open an edit dialog aimed at a
        // pseudo-node.
        const actorTo = state.actorsById[e.to];
        if (actorTo) {
          if (state.hiddenActorKinds.has(actorTo.actor)) return;
          if (!visibleIds.has(e.from) || !state.actorPositions[e.to]) return;
          const isDelivery = e.on === 'github';
          const artifactTo = e.artifact === 'issue' ? 'issue' : 'pr';
          list.push({
            from: e.from, to: e.to,
            color: isDelivery ? GH_COLOR[artifactTo] : EDGE_STYLES.handoff.color,
            width: isDelivery ? 2 : 1.5,
            dash: isDelivery ? '' : '6 4', opacity: 1,
            labelText: isDelivery
              ? `${artifactTo === 'issue' ? 'Issue' : 'PR'} → 👤`
              : `👤 ${e.label || ''}`.trim(),
            chip: true, gate: false,
            hit: null,
          });
          return;
        }
        if (!visibleIds.has(e.from) || !visibleIds.has(e.to)) return;
        const isGithub = e.on === 'github';
        const artifact = e.artifact === 'issue' ? 'issue' : 'pr';
        // Outcome-keyed label edge (#828): the emitter set this label as part of a
        // structured outcome. Title the edge with the outcome, colour it like the
        // switch badge, and tag the hit payload so a click focuses the Routing tab.
        const isOutcome = e.on === 'label' && !!e.outcome;
        // Internal-channel delivery (#1174, extended to labelled PR/issue channels
        // in #1194): same hue as its label/outcome/github edge family, but dotted —
        // the wake bypasses the GitHub poller (orchestrator queue), and the dot
        // pattern is distinct from the 6-4 dash of actor edges.
        const isInternal = (e.on === 'label' || e.on === 'github') && e.transport === 'internal';
        // Direct hand-off (#2031). Checked BEFORE `isOutcome` in every arm
        // below: a wake edge always carries an `outcome` (that is what edgeId
        // keys on), so the amber outcome-keyed styling would otherwise swallow
        // it and every direct hand-off would render as a generic ◇ switch edge.
        const isWake = e.on === 'wake';
        list.push({
          from: e.from, to: e.to,
          color: isGithub ? GH_COLOR[artifact]
            : (isWake ? EDGE_STYLES.wake.color
              : (isOutcome ? OUTCOME_EDGE_COLOR : (EXTRA_COLOR[e.on] || EDGE_STYLES.label.color))),
          width: isGithub ? 2 : 1.5,
          // Solid: dotted means "internal transport of a label" (#1174), and a
          // direct hand-off carries no label to transport.
          dash: isInternal ? '2 3' : '',
          opacity: 1,
          labelText: isGithub ? channelChipText(e)
            : (isWake ? wakeChipText(e, nodeDisplayName, outcomeOptionTitle,
              wakeEdgeIsAmbiguous(state.extraEdges, e))
              : (isOutcome ? outcomeEdgeText(e) : (e.on === 'label' ? labelChipText(e) : (e.label || '')))),
          // A filled pill, like a GitHub-channel edge: the `↪ <Target>` text is
          // the whole content of the edge (there is no label token to read), so
          // it must stay legible over crossing lines rather than sit as bare
          // haloed text.
          chip: isGithub || isWake,
          gate: e.gate === 'human',
          hit: { from: e.from, to: e.to, label: e.label, on: e.on, kind: e.on,
            artifact: isGithub ? artifact : undefined, gate: e.gate, triggerId: e.triggerId,
            ...(isInternal ? { transport: 'internal' } : {}),
            // Carry the `audience` tag (#1036): a github delivery to a NAMED
            // human role (unified-graph tags it `audience:'human'`) must reach
            // the human-aware review-gate editor via findReviewGate — dropping
            // it here mis-routes the click to the agent→agent EditChannelDialog,
            // whose channel ops don't touch bundle.humans (silent no-op remove).
            ...(e.audience ? { audience: e.audience } : {}),
            // #1197: a label delivered to a named person (handoff:'human', no
            // listening trigger) routes to its own delivery editor, not the
            // agent→agent hand-off editor. Carry `brake` so a brake hand-off is
            // still distinguished from a plain-label delivery downstream.
            ...(e.handoff ? { handoff: e.handoff } : {}),
            ...(e.brake ? { brake: true } : {}),
            // #2031: the producer's hand-off note. The Edit-hand-off dialog
            // edits it in place, so it must survive the click — there is no
            // trigger behind a wake edge to re-read it from (the consumer's
            // listener is derived from the action, not the authoring point).
            ...(e.note ? { note: e.note } : {}),
            ...(e.outcome ? { outcome: e.outcome } : {}) },
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
        if (e.hit) addEdgeHit(d, e.hit);
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
      const pH = getNodeHeight(bp.parent);
      const cH = getNodeHeight(n.id);
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
    if (e.on === 'loop') {
      // Loop self-edge (#936): the stop-contract badge — budget (≤N iter / token
      // cap), stop condition (until:) and verifier (✓) at a glance. Click opens
      // the shared loop TriggerForm for the full contract.
      return {
        icon: '↻', text: summarizeLoopEdge(e.loop), color: EDGE_STYLES.loop.color,
        title: 'Loop — re-arms until the stop contract is met',
      };
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
    // Claim (#958) — the full swap belongs in the tooltip; the chip carries only
    // the compact `⇥ wip` badge (see labelChipText).
    const claimTip = claimTooltip(e.claim);
    return {
      icon: gate ? '👤✓' : '🏷',
      text: labelChipText(e),
      color: gate ? EDGE_STYLES.gate.color : EDGE_STYLES.label.color,
      title: (gate ? 'Human approval gate (GitHub label)' : 'GitHub label trigger') + evs
        + (claimTip ? ` — ${claimTip}` : ''),
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
    const base = tag ? `${e.label || ''} · ${tag}` : (e.label || '');
    // Claim badge (#958): the listener takes its wake label over as `<wake>:wip`
    // when it fires. Appended to the same chip rather than drawn as a second
    // badge — one chip per edge keeps the routed-label placement (and
    // estChipWidth) honest.
    const claim = summarizeClaimEdge(e.claim);
    return claim ? `${base} ${claim}` : base;
  }
  // The producer's title for an outcome-keyed edge (#828): resolve the outcome
  // option's title from the source node so the edge reads `◇ Accepted` rather
  // than the raw label. Falls back to the option id, then the label.
  function outcomeEdgeText(e) {
    const title = outcomeOptionTitle(e.from, e.outcome) || e.label || '';
    return `◇ ${title}`;
  }

  // A node's display name, and a producer's title for one of its outcome
  // options. Both are id fallbacks, never blank for a resolvable node/option, so
  // a chip built from them always says something. Shared by outcomeEdgeText and
  // the #2031 wake chip — the same lookup, previously inline in the former.
  function nodeDisplayName(id) {
    // `title`, NOT `displayName`: a `state.byId` entry is a *briefing* object
    // (built in setData as `{ id, title: n.displayName || n.id, … }`), so the
    // unified node's `displayName` does not survive into it — reading it would
    // silently fall through to the raw id on every single chip, which is the
    // one failure mode a name lookup can have and never report. The node cards
    // read `bp.title` for the same reason.
    const n = state.byId[id];
    return (n && (n.title || n.id)) || id || '';
  }
  function outcomeOptionTitle(fromId, outcomeId) {
    const src = state.byId[fromId];
    const opt = src && src.outcomes && Array.isArray(src.outcomes.options)
      ? src.outcomes.options.find(o => o.id === outcomeId) : null;
    return (opt && (opt.title || opt.id)) || outcomeId || '';
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
    for (const ch of String(text || '')) n += /[\u0000-\u00ff]/.test(ch) ? 1 : 1.7;
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
      const artH = getArtifactHeight(path);

      // Output edges: BP → artifact (green), into the lane.
      reg.producers.forEach(bpId => {
        if (!visibleBpIds.has(bpId)) return;
        const bpPos = state.positions[bpId];
        if (!bpPos) return;

        const bpH  = getNodeHeight(bpId);
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

      // Delivery to a person (#981): the artifact's declared audience is a
      // human — draw artifact → @human so the hand-off is explicit (same
      // dashed consumer-arm styling, rose like the other human hand-offs).
      const humanPos = state.actorPositions['@human'];
      if (reg.humanAudience && humanPos && !state.hiddenActorKinds.has('human')) {
        const hCx = humanPos.x + ACTOR_W / 2;
        const hCy = humanPos.y + ACTOR_H / 2;
        const d = vertical
          ? drawBezierEdge(
              topAnchorX(artPos, hCx), artPos.y,
              hCx, humanPos.y + ACTOR_H,
              EDGE_STYLES.handoff.color, 1.5, '4 3', true, 'vertical')
          : drawBezierEdge(
              artPos.x, leftAnchorY(artPos, artH, hCy),
              humanPos.x + ACTOR_W, hCy,
              EDGE_STYLES.handoff.color, 1.5, '4 3', true, 'horizontal');
        void d; // display-only — no edge hit, the audience is edited in the Routing tab
      }

      // Input edges: artifact → BP (data-flow green, dashed to read as the
      // consumer arm), back out of the lane.
      reg.consumers.forEach(bpId => {
        if (!visibleBpIds.has(bpId)) return;
        const bpPos = state.positions[bpId];
        if (!bpPos) return;

        const bpH  = getNodeHeight(bpId);
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
    state.outputsVisible.clear();
    state.inputsVisible.clear();
    render();
  }

  // The measured extent of everything drawn, in canvas coordinates. Shared by
  // "Fit to view" and the pan clamp so the two can never disagree about where
  // the graph actually is. Returns null when there is nothing to measure.
  //
  // CACHED (state.contentBounds): the pan clamp needs this on every mousemove —
  // ~400 per second during a drag — and walking the visible tree that often cost
  // more than the clamp saves. It only changes when the layout does, so it is
  // invalidated by layout() and by the edge pass that fills in state.edgeBounds.
  function contentBounds() {
    if (state.contentBounds === null) state.contentBounds = computeContentBounds();
    return state.contentBounds;
  }

  function computeContentBounds() {
    const visible = getVisibleNodes();
    if (visible.length === 0) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    visible.forEach(n => {
      const pos = state.positions[n.id];
      if (!pos) return;
      const h  = getNodeHeight(n.id);
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + NODE_W);
      maxY = Math.max(maxY, pos.y + h);
    });

    for (const [path, pos] of Object.entries(state.artifactPositions)) {
      const h  = getArtifactHeight(path);
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

    return minX === Infinity ? null : { minX, minY, maxX, maxY };
  }

  // Bound the pan to the content (see pan-clamp.js): repeated same-direction
  // dragging used to push the offset past a million pixels, losing the board and
  // handing the compositor a layer nowhere near the screen.
  function clampStatePan() {
    const c = contentBounds();
    if (!c) return;
    const vs = viewportSize();
    const p = clampPan(state.pan, {
      zoom: state.zoom, viewportW: vs.w, viewportH: vs.h, content: c,
    });
    state.pan.x = p.x;
    state.pan.y = p.y;
  }

  function fitToView() {
    state.userTransform = false;
    const bounds = contentBounds();
    if (!bounds) return;
    const { minX, minY, maxX, maxY } = bounds;

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
    clampStatePan();
    scheduleTransform();
  }

  function onMouseup(e) {
    if (state.connecting) { finishConnect(e); return; }
    state.dragging = false;
    viewport.style.cursor = 'grab';
  }

  // ── Connect-to-wire (#362 UI rework Phase C2) ──────────────────────────────
  let tempEdge = null;
  function toCanvas(clientX, clientY) {
    return screenPointToCanvas(clientX, clientY, viewport.getBoundingClientRect(), state.pan, state.zoom);
  }
  // source (#1029): { el, kind } — the exact port element the drag started on and
  // its type ('handoff' ● / 'outcome' yellow / 'artifact' GitHub badge). We capture
  // the port's canvas-space anchor + colour so the preview line starts at, and
  // visually matches, the grabbed port instead of the hard-coded ● centre. Absent
  // (or without an element) → fall back to the source node/actor's ● anchor.
  function startConnect(fromId, outcome, source) {
    state.connecting = { fromId, outcome: outcome || null };
    const color = previewStrokeColor(source && source.kind);
    state.connecting.color = color;
    if (source && source.el) {
      const r = source.el.getBoundingClientRect();
      state.connecting.anchor = portRectAnchor(r, viewport.getBoundingClientRect(), state.pan, state.zoom);
    }
    viewport.style.cursor = 'crosshair';
    tempEdge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tempEdge.setAttribute('stroke', color);
    tempEdge.setAttribute('stroke-width', '2');
    tempEdge.setAttribute('stroke-dasharray', '5 4');
    tempEdge.setAttribute('fill', 'none');
    svgEdges.appendChild(tempEdge);
  }
  function updateTempEdge(clientX, clientY) {
    if (!tempEdge) return;
    const fromId = state.connecting.fromId;
    // Start the preview at the exact port the drag began on when we captured it
    // (#1029), stored in canvas coords so it stays glued to the port under
    // pan/zoom. Fall back to the source node/actor's right-edge vertical centre
    // (the ● port) — the drag source is an agent card or an actor node (#411).
    let x1, y1;
    const anchor = state.connecting.anchor;
    if (anchor) {
      x1 = anchor.x;
      y1 = anchor.y;
    } else {
      const actorPos = state.actorPositions[fromId];
      if (actorPos) {
        x1 = actorPos.x + ACTOR_W;
        y1 = actorPos.y + ACTOR_H / 2;
      } else {
        const pos = state.positions[fromId];
        if (!pos) return;
        x1 = pos.x + NODE_W;
        y1 = pos.y + getNodeHeight(fromId) / 2;
      }
    }
    const p = toCanvas(clientX, clientY);
    const cx = x1 + (p.x - x1) * 0.4;
    const cx2 = p.x - (p.x - x1) * 0.4;
    tempEdge.setAttribute('d', `M ${x1} ${y1} C ${cx} ${y1}, ${cx2} ${p.y}, ${p.x} ${p.y}`);
  }
  function finishConnect(e) {
    const fromId = state.connecting.fromId;
    const outcome = state.connecting.outcome;
    state.connecting = null;
    viewport.style.cursor = 'grab';
    if (tempEdge) { tempEdge.remove(); tempEdge = null; }
    // Only agent cards are valid drop targets — actor nodes are sources only.
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const nodeEl = el && el.closest ? el.closest('.bp-node') : null;
    const toId = nodeEl && nodeEl.dataset ? nodeEl.dataset.id : null;
    if (!toId || toId === fromId) return;
    // A drag from an outcome port pre-fills the outcome's label hand-off (#828);
    // the plain ● port creates any edge type via onConnect.
    if (outcome && onConnectOutcome) onConnectOutcome(fromId, toId, outcome);
    else if (onConnect) onConnect(fromId, toId);
  }

  // Cache the viewport rect so wheel events don't force a layout reflow on every tick.
  // Invalidated by onResize so it stays accurate after layout changes.
  let cachedViewportRect = null;
  function onWheel(e) {
    e.preventDefault();
    if (!cachedViewportRect) cachedViewportRect = viewport.getBoundingClientRect();
    setZoom(state.zoom * (e.deltaY > 0 ? 0.9 : 1.1), e.clientX - cachedViewportRect.left, e.clientY - cachedViewportRect.top);
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
    clampStatePan();
    scheduleTransform();
  }

  // Throttle all DOM writes to one per animation frame — pan and wheel both
  // call this at raw pointer-event rate, which far exceeds display refresh.
  let transformRaf = 0;
  function applyTransform() {
    if (transformRaf) return;
    transformRaf = requestAnimationFrame(() => {
      transformRaf = 0;
      canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
      const pct = Math.round(state.zoom * 100) + '%';
      if (document.activeElement !== zoomInput && zoomInput.value !== pct) zoomInput.value = pct;
    });
  }

  // ─── Utilities ────────────────────────────────────────────────────────

  function esc(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  }


  // ─── Resize observer ─────────────────────────────────────────────────

  function onResize() {
    cachedViewportRect = null;
    state.viewportSize.w = viewport.clientWidth;
    state.viewportSize.h = viewport.clientHeight;
    layout();
    render();
  }

  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(viewport);

  // ─── Toolbar setup ────────────────────────────────────────────────────

  // Tooltip handles for the control-row buttons (#1999). Collected so cleanup()
  // can destroy them: the tooltip span lives in document.body, not in the
  // viewport subtree this module tears down, so an open one would outlive the
  // button it describes.
  const toolBtnTips = [];

  function makeToolBtn(label, fn, title) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:4px 10px;font-size:11px;border-radius:4px;border:1px solid var(--eb-border-default);background:var(--eb-bg-elevated);backdrop-filter:blur(4px);color:var(--eb-text-secondary);cursor:pointer;transition:border-color 0.1s,color 0.1s;';
    b.addEventListener('mouseover', () => { b.style.borderColor = 'var(--eb-border-hover)'; b.style.color = 'var(--eb-text-primary)'; });
    b.addEventListener('mouseout',  () => {
      b.style.borderColor = b._active ? '#3b82f6' : 'var(--eb-border-default)';
      b.style.color       = b._active ? '#3b82f6' : 'var(--eb-text-secondary)';
    });
    b.addEventListener('click', fn);
    // The imperative twin of the React <Tooltip> — same .eb-tooltip look, same
    // placement math, same hover+focus triggers. `b._tip` lets the three
    // toggles relabel their hint when they relabel themselves.
    b._tip = attachTooltip(b, title);
    toolBtnTips.push(b._tip);
    return b;
  }

  function updateArchivedBtn(btn) {
    btn._active            = state.showArchived;
    btn._tip?.setLabel(archivedTitle(state.showArchived));
    btn.style.borderColor  = state.showArchived ? '#3b82f6' : 'var(--eb-border-default)';
    btn.style.color        = state.showArchived ? '#3b82f6' : 'var(--eb-text-secondary)';
    btn.style.background   = state.showArchived ? 'rgba(59,130,246,0.15)' : 'var(--eb-bg-elevated)';
  }

  toolbarEl.appendChild(makeToolBtn('Fit',          () => { state.userTransform = false; fitToView(); }, CANVAS_TITLES.fit));
  toolbarEl.appendChild(makeToolBtn('Expand All',   () => expandAll(), CANVAS_TITLES.expandAll));
  toolbarEl.appendChild(makeToolBtn('Collapse All', () => collapseAll(), CANVAS_TITLES.collapseAll));

  function updateOrientationBtn(btn) {
    const active = state.orientation === 'vertical';
    btn._active            = active;
    btn.textContent        = active ? 'Flow →' : 'Flow ↓';
    // "Flow →" is not a name a screen reader can act on, so the button carries
    // the descriptive hint as its accessible name too (the native title= this
    // replaced was the only thing making it readable at all).
    btn.setAttribute('aria-label', orientationTitle(state.orientation));
    btn._tip?.setLabel(orientationTitle(state.orientation));
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
  }, orientationTitle(state.orientation));
  updateOrientationBtn(orientationBtn);
  toolbarEl.appendChild(orientationBtn);

  const archivedBtn = makeToolBtn('Archived', () => {
    state.showArchived = !state.showArchived;
    localStorage.setItem('ace-graph-show-archived', state.showArchived);
    updateArchivedBtn(archivedBtn);
    recomputeRoots();
    render();
  }, archivedTitle(state.showArchived));
  updateArchivedBtn(archivedBtn);
  toolbarEl.appendChild(archivedBtn);

  // Stages toggle (#362 E): group + band nodes by their manual stage.
  const updateStagesBtn = (btn) => {
    btn.textContent = state.showStages ? 'Stages: on' : 'Stages';
    btn._tip?.setLabel(stagesTitle(state.showStages));
    btn.style.color = state.showStages ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)';
  };
  const stagesBtn = makeToolBtn('Stages', () => {
    state.showStages = !state.showStages;
    localStorage.setItem('flow-graph-show-stages', state.showStages);
    updateStagesBtn(stagesBtn);
    state.userTransform = false;
    render();
  }, stagesTitle(state.showStages));
  updateStagesBtn(stagesBtn);
  toolbarEl.appendChild(stagesBtn);

  // ─── Init ─────────────────────────────────────────────────────────────

  renderLegend();
  setupPanZoom();
  // No auto-fetch — the React wrapper loads /api/flows/graph and calls setData.

  // ─── Public API ─────────────────────────────────────────────────────────

  function cleanup() {
    if (viewFrame) { cancelAnimationFrame(viewFrame); viewFrame = 0; }
    viewport.removeEventListener('mousedown', onMousedown);
    window.removeEventListener('mousemove', onMousemove);
    window.removeEventListener('mouseup', onMouseup);
    viewport.removeEventListener('wheel', onWheel);
    document.removeEventListener('click', onDocClickCloseZoomMenu);
    resizeObserver.disconnect();
    // Before the buttons go: their tooltips are portaled into document.body, so
    // one left open would survive the subtree removal below.
    for (const tip of toolBtnTips) tip.destroy();
    toolBtnTips.length = 0;
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
