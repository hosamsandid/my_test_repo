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

  // ── import a plan (content migration, #1566) ─────────────────────────────────
  // POST the pasted/uploaded PlanDoc to the Team-Admin-only /api/import route,
  // which normalizes + replaces the board (keeping id/teamId and the autonomy set
  // above). A file, if chosen, wins over the textarea.
  function readImportSource() {
    var file = document.getElementById('importFile').files[0];
    if (file) {
      return file.text ? file.text() : new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || '')); };
        fr.onerror = function () { reject(new Error('could not read the file')); };
        fr.readAsText(file);
      });
    }
    return Promise.resolve(document.getElementById('importText').value || '');
  }

  function doImport() {
    setMsg('importOk', ''); setMsg('importErr', '');
    readImportSource().then(function (text) {
      if (!text.trim()) throw new Error('choose a file or paste a PlanDoc first');
      var parsed;
      try { parsed = JSON.parse(text); } catch (e) { throw new Error('not valid JSON: ' + e.message); }
      if (!window.confirm('Replace the current board with the imported plan? This cannot be undone.')) return null;
      return fetch(api('import'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc: parsed }),
      }).then(function (r) {
        return r.json().then(
          function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; },
          function () { throw new Error('HTTP ' + r.status); },
        );
      });
    }).then(function (doc) {
      if (!doc) return; // cancelled at the confirm
      paint(doc);
      var panels = (doc.panels || []).length;
      var lanes = (doc.panels || []).reduce(function (n, p) { return n + ((p.lanes || []).length); }, 0);
      setMsg('importOk', 'Imported — ' + panels + ' panel(s), ' + lanes + ' lane(s). The board now shows this plan.');
      document.getElementById('importText').value = '';
      document.getElementById('importFile').value = '';
    }).catch(function (e) { setMsg('importErr', 'Could not import: ' + e.message); });
  }

  var importBtn = document.getElementById('importBtn');
  if (importBtn) importBtn.addEventListener('click', doImport);

  load();
})();
