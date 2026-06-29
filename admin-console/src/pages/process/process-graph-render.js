// process-graph-render.js — ES module
//
// Custom SVG/DOM renderer for the Process Canvas (#330). No graph/flow library
// (per the epic decision) — it follows the precedent of bp-graph.js: absolutely
// positioned DOM nodes over an SVG edge layer, with transform-based pan/zoom and
// a ResizeObserver. Read-only here; node selection is surfaced via onSelectNode
// so the inspector (#331) and edge modeling (#332) can build on top.
//
//   const g = initProcessGraph(viewportEl, { onSelectNode });
//   g.setData(graph);   // { nodes, edges, gates, labels } from /api/process/graph
//   g.fit();
//   g.cleanup();

import { normalizeGraph, computeRanks, orderWithinRanks } from './process-layout';

const NODE_W = 260;
const H_GAP = 90;   // horizontal gap between rank columns
const V_GAP = 28;   // vertical gap between stacked nodes in a column

// Edge colour per kind. CSS custom properties so light/dark switch for free.
const KIND_COLOR = {
  agent:  'var(--eb-status-info)',
  review: 'var(--eb-status-warning)',
  gate:   'var(--eb-status-error)',
  brake:  '#a855f7',
  timer:  'var(--eb-text-muted)',
  dangling: 'var(--eb-text-muted)',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function initProcessGraph(viewport, { onSelectNode, onConnect, onSelectEdge } = {}) {
  viewport.style.position = 'relative';
  viewport.style.overflow = 'hidden';
  viewport.style.width = '100%';
  viewport.style.height = '100%';
  viewport.style.cursor = 'grab';

  const canvas = document.createElement('div');
  canvas.style.cssText = 'position:absolute;top:0;left:0;transform-origin:0 0;user-select:none;';
  viewport.appendChild(canvas);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.style.cssText = 'position:absolute;top:0;left:0;overflow:visible;pointer-events:none;';
  canvas.appendChild(svg);

  const emptyEl = document.createElement('div');
  emptyEl.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--eb-text-muted);font-size:13px;pointer-events:none;text-align:center;';
  viewport.appendChild(emptyEl);

  const zoomEl = document.createElement('div');
  zoomEl.style.cssText = 'position:absolute;bottom:8px;right:12px;font-size:11px;color:var(--eb-text-muted);pointer-events:none;z-index:20;';
  zoomEl.textContent = '100%';
  viewport.appendChild(zoomEl);

  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'position:absolute;top:12px;left:12px;z-index:20;display:flex;gap:6px;';
  viewport.appendChild(toolbar);
  const fitBtn = mkToolBtn('Fit', () => { state.userTransform = false; fit(); });
  toolbar.appendChild(fitBtn);

  viewport.appendChild(legend());

  const state = {
    nodes: [], edges: [], positions: {},
    pan: { x: 0, y: 0 }, zoom: 1,
    userTransform: false,
    dragging: false, dragStart: { x: 0, y: 0 }, panStart: { x: 0, y: 0 },
    selectedId: null,
    synthetic: new Set(), // ids of synthetic (gate/brake/orphan/deadend) nodes
    connecting: null,     // { fromId } while dragging a new hand-off edge
    editable: true,       // false for the read-only template/blueprint level
    lintsByNode: new Map(), // nodeId -> [lint, ...] (#333)
  };

  // Convert a client point to canvas (graph) coordinates given pan/zoom.
  function toCanvas(clientX, clientY) {
    const r = viewport.getBoundingClientRect();
    return {
      x: (clientX - r.left - state.pan.x) / state.zoom,
      y: (clientY - r.top - state.pan.y) / state.zoom,
    };
  }

  // ── Layered (Sugiyama-ish) layout — pure helpers in process-layout.js ──
  function layout() {
    const { nodes } = state;
    if (!nodes.length) return;
    const rank = computeRanks(nodes, state.edges);
    const { cols, ranksSorted } = orderWithinRanks(nodes, state.edges, rank);

    const pos = {};
    let x = 0;
    for (const r of ranksSorted) {
      let y = 0;
      for (const id of cols[r]) {
        pos[id] = { x, y };
        y += nodeHeight(id) + V_GAP;
      }
      x += NODE_W + H_GAP;
    }
    state.positions = pos;
  }

  function nodeHeight(id) {
    const el = canvas.querySelector(`.pc-node[data-id="${cssEsc(id)}"]`);
    if (el) return el.offsetHeight;
    const n = state.nodes.find(x => x.id === id);
    if (!n) return 60;
    if (n.synthetic) return 36;
    return 56 + (n.triggers ? n.triggers.length : 0) * 22;
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  function render() {
    layout();
    canvas.querySelectorAll('.pc-node').forEach(el => el.remove());

    for (const n of state.nodes) {
      const pos = state.positions[n.id];
      if (!pos) continue;
      const el = n.synthetic ? renderSynthetic(n) : renderAgent(n);
      el.dataset.id = n.id;
      el.style.left = pos.x + 'px';
      el.style.top = pos.y + 'px';
      canvas.appendChild(el);
    }

    // Re-measure real heights and reposition vertically, then draw edges.
    requestAnimationFrame(() => {
      layout();
      canvas.querySelectorAll('.pc-node').forEach(el => {
        const p = state.positions[el.dataset.id];
        if (p) { el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; }
      });
      drawEdges();
      if (!state.userTransform) fit();
    });
  }

  function renderAgent(n) {
    const el = document.createElement('div');
    el.className = 'pc-node';
    const selected = state.selectedId === n.id;
    el.style.cssText = `
      position:absolute;width:${NODE_W}px;box-sizing:border-box;
      background:var(--eb-bg-surface);
      border:${selected ? '2px solid var(--eb-accent-primary)' : '1px solid var(--eb-border-default)'};
      border-radius:var(--eb-radius-lg);padding:10px 12px;
      font-size:12px;color:var(--eb-text-primary);box-shadow:var(--eb-shadow-sm);
      cursor:pointer;`;
    el.addEventListener('mousedown', e => e.stopPropagation());
    el.addEventListener('click', () => { state.selectedId = n.id; onSelectNode?.(n.id); render(); });

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;margin-bottom:6px;';
    const nodeLints = state.lintsByNode.get(n.id) || [];
    const lintBadge = nodeLints.length
      ? (() => {
          const sev = nodeLints.some(l => l.severity === 'error') ? 'var(--eb-status-error)' : 'var(--eb-status-warning)';
          const title = nodeLints.map(l => '• ' + (l.message || l.code)).join('\n').replace(/`/g, '');
          return `<span title="${esc(title)}" style="flex-shrink:0;color:${sev};font-size:12px">⚠ ${nodeLints.length}</span>`;
        })()
      : '';
    head.innerHTML =
      (n.isEntryPoint ? `<span title="DM entry point" style="flex-shrink:0">💬</span>` : '') +
      `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(n.displayName || n.id)}</span>` +
      lintBadge;
    el.appendChild(head);

    const badges = document.createElement('div');
    badges.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;';
    if (n.kind === 'pr-review') {
      badges.appendChild(pill('PR review', 'var(--eb-status-warning)'));
      el.style.borderColor = 'var(--eb-status-warning)';
    } else {
      badges.appendChild(pill(n.role || 'agent', 'var(--eb-text-muted)'));
    }
    if (n.sessionPolicy === 'per-invocation') badges.appendChild(pill('per-invocation', 'var(--eb-status-info)'));
    el.appendChild(badges);

    for (const t of n.triggers || []) {
      el.appendChild(triggerRow(t));
    }

    // Connect port: drag from here to another node to wire a hand-off (#332).
    if (onConnect && state.editable) {
      const port = document.createElement('div');
      port.title = 'Drag to another agent to wire a hand-off';
      port.style.cssText = `position:absolute;right:-7px;top:calc(50% - 7px);width:14px;height:14px;border-radius:50%;background:var(--eb-accent-primary);border:2px solid var(--eb-bg-surface);cursor:crosshair;z-index:2;`;
      port.addEventListener('mousedown', (e) => {
        e.stopPropagation(); e.preventDefault();
        startConnect(n.id);
      });
      el.appendChild(port);
    }
    return el;
  }

  function triggerRow(t) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:var(--eb-text-secondary);padding:2px 0;border-top:1px solid var(--eb-border-default);';
    const icon = t.type === 'cron' ? '⏱' : t.type === 'once' ? '⏲' : t.type === 'http' ? '🔗' : '▾';
    const listen = t.type === 'github-event'
      ? (t.labelFilter ? `🏷 ${esc(t.labelFilter)}` : (t.events || []).map(esc).join(', '))
      : (t.type === 'cron' ? esc(t.cron || 'cron') : t.type);
    const emits = (t.emits || []).length
      ? `<span style="color:var(--eb-status-info)"> → ${(t.emits || []).map(esc).join(', ')}</span>`
      : '';
    row.innerHTML = `<span style="flex-shrink:0">${icon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${listen}${emits}${t.emitsDerived ? ' <span title="heuristic, unconfirmed" style="color:var(--eb-text-muted)">≈</span>' : ''}</span>`;
    return row;
  }

  function renderSynthetic(n) {
    const k = n.syntheticKind;
    const color = k === 'gate' ? 'var(--eb-status-error)'
      : k === 'brake' ? '#a855f7' : 'var(--eb-text-muted)';
    const dashed = k === 'orphan' || k === 'deadend';
    const icon = k === 'gate' ? '🔒' : k === 'brake' ? '🛑' : '⚠';
    const sub = k === 'orphan' ? 'no emitter' : k === 'deadend' ? 'no listener' : 'human only';
    const el = document.createElement('div');
    el.className = 'pc-node';
    el.style.cssText = `
      position:absolute;width:${NODE_W}px;box-sizing:border-box;
      background:var(--eb-bg-app);
      border:1px ${dashed ? 'dashed' : 'solid'} ${color};
      border-radius:var(--eb-radius-full);padding:6px 12px;
      font-size:11px;color:${color};display:flex;align-items:center;gap:6px;`;
    el.addEventListener('mousedown', e => e.stopPropagation());
    el.innerHTML = `<span>${icon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600">${esc(n.displayName || n.id)}</span><span style="color:var(--eb-text-muted);font-size:10px">${sub}</span>`;
    return el;
  }

  // ── Edges ─────────────────────────────────────────────────────────────
  function drawEdges() {
    svg.innerHTML = '';
    let maxX = 100, maxY = 100;
    Object.values(state.positions).forEach(p => {
      maxX = Math.max(maxX, p.x + NODE_W + 120);
      maxY = Math.max(maxY, p.y + 240);
    });
    svg.setAttribute('width', maxX);
    svg.setAttribute('height', maxY);

    for (const e of state.edges) {
      const a = nodeBox(e.from), b = nodeBox(e.to);
      if (!a || !b) continue;
      const color = KIND_COLOR[e.kind] || KIND_COLOR.agent;
      const dashed = e.orphan || e.deadEnd || e.kind === 'timer';

      if (e.from === e.to) { drawSelfLoop(a, color, e.label); continue; }

      // Connect right edge of source to left edge of target (left→right flow).
      let x1 = a.x + a.w, y1 = a.y + a.h / 2;
      let x2 = b.x, y2 = b.y + b.h / 2;
      // Back-edge (target sits left of source): route from left of source to
      // right of target so the arrow reads correctly.
      if (b.x < a.x) { x1 = a.x; x2 = b.x + b.w; }
      const d = drawBezier(x1, y1, x2, y2, color, dashed);
      if (e.label) drawLabel((x1 + x2) / 2, (y1 + y2) / 2, e.label, color);
      if (onSelectEdge && state.editable && isEditableEdge(e)) addEdgeHit(d, e);
    }
  }

  // A wired hand-off (agent/review between two real agents) can be edited/
  // deleted; gates, brakes, timers, orphans and dead-ends cannot.
  function isEditableEdge(e) {
    if (e.orphan || e.deadEnd || e.kind === 'timer') return false;
    if (e.kind === 'gate' || e.kind === 'brake') return false;
    if (e.from === e.to) return false;
    return !state.synthetic.has(e.from) && !state.synthetic.has(e.to);
  }
  function addEdgeHit(d, e) {
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', '14');
    hit.setAttribute('fill', 'none');
    hit.style.cursor = 'pointer';
    hit.style.pointerEvents = 'stroke';
    hit.addEventListener('mousedown', (ev) => ev.stopPropagation());
    hit.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onSelectEdge({ from: e.from, to: e.to, label: e.label, kind: e.kind, triggerId: e.triggerId });
    });
    svg.appendChild(hit);
  }

  function nodeBox(id) {
    const pos = state.positions[id];
    if (!pos) return null;
    const el = canvas.querySelector(`.pc-node[data-id="${cssEsc(id)}"]`);
    return { x: pos.x, y: pos.y, w: NODE_W, h: el ? el.offsetHeight : nodeHeight(id) };
  }

  function drawBezier(x1, y1, x2, y2, stroke, dashed) {
    // Horizontal cubic; control points pull along the signed span so the end
    // tangent (and thus the arrowhead) reads correctly for forward and back edges.
    const cx1 = x1 + (x2 - x1) * 0.4;
    const cx2 = x2 - (x2 - x1) * 0.4;
    const d = `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`;
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('stroke', stroke);
    p.setAttribute('stroke-width', '1.5');
    p.setAttribute('fill', 'none');
    if (dashed) p.setAttribute('stroke-dasharray', '5 4');
    p.setAttribute('opacity', '0.8');
    svg.appendChild(p);
    // Arrowhead aimed along the end tangent; horizontal flow → 0 (→) or π (←).
    const theta = Math.atan2(0, x2 - cx2);
    const a = 0.45, s = 7;
    const tri = document.createElementNS(SVG_NS, 'polygon');
    tri.setAttribute('points',
      `${x2},${y2} ${x2 - s * Math.cos(theta - a)},${y2 - s * Math.sin(theta - a)} ${x2 - s * Math.cos(theta + a)},${y2 - s * Math.sin(theta + a)}`);
    tri.setAttribute('fill', stroke);
    tri.setAttribute('opacity', '0.8');
    svg.appendChild(tri);
    return d;
  }

  function drawSelfLoop(box, color, label) {
    const x = box.x + box.w - 24, y = box.y;
    const d = `M ${x} ${y} c 0 -22, 40 -22, 40 0`;
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('stroke', color);
    p.setAttribute('stroke-width', '1.5');
    p.setAttribute('stroke-dasharray', '4 3');
    p.setAttribute('fill', 'none');
    svg.appendChild(p);
    if (label) drawLabel(x + 20, y - 20, label, color);
  }

  function drawLabel(cx, cy, text, color) {
    const g = document.createElementNS(SVG_NS, 'g');
    const t = document.createElementNS(SVG_NS, 'text');
    t.textContent = text;
    t.setAttribute('x', cx); t.setAttribute('y', cy);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'middle');
    t.setAttribute('font-size', '10');
    t.setAttribute('fill', color);
    // Background rect for legibility over edges.
    const rect = document.createElementNS(SVG_NS, 'rect');
    const w = Math.max(20, text.length * 5.6 + 8);
    rect.setAttribute('x', cx - w / 2); rect.setAttribute('y', cy - 8);
    rect.setAttribute('width', w); rect.setAttribute('height', 16);
    rect.setAttribute('rx', 3);
    rect.setAttribute('fill', 'var(--eb-bg-app)');
    rect.setAttribute('opacity', '0.9');
    g.appendChild(rect); g.appendChild(t);
    svg.appendChild(g);
  }

  // ── Pan / zoom / fit ──────────────────────────────────────────────────
  function applyTransform() {
    canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
    zoomEl.textContent = Math.round(state.zoom * 100) + '%';
  }
  function onMousedown(e) {
    if (e.button !== 0) return;
    state.dragging = true; state.userTransform = true;
    state.dragStart = { x: e.clientX, y: e.clientY };
    state.panStart = { ...state.pan };
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
    state.dragging = false; viewport.style.cursor = 'grab';
  }

  // ── Connect-to-wire (#332) ────────────────────────────────────────────
  let tempEdge = null;
  function startConnect(fromId) {
    state.connecting = { fromId };
    viewport.style.cursor = 'crosshair';
    tempEdge = document.createElementNS(SVG_NS, 'path');
    tempEdge.setAttribute('stroke', 'var(--eb-accent-primary)');
    tempEdge.setAttribute('stroke-width', '2');
    tempEdge.setAttribute('stroke-dasharray', '5 4');
    tempEdge.setAttribute('fill', 'none');
    svg.appendChild(tempEdge);
  }
  function updateTempEdge(clientX, clientY) {
    if (!tempEdge) return;
    const src = nodeBox(state.connecting.fromId);
    if (!src) return;
    const x1 = src.x + src.w, y1 = src.y + src.h / 2;
    const p = toCanvas(clientX, clientY);
    const cx = x1 + (p.x - x1) * 0.4, cx2 = p.x - (p.x - x1) * 0.4;
    tempEdge.setAttribute('d', `M ${x1} ${y1} C ${cx} ${y1}, ${cx2} ${p.y}, ${p.x} ${p.y}`);
  }
  function finishConnect(e) {
    const fromId = state.connecting.fromId;
    state.connecting = null;
    viewport.style.cursor = 'grab';
    if (tempEdge) { tempEdge.remove(); tempEdge = null; }
    // Which node is under the cursor?
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const nodeEl = el && el.closest ? el.closest('.pc-node') : null;
    const toId = nodeEl && nodeEl.dataset ? nodeEl.dataset.id : null;
    if (!toId || toId === fromId) return;
    if (state.synthetic.has(toId)) return; // can't wire into a gate/brake/etc.
    onConnect?.(fromId, toId);
  }
  function onWheel(e) {
    e.preventDefault();
    state.userTransform = true;
    const old = state.zoom;
    state.zoom = Math.max(0.2, Math.min(2.5, state.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    const r = viewport.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    state.pan.x = mx - (mx - state.pan.x) * (state.zoom / old);
    state.pan.y = my - (my - state.pan.y) * (state.zoom / old);
    applyTransform();
  }
  function fit() {
    if (!state.nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of state.nodes) {
      const p = state.positions[n.id]; if (!p) continue;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + nodeHeight(n.id));
    }
    if (!isFinite(minX)) return;
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    const cw = maxX - minX + 80, ch = maxY - minY + 80;
    state.zoom = Math.max(0.2, Math.min(vw / cw, vh / ch, 1.3));
    state.pan.x = (vw - cw * state.zoom) / 2 - minX * state.zoom + 40 * state.zoom;
    state.pan.y = (vh - ch * state.zoom) / 2 - minY * state.zoom + 40 * state.zoom;
    applyTransform();
  }

  viewport.addEventListener('mousedown', onMousedown);
  window.addEventListener('mousemove', onMousemove);
  window.addEventListener('mouseup', onMouseup);
  viewport.addEventListener('wheel', onWheel, { passive: false });
  const ro = new ResizeObserver(() => { if (!state.userTransform) fit(); });
  ro.observe(viewport);

  function setData(graph) {
    const norm = normalizeGraph(graph || { nodes: [], edges: [] });
    state.nodes = norm.nodes;
    state.edges = norm.edges;
    state.synthetic = new Set(norm.nodes.filter(n => n.synthetic).map(n => n.id));
    state.lintsByNode = new Map();
    for (const l of (graph && graph.lints) || []) {
      if (!l.nodeId) continue;
      if (!state.lintsByNode.has(l.nodeId)) state.lintsByNode.set(l.nodeId, []);
      state.lintsByNode.get(l.nodeId).push(l);
    }
    state.userTransform = false;
    const has = state.nodes.length > 0;
    emptyEl.style.display = has ? 'none' : 'block';
    emptyEl.textContent = has ? '' : 'No agents with triggers to display.';
    svg.innerHTML = '';
    if (has) render(); else canvas.querySelectorAll('.pc-node').forEach(el => el.remove());
  }

  return {
    setData,
    fit: () => { state.userTransform = false; fit(); },
    setSelected: (id) => { state.selectedId = id; render(); },
    setEditable: (v) => { if (state.editable !== v) { state.editable = v; render(); } },
    cleanup() {
      viewport.removeEventListener('mousedown', onMousedown);
      window.removeEventListener('mousemove', onMousemove);
      window.removeEventListener('mouseup', onMouseup);
      viewport.removeEventListener('wheel', onWheel);
      ro.disconnect();
      while (viewport.firstChild) viewport.removeChild(viewport.firstChild);
    },
  };
}

// ── small helpers ────────────────────────────────────────────────────────
function pill(text, color) {
  const s = document.createElement('span');
  s.style.cssText = `display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;border:1px solid ${color}55;color:${color};background:${color}1a;`;
  s.textContent = text;
  return s;
}
function mkToolBtn(label, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'padding:4px 10px;font-size:11px;border-radius:4px;border:1px solid var(--eb-border-default);background:var(--eb-bg-elevated);color:var(--eb-text-secondary);cursor:pointer;';
  b.addEventListener('click', fn);
  return b;
}
function legend() {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;bottom:14px;left:50%;transform:translateX(-50%);background:var(--eb-bg-elevated);border:1px solid var(--eb-border-default);border-radius:8px;padding:6px 12px;display:flex;gap:12px;align-items:center;z-index:20;pointer-events:none;font-size:11px;white-space:nowrap;';
  const sw = (c, label, dash) =>
    `<span style="display:flex;align-items:center;gap:4px"><span style="width:14px;height:0;border-top:2px ${dash ? 'dashed' : 'solid'} ${c};display:inline-block"></span><span style="color:var(--eb-text-secondary)">${label}</span></span>`;
  el.innerHTML =
    sw('var(--eb-status-info)', 'hand-off') +
    sw('var(--eb-status-warning)', 'review') +
    sw('var(--eb-status-error)', 'human gate') +
    sw('#a855f7', 'brake') +
    sw('var(--eb-text-muted)', 'timer / unwired', true);
  return el;
}
function esc(str) {
  const el = document.createElement('span');
  el.textContent = str == null ? '' : String(str);
  return el.innerHTML;
}
function cssEsc(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}
