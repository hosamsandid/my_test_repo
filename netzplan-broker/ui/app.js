/* Network Plan board UI (plugin #3, epic #1554).
 *
 * Phase 3 (#1563) shipped a read + tick view of a single swimlane. Phase 4
 * (#1564) turns it into the composed board the concept describes (§5): the four
 * primitives (swimlane, graph, bipartite, blocks) render, and an Edit mode lets
 * a team member add / edit / reorder / remove panels and their contents — every
 * change flows through the pure plan-doc.js mutations via POST /api/mutate, so
 * the server (and its unit tests) remain the source of truth. Reads stay
 * always-allowed; ticking a milestone stays the one write available without Edit.
 *
 * Served from the sidecar and iframed into the console by the §4.8 proxy;
 * identity arrives as the console-signed viewer headers the proxy adds, so this
 * page injects no state and inherits none. Dependency-free vanilla JS.
 *
 * The controls are deliberately compact (inline buttons + prompt() entry, no
 * framework): the *capability* — add/edit/reorder/remove for every primitive — is
 * complete; the direct-manipulation polish the concept sketches (drag reorder,
 * colour pickers, click-a-milestone to set a requirement target, undo/redo) is a
 * refinement over the very same mutations. See the PR.
 */
(function () {
  'use strict';
  var base = location.pathname.replace(/\/(index\.html|admin\.html)?$/, '/');
  function api(p) { return base + 'api/' + p; }

  var doc = null;
  var editMode = false;
  var hover = { panelId: null, nodeId: null }; // graph hover-highlight state

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'onclick') e.addEventListener('click', attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (k) {
      if (k == null || k === false) return;
      e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    });
    return e;
  }
  function setErr(msg) { document.getElementById('err').textContent = msg || ''; }
  function ask(label, cur) { return window.prompt(label, cur == null ? '' : cur); } // null on cancel

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
  function load() { setErr(''); req('board').then(function (d) { doc = d; render(); }).catch(function (e) { setErr('Could not load the board: ' + e.message); }); }
  function mutate(op) { setErr(''); req('mutate', 'POST', { op: op }).then(function (d) { doc = d; render(); }).catch(function (e) { setErr('Could not save: ' + e.message); }); }
  function tick(panelId, laneId, milestoneId, done) {
    setErr('');
    req('tick', 'POST', { panelId: panelId, laneId: laneId, milestoneId: milestoneId, done: done })
      .then(function (d) { doc = d; render(); })
      .catch(function (e) { setErr('Could not save: ' + e.message); load(); });
  }

  // ── small edit helpers ─────────────────────────────────────────────────────
  function btn(label, title, onClick) { return el('button', { class: 'btn mini', title: title || label, onclick: onClick }, [label]); }
  function ids(list) { return (list || []).map(function (x) { return x.id; }); }
  // order array with `id` moved by dir (-1 up / +1 down); null if it can't move
  function moved(list, id, dir) {
    var a = ids(list); var i = a.indexOf(id); var j = i + dir;
    if (i < 0 || j < 0 || j >= a.length) return null;
    var t = a[i]; a[i] = a[j]; a[j] = t; return a;
  }
  // ▲▼ buttons for an ordered list, calling `reorderType` with { ...extra, order }
  function reorderBtns(list, id, reorderType, extra) {
    if (!editMode) return null;
    var wrap = el('span', { class: 'row-actions' });
    wrap.appendChild(btn('▲', 'move up', function () { var o = moved(list, id, -1); if (o) mutate(Object.assign({ type: reorderType, order: o }, extra || {})); }));
    wrap.appendChild(btn('▼', 'move down', function () { var o = moved(list, id, 1); if (o) mutate(Object.assign({ type: reorderType, order: o }, extra || {})); }));
    return wrap;
  }

  // ── owners (board-level) ──────────────────────────────────────────────────
  function ownersBar() {
    var bar = el('div', { class: 'panel' }, [el('header', null, [el('span', { class: 'ptitle' }, ['Owners']), el('span', { class: 'kind' }, ['shared'])])]);
    var body = el('div', { class: 'body' });
    (doc.owners || []).forEach(function (o) {
      var row = el('div', { class: 'entry' }, [
        el('span', null, [o.name || o.id]),
        btn('rename', 'rename owner', function () { var v = ask('Owner name', o.name); if (v != null) mutate({ type: 'rename-owner', id: o.id, name: v }); }),
        btn('✕', 'delete owner', function () { mutate({ type: 'delete-owner', id: o.id }); }),
      ]);
      body.appendChild(row);
    });
    body.appendChild(btn('+ owner', 'add owner', function () { var v = ask('Owner name'); if (v != null) mutate({ type: 'add-owner', name: v }); }));
    bar.appendChild(body);
    return bar;
  }

  // ── panel wrapper (title, kind, reorder, delete) ───────────────────────────
  function panelShell(panel, bodyEl) {
    var head = el('header');
    head.appendChild(el('span', { class: 'ptitle' }, [panel.title || '(untitled ' + panel.kind + ')']));
    head.appendChild(el('span', { class: 'kind' }, [panel.kind]));
    if (editMode) {
      head.appendChild(btn('rename', 'rename panel', function () { var v = ask('Panel title', panel.title); if (v != null) renamePanel(panel, v); }));
      var rb = reorderBtns(doc.panels, panel.id, 'reorder-panels'); if (rb) head.appendChild(rb);
      head.appendChild(btn('✕', 'remove panel', function () { if (window.confirm('Remove this panel?')) mutate({ type: 'delete-panel', id: panel.id }); }));
    }
    return el('section', { class: 'panel' }, [head, el('div', { class: 'body' }, [bodyEl])]);
  }
  // A panel title is kind-agnostic — one op edits it for every primitive.
  function renamePanel(panel, title) { mutate({ type: 'set-panel-title', id: panel.id, title: title }); }

  // ── swimlane ────────────────────────────────────────────────────────────────
  function renderSwimlane(panel) {
    var ownerById = {}; (doc.owners || []).forEach(function (o) { ownerById[o.id] = o; });
    var body = el('div');
    var byZone = {};
    panel.lanes.forEach(function (l) { (byZone[l.zoneId || ''] = byZone[l.zoneId || ''] || []).push(l); });
    var zones = (panel.zones || []).slice();
    if (byZone['']) zones.push({ id: '', name: '(no zone)', or: false });

    if (!panel.lanes.length && !editMode) {
      body.appendChild(el('div', { class: 'empty' }, ['This swimlane is empty. Turn on Edit to add zones, lanes and milestones.']));
    }
    zones.forEach(function (z) {
      var lanes = byZone[z.id] || [];
      if (!lanes.length && z.id === '') return;
      var zhead = el('header', null, [z.name || z.id || '(no zone)']);
      if (editMode && z.id) {
        zhead.appendChild(btn(z.or ? 'OR ✓' : 'OR', 'toggle OR zone', function () { mutate({ type: 'update-zone', panelId: panel.id, id: z.id, or: !z.or }); }));
        zhead.appendChild(btn('rename', 'rename zone', function () { var v = ask('Zone name', z.name); if (v != null) mutate({ type: 'update-zone', panelId: panel.id, id: z.id, name: v }); }));
        zhead.appendChild(btn('✕', 'delete zone', function () { mutate({ type: 'delete-zone', panelId: panel.id, id: z.id }); }));
      }
      var zoneEl = el('section', { class: 'zone' + (z.or ? ' or' : '') }, [zhead]);
      lanes.forEach(function (l) {
        var owner = ownerById[l.ownerId];
        var ms = el('div', { class: 'ms' }, (l.milestones || []).map(function (m) {
          var cb = el('input', { type: 'checkbox' }); cb.checked = !!m.done;
          cb.addEventListener('change', function () { tick(panel.id, l.id, m.id, cb.checked); });
          var lab = el('label', m.done ? { class: 'done' } : null, [cb, m.label || m.id]);
          if (editMode) lab.appendChild(btn('✕', 'delete milestone', function () { mutate({ type: 'delete-milestone', panelId: panel.id, laneId: l.id, id: m.id }); }));
          return lab;
        }));
        if (editMode) ms.appendChild(btn('+ milestone', 'add milestone', function () { var v = ask('Milestone label'); if (v != null) mutate({ type: 'add-milestone', panelId: panel.id, laneId: l.id, label: v }); }));
        var title = el('div', { class: 'title' }, [
          el('div', null, [l.title || l.id]),
          el('div', { class: 'owner' }, [owner ? owner.name : (l.ownerId || '')]),
        ]);
        var lane = el('div', { class: 'lane' }, [title, ms]);
        if (editMode) {
          var acts = el('div', { class: 'row-actions' }, [
            btn('rename', 'rename lane', function () { var v = ask('Lane title', l.title); if (v != null) mutate({ type: 'update-lane', panelId: panel.id, id: l.id, title: v }); }),
            btn('owner', 'set owner id ("" clears)', function () { var v = ask('Owner id', l.ownerId); if (v != null) mutate({ type: 'update-lane', panelId: panel.id, id: l.id, ownerId: v || null }); }),
            btn('✕', 'delete lane', function () { mutate({ type: 'delete-lane', panelId: panel.id, id: l.id }); }),
          ]);
          lane.appendChild(acts);
        }
        zoneEl.appendChild(lane);
      });
      body.appendChild(zoneEl);
    });
    if (editMode) {
      body.appendChild(el('div', { class: 'row-actions' }, [
        btn('+ zone', 'add zone', function () { var v = ask('Zone name'); if (v != null) mutate({ type: 'add-zone', panelId: panel.id, name: v }); }),
        btn('+ lane', 'add lane (optionally in a zone)', function () {
          var v = ask('Lane title'); if (v == null) return;
          var z = ask('Zone id (blank for none)'); if (z === null) z = '';
          var op = { type: 'add-lane', panelId: panel.id, title: v }; if (z) op.zoneId = z; mutate(op);
        }),
        btn('+ requirement', 'add a requirement line', function () { var v = ask('Requirement label'); if (v != null) mutate({ type: 'add-requirement', panelId: panel.id, label: v }); }),
      ]));
    }
    return body;
  }

  // ── graph ────────────────────────────────────────────────────────────────────
  function neighbourSet(panel, nodeId) {
    var set = {}; set[nodeId] = true;
    (panel.edges || []).forEach(function (e) { if (e.from === nodeId) set[e.to] = true; if (e.to === nodeId) set[e.from] = true; });
    return set;
  }
  function renderGraph(panel) {
    var ownerById = {}; (doc.owners || []).forEach(function (o) { ownerById[o.id] = o; });
    var body = el('div');
    var byBand = {}; panel.nodes.forEach(function (n) { (byBand[n.bandId || ''] = byBand[n.bandId || ''] || []).push(n); });
    var bands = (panel.bands || []).slice();
    if (byBand['']) bands.push({ id: '', name: '(no band)', color: '#94a3b8' });
    var hovering = hover.panelId === panel.id && hover.nodeId ? neighbourSet(panel, hover.nodeId) : null;

    bands.forEach(function (b) {
      var list = byBand[b.id] || []; if (!list.length && b.id === '') return;
      var bh = el('header', null, [b.name || b.id || '(no band)']);
      bh.style.borderLeftColor = b.color || '#64748b';
      if (editMode && b.id) {
        bh.appendChild(btn('rename', 'rename band', function () { var v = ask('Band name', b.name); if (v != null) mutate({ type: 'update-band', panelId: panel.id, id: b.id, name: v }); }));
        var rb = reorderBtns(panel.bands, b.id, 'reorder-bands', { panelId: panel.id }); if (rb) bh.appendChild(rb);
        bh.appendChild(btn('✕', 'delete band (nodes keep, unbanded)', function () { mutate({ type: 'delete-band', panelId: panel.id, id: b.id }); }));
      }
      var bandEl = el('div', { class: 'band' }, [bh]);
      var nodesEl = el('div', { class: 'nodes' });
      list.forEach(function (n) {
        var cls = 'gnode' + (hovering ? (hovering[n.id] ? ' neighbour' : ' dim') : '');
        var owner = ownerById[n.ownerId];
        var node = el('div', { class: cls }, [
          el('div', { class: 'nlabel' }, [n.label || n.id]),
          el('div', { class: 'nmeta' }, [[n.type, n.status, owner ? owner.name : ''].filter(Boolean).join(' · ') || ' ']),
        ]);
        node.addEventListener('mouseenter', function () { hover = { panelId: panel.id, nodeId: n.id }; render(); });
        node.addEventListener('mouseleave', function () { hover = { panelId: null, nodeId: null }; render(); });
        if (editMode) {
          node.appendChild(el('div', { class: 'row-actions' }, [
            btn('edit', 'edit label/type/status', function () {
              var v = ask('Node label', n.label); if (v == null) return;
              var t = ask('Node type', n.type); if (t == null) t = n.type;
              var s = ask('Status', n.status); if (s == null) s = n.status;
              mutate({ type: 'update-node', panelId: panel.id, id: n.id, label: v, nodeType: t, status: s });
            }),
            btn('→edge', 'add a dependency edge to another node id', function () { var to = ask('Depends-on node id'); if (to) mutate({ type: 'add-edge', panelId: panel.id, from: n.id, to: to, edgeType: 'depends' }); }),
            btn('✕', 'delete node', function () { mutate({ type: 'delete-node', panelId: panel.id, id: n.id }); }),
          ]));
        }
        nodesEl.appendChild(node);
      });
      if (editMode) nodesEl.appendChild(btn('+ node', 'add node', function () {
        var v = ask('Node label'); if (v == null) return;
        var op = { type: 'add-node', panelId: panel.id, label: v }; if (b.id) op.bandId = b.id; mutate(op);
      }));
      bandEl.appendChild(nodesEl);
      body.appendChild(bandEl);
    });

    if ((panel.edges || []).length) {
      var edgesEl = el('div', { class: 'edges' }, ['Edges: ']);
      panel.edges.forEach(function (e) {
        var chip = el('span', { class: 'edge' }, [e.from + ' → ' + e.to + (e.type ? ' (' + e.type + ')' : '')]);
        if (editMode) chip.appendChild(btn('✕', 'delete edge', function () { mutate({ type: 'delete-edge', panelId: panel.id, id: e.id }); }));
        edgesEl.appendChild(chip);
      });
      body.appendChild(edgesEl);
    }
    if (editMode) body.appendChild(el('div', { class: 'row-actions' }, [
      btn('+ band', 'add band', function () { var v = ask('Band name'); if (v != null) mutate({ type: 'add-band', panelId: panel.id, name: v }); }),
    ]));
    if (!panel.nodes.length && !editMode) body.appendChild(el('div', { class: 'empty' }, ['This graph is empty. Turn on Edit to add bands, nodes and dependency edges.']));
    return body;
  }

  // ── bipartite ────────────────────────────────────────────────────────────────
  function renderBipartite(panel) {
    var body = el('div');
    var cols = el('div', { class: 'bip' });
    ['left', 'right'].forEach(function (side) {
      var col = el('div', { class: 'col' }, [el('h4', null, [side === 'left' ? 'Streams' : 'Targets'])]);
      (panel[side] || []).forEach(function (en) {
        var row = el('div', { class: 'entry' }, [el('span', null, [en.label || en.id]), en.sub ? el('span', { class: 'sub' }, [en.sub]) : null]);
        if (editMode) {
          var rb = reorderBtns(panel[side], en.id, 'reorder-bip-entries', { panelId: panel.id, side: side }); if (rb) row.appendChild(rb);
          row.appendChild(btn('rename', 'rename entry', function () { var v = ask('Label', en.label); if (v != null) mutate({ type: 'update-bip-entry', panelId: panel.id, side: side, id: en.id, label: v }); }));
          row.appendChild(btn('✕', 'delete entry', function () { mutate({ type: 'delete-bip-entry', panelId: panel.id, side: side, id: en.id }); }));
        }
        col.appendChild(row);
      });
      if (editMode) col.appendChild(btn('+ ' + side, 'add ' + side + ' entry', function () { var v = ask('Label'); if (v != null) mutate({ type: 'add-bip-entry', panelId: panel.id, side: side, label: v }); }));
      cols.appendChild(col);
    });
    body.appendChild(cols);

    if ((panel.edges || []).length) {
      var edgesEl = el('div', { class: 'edges bipedges' }, ['Mappings: ']);
      panel.edges.forEach(function (e) {
        var chip = el('span', { class: 'edge' + (e.muted ? ' muted' : '') }, [e.from + ' → ' + e.to + (e.type ? ' (' + e.type + ')' : '') + (e.muted ? ' · muted' : '')]);
        if (editMode) {
          chip.appendChild(btn(e.muted ? 'unmute' : 'mute', 'toggle muted style', function () { mutate({ type: 'update-bip-edge', panelId: panel.id, id: e.id, muted: !e.muted }); }));
          chip.appendChild(btn('✕', 'delete mapping', function () { mutate({ type: 'delete-bip-edge', panelId: panel.id, id: e.id }); }));
        }
        edgesEl.appendChild(chip);
      });
      body.appendChild(edgesEl);
    }
    if (editMode) body.appendChild(btn('+ mapping', 'map a left entry to a right entry', function () {
      var from = ask('Left entry id'); if (!from) return; var to = ask('Right entry id'); if (!to) return;
      mutate({ type: 'add-bip-edge', panelId: panel.id, from: from, to: to, edgeType: 'maps' });
    }));
    return body;
  }

  // ── blocks ────────────────────────────────────────────────────────────────────
  function renderBlocks(panel) {
    var body = el('div');
    (panel.blocks || []).forEach(function (b) {
      var block = el('div', { class: 'block' });
      if (b.heading) block.appendChild(el('div', { class: 'bhead' }, [b.heading]));
      if (b.subtitle) block.appendChild(el('div', { class: 'bsubtitle' }, [b.subtitle]));
      if (b.body) block.appendChild(el('div', { class: 'bbody' }, [b.body]));
      if ((b.chips || []).length) block.appendChild(el('div', { class: 'chips' }, b.chips.map(function (c) { return el('span', { class: 'chip' }, [c]); })));
      if ((b.tiles || []).length) block.appendChild(el('div', { class: 'tiles' }, b.tiles.map(function (t) {
        return el('div', { class: 'tile' }, [
          t.value ? el('div', { class: 'value' }, [t.value]) : null,
          el('div', { class: 'tlabel' }, [t.label || t.id]),
          t.sub ? el('div', { class: 'tsub' }, [t.sub]) : null,
        ]);
      })));
      if (b.meta) block.appendChild(el('div', { class: 'bmeta' }, [b.meta]));
      block.appendChild(el('div', { class: 'bmeta' }, ['type: ' + b.type]));
      if (editMode) {
        var rb = reorderBtns(panel.blocks, b.id, 'reorder-blocks', { panelId: panel.id });
        var acts = el('div', { class: 'row-actions' }, [
          btn('heading', 'set heading', function () { var v = ask('Heading', b.heading); if (v != null) mutate({ type: 'update-block', panelId: panel.id, id: b.id, heading: v }); }),
          btn('body', 'set body', function () { var v = ask('Body', b.body); if (v != null) mutate({ type: 'update-block', panelId: panel.id, id: b.id, body: v }); }),
          btn('+ tile', 'add a KPI/card tile', function () {
            var lab = ask('Tile label'); if (lab == null) return; var val = ask('Tile value', ''); if (val == null) val = '';
            var tiles = (b.tiles || []).concat([{ label: lab, value: val }]);
            mutate({ type: 'update-block', panelId: panel.id, id: b.id, tiles: tiles });
          }),
          rb,
          btn('✕', 'delete block', function () { mutate({ type: 'delete-block', panelId: panel.id, id: b.id }); }),
        ]);
        block.appendChild(acts);
      }
      body.appendChild(block);
    });
    if (editMode) body.appendChild(el('div', { class: 'row-actions' }, ['cover', 'kpi', 'callout', 'cards'].map(function (t) {
      return btn('+ ' + t, 'add a ' + t + ' block', function () {
        var h = ask(t + ' heading (blank ok)'); if (h === null) return;
        mutate({ type: 'add-block', panelId: panel.id, blockType: t, heading: h });
      });
    })));
    if (!(panel.blocks || []).length && !editMode) body.appendChild(el('div', { class: 'empty' }, ['No blocks yet. Turn on Edit to add a cover, KPI tiles, a callout or cards.']));
    return body;
  }

  function renderPanel(panel) {
    var bodyEl;
    if (panel.kind === 'graph') bodyEl = renderGraph(panel);
    else if (panel.kind === 'bipartite') bodyEl = renderBipartite(panel);
    else if (panel.kind === 'blocks') bodyEl = renderBlocks(panel);
    else bodyEl = renderSwimlane(panel);
    return panelShell(panel, bodyEl);
  }

  function render() {
    if (!doc) return;
    document.getElementById('name').textContent = doc.name || 'Network Plan';
    document.getElementById('sub').textContent = 'Autonomy level ' + (doc.settings && doc.settings.agentAutonomy) + (editMode ? ' · editing' : '');
    document.querySelectorAll('.editonly').forEach(function (n) { n.classList.toggle('hidden', !editMode); });
    var board = document.getElementById('board');
    board.textContent = '';
    if (editMode) board.appendChild(ownersBar());
    if (!(doc.panels || []).length) {
      board.appendChild(el('div', { class: 'empty' }, ['This board has no panels. Turn on Edit and add one.']));
      return;
    }
    doc.panels.forEach(function (p) { board.appendChild(renderPanel(p)); });
  }

  // ── wiring ──────────────────────────────────────────────────────────────────
  var toggle = document.getElementById('editToggle');
  if (toggle) toggle.addEventListener('change', function () { editMode = toggle.checked; hover = { panelId: null, nodeId: null }; render(); });
  document.querySelectorAll('[data-add]').forEach(function (b) {
    b.addEventListener('click', function () { mutate({ type: 'add-panel', kind: b.getAttribute('data-add') }); });
  });

  load();
})();
