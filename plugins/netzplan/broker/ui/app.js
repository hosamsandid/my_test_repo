/* Project Plan — graph canvas controller (plugin #3, epic #1554).
 *
 * A green-field rewrite of the board UI as a single visual node-graph canvas,
 * in the spirit of the console's Flow editor but dependency-free:
 *
 *   • ONE `kind:'graph'` panel is "the plan". Milestones are node cards, phases
 *     are horizontal bands, a directed edge means "feeds / depends on" (arrow at
 *     the downstream node). Layout is 100% automatic (graph-layout.js) — the
 *     user never positions a node.
 *   • No Edit / View mode: every interaction is always on. Drag the Milestone
 *     chip onto a phase to add a node; drag a node's ● port onto another to
 *     connect; click a node to edit label/sub/owner/status/phase or delete;
 *     click an edge to delete; rename/recolor/reorder/delete phases in the band
 *     gutter; manage owners in the top bar.
 *   • Every change goes through POST /api/mutate then re-renders from the server
 *     document (never optimistic) — plan-doc.js stays the single source of truth,
 *     and a second browser profile sees the same board.
 *
 * The server contract is unchanged (server.js handleUi): GET /api/board, POST
 * /api/mutate {op}, GET /api/export. Human writes are role-gated by the proxy,
 * not autonomy-gated, so a logged-in team member can always edit. Autonomy (the
 * agent ladder) stays on the Team-Admin /admin page. */
