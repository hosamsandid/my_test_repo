/* Jira plugin `/admin` route (Jira plan §6.4, Phase 4) — the watch config.
 *
 * team-admin only (the broker re-enforces the role from the signed viewer
 * headers). Replaces #1539's `env.jiraProjects[]` and the `jira-event` trigger
 * fields: a list of `{ projectKey, statusFilters: string[] }` rows. Each project
 * holds a SET of target statuses (chips) and fires on a transition into any of
 * them; an empty set fires on any status change. Which agents a change wakes is
 * decided per-agent by a `plugin-event` trigger, not here.
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
      var chips = (w.statusFilters || []).map(function (s, j) {
        return '<span class="mini-chip removable">' + esc(s)
          + '<button data-rm="' + i + ':' + j + '" aria-label="remove">✕</button></span>';
      }).join('');
      return '<div class="watch-editor-row">'
        + '<input data-i="' + i + '" data-k="projectKey" class="pk-input" placeholder="KAN" value="' + esc(w.projectKey || '') + '" />'
        + '<div class="chip-editor">'
        + chips
        + '<input data-add="' + i + '" class="chip-add" placeholder="' + (chips ? 'add status…' : 'status (blank = any)') + '" />'
        + '</div>'
        + '<button data-del="' + i + '" class="btn ghost sm" aria-label="remove project">Remove</button>'
        + '</div>';
    }).join('') || '<div class="empty">No projects watched.</div>';

    Array.prototype.forEach.call($('rows').querySelectorAll('input[data-k]'), function (inp) {
      inp.oninput = function () { state.watches[Number(inp.dataset.i)][inp.dataset.k] = inp.value; };
    });
    Array.prototype.forEach.call($('rows').querySelectorAll('input[data-add]'), function (inp) {
      inp.onkeydown = function (e) {
        if (e.key !== 'Enter' && e.key !== ',') return;
        e.preventDefault();
        var i = Number(inp.dataset.add);
        var v = inp.value.trim();
        if (v && state.watches[i].statusFilters.indexOf(v) < 0) state.watches[i].statusFilters.push(v);
        inp.value = '';
        render();
        var next = $('rows').querySelector('input[data-add="' + i + '"]');
        if (next) next.focus();
      };
    });
    Array.prototype.forEach.call($('rows').querySelectorAll('button[data-rm]'), function (b) {
      b.onclick = function () {
        var parts = b.dataset.rm.split(':');
        state.watches[Number(parts[0])].statusFilters.splice(Number(parts[1]), 1);
        render();
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
        return { projectKey: w.projectKey || '', statusFilters: (w.statusFilters || []).slice() };
      });
      $('meta').textContent = r.setBy ? ('Last saved by ' + r.setBy + (r.setAt ? ' on ' + r.setAt : '')) : '';
      render();
    }).catch(function (e) { err(e.message); });
  }

  $('add').onclick = function () { state.watches.push({ projectKey: '', statusFilters: [] }); render(); };

  $('save').onclick = function () {
    msg('Saving…');
    var watches = state.watches
      .map(function (w) {
        var out = { projectKey: (w.projectKey || '').trim() };
        var sf = (w.statusFilters || []).map(function (s) { return String(s).trim(); }).filter(Boolean);
        if (sf.length) out.statusFilters = sf;
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
