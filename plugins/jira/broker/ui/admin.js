/* Jira plugin `/admin` route (Jira plan §6.4, Phase 4) — the watch config.
 *
 * team-admin only (the broker re-enforces the role from the signed viewer
 * headers). Replaces #1539's `env.jiraProjects[]` and the `jira-event` trigger
 * fields: a list of `{ projectKey, statusFilters: string[], events: string[] }`
 * rows. `events` is the row's opt-in set of event kinds (checkboxes, served
 * by the broker as `eventKinds`; status changes only by default). The status
 * chips gate status changes only: a transition into any of them fires; an
 * empty set fires on any status change. Which agents an event wakes is
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
  var state = { team: null, teams: [], watches: [], eventKinds: [] };

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

  // A status is committed to state on Enter / comma. Whatever is still typed
  // in a chip box when the user clicks Save (or Add/Remove, which re-render)
  // must not be silently dropped — adopt it first, exactly as Enter would.
  function commitPending() {
    Array.prototype.forEach.call($('rows').querySelectorAll('input[data-add]'), function (inp) {
      var i = Number(inp.dataset.add);
      var v = inp.value.trim();
      if (v && state.watches[i] && state.watches[i].statusFilters.indexOf(v) < 0) state.watches[i].statusFilters.push(v);
      inp.value = '';
    });
  }

  function render() {
    $('rows').innerHTML = state.watches.map(function (w, i) {
      var chips = (w.statusFilters || []).map(function (s, j) {
        return '<span class="mini-chip removable">' + esc(s)
          + '<button data-rm="' + i + ':' + j + '" aria-label="remove">✕</button></span>';
      }).join('');
      var kinds = state.eventKinds.length > 1
        ? '<div class="kind-editor">' + state.eventKinds.map(function (k) {
          var on = w.events.indexOf(k.name) >= 0;
          return '<label class="kind-check"><input type="checkbox" data-ev="' + i + '" value="' + esc(k.name) + '"'
            + (on ? ' checked' : '') + ' /> ' + esc(k.label) + '</label>';
        }).join('') + '</div>'
        : '';
      return '<div class="watch-editor-block">'
        + '<div class="watch-editor-row">'
        + '<input data-i="' + i + '" data-k="projectKey" class="pk-input" placeholder="KAN" value="' + esc(w.projectKey || '') + '" />'
        + '<div class="chip-editor">'
        + chips
        + '<input data-add="' + i + '" class="chip-add" placeholder="' + (chips ? 'add status, Enter' : 'status + Enter (blank = any)') + '" />'
        + '</div>'
        + '<button data-del="' + i + '" class="btn ghost sm" aria-label="remove project">Remove</button>'
        + '</div>'
        + kinds
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
        commitPending();
        state.watches[Number(parts[0])].statusFilters.splice(Number(parts[1]), 1);
        render();
      };
    });
    Array.prototype.forEach.call($('rows').querySelectorAll('input[data-ev]'), function (cb) {
      cb.onchange = function () {
        var w = state.watches[Number(cb.dataset.ev)];
        var at = w.events.indexOf(cb.value);
        if (cb.checked && at < 0) w.events.push(cb.value);
        if (!cb.checked && at >= 0) w.events.splice(at, 1);
      };
    });
    Array.prototype.forEach.call($('rows').querySelectorAll('button[data-del]'), function (b) {
      b.onclick = function () { commitPending(); state.watches.splice(Number(b.dataset.del), 1); render(); };
    });
  }

  function load() {
    err(null); msg('');
    api('/admin/watch?' + teamQS()).then(function (r) {
      state.eventKinds = r.eventKinds || [];
      state.watches = (r.watches || []).map(function (w) {
        return {
          projectKey: w.projectKey || '',
          statusFilters: (w.statusFilters || []).slice(),
          events: (w.events && w.events.length ? w.events : ['status_changed']).slice(),
        };
      });
      $('meta').textContent = r.setBy ? ('Last saved by ' + r.setBy + (r.setAt ? ' on ' + r.setAt : '')) : '';
      render();
    }).catch(function (e) { err(e.message); });
  }

  $('add').onclick = function () { commitPending(); state.watches.push({ projectKey: '', statusFilters: [], events: ['status_changed'] }); render(); };

  $('save').onclick = function () {
    commitPending();
    render();
    msg('Saving…');
    var watches = state.watches
      .map(function (w) {
        var out = { projectKey: (w.projectKey || '').trim() };
        var sf = (w.statusFilters || []).map(function (s) { return String(s).trim(); }).filter(Boolean);
        if (sf.length) out.statusFilters = sf;
        // All boxes unticked saves as the default (status changes) — the
        // broker would normalise an empty set to that anyway.
        if (w.events && w.events.length) out.events = w.events.slice();
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
    // Only the teams this viewer administers — `isAdmin` is per team, and
    // the broker refuses /admin/* for any other team regardless.
    state.teams = (ctx.teams || []).filter(function (t) { return t.isAdmin; });
    if (!ctx.isAdmin || !state.teams.length) { err('Watch config is team-admin only.'); return; }
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