(function () {
  'use strict';

  var base = location.pathname.replace(/\/(index\.html|admin\.html)?$/, '/');
  function api(p) { return base + 'api/' + p; }

  // ── status model (drives node colour) ───────────────────────────────────────
  var STATUSES = ['open', 'in-progress', 'done', 'blocked'];
  var STATUS_COLOR = {
    'open': 'var(--st-open)',
    'in-progress': 'var(--st-progress)',
    'done': 'var(--st-done)',
    'blocked': 'var(--st-blocked)',
  };
  var STATUS_LABEL = {
    'open': 'Open', 'in-progress': 'In progress', 'done': 'Done', 'blocked': 'Blocked',
  };
  function normStatus(s) { return STATUSES.indexOf(s) >= 0 ? s : 'open'; }
  function nextStatus(s) { return STATUSES[(STATUSES.indexOf(normStatus(s)) + 1) % STATUSES.length]; }

  // ── state ────────────────────────────────────────────────────────────────────
  var doc = null;
  var L = null;                       // last computed layout
  var view = { zoom: 1, panX: 0, panY: 0 };
  var selection = null;               // { kind:'node'|'edge', id }
  var focusLabel = false;             // focus the label input on next popover render
  var connecting = null;              // { fromId, x, y } during a ●-port drag
  var didInitialFit = false;

  // ── tiny DOM helper ──────────────────────────────────────────────────────────
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'style') e.style.cssText = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (k) {
      if (k == null || k === false) return;
      e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    });
    return e;
  }
  function $(id) { return document.getElementById(id); }
  var errTimer = null;
  function setErr(msg) {
    var e = $('err');
    if (!msg) { e.classList.add('hidden'); return; }
    e.textContent = msg; e.classList.remove('hidden');
    clearTimeout(errTimer); errTimer = setTimeout(function () { e.classList.add('hidden'); }, 5000);
  }

  // ── transport ────────────────────────────────────────────────────────────────
  function req(path, method, body) {
    return fetch(api(path), {
      method: method || 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (r.ok) return r.json();
      return r.json().then(
        function (j) { throw new Error(j.error || ('HTTP ' + r.status)); },
        function () { throw new Error('HTTP ' + r.status); },
      );
    });
  }
  // postOp resolves to the new document without rendering, so callers can chain
  // two ops (e.g. lazily create the panel, then add a node) and render once.
  function postOp(op) { return req('mutate', 'POST', { op: op }).then(function (d) { doc = d; return d; }); }
  function mutate(op) { setErr(''); return postOp(op).then(render).catch(function (e) { setErr('Could not save: ' + e.message); }); }
  function load() {
    setErr('');
    return req('board').then(function (d) { doc = d; render(); if (!didInitialFit) { fit(); didInitialFit = true; } })
      .catch(function (e) { setErr('Could not load the board: ' + e.message); });
  }

  // ── the graph panel (one `kind:'graph'` panel = "the plan") ──────────────────
  function graphPanel() { return (doc && doc.panels || []).filter(function (p) { return p.kind === 'graph'; })[0] || null; }

  // Resolve the graph panel, lazily creating it (with a first phase so there is
  // somewhere to drop) on the first write — never on GET. Resolves to the panel.
  function ensurePanel() {
    var p = graphPanel();
    if (p) return Promise.resolve(p);
    return postOp({ type: 'add-panel', kind: 'graph', title: 'Plan' }).then(function () {
      return postOp({ type: 'add-band', panelId: graphPanel().id, name: 'Phase 1' });
    }).then(function () { return graphPanel(); });
  }

  // ── owners ─────────────────────────────────────────────────────────────────
  function ownerById(id) { return (doc.owners || []).filter(function (o) { return o.id === id; })[0] || null; }

  function renderOwners() {
    var bar = $('owners');
    bar.textContent = '';
    bar.appendChild(el('span', { class: 'cap' }, ['Owners']));
    (doc.owners || []).forEach(function (o) {
      var swatch = el('span', { class: 'swatch', style: 'background:' + (o.color || '#94a3b8') });
      var picker = el('input', { type: 'color', value: toHex(o.color) });
      picker.addEventListener('input', function () { mutate({ type: 'rename-owner', id: o.id, color: picker.value }); });
      swatch.appendChild(picker);
      var name = el('span', { class: 'oname', contenteditable: 'true', spellcheck: 'false' }, [o.name || o.id]);
      commitOnBlur(name, o.name || '', function (v) { mutate({ type: 'rename-owner', id: o.id, name: v }); });
      bar.appendChild(el('span', { class: 'owner-pill' }, [
        swatch, name,
        el('button', { class: 'x', title: 'Remove owner', onclick: function () { mutate({ type: 'delete-owner', id: o.id }); } }, ['✕']),
      ]));
    });
    bar.appendChild(el('button', {
      class: 'btn mini', title: 'Add an owner',
      onclick: function () { mutate({ type: 'add-owner', name: 'New owner' }); },
    }, ['+ Owner']));
  }

  // ── canvas render ────────────────────────────────────────────────────────────
  function render() {
    if (!doc) return;
    $('name').textContent = doc.name || 'Project Plan';
    $('sub').textContent = 'Agent autonomy level ' + ((doc.settings && doc.settings.agentAutonomy) || 0);
    renderOwners();
    renderLegend();

    var canvas = $('canvas');
    canvas.textContent = '';
    var panel = graphPanel();
    // Show the "drag a milestone" overlay only when there is nothing to drop
    // onto yet (no panel, or a blank panel with no phases and no milestones);
    // once phase bands exist they are the drop targets and guide the eye.
    var empty = !panel || (!(panel.nodes || []).length && !(panel.bands || []).length);
    $('emptyState').classList.toggle('hidden', !empty);

    if (!panel) { L = null; closePopover(); applyTransform(); return; }

    L = PlanLayout.compute(panel);
    canvas.style.width = L.width + 'px';
    canvas.style.height = L.height + 'px';

    // bands (behind everything)
    L.bands.forEach(function (b) { canvas.appendChild(bandEl(panel, b)); });
    // edges (svg over bands, under nodes)
    canvas.appendChild(edgeLayer(panel, L));
    // nodes
    L.nodes.forEach(function (p) { canvas.appendChild(nodeEl(panel, p)); });

    applyTransform();
    renderPopover();
  }

  function bandEl(panel, b) {
    var wrap = el('div', {
      class: 'band' + (b.synthetic ? ' synthetic' : ''),
      'data-band-id': b.id,
      style: 'top:' + b.top + 'px; height:' + b.height + 'px; width:' + L.width + 'px;',
    });
    wrap.appendChild(el('div', { class: 'band-tint', style: 'background:' + (b.color || '#94a3b8') }));
    wrap.appendChild(el('div', { class: 'band-accent', style: 'background:' + (b.color || '#94a3b8') }));

    var gutter = el('div', { class: 'band-gutter' });
    if (b.synthetic) {
      gutter.appendChild(el('div', { class: 'band-name', style: 'color:var(--ink-faint)' }, [b.name]));
      gutter.appendChild(el('div', { class: 'band-ctrls' }, [
        el('span', { style: 'font-size:11px;color:var(--ink-faint)' }, ['unbanded milestones']),
      ]));
    } else {
      var name = el('div', { class: 'band-name', contenteditable: 'true', spellcheck: 'false' }, [b.name || '(phase)']);
      commitOnBlur(name, b.name || '', function (v) { mutate({ type: 'update-band', panelId: panel.id, id: b.id, name: v }); });
      gutter.appendChild(name);

      var swatch = el('span', { class: 'swatch', style: 'background:' + (b.color || '#94a3b8') });
      var picker = el('input', { type: 'color', value: toHex(b.color) });
      picker.addEventListener('input', function () { mutate({ type: 'update-band', panelId: panel.id, id: b.id, color: picker.value }); });
      swatch.appendChild(picker);

      gutter.appendChild(el('div', { class: 'band-ctrls' }, [
        swatch,
        el('button', { class: 'btn mini ghost', title: 'Move phase up', onclick: function () { reorderBand(panel, b.id, -1); } }, ['▲']),
        el('button', { class: 'btn mini ghost', title: 'Move phase down', onclick: function () { reorderBand(panel, b.id, 1); } }, ['▼']),
        el('button', { class: 'btn mini ghost danger', title: 'Delete phase (its milestones stay, unbanded)', onclick: function () {
          if (window.confirm('Delete this phase? Its milestones stay on the board, unbanded.')) mutate({ type: 'delete-band', panelId: panel.id, id: b.id });
        } }, ['✕']),
      ]));
    }
    wrap.appendChild(gutter);
    return wrap;
  }

  function reorderBand(panel, id, dir) {
    var order = (panel.bands || []).slice().sort(function (a, c) { return (a.order || 0) - (c.order || 0); }).map(function (x) { return x.id; });
    var i = order.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    var t = order[i]; order[i] = order[j]; order[j] = t;
    mutate({ type: 'reorder-bands', panelId: panel.id, order: order });
  }

  function nodeEl(panel, p) {
    var n = p.node;
    var status = normStatus(n.status);
    var owner = ownerById(n.ownerId);
    var node = el('div', {
      class: 'node' + (selection && selection.kind === 'node' && selection.id === n.id ? ' selected' : ''),
      'data-node-id': n.id,
      style: 'left:' + p.x + 'px; top:' + p.y + 'px; width:' + p.w + 'px; height:' + p.h + 'px;',
    });
    node.appendChild(el('div', { class: 'accent', style: 'background:' + STATUS_COLOR[status] }));

    var foot = el('div', { class: 'nfoot' }, [
      owner ? el('span', { class: 'ochip', style: ownerChipStyle(owner), title: 'Owner: ' + (owner.name || owner.id) }, [owner.name || owner.id]) : null,
      el('span', { class: 'sdot', style: 'background:' + STATUS_COLOR[status] }),
      el('span', { class: 'sname' }, [STATUS_LABEL[status]]),
    ]);
    node.appendChild(el('div', { class: 'nbody' }, [
      el('div', { class: 'nlabel' }, [n.label || '(untitled)']),
      n.sub ? el('div', { class: 'nsub', title: n.sub }, [n.sub]) : null,
      foot,
    ]));

    // connect port
    var port = el('div', { class: 'port', title: 'Drag to connect to another milestone' });
    port.addEventListener('mousedown', function (ev) { ev.stopPropagation(); ev.preventDefault(); startConnect(n.id, ev); });
    node.appendChild(port);

    // click → inspect / edit
    node.addEventListener('click', function (ev) { ev.stopPropagation(); selectNode(n.id); });
    // hover → dim non-neighbours (direct DOM, no re-render)
    node.addEventListener('mouseenter', function () { highlightNeighbours(panel, n.id); });
    node.addEventListener('mouseleave', clearHighlight);
    return node;
  }

  function ownerChipStyle(o) {
    var c = o.color || '#64748b';
    return 'background:' + hexA(c, 0.16) + '; color:' + c + '; border:1px solid ' + hexA(c, 0.35) + ';';
  }

  function highlightNeighbours(panel, nodeId) {
    var keep = {}; keep[nodeId] = true;
    (panel.edges || []).forEach(function (e) { if (e.from === nodeId) keep[e.to] = true; if (e.to === nodeId) keep[e.from] = true; });
    document.querySelectorAll('.node').forEach(function (nd) {
      var id = nd.getAttribute('data-node-id');
      nd.classList.toggle('dim', !keep[id]);
      nd.classList.toggle('hi', !!keep[id] && id !== nodeId);
    });
  }
  function clearHighlight() {
    document.querySelectorAll('.node').forEach(function (nd) { nd.classList.remove('dim', 'hi'); });
  }

  // ── edges (svg) ────────────────────────────────────────────────────────────
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function edgePath(e) {
    var dx = Math.max(42, Math.abs(e.x2 - e.x1) / 2);
    if (e.backward) dx = Math.max(60, Math.abs(e.x2 - e.x1) / 2 + 40);
    return 'M ' + e.x1 + ' ' + e.y1 + ' C ' + (e.x1 + dx) + ' ' + e.y1 + ', ' + (e.x2 - dx) + ' ' + e.y2 + ', ' + e.x2 + ' ' + e.y2;
  }
  function edgeLayer(panel, layout) {
    var s = svg('svg', { class: 'edge-layer', width: layout.width, height: layout.height });
    var defs = svg('defs');
    var marker = svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    marker.appendChild(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--line-strong)' }));
    var markerSel = svg('marker', { id: 'arrow-sel', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    markerSel.appendChild(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--accent)' }));
    defs.appendChild(marker); defs.appendChild(markerSel);
    s.appendChild(defs);

    layout.edges.forEach(function (e) {
      var d = edgePath(e);
      var sel = selection && selection.kind === 'edge' && selection.id === e.id;
      var vis = svg('path', { class: 'edge-path' + (sel ? ' sel' : ''), d: d, 'marker-end': sel ? 'url(#arrow-sel)' : 'url(#arrow)' });
      var hit = svg('path', { class: 'edge-hit', d: d });
      hit.addEventListener('click', function (ev) { ev.stopPropagation(); selectEdge(e.id); });
      s.appendChild(vis); s.appendChild(hit);
    });
    return s;
  }

  // ── selection + popover ──────────────────────────────────────────────────────
  function selectNode(id) { selection = { kind: 'node', id: id }; focusLabel = false; render(); }
  function selectEdge(id) { selection = { kind: 'edge', id: id }; render(); }
  function clearSelection() { if (selection) { selection = null; closePopover(); render(); } }

  var popEl = null;
  function closePopover() { if (popEl) { popEl.remove(); popEl = null; } }

  // screen coordinate of a canvas point (canvas is translate+scale transformed)
  function toScreen(cx, cy) {
    var r = $('viewport').getBoundingClientRect();
    return { x: r.left + view.panX + cx * view.zoom, y: r.top + view.panY + cy * view.zoom };
  }

  function renderPopover() {
    closePopover();
    if (!selection || !L) return;
    if (selection.kind === 'node') {
      var p = L.nodes.filter(function (x) { return x.id === selection.id; })[0];
      if (!p) { selection = null; return; }
      popEl = nodePopover(p);
    } else if (selection.kind === 'edge') {
      var e = L.edges.filter(function (x) { return x.id === selection.id; })[0];
      if (!e) { selection = null; return; }
      popEl = edgePopover(e);
    }
    if (popEl) document.body.appendChild(popEl);
    positionPopover();
    if (popEl && focusLabel) {
      var inp = popEl.querySelector('input[data-label]');
      if (inp) { inp.focus(); inp.select(); }
      focusLabel = false;
    }
  }

  function positionPopover() {
    if (!popEl || !selection || !L) return;
    var anchor;
    if (selection.kind === 'node') {
      var p = L.nodes.filter(function (x) { return x.id === selection.id; })[0];
      if (!p) return;
      anchor = toScreen(p.x + p.w + 6, p.y);
    } else {
      var e = L.edges.filter(function (x) { return x.id === selection.id; })[0];
      if (!e) return;
      anchor = toScreen((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2);
    }
    var vw = window.innerWidth, vh = window.innerHeight;
    var pw = popEl.offsetWidth || 240, ph = popEl.offsetHeight || 200;
    var x = Math.min(anchor.x, vw - pw - 12);
    var y = Math.min(anchor.y, vh - ph - 12);
    popEl.style.left = Math.max(8, x) + 'px';
    popEl.style.top = Math.max(8, y) + 'px';
  }

  function pfield(labelText, controlEl) {
    return el('div', { class: 'pfield' }, [el('label', { class: 'plab' }, [labelText]), controlEl]);
  }

  function nodePopover(p) {
    var panel = graphPanel();
    var n = p.node;
    var pop = el('div', { class: 'popover' });
    pop.addEventListener('click', function (ev) { ev.stopPropagation(); });
    pop.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });

    var label = el('input', { type: 'text', value: n.label || '', placeholder: 'Milestone', 'data-label': '1' });
    commitOnEnterBlur(label, n.label || '', function (v) { mutate({ type: 'update-node', panelId: panel.id, id: n.id, label: v }); });
    pop.appendChild(pfield('Milestone', label));

    var sub = el('input', { type: 'text', value: n.sub || '', placeholder: 'Detail (optional)' });
    commitOnEnterBlur(sub, n.sub || '', function (v) { mutate({ type: 'update-node', panelId: panel.id, id: n.id, sub: v }); });
    pop.appendChild(pfield('Detail', sub));

    // owner + status row
    var ownerSel = el('select');
    ownerSel.appendChild(el('option', { value: '' }, ['— No owner —']));
    (doc.owners || []).forEach(function (o) {
      var opt = el('option', { value: o.id }, [o.name || o.id]);
      if (o.id === n.ownerId) opt.setAttribute('selected', 'selected');
      ownerSel.appendChild(opt);
    });
    ownerSel.addEventListener('change', function () { mutate({ type: 'update-node', panelId: panel.id, id: n.id, ownerId: ownerSel.value || null }); });

    var status = normStatus(n.status);
    var statusBtn = el('button', { class: 'status-btn', title: 'Click to cycle status' }, [
      el('span', { class: 'sdot', style: 'background:' + STATUS_COLOR[status] }),
      STATUS_LABEL[status],
    ]);
    statusBtn.addEventListener('click', function () { mutate({ type: 'update-node', panelId: panel.id, id: n.id, status: nextStatus(n.status) }); });

    pop.appendChild(pfield('Owner', ownerSel));
    pop.appendChild(pfield('Status', statusBtn));

    // phase (band)
    var bandSel = el('select');
    bandSel.appendChild(el('option', { value: '' }, ['— Unassigned —']));
    (panel.bands || []).slice().sort(function (a, c) { return (a.order || 0) - (c.order || 0); }).forEach(function (b) {
      var opt = el('option', { value: b.id }, [b.name || b.id]);
      if (b.id === n.bandId) opt.setAttribute('selected', 'selected');
      bandSel.appendChild(opt);
    });
    bandSel.addEventListener('change', function () { mutate({ type: 'update-node', panelId: panel.id, id: n.id, bandId: bandSel.value || null }); });
    pop.appendChild(pfield('Phase', bandSel));

    pop.appendChild(el('div', { class: 'pactions' }, [
      el('button', { class: 'btn mini danger', onclick: function () { mutate({ type: 'delete-node', panelId: panel.id, id: n.id }); selection = null; } }, ['Delete milestone']),
      el('button', { class: 'btn mini ghost', onclick: clearSelection }, ['Close']),
    ]));
    return pop;
  }

  function edgePopover(e) {
    var panel = graphPanel();
    var fromN = (panel.nodes || []).filter(function (x) { return x.id === e.from; })[0];
    var toN = (panel.nodes || []).filter(function (x) { return x.id === e.to; })[0];
    var pop = el('div', { class: 'popover' });
    pop.addEventListener('click', function (ev) { ev.stopPropagation(); });
    pop.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    pop.appendChild(el('div', { style: 'font-size:12.5px' }, [
      el('b', null, [(fromN && fromN.label) || e.from]), ' feeds ', el('b', null, [(toN && toN.label) || e.to]),
    ]));
    pop.appendChild(el('div', { class: 'pactions' }, [
      el('button', { class: 'btn mini danger', onclick: function () { mutate({ type: 'delete-edge', panelId: panel.id, id: e.id }); selection = null; } }, ['Delete dependency']),
      el('button', { class: 'btn mini ghost', onclick: clearSelection }, ['Close']),
    ]));
    return pop;
  }

  // ── connect (drag a node's ● port onto another node) ─────────────────────────
  var overlay = null;
  function startConnect(fromId, ev) {
    clearSelection();
    var r = ev.target.getBoundingClientRect();
    connecting = { fromId: fromId, sx: r.left + r.width / 2, sy: r.top + r.height / 2, x: ev.clientX, y: ev.clientY };
    overlay = el('svg', { class: 'connect-overlay' });
    overlay.appendChild(svg('path', { d: '' }));
    document.body.appendChild(overlay);
    drawConnect();
    document.addEventListener('mousemove', onConnectMove, true);
    document.addEventListener('mouseup', onConnectUp, true);
  }
  function drawConnect() {
    if (!overlay || !connecting) return;
    var c = connecting;
    var dx = Math.max(42, Math.abs(c.x - c.sx) / 2);
    overlay.querySelector('path').setAttribute('d', 'M ' + c.sx + ' ' + c.sy + ' C ' + (c.sx + dx) + ' ' + c.sy + ', ' + (c.x - dx) + ' ' + c.y + ', ' + c.x + ' ' + c.y);
  }
  function onConnectMove(ev) { if (!connecting) return; connecting.x = ev.clientX; connecting.y = ev.clientY; drawConnect(); }
  function onConnectUp(ev) {
    document.removeEventListener('mousemove', onConnectMove, true);
    document.removeEventListener('mouseup', onConnectUp, true);
    if (overlay) { overlay.remove(); overlay = null; }
    var c = connecting; connecting = null;
    if (!c) return;
    var target = document.elementFromPoint(ev.clientX, ev.clientY);
    var nodeDiv = target && target.closest ? target.closest('.node') : null;
    if (!nodeDiv) return;
    var toId = nodeDiv.getAttribute('data-node-id');
    if (!toId || toId === c.fromId) return;
    var panel = graphPanel();
    if (!panel) return;
    mutate({ type: 'add-edge', panelId: panel.id, from: c.fromId, to: toId, edgeType: 'depends' });
  }

  // ── palette drop (add a milestone onto a phase) ──────────────────────────────
  function bandIdAtClient(cx, cy) {
    var els = document.elementsFromPoint ? document.elementsFromPoint(cx, cy) : [document.elementFromPoint(cx, cy)];
    for (var i = 0; i < els.length; i++) {
      var b = els[i] && els[i].closest ? els[i].closest('[data-band-id]') : null;
      if (b) return b.getAttribute('data-band-id');
    }
    // fallback: hit-test by canvas-y against the last layout
    if (L) {
      var r = $('viewport').getBoundingClientRect();
      var canvasY = (cy - r.top - view.panY) / view.zoom;
      for (var j = 0; j < L.bands.length; j++) {
        var bd = L.bands[j];
        if (canvasY >= bd.top && canvasY <= bd.top + bd.height) return bd.id;
      }
      if (L.bands.length) return L.bands[0].id;
    }
    return null;
  }

  function addMilestoneAt(cx, cy) {
    setErr('');
    ensurePanel().then(function (panel) {
      // hit-test the phase under the cursor; on the very first drop the band was
      // just created and isn't laid out yet, so fall back to the first phase.
      var bandId = bandIdAtClient(cx, cy) || (panel.bands && panel.bands[0] && panel.bands[0].id);
      var before = {};
      (panel.nodes || []).forEach(function (n) { before[n.id] = true; });
      var op = { type: 'add-node', panelId: panel.id, label: 'New milestone', status: 'open' };
      if (bandId) op.bandId = bandId;
      return postOp(op).then(function () {
        var gp = graphPanel();
        var fresh = (gp.nodes || []).filter(function (n) { return !before[n.id]; })[0] || (gp.nodes || [])[gp.nodes.length - 1];
        if (fresh) { selection = { kind: 'node', id: fresh.id }; focusLabel = true; }
        render();
      });
    }).catch(function (e) { setErr('Could not add a milestone: ' + e.message); });
  }

  // ── pan + zoom ────────────────────────────────────────────────────────────
  function applyTransform() {
    $('canvas').style.transform = 'translate(' + view.panX + 'px,' + view.panY + 'px) scale(' + view.zoom + ')';
    $('zoomPct').textContent = Math.round(view.zoom * 100) + '%';
    positionPopover();
  }
  function clampZoom(z) { return Math.max(0.25, Math.min(2.4, z)); }
  function zoomAt(cx, cy, factor) {
    var r = $('viewport').getBoundingClientRect();
    var mx = cx - r.left, my = cy - r.top;
    var nz = clampZoom(view.zoom * factor);
    view.panX = mx - ((mx - view.panX) / view.zoom) * nz;
    view.panY = my - ((my - view.panY) / view.zoom) * nz;
    view.zoom = nz;
    applyTransform();
  }
  function fit() {
    if (!L) { view = { zoom: 1, panX: 0, panY: 0 }; applyTransform(); return; }
    var vp = $('viewport').getBoundingClientRect();
    var margin = 40;
    var zx = (vp.width - margin) / L.width;
    var zy = (vp.height - margin) / L.height;
    var z = clampZoom(Math.min(zx, zy, 1));
    view.zoom = z;
    view.panX = Math.max(margin / 2, (vp.width - L.width * z) / 2);
    view.panY = margin / 2;
    applyTransform();
  }

  function initPanZoom() {
    var vp = $('viewport');
    vp.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });

    var panning = null;
    vp.addEventListener('mousedown', function (ev) {
      // start a pan only on empty canvas (not a node, port, band gutter control, popover)
      if (ev.button !== 0) return;
      var t = ev.target;
      if (t.closest('.node') || t.closest('.band-gutter') || t.closest('.popover')) return;
      panning = { x: ev.clientX, y: ev.clientY, px: view.panX, py: view.panY, moved: false };
      vp.classList.add('panning');
    });
    document.addEventListener('mousemove', function (ev) {
      if (!panning) return;
      view.panX = panning.px + (ev.clientX - panning.x);
      view.panY = panning.py + (ev.clientY - panning.y);
      if (Math.abs(ev.clientX - panning.x) + Math.abs(ev.clientY - panning.y) > 3) panning.moved = true;
      applyTransform();
    });
    document.addEventListener('mouseup', function (ev) {
      if (!panning) return;
      var moved = panning.moved;
      panning = null;
      vp.classList.remove('panning');
      // a click on empty canvas (no drag) clears the selection
      if (!moved) {
        var t = ev.target;
        if (!(t.closest('.node') || t.closest('.edge-hit') || t.closest('.popover') || t.closest('.band-gutter'))) clearSelection();
      }
    });
  }

  // ── legend ────────────────────────────────────────────────────────────────
  function renderLegend() {
    var lg = $('legend');
    lg.textContent = '';
    lg.appendChild(el('span', { style: 'font-weight:600;color:var(--ink)' }, ['Status']));
    STATUSES.forEach(function (s) {
      lg.appendChild(el('span', { class: 'li' }, [
        el('span', { class: 'sdot', style: 'background:' + STATUS_COLOR[s] }),
        STATUS_LABEL[s],
      ]));
    });
  }

  // ── export ────────────────────────────────────────────────────────────────
  function exportBoard() {
    setErr('');
    fetch(api('export'), { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = el('a', { href: url, download: (doc && doc.name ? doc.name.replace(/[^A-Za-z0-9._-]+/g, '-') : 'project-plan') + '.json' });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 0);
      })
      .catch(function (e) { setErr('Could not export: ' + e.message); });
  }

  // ── small utilities ─────────────────────────────────────────────────────────
  // commit a contenteditable's text on blur (Enter also blurs); revert on Escape.
  function commitOnBlur(node, initial, onCommit) {
    node.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); node.blur(); }
      else if (ev.key === 'Escape') { node.textContent = initial; node.blur(); }
    });
    node.addEventListener('blur', function () {
      var v = (node.textContent || '').trim();
      if (v !== (initial || '').trim()) onCommit(v);
    });
  }
  // commit an <input> on Enter or blur; revert on Escape.
  function commitOnEnterBlur(input, initial, onCommit) {
    var committed = false;
    function commit() { if (committed) return; committed = true; var v = input.value; if (v !== initial) onCommit(v); }
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { committed = true; input.value = initial; input.blur(); }
    });
    input.addEventListener('blur', commit);
  }
  // '#rrggbb' from a css colour string (best-effort; falls back to slate)
  function toHex(c) {
    if (typeof c === 'string' && /^#([0-9a-f]{6})$/i.test(c)) return c;
    if (typeof c === 'string' && /^#([0-9a-f]{3})$/i.test(c)) {
      return '#' + c.slice(1).split('').map(function (h) { return h + h; }).join('');
    }
    return '#64748b';
  }
  function hexA(c, a) {
    var h = toHex(c);
    var r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  function init() {
    $('exportBtn').addEventListener('click', exportBoard);
    $('addPhaseBtn').addEventListener('click', function () {
      ensurePanel().then(function (panel) { return mutate({ type: 'add-band', panelId: panel.id, name: 'New phase' }); });
    });

    // palette milestone: HTML5 drag onto the canvas
    var chip = $('paletteMilestone');
    chip.addEventListener('dragstart', function (ev) { ev.dataTransfer.setData('text/plain', 'milestone'); ev.dataTransfer.effectAllowed = 'copy'; });
    var vp = $('viewport');
    vp.addEventListener('dragover', function (ev) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; $('emptyState').classList.add('drop-hot'); });
    vp.addEventListener('dragleave', function (ev) { if (ev.target === vp) $('emptyState').classList.remove('drop-hot'); });
    vp.addEventListener('drop', function (ev) { ev.preventDefault(); $('emptyState').classList.remove('drop-hot'); addMilestoneAt(ev.clientX, ev.clientY); });

    $('zoomIn').addEventListener('click', function () { var r = $('viewport').getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.15); });
    $('zoomOut').addEventListener('click', function () { var r = $('viewport').getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.15); });
    $('zoomFit').addEventListener('click', fit);

    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') clearSelection(); });
    window.addEventListener('resize', positionPopover);

    initPanZoom();
    load();
  }

  init();
})();
