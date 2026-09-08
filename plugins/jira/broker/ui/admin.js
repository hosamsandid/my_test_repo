/* Jira plugin `/admin` route (Jira plan §6.4, Phase 4) — the watch config.
 *
 * team-admin only (the broker re-enforces the role from the signed viewer
 * headers). Replaces #1539's `env.jiraProjects[]` and the `jira-event` trigger
 * fields: a list of `{ projectKey, statusFilter? }` rows. Which agents a change
 * wakes is decided per-agent by a `plugin-event` trigger, not here.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  // The proxied mount is /plugins/jira/ui; the routes are '' (→ index.html) and
  // '/admin' (→ admin.html). Strip either so `api/…` never leaks a level up.
  var base = location.pathname.replace(/\/(index\.html|admin(\.html)?)$/, '/');
  if (base.slice(-1) !== '/') base += '/';
  function API(p) { return base + 'api' + p; }
  var state = { team: null, teams: [], watches: [] };

  var bl = $('backLink');
  if (bl) bl.href = base;

  window.addEventListener('storage', function (e) {
    if (e.key === 'eb-theme' && e.newValue) document.documentElement.dataset.theme = e.newValue;
  });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function err(m) { var el = $('err'); if (!m) { el.hidden = true; return; } el.hidden = false; el.textContent = m; }
  function msg(m) { $('msg').textContent = m || ''; }

  function api(path, opts) {
    return fetch(API(path), opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status));
        return b;
      });
    });
  }
  function teamQS() { return 'team=' + encodeURIComponent(state.team || ''); }

  function render() {
    $('rows').innerHTML = state.watches.map(function (w, i) {
      return '<div class="field" style="display:flex; gap:.5rem; margin-bottom:.4rem;">'
        + '<input data-i="' + i + '" data-k="projectKey" class="field" style="flex:0 0 130px;" placeholder="KAN" value="' + esc(w.projectKey || '') + '" />'
        + '<input data-i="' + i + '" data-k="statusFilter" class="field" style="flex:1;" placeholder="status (blank = any)" value="' + esc(w.statusFilter || '') + '" />'
        + '<button data-del="' + i + '" class="btn">✕</button>'
        + '</div>';
    }).join('') || '<div class="empty">No projects watched.</div>';

    Array.prototype.forEach.call($('rows').querySelectorAll('input'), function (inp) {
      inp.oninput = function () {
        var i = Number(inp.dataset.i);
        state.watches[i][inp.dataset.k] = inp.value;
      };
    });
    Array.prototype.forEach.call($('rows').querySelectorAll('button[data-del]'), function (b) {
      b.onclick = function () { state.watches.splice(Number(b.dataset.del), 1); render(); };
    });
  }

  function load() {
    err(null); msg('');
    api('/admin/watch?' + teamQS()).then(function (r) {
      state.watches = (r.watches || []).map(function (w) {
        return { projectKey: w.projectKey || '', statusFilter: w.statusFilter || '' };
      });
      $('meta').textContent = r.setBy ? ('Last saved by ' + r.setBy + (r.setAt ? ' on ' + r.setAt : '')) : '';
      render();
    }).catch(function (e) { err(e.message); });
  }

  $('add').onclick = function () { state.watches.push({ projectKey: '', statusFilter: '' }); render(); };

  $('save').onclick = function () {
    msg('Saving…');
    var watches = state.watches
      .map(function (w) {
        var out = { projectKey: (w.projectKey || '').trim() };
        if ((w.statusFilter || '').trim()) out.statusFilter = w.statusFilter.trim();
        return out;
      })
      .filter(function (w) { return w.projectKey; });
    api('/admin/watch?' + teamQS(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watches: watches }),
    }).then(function () { msg('Saved.'); load(); })
      .catch(function (e) { msg(''); err(e.message); });
  };

  api('/context').then(function (ctx) {
    state.teams = ctx.teams || [];
    if (!ctx.isAdmin) { err('Watch config is team-admin only.'); return; }
    var sel = $('team');
    if (state.teams.length > 1) {
      sel.hidden = false;
      sel.innerHTML = state.teams.map(function (t) { return '<option>' + esc(t.teamId) + '</option>'; }).join('');
      sel.onchange = function () { state.team = sel.value; load(); };
    }
    state.team = state.teams.length ? state.teams[0].teamId : null;
    if (!state.team) { err('Not granted to any team you can see.'); return; }
    load();
  }).catch(function (e) { err(e.message); });
})();
