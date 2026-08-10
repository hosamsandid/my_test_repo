/* Network Plan board UI (plugin #3, Phase 3, #1563) — minimal read + tick view.
 *
 * Served from the sidecar and iframed into the console by the §4.8 proxy. It
 * fetches its data from the SAME sidecar (relative to the current UI path, which
 * the console proxies), so identity arrives as the console-signed viewer headers
 * the proxy adds — this page injects no state and inherits none (the iframe
 * boundary is the contract, §4.8). Dependency-free vanilla JS.
 *
 * The full swimlane editor (direct manipulation, selection inspector, colour
 * pickers, reorder, requirement-target-by-click, undo/redo) is the Phase-3
 * completion step; this renders the board and lets a viewer tick milestones so
 * the board is usable on Podman end-to-end.
 */
(function () {
  'use strict';
  // Base = the directory this page is served from, so `api/board` resolves to
  // <mount>/api/board whether or not the URL carried a trailing slash.
  var base = location.pathname.replace(/\/(index\.html|admin\.html)?$/, '/');

  function api(p) { return base + 'api/' + p; }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (k) { e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
    return e;
  }
  function setErr(msg) { document.getElementById('err').textContent = msg || ''; }

  function render(doc) {
    document.getElementById('name').textContent = doc.name || 'Network Plan';
    document.getElementById('sub').textContent = 'Autonomy level ' + (doc.settings && doc.settings.agentAutonomy);
    var ownerById = {};
    (doc.owners || []).forEach(function (o) { ownerById[o.id] = o; });
    var board = document.getElementById('board');
    board.textContent = '';
    var panel = (doc.panels || [])[0];
    if (!panel || !panel.lanes.length) {
      board.appendChild(el('div', { class: 'empty' }, ['This board is empty. Add zones, lanes and milestones from the plan.']));
      return;
    }
    var byZone = {};
    panel.lanes.forEach(function (l) { (byZone[l.zoneId || ''] = byZone[l.zoneId || ''] || []).push(l); });
    var zones = (panel.zones || []).slice();
    // include an unnamed bucket for zone-less lanes
    if (byZone['']) zones.push({ id: '', name: '(no zone)', or: false });
    zones.forEach(function (z) {
      var lanes = byZone[z.id] || [];
      if (!lanes.length) return;
      var zoneEl = el('section', { class: 'zone' + (z.or ? ' or' : '') }, [el('header', null, [z.name || z.id])]);
      lanes.forEach(function (l) {
        var owner = ownerById[l.ownerId];
        var ms = el('div', { class: 'ms' }, (l.milestones || []).map(function (m) {
          var cb = el('input', { type: 'checkbox' });
          cb.checked = !!m.done;
          cb.addEventListener('change', function () { tick(panel.id, l.id, m.id, cb.checked); });
          var lab = el('label', m.done ? { class: 'done' } : null, [cb, m.label || m.id]);
          return lab;
        }));
        var title = el('div', { class: 'title' }, [
          el('div', null, [l.title || l.id]),
          el('div', { class: 'owner' }, [owner ? owner.name : (l.ownerId || '')]),
        ]);
        zoneEl.appendChild(el('div', { class: 'lane' }, [title, ms]));
      });
      board.appendChild(zoneEl);
    });
  }

  function load() {
    setErr('');
    fetch(api('board'), { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(render)
      .catch(function (e) { setErr('Could not load the board: ' + e.message); });
  }

  function tick(panelId, laneId, milestoneId, done) {
    setErr('');
    fetch(api('tick'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panelId: panelId, laneId: laneId, milestoneId: milestoneId, done: done }),
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(render)
      .catch(function (e) { setErr('Could not save: ' + e.message); load(); });
  }

  load();
})();
