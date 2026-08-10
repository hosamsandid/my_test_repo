/* Network Plan /admin UI (plugin #3, Phase 3, #1563) — the autonomy ladder.
 *
 * Served at the /admin route, which the manifest declares at minRole team-admin
 * and the broker re-enforces (viewer-headers.js): a Team Member never reaches
 * this page. Sets settings.agentAutonomy on the document (0/1/2). Dependency-free.
 */
(function () {
  'use strict';
  var base = location.pathname.replace(/\/(index\.html|admin\.html)?$/, '/');
  function api(p) { return base + 'api/' + p; }
  function setMsg(id, msg) { document.getElementById(id).textContent = msg || ''; }

  function paint(doc) {
    var level = (doc.settings && doc.settings.agentAutonomy) || 0;
    var radios = document.querySelectorAll('input[name="autonomy"]');
    radios.forEach(function (r) { r.checked = Number(r.value) === level; });
  }

  function load() {
    fetch(api('board'), { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(paint)
      .catch(function (e) { setMsg('err', 'Could not load: ' + e.message); });
  }

  function save(level) {
    setMsg('ok', ''); setMsg('err', '');
    fetch(api('settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentAutonomy: level }),
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (doc) { paint(doc); setMsg('ok', 'Saved — autonomy level ' + level + '.'); })
      .catch(function (e) { setMsg('err', 'Could not save: ' + e.message); load(); });
  }

  document.querySelectorAll('input[name="autonomy"]').forEach(function (r) {
    r.addEventListener('change', function () { if (r.checked) save(Number(r.value)); });
  });
  load();
})();
