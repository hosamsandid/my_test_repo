/* Jira plugin UI (Jira plan §6.4) — the `/` read route.
 *
 * Dependency-free vanilla JS, like github-issues/ui/app.js. Every call goes to
 * this sidecar's `/ui/api/*`, proxied by the console with signed viewer headers;
 * the broker holds the team's Jira credential and calls Jira server-side. This
 * page never sees a token.
 *
 * Two tabs:
 *  • Board    — the team's projects → issues, the watch-health panel (one
 *               expandable card per watched project; a failing watch opens its
 *               failure detail), and the per-scope inbox.
 *  • Activity — the retained event log: every status change the poller saw in a
 *               watched project and what it did with it, filterable by issue
 *               type and by "watched vs all activity".
 */
(function () {
  'use strict';

  // The proxied mount is /plugins/jira/ui; the routes are '' (→ index.html) and
  // '/admin' (→ admin.html). Strip either so `api/…` never leaks a level up.
  var base = location.pathname.replace(/\/(index\.html|admin(\.html)?)$/, '/');
  if (base.slice(-1) !== '/') base += '/';
  function API(p) { return base + 'api' + p; }
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    team: null, teams: [], isAdmin: false,
    view: 'board',
    projectNames: {},
    watches: [], watchHealth: null, expanded: {},
    activity: { rows: [], type: null, scope: 'watched' },
  };

  // Follow live theme toggles from the console (same origin).
  window.addEventListener('storage', function (e) {
    if (e.key === 'eb-theme' && e.newValue) document.documentElement.dataset.theme = e.newValue;
  });

  function showErr(msg) {
    var el = $('err');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false; el.textContent = msg;
  }

  function req(path, opts) {
    return fetch(API(path), opts || { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
        return body;
      });
    });
  }
  function get(path) { return req(path); }
  function post(path, body) {
    return req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
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

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDay(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return 'Unknown date';
    var today = new Date();
    var y = new Date(today.getTime() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function relFromNow(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var mins = Math.round((t - Date.now()) / 60000);
    if (mins <= 0) return 'now';
    if (mins < 60) return 'in ~' + mins + ' min';
    return 'in ~' + Math.round(mins / 60) + ' h';
  }

  // ── issues ────────────────────────────────────────────────────────────────
  function loadProjects() {
    var sel = $('project');
    sel.innerHTML = '<option value="">Loading…</option>';
    return get('/projects?' + teamQS()).then(function (r) {
      state.projectNames = {};
      var opts = (r.projects || []).map(function (p) {
        state.projectNames[p.key] = p.name;
        return '<option value="' + esc(p.key) + '">' + esc(p.key) + ' — ' + esc(p.name) + '</option>';
      });
      sel.innerHTML = opts.length ? opts.join('') : '<option value="">No projects visible</option>';
      loadIssues();
      if (state.watches.length) renderWatches(); // fill in project names on already-rendered cards
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
        return '<a class="issue-card" href="' + esc(i.url) + '" target="_blank" rel="noopener">'
          + '<div class="ic-line1">'
          + '<span class="ic-num">' + esc(i.key) + '</span>'
          + '<span class="ic-title">' + esc(i.summary) + '</span>'
          + '</div>'
          + '<div class="ic-line2">'
          + statusPill(i.status || '—', typeColor(i.issueType), i.issueType)
          + (i.assignee ? '<span class="ic-assignee">' + esc(i.assignee) + '</span>' : '')
          + '</div>'
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
          var when = ev.created || e.receivedAt || '';
          return '<div class="issue-item"><strong>' + esc(ev.issueKey || ev.id || '?') + '</strong> '
            + esc(ev.fromStatus || 'new') + ' <span class="arr">→</span> ' + esc(ev.toStatus || '?')
            + (when ? '<div class="hint">' + esc(fmtTime(when)) + ' · ' + esc(fmtDay(when)) + '</div>' : '')
            + '</div>';
        }).join('')
        : '<div class="empty">Nothing queued.</div>';
    }).catch(function (e) { $('inbox').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  // ── issue-type glyph ──────────────────────────────────────────────────────
  function typeGlyph(type) {
    var t = String(type || '').toLowerCase();
    var cls = 'tg-other', path;
    if (/bug|defect|incident/.test(t)) {
      cls = 'tg-bug';
      path = '<circle cx="12" cy="12" r="7" stroke="currentColor" stroke-width="1.8"/><path d="M12 5V3M12 21v-2M5 12H3M21 12h-2M6.5 6.5 5 5M17.5 6.5 19 5M6.5 17.5 5 19M17.5 17.5 19 19" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';
    } else if (/story/.test(t)) {
      cls = 'tg-story';
      path = '<path d="M6 3h12v18l-6-4-6 4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>';
    } else if (/epic/.test(t)) {
      cls = 'tg-epic';
      path = '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>';
    } else if (/sub-?task/.test(t)) {
      cls = 'tg-subtask';
      path = '<rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M8 12h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
    } else if (/task/.test(t)) {
      cls = 'tg-task';
      path = '<rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="m8 12 3 3 5-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
    } else {
      // unknown / custom type (e.g. "Feature") — a neutral marker, never the
      // task checkmark (which reads as "done").
      cls = 'tg-other';
      path = '<rect x="5" y="5" width="14" height="14" rx="3" stroke="currentColor" stroke-width="1.7"/>';
    }
    return '<span class="type-glyph ' + cls + '" title="' + esc(type || 'Issue') + '">'
      + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none">' + path + '</svg></span>';
  }

  // The dot colour for a status pill, keyed on the issue TYPE (mirrors Jira's
  // own type colours: story green, bug red, task blue, epic purple).
  function typeColor(type) {
    var t = String(type || '').toLowerCase();
    if (/bug|defect|incident/.test(t)) return 'var(--eb-status-error)';
    if (/story/.test(t)) return 'var(--eb-status-success)';
    if (/epic/.test(t)) return 'var(--eb-accent-primary)';
    if (/task/.test(t)) return 'var(--eb-status-info)';
    return 'var(--eb-text-muted)';
  }

  // One pill: a coloured dot + a label. `dotColor` is a CSS value; `title` is an
  // optional hover string.
  function statusPill(label, dotColor, title) {
    return '<span class="status-pill"' + (title ? ' title="' + esc(title) + '"' : '') + '>'
      + '<span class="status-dot" style="background:' + dotColor + '"></span>'
      + esc(label) + '</span>';
  }

  // ── watch health ──────────────────────────────────────────────────────────
  var HEALTH = {
    watching: { label: 'Watching', cls: 'ok' },
    degraded: { label: 'Degraded', cls: 'warn' },
    failing: { label: 'Failing', cls: 'err' },
  };

  // The always-visible roll-up badge at the top of "Watching" (null only when
  // there are no watches at all — nothing to summarise).
  function rollupText(h) {
    if (!h || !h.total) return null;
    if (h.failing) return h.failing + ' failing';
    if (h.degraded) return h.degraded + ' degraded';
    return 'All watching';
  }
  function rollupClass(h) {
    return 'health-pill ' + (h && h.failing ? 'err' : h && h.degraded ? 'warn' : 'ok');
  }

  // The compact health pill for the Activity-view strip rows.
  function healthPill(status) {
    var m = HEALTH[status] || HEALTH.watching;
    return '<span class="health-pill ' + m.cls + '"><span class="dot"></span>' + m.label + '</span>';
  }

  // Check (healthy) / warning-triangle (degraded, failing) — coloured by the
  // enclosing .wc-health class.
  function healthIcon(status) {
    if (status === 'watching') {
      return '<svg class="hi" width="14" height="14" viewBox="0 0 24 24" fill="none">'
        + '<path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    return '<svg class="hi" width="14" height="14" viewBox="0 0 24 24" fill="none">'
      + '<path d="M12 9v4M12 17h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" '
      + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  // Which agents a transition wakes is decided per agent by its `plugin-event`
  // trigger (and its payload filter, e.g. `toStatus=…`) — not here. The
  // pre-Phase-2 `wake.agentIds` is no longer read by the broker.
  function wakeText() {
    return 'wakes agents by their plugin-event triggers';
  }

  // Decorative dot palette for the watch card's target-status pills (they carry
  // no semantic colour of their own — all are statuses the watch fires on).
  var STATUS_DOTS = [
    'var(--eb-accent-primary)', 'var(--eb-status-warning)',
    'var(--eb-status-info)', 'var(--eb-status-success)',
  ];

  // The "Wakes on <pills> … wakes N agents" second row of a watch-card head.
  function wakesRow(w) {
    var list = w.statusFilters || [];
    var pills;
    if (!list.length) {
      pills = '<span class="wc-any">any status change</span>';
    } else {
      pills = list.slice(0, 3).map(function (s, idx) {
        return statusPill(s, STATUS_DOTS[idx % STATUS_DOTS.length]);
      }).join('');
      if (list.length > 3) pills += '<span class="wc-more">+' + (list.length - 3) + ' more</span>';
    }
    return '<div class="wc-wakes"><span class="wc-wakes-label">Wakes on</span>' + pills
      + '<span class="wc-agents">' + esc(wakeText(w)) + '</span></div>';
  }

  function failurePanel(w) {
    var h = w.health || {};
    var errs = (h.recentErrors || []).map(function (e) {
      return '<div class="err-row"><span class="err-ts">' + esc(fmtTime(e.at)) + '</span>'
        + '<span class="err-msg">' + esc(e.message) + '</span></div>';
    }).join('') || '<div class="err-row"><span class="err-msg hint">No error detail recorded.</span></div>';
    var retryBtn = state.isAdmin
      ? '<button class="btn ghost sm" data-retry="' + esc(w.projectKey) + '">'
        + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M3 12a9 9 0 0 1 15.5-6.2M21 12a9 9 0 0 1-15.5 6.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18 3v4h-4M6 21v-4h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        + '<span class="rl">Retry now</span></button>'
      : '';
    return '<div class="failure">'
      + '<div class="failure-summary">'
      + '<div><div class="fs-count">' + (h.consecutiveFailures || 0) + ' consecutive poll failure' + ((h.consecutiveFailures || 0) === 1 ? '' : 's') + '</div>'
      + (h.skipUntil ? '<div class="hint">Backing off — next attempt ' + esc(fmtTime(h.skipUntil)) + ' (' + esc(relFromNow(h.skipUntil)) + ')</div>' : '')
      + '</div><span class="spacer"></span>' + retryBtn + '</div>'
      + '<div class="err-log">' + errs + '</div>'
      + '<div class="failure-hint">Usually a bad or expired API token. A Team Admin fixes it under '
      + '<strong>Plugins → Jira → Credentials</strong>.</div>'
      + '</div>';
  }

  function healthyDetail(w) {
    var h = w.health || {};
    var wakesCell = '<div><span class="dt-label">Wakes</span><span>agents whose plugin-event trigger matches</span></div>';
    return '<div class="watch-detail">'
      + '<div><span class="dt-label">Last poll</span><span>' + (h.lastPolledAt ? esc(fmtTime(h.lastPolledAt)) + ' · ' + esc(fmtDay(h.lastPolledAt)) : 'not yet') + '</span></div>'
      + '<div><span class="dt-label">Seen this cursor</span><span>' + (h.baselined ? esc(h.seenCount) + ' events' : 'not baselined') + '</span></div>'
      + wakesCell
      + '</div>';
  }

  function renderWatchCard(w) {
    var status = (w.health && w.health.status) || 'watching';
    // A failing card defaults open (its detail is the point); still collapsible.
    var e = state.expanded[w.projectKey];
    var open = e === undefined ? status === 'failing' : !!e;
    var body = '';
    if (open) body = status === 'failing' ? failurePanel(w) : healthyDetail(w);
    var m = HEALTH[status] || HEALTH.watching;
    var name = state.projectNames[w.projectKey] || '';
    return '<div class="watch-card ' + status + (open ? ' open' : '') + '" data-key="' + esc(w.projectKey) + '">'
      + '<button class="wc-head" data-toggle="' + esc(w.projectKey) + '">'
      + '<div class="wc-row">'
      + '<span class="proj-badge">' + esc(w.projectKey) + '</span>'
      + (name ? '<span class="wc-name">' + esc(name) + '</span>' : '')
      + '<span class="spacer"></span>'
      + '<span class="wc-health ' + m.cls + '">' + healthIcon(status) + m.label + '</span>'
      + '<span class="chev' + (open ? ' up' : '') + '">'
      + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      + '</span>'
      + '</div>'
      + wakesRow(w)
      + '</button>'
      + body
      + '</div>';
  }

  function renderStripRow(w) {
    var status = (w.health && w.health.status) || 'watching';
    return '<div class="strip-row ' + status + '">'
      + '<span class="proj-badge sm">' + esc(w.projectKey) + '</span>'
      + '<span class="hint">' + esc((w.statusFilters && w.statusFilters.length) ? w.statusFilters.length + ' statuses' : 'any status') + '</span>'
      + '<span class="spacer"></span>' + healthPill(status) + '</div>';
  }

  function renderWatches() {
    var h = state.watchHealth;
    var txt = rollupText(h);
    ['watchRollup', 'watchRollup2'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      if (txt) {
        el.hidden = false;
        el.className = rollupClass(h);
        el.innerHTML = '<span class="dot"></span>' + esc(txt);
      } else { el.hidden = true; }
    });

    var cards = $('watches');
    cards.innerHTML = state.watches.length
      ? state.watches.map(renderWatchCard).join('')
      : '<div class="empty">No projects watched. A Team Admin configures this under Watch config.</div>';

    var strip = $('watchStrip');
    strip.innerHTML = state.watches.length
      ? state.watches.map(renderStripRow).join('')
      : '<div class="empty">No watches.</div>';

    Array.prototype.forEach.call(cards.querySelectorAll('[data-toggle]'), function (b) {
      b.onclick = function () {
        var k = b.dataset.toggle;
        var card = b.parentNode; // .watch-card
        state.expanded[k] = !(card && card.classList.contains('open'));
        renderWatches();
      };
    });
    Array.prototype.forEach.call(cards.querySelectorAll('[data-retry]'), function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var lbl = b.querySelector('.rl');
        b.disabled = true; if (lbl) lbl.textContent = 'Retrying…';
        post('/admin/retry?' + teamQS(), { projectKey: b.dataset.retry })
          .then(function () { return loadWatches(); })
          .catch(function (e) { showErr(e.message); b.disabled = false; if (lbl) lbl.textContent = 'Retry now'; });
      };
    });
  }

  function loadWatches() {
    return get('/watches?' + teamQS()).then(function (r) {
      state.watches = r.watches || [];
      state.watchHealth = r.health || null;
      renderWatches();
    }).catch(function (e) {
      $('watches').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    });
  }

  // ── activity ──────────────────────────────────────────────────────────────
  var OUTCOME = {
    delivered: { label: 'woke agents', cls: 'oc-ok' },
    digested: { label: 'folded into digest', cls: 'oc-info' },
    throttled: { label: 'throttled', cls: 'oc-warn' },
    filtered: { label: 'not a watched status', cls: 'oc-muted' },
    stale: { label: 'old transition, issue re-touched', cls: 'oc-muted' },
    baseline: { label: 'baseline', cls: 'oc-muted' },
  };
  var ACTED = { delivered: 1, digested: 1, throttled: 1 };

  function outcomeChip(o, detail) {
    var m = OUTCOME[o] || { label: o, cls: 'oc-muted' };
    return '<span class="oc ' + m.cls + '"' + (detail ? ' title="' + esc(detail) + '"' : '') + '>' + esc(m.label) + '</span>';
  }

  function visibleActivityRows() {
    var rows = state.activity.rows;
    if (state.activity.scope === 'watched') rows = rows.filter(function (r) { return ACTED[r.outcome]; });
    if (state.activity.type) rows = rows.filter(function (r) { return (r.event.issueType || 'Other') === state.activity.type; });
    return rows;
  }

  function renderTypeFilters() {
    var types = {};
    state.activity.rows.forEach(function (r) { types[r.event.issueType || 'Other'] = 1; });
    var keys = Object.keys(types).sort();
    var box = $('typeFilters');
    if (!keys.length) { box.innerHTML = ''; return; }
    var chips = ['<button class="chip' + (state.activity.type == null ? ' is-active' : '') + '" data-type="">All types</button>'];
    keys.forEach(function (k) {
      chips.push('<button class="chip' + (state.activity.type === k ? ' is-active' : '') + '" data-type="' + esc(k) + '">' + esc(k) + '</button>');
    });
    box.innerHTML = chips.join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-type]'), function (b) {
      b.onclick = function () { state.activity.type = b.dataset.type || null; renderActivity(); };
    });
  }

  function renderActivity() {
    renderTypeFilters();
    var rows = visibleActivityRows();
    var box = $('activity');
    if (!rows.length) {
      box.innerHTML = '<div class="empty">' + (state.activity.rows.length ? 'Nothing matches this filter.' : 'No activity yet.') + '</div>';
      return;
    }
    var html = '';
    var lastDay = null;
    rows.forEach(function (r) {
      var ev = r.event || {};
      var when = ev.created || r.at;
      var day = fmtDay(when);
      if (day !== lastDay) { html += '<div class="day-sep">' + esc(day) + '</div>'; lastDay = day; }
      var keyCell = ev.issueUrl
        ? '<a class="ac-key" href="' + esc(ev.issueUrl) + '" target="_blank" rel="noopener">' + esc(ev.issueKey || ev.id || '?') + '</a>'
        : '<span class="ac-key">' + esc(ev.issueKey || ev.id || '?') + '</span>';
      html += '<div class="ac-row">'
        + typeGlyph(ev.issueType)
        + '<span class="ac-main">' + keyCell
        + '<span class="ac-summary">' + esc(ev.summary || '') + '</span></span>'
        + '<span class="ac-transition">' + esc(ev.fromStatus || '?') + ' <span class="arr">→</span> ' + esc(ev.toStatus || '?') + '</span>'
        + '<span class="ac-time">' + esc(fmtTime(when)) + (ev.author ? ' · ' + esc(ev.author) : '') + '</span>'
        + outcomeChip(r.outcome, r.detail)
        + '</div>';
    });
    box.innerHTML = html;
  }

  function loadActivity() {
    return get('/activity?' + teamQS('limit=300')).then(function (r) {
      state.activity.rows = r.rows || [];
      renderActivity();
    }).catch(function (e) { $('activity').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  // ── view switching ────────────────────────────────────────────────────────
  function switchView(v) {
    state.view = v;
    $('view-board').hidden = v !== 'board';
    $('view-activity').hidden = v !== 'activity';
    $('tab-board').classList.toggle('is-active', v === 'board');
    $('tab-activity').classList.toggle('is-active', v === 'activity');
  }

  function refreshAll() {
    showErr(null);
    loadIssues();
    loadInbox();
    loadWatches();
    loadActivity();
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  get('/context').then(function (ctx) {
    state.teams = ctx.teams || [];
    state.isAdmin = !!ctx.isAdmin;
    if (ctx.isAdmin) { var al = $('adminLink'); al.href = base + 'admin'; al.hidden = false; }
    var teamSel = $('team');
    if (state.teams.length > 1) {
      teamSel.hidden = false;
      teamSel.innerHTML = state.teams.map(function (t) {
        return '<option value="' + esc(t.teamId) + '">' + esc(t.teamId) + '</option>';
      }).join('');
      teamSel.onchange = function () {
        state.team = teamSel.value; state.expanded = {};
        loadProjects(); refreshAll();
      };
    }
    state.team = state.teams.length ? state.teams[0].teamId : null;
    if (!state.team) { showErr('This plugin is not granted to any team you can see.'); return; }
    var t = state.teams[0];
    if (!t.hasCredential) showErr('This team has no Jira credential configured — a Team Admin sets it on the Plugins page.');
    loadProjects();
    loadInbox();
    loadWatches();
    loadActivity();
  }).catch(function (e) { showErr(e.message); });

  $('tab-board').onclick = function () { switchView('board'); };
  $('tab-activity').onclick = function () { switchView('activity'); };
  Array.prototype.forEach.call(document.querySelectorAll('#scopeToggle .seg-btn'), function (b) {
    b.onclick = function () {
      state.activity.scope = b.dataset.scope;
      Array.prototype.forEach.call(document.querySelectorAll('#scopeToggle .seg-btn'), function (x) {
        x.classList.toggle('is-active', x === b);
      });
      renderActivity();
    };
  });
  $('project').onchange = loadIssues;
  $('status').oninput = (function () {
    var t; return function () { clearTimeout(t); t = setTimeout(loadIssues, 300); };
  })();
  $('refresh').onclick = refreshAll;
})();
