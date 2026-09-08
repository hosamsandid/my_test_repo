/* Jira plugin UI (Jira plan §6.4) — the `/` read route.
 *
 * Dependency-free vanilla JS, like github-issues/ui/app.js. Every call goes to
 * this sidecar's `/ui/api/*`, proxied by the console with signed viewer headers;
 * the broker holds the team's Jira credential and calls Jira server-side. This
 * page never sees a token.
 *
 * Sections: the team's projects → issues (most-recently-updated first, optional
 * status filter), the per-scope event inbox (what a status change queued), and
 * what the poller is watching (project + cursor). Phase 4 adds an `/admin`
 * route for editing the watch config.
 */
(function () {
  'use strict';

  // The proxied mount is /plugins/jira/ui; the routes are '' (→ index.html) and
  // '/admin' (→ admin.html). Strip either so `api/…` never leaks a level up.
  var base = location.pathname.replace(/\/(index\.html|admin(\.html)?)$/, '/');
  if (base.slice(-1) !== '/') base += '/';
  function API(p) { return base + 'api' + p; }
  var $ = function (id) { return document.getElementById(id); };
  var state = { team: null, teams: [] };

  // Follow live theme toggles from the console (same origin).
  window.addEventListener('storage', function (e) {
    if (e.key === 'eb-theme' && e.newValue) document.documentElement.dataset.theme = e.newValue;
  });

  function showErr(msg) {
    var el = $('err');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false; el.textContent = msg;
  }

  function get(path) {
    return fetch(API(path), { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
        return body;
      });
    });
  }

  function teamQS(extra) {
    var q = 'team=' + encodeURIComponent(state.team || '');
    return extra ? q + '&' + extra : q;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ── issues ────────────────────────────────────────────────────────────────
  function loadProjects() {
    var sel = $('project');
    sel.innerHTML = '<option value="">Loading…</option>';
    return get('/projects?' + teamQS()).then(function (r) {
      var opts = (r.projects || []).map(function (p) {
        return '<option value="' + esc(p.key) + '">' + esc(p.key) + ' — ' + esc(p.name) + '</option>';
      });
      sel.innerHTML = opts.length ? opts.join('') : '<option value="">No projects visible</option>';
      loadIssues();
    }).catch(function (e) {
      sel.innerHTML = '<option value="">—</option>';
      showErr(e.message);
    });
  }

  function loadIssues() {
    var project = $('project').value;
    var status = $('status').value.trim();
    var box = $('issues');
    if (!project) { box.innerHTML = '<div class="empty">Pick a project.</div>'; return; }
    box.innerHTML = '<div class="skeleton"></div>';
    var qs = teamQS('project=' + encodeURIComponent(project) + (status ? '&status=' + encodeURIComponent(status) : ''));
    get('/issues?' + qs).then(function (r) {
      var rows = (r.issues || []).map(function (i) {
        return '<a class="issue-row" href="' + esc(i.url) + '" target="_blank" rel="noopener">'
          + '<span class="issue-num">' + esc(i.key) + '</span>'
          + '<span class="issue-title">' + esc(i.summary) + '</span>'
          + '<span class="label-chip">' + esc(i.status || '—') + '</span>'
          + (i.assignee ? '<span class="hint">' + esc(i.assignee) + '</span>' : '')
          + '</a>';
      });
      box.innerHTML = rows.length ? rows.join('') : '<div class="empty">No matching issues.</div>';
    }).catch(function (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  // ── inbox ─────────────────────────────────────────────────────────────────
  function loadInbox() {
    get('/inbox?' + teamQS()).then(function (r) {
      var entries = r.entries || [];
      $('inboxCount').textContent = entries.length ? '(' + entries.length + ')' : '';
      $('inbox').innerHTML = entries.length
        ? entries.slice(-20).reverse().map(function (e) {
          var ev = e.event || {};
          return '<div class="issue-item"><strong>' + esc(ev.issueKey || ev.id || '?') + '</strong> '
            + esc(ev.fromStatus || '?') + ' → ' + esc(ev.toStatus || '?')
            + '<div class="hint">' + esc(ev.created || e.receivedAt || '') + '</div></div>';
        }).join('')
        : '<div class="empty">Nothing queued.</div>';
    }).catch(function (e) { $('inbox').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  // ── watches ───────────────────────────────────────────────────────────────
  function loadWatches() {
    get('/watches?' + teamQS()).then(function (r) {
      var w = (r.watches || []).map(function (x) {
        return '<div class="issue-item"><strong>' + esc(x.projectKey) + '</strong>'
          + (x.statusFilter ? ' · <span class="label-chip">' + esc(x.statusFilter) + '</span>' : ' · any status')
          + '</div>';
      });
      var cur = Object.keys(r.cursors || {}).map(function (k) {
        var c = r.cursors[k] || {};
        return '<div class="hint">' + esc(k) + ': ' + ((c.seen || []).length) + ' seen'
          + (c.consecutiveFailures ? ' · ⚠ ' + c.consecutiveFailures + ' failures' : '') + '</div>';
      });
      $('watches').innerHTML = (w.length ? w.join('') : '<div class="empty">No watch configured.</div>')
        + cur.join('')
        + (r.setBy ? '<div class="hint">set by ' + esc(r.setBy) + '</div>' : '');
    }).catch(function (e) { $('watches').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  function refreshAll() {
    showErr(null);
    loadIssues();
    loadInbox();
    loadWatches();
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  get('/context').then(function (ctx) {
    state.teams = ctx.teams || [];
    if (ctx.isAdmin) { var al = $('adminLink'); al.href = base + 'admin'; al.hidden = false; }
    var teamSel = $('team');
    if (state.teams.length > 1) {
      teamSel.hidden = false;
      teamSel.innerHTML = state.teams.map(function (t) {
        return '<option value="' + esc(t.teamId) + '">' + esc(t.teamId) + '</option>';
      }).join('');
      teamSel.onchange = function () { state.team = teamSel.value; loadProjects(); loadInbox(); loadWatches(); };
    }
    state.team = state.teams.length ? state.teams[0].teamId : null;
    if (!state.team) { showErr('This plugin is not granted to any team you can see.'); return; }
    var t = state.teams[0];
    if (!t.hasCredential) showErr('This team has no Jira credential configured — a Team Admin sets it on the Plugins page.');
    loadProjects();
    loadInbox();
    loadWatches();
  }).catch(function (e) { showErr(e.message); });

  $('project').onchange = loadIssues;
  $('status').oninput = (function () {
    var t; return function () { clearTimeout(t); t = setTimeout(loadIssues, 300); };
  })();
  $('refresh').onclick = refreshAll;
})();
