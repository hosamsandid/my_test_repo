/* GitHub Issues plugin — console UI controller (issue #1633).
 *
 * Dependency-free. Talks only to its own broker over relative paths (the iframe
 * src ends in "/", so `base` resolves to the plugin's /ui/ mount). Flow:
 *   choose team → choose repo → list issues → open one → add/remove labels.
 * The broker holds the team's GitHub token and makes every API call server-side;
 * this UI never sees a token. Team+repo selection is remembered per user by the
 * broker (server-side) and mirrored to localStorage as a fast-path pre-select. */
(function () {
  'use strict';

  var base = location.pathname.replace(/\/index\.html$/, '/');
  if (base.slice(-1) !== '/') base += '/';
  function apiUrl(p) { return base + 'api' + p; }

  var LS_KEY = 'githubIssues.lastUsed';

  // ── tiny DOM helpers ────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
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
  // Defensive fallback only (markdown.js loads before app.js): HTML-escape so a
  // failed script load still shows the body as safe text, never raw markup.
  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  var errTimer = null;
  function setErr(msg) {
    var e = $('err');
    if (!msg) { e.classList.add('hidden'); return; }
    e.textContent = msg; e.classList.remove('hidden');
    clearTimeout(errTimer); errTimer = setTimeout(function () { e.classList.add('hidden'); }, 6000);
  }
  function banner(msg) {
    var b = $('banner');
    if (!msg) { b.classList.add('hidden'); return; }
    b.textContent = msg; b.classList.remove('hidden');
  }

  function req(path, opts) {
    return fetch(apiUrl(path), Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}))
      .then(function (r) {
        return r.text().then(function (t) {
          var body = null; try { body = t ? JSON.parse(t) : null; } catch (e) { body = null; }
          if (!r.ok) { var err = new Error((body && body.error) || ('HTTP ' + r.status)); err.code = body && body.code; err.status = r.status; throw err; }
          return body;
        });
      });
  }

  // Pure view helpers (issue-list.js UMD, loaded before app.js). Defensive
  // fallbacks keep the UI usable if that script fails to load.
  var IssueList = window.AEEIssueList || {
    normalizeQuery: function (t) { return String(t == null ? '' : t).trim(); },
    pagerState: function (p, m) { return { page: p, hasPrev: p > 1, hasNext: !!m, label: 'Page ' + p }; },
    emptyMessage: function (q, s) { return q ? 'No items match “' + q + '”.' : 'No ' + (s === 'all' ? '' : s + ' ') + 'items in this repository.'; },
    normType: function (t) { return t === 'prs' || t === 'all' ? t : 'issues'; },
    isPullRequestItem: function (it) { return !!(it && it.isPullRequest); },
  };

  // ── state ───────────────────────────────────────────────────────────────────
  var teams = [];          // [{teamId, teamName, repos, hasToken, flowLabels}]
  var team = null;         // selected teamId
  var repo = null;         // selected repo fullName
  var state = 'open';
  var type = 'issues';     // Show: issues | prs | all (#2746)
  var page = 1;
  var issues = [];
  var hasMore = false;     // server's paging signal for the current view
  var searchText = '';     // ephemeral title filter (reset on reload, never stored)
  var selected = null;     // selected issue number

  function currentTeam() { return teams.filter(function (t) { return t.teamId === team; })[0] || null; }

  function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ team: team, repo: repo, state: state, type: type })); } catch (e) { /* ignore */ }
  }
  function readLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; }
  }

  // ── selectors ────────────────────────────────────────────────────────────────
  function renderTeamSelect() {
    var sel = $('teamSelect');
    sel.innerHTML = '';
    teams.forEach(function (t) {
      sel.appendChild(el('option', { value: t.teamId }, [t.teamName || t.teamId]));
    });
    sel.value = team || '';
  }
  function renderRepoSelect() {
    var sel = $('repoSelect');
    sel.innerHTML = '';
    var t = currentTeam();
    var repos = (t && t.repos) || [];
    if (!repos.length) {
      sel.appendChild(el('option', { value: '' }, ['— no repositories —']));
      sel.disabled = true;
    } else {
      sel.disabled = false;
      repos.forEach(function (r) { sel.appendChild(el('option', { value: r.fullName }, [r.fullName])); });
      if (!repo || !repos.some(function (r) { return r.fullName === repo; })) repo = repos[0].fullName;
      sel.value = repo;
    }
  }

  // A team with no token / no repos gets a clear banner instead of a silent fail.
  function updateBanner() {
    var t = currentTeam();
    if (!t) { banner(''); return; }
    if (!t.repos || !t.repos.length) { banner('This team\'s Working Environment exposes no repositories. Add one to it, then reload.'); return; }
    if (!t.hasToken) { banner('This team\'s Working Environment has no GitHub token configured. Ask an admin to add one on the GitHub Tokens page.'); return; }
    banner('');
  }

  // ── issue list ───────────────────────────────────────────────────────────────
  function skeleton(on) { $('listSkeleton').classList.toggle('hidden', !on); }

  // Reset to the first page (new team/repo/state, or a new search query) and load.
  function resetAndLoad() {
    page = 1; selected = null; renderDetail(null);
    loadList();
  }

  // Load the current page — the normal listing, or a server-side title search
  // when the filter box is non-empty (#1658). Each page REPLACES the list (no
  // more unbounded append); the pager moves between pages. Search and listing
  // share the same pager (AC7) and the same server paging signal (AC2).
  function loadList() {
    var t = currentTeam();
    if (!t || !repo || !t.hasToken) { issues = []; hasMore = false; $('issueList').innerHTML = ''; renderPager(); renderListEmpty(); return; }
    skeleton(true);
    $('listEmpty').classList.add('hidden');
    var q = IssueList.normalizeQuery(searchText);
    var common = 'team=' + encodeURIComponent(team) + '&repo=' + encodeURIComponent(repo) + '&state=' + encodeURIComponent(state) + '&type=' + encodeURIComponent(type) + '&page=' + page;
    var path = q ? '/search?' + common + '&q=' + encodeURIComponent(q) : '/issues?' + common;
    req(path)
      .then(function (data) {
        skeleton(false);
        issues = data.issues || [];
        hasMore = !!data.hasMore;
        renderIssueList();
        renderPager();
      })
      .catch(function (err) {
        skeleton(false);
        issues = []; hasMore = false;
        renderIssueList();
        renderPager();
        // never surface a raw 4xx/5xx — req() already carries the broker's
        // friendly message (rate limit, token, etc.)
        if (err.code === 'no-token') banner(err.message);
        else setErr(err.message);
      });
  }

  function renderPager() {
    var st = IssueList.pagerState(page, hasMore);
    $('prevBtn').disabled = !st.hasPrev;
    $('nextBtn').disabled = !st.hasNext;
    $('pagerInfo').textContent = st.label;
    // hide the pager entirely when there is nothing to page through
    $('pager').classList.toggle('hidden', !st.hasPrev && !st.hasNext);
  }

  function renderListEmpty() {
    var t = currentTeam();
    var e = $('listEmpty');
    if (!t || !t.repos || !t.repos.length || !t.hasToken) { e.classList.add('hidden'); return; }
    if (!issues.length) { e.textContent = IssueList.emptyMessage(searchText, state, type); e.classList.remove('hidden'); }
    else e.classList.add('hidden');
  }

  function stateBadge(s) { return el('span', { class: 'state ' + (s === 'closed' ? 'closed' : 'open') }, [s]); }
  // Marks a pull request in the list/detail (#2746) so it is never mistaken for an issue.
  function kindBadge(it) { return IssueList.isPullRequestItem(it) ? el('span', { class: 'kind-pr', title: 'Pull request' }, ['PR']) : null; }

  function labelChips(labels, onRemove) {
    return (labels || []).map(function (l) {
      var kids = [el('span', { class: 'label-dot', style: l.color ? 'background:#' + l.color : '' }), l.name];
      if (onRemove) kids.push(el('button', { title: 'Remove label', onclick: function (ev) { ev.stopPropagation(); onRemove(l.name); } }, ['×']));
      var agents = onRemove ? agentsForLabel(l.name) : [];
      var attrs = { class: 'label-chip' };
      if (agents.length) attrs.title = 'Wakes: ' + agents.join(', ');
      return el('span', attrs, kids);
    });
  }

  // Which agent(s) a label wakes for the selected team + repo (#1642, AC6–8),
  // from the broker's per-repo preview. A label listener with no labelFilter
  // wakes on ANY label — carried under the '' key — so fold those in too.
  function agentsForLabel(name) {
    var map = suggestions.labelAgents || {};
    var out = [];
    var seen = {};
    (map[name] || []).concat(map[''] || []).forEach(function (a) {
      if (a && !seen[a]) { seen[a] = 1; out.push(a); }
    });
    return out;
  }

  function renderIssueList() {
    var ul = $('issueList');
    ul.innerHTML = '';
    issues.forEach(function (it) {
      var item = el('li', {
        class: 'issue-item' + (selected === it.number ? ' active' : ''),
        onclick: function () { openIssue(it.number); },
      }, [
        el('div', { class: 'issue-row' }, [
          el('span', { class: 'issue-num' }, ['#' + it.number]),
          kindBadge(it),
          el('span', { class: 'issue-title' }, [it.title]),
          stateBadge(it.state),
        ]),
        it.labels && it.labels.length ? el('div', { class: 'labels' }, labelChips(it.labels)) : null,
      ]);
      ul.appendChild(item);
    });
    renderListEmpty();
  }

  // ── issue detail + labels ────────────────────────────────────────────────────
  function openIssue(number) {
    selected = number;
    renderIssueList();
    req('/issue?team=' + encodeURIComponent(team) + '&repo=' + encodeURIComponent(repo) + '&number=' + number)
      .then(function (data) { renderDetail(data.issue); loadSuggestions(); })
      .catch(function (err) { setErr(err.message); });
  }

  function applyIssueToList(issue) {
    for (var i = 0; i < issues.length; i++) { if (issues[i].number === issue.number) { issues[i] = issue; break; } }
    renderIssueList();
  }

  var currentIssue = null;
  var suggestions = { flowLabels: [], repoLabels: [], labelAgents: {}, labelUsage: {} };

  function renderDetail(issue) {
    currentIssue = issue;
    var d = $('detail');
    var emptyMsg = $('detailEmpty');
    if (!issue) { d.classList.add('hidden'); emptyMsg.classList.remove('hidden'); return; }
    emptyMsg.classList.add('hidden'); d.classList.remove('hidden');
    d.innerHTML = '';
    d.appendChild(el('h2', {}, [issue.title]));
    d.appendChild(el('div', { class: 'meta' }, [
      el('span', { class: 'issue-num' }, ['#' + issue.number]),
      kindBadge(issue),
      stateBadge(issue.state),
      issue.user ? el('span', {}, ['opened by ' + issue.user]) : null,
      issue.htmlUrl ? el('a', { href: issue.htmlUrl, target: '_blank', rel: 'noopener' }, ['view on GitHub ↗']) : null,
    ]));
    // Workflow-trigger action bar (#1730): a row of prominent buttons — one per
    // flow label that wakes an agent — sits between the meta line and the
    // scrollable body. Populated by renderActionBar() (also re-run after
    // loadSuggestions resolves, since it needs the pushed flow-label data).
    d.appendChild(el('div', { class: 'action-bar hidden', id: 'actionBar' }));
    renderActionBar();
    // Render the Markdown body safely (#1642, Item 3). markdown.js escapes all
    // untrusted text and emits only a whitelisted element set, so its output is
    // safe to assign via innerHTML; an empty body keeps the placeholder (AC4).
    if (issue.body) {
      var body = el('div', { class: 'body md' });
      body.innerHTML = (window.AEEMarkdown ? window.AEEMarkdown.render(issue.body) : escapeText(issue.body));
      d.appendChild(body);
    } else {
      d.appendChild(el('div', { class: 'body empty-body' }, ['No description provided.']));
    }

    d.appendChild(el('div', { class: 'section-title' }, ['Labels']));
    d.appendChild(el('div', { class: 'labels' }, issue.labels && issue.labels.length ? labelChips(issue.labels, removeLabel) : [el('span', { class: 'hint' }, ['No labels yet.'])]));

    d.appendChild(el('div', { class: 'section-title' }, ['Add a label']));
    var input = el('input', { id: 'labelInput', placeholder: 'label name (any label)', onkeydown: function (ev) { if (ev.key === 'Enter') addFromInput(); } });
    d.appendChild(el('div', { class: 'add-label' }, [input, el('button', { class: 'btn', onclick: addFromInput }, ['Add'])]));
    var sug = el('div', { class: 'suggest', id: 'suggest' });
    d.appendChild(sug);
    d.appendChild(el('div', { class: 'hint', id: 'suggestHint' }, [suggestHintText()]));
    renderSuggestions();
  }

  // AC5: the hint must reflect what is actually shown. With flow labels, they're
  // suggested first; with none, it's the repository's own labels — either way
  // free-text still works.
  function suggestHintText() {
    var hasFlow = (suggestions.flowLabels || []).length > 0;
    return hasFlow
      ? 'Your flow\'s gate & outcome labels are suggested first; you can type any label.'
      : 'This team\'s flow defines no labels yet — showing this repository\'s labels. You can type any label.';
  }

  function loadSuggestions() {
    req('/labels?team=' + encodeURIComponent(team) + '&repo=' + encodeURIComponent(repo))
      .then(function (data) { suggestions = data; renderSuggestions(); renderActionBar(); })
      .catch(function () { /* suggestions are optional */ });
  }

  // How the label is normally used, for the action-bar colour coding (#1730,
  // AC4). Only the two known classes count; anything else (incl. a data gap)
  // degrades to a neutral treatment rather than being mis-coloured.
  function triggerUsage(name) {
    var u = (suggestions.labelUsage || {})[name];
    return (u === 'humanGate' || u === 'agentEmitted') ? u : 'neutral';
  }
  var USAGE_META = {
    humanGate:    { cls: 'gate',    tag: 'human-set gate',   glyph: '⇤', legend: 'Human-set gate — a hand-off you deliberately set' },
    agentEmitted: { cls: 'agent',   tag: 'agent-set label',  glyph: '⚙', legend: 'Agent-set label — usually set by an agent itself' },
    neutral:      { cls: 'neutral', tag: 'workflow label',   glyph: '•', legend: 'Workflow label' },
  };

  // AC3 primary copy: "Trigger <Agent>"; when >1 agent wakes, convey that too.
  function triggerButtonLabel(agents) {
    if (agents.length === 1) return 'Trigger ' + agents[0];
    if (agents.length === 2) return 'Trigger ' + agents[0] + ' & ' + agents[1];
    return 'Trigger ' + agents[0] + ' +' + (agents.length - 1) + ' more';
  }

  // The workflow-trigger action bar (#1730). One button per FLOW label that
  // wakes ≥1 agent for the selected team+repo (AC2), colour-coded by usage
  // (AC4), disabled-with-hint when already applied (AC6). Renders nothing when
  // no label qualifies (AC7). Re-run on every renderDetail + after the flow
  // labels load, so it never shows stale buttons from a prior ticket (AC10).
  function renderActionBar() {
    var bar = $('actionBar');
    if (!bar) return;
    bar.innerHTML = '';
    if (!currentIssue) { bar.classList.add('hidden'); return; }

    var applied = {};
    (currentIssue.labels || []).forEach(function (l) { applied[l.name] = true; });

    // Candidate labels: the team's flow labels, de-duplicated, that actually
    // wake an agent in this repo. A label that wakes nobody gets no button.
    var seen = {};
    var buttons = [];
    (suggestions.flowLabels || []).forEach(function (n) {
      var name = typeof n === 'string' ? n : (n && n.name);
      if (!name || seen[name]) return;
      seen[name] = 1;
      var agents = agentsForLabel(name);
      if (!agents.length) return;
      buttons.push({ name: name, agents: agents, usage: triggerUsage(name) });
    });

    if (!buttons.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');

    bar.appendChild(el('div', { class: 'action-bar-title' }, ['Trigger a workflow']));

    var row = el('div', { class: 'trigger-btns' });
    buttons.forEach(function (b) {
      var meta = USAGE_META[b.usage] || USAGE_META.neutral;
      var isApplied = !!applied[b.name];
      var wakesText = 'Wakes ' + b.agents.join(', ');
      var attrs = {
        class: 'trigger-btn ' + meta.cls + (isApplied ? ' applied' : ''),
        type: 'button',
        title: isApplied
          ? (b.name + ' is already applied — already triggered (' + wakesText + ')')
          : ('Add the “' + b.name + '” label — ' + wakesText),
      };
      if (isApplied) { attrs.disabled = ''; attrs['aria-disabled'] = 'true'; }
      else { attrs.onclick = function () { addLabel(b.name); }; }
      var kids = [
        el('span', { class: 'tb-main' }, [
          el('span', { class: 'tb-glyph', 'aria-hidden': 'true' }, [meta.glyph]),
          triggerButtonLabel(b.agents),
        ]),
        el('span', { class: 'tb-sub' }, [
          el('span', { class: 'tb-usage' }, [meta.tag]),
          el('span', { class: 'tb-label' }, [b.name]),
        ]),
      ];
      if (isApplied) kids.push(el('span', { class: 'tb-hint' }, ['✓ already triggered']));
      row.appendChild(el('button', attrs, kids));
    });
    bar.appendChild(row);

    // Legend (AC4): explain the colour coding, but only for the treatments
    // actually present, and never rely on colour alone — each swatch carries the
    // glyph + text that also appears on the buttons.
    var present = {};
    buttons.forEach(function (b) { present[b.usage] = 1; });
    var legendKeys = ['humanGate', 'agentEmitted', 'neutral'].filter(function (k) { return present[k]; });
    if (legendKeys.length > 1) {
      var legend = el('div', { class: 'action-legend' });
      legendKeys.forEach(function (k) {
        var meta = USAGE_META[k];
        legend.appendChild(el('span', { class: 'legend-item ' + meta.cls }, [
          el('span', { class: 'legend-swatch', 'aria-hidden': 'true' }, [meta.glyph]),
          meta.legend,
        ]));
      });
      bar.appendChild(legend);
    }
  }

  function renderSuggestions() {
    var sug = $('suggest');
    if (!sug || !currentIssue) return;
    sug.innerHTML = '';
    var applied = {};
    (currentIssue.labels || []).forEach(function (l) { applied[l.name] = true; });
    var names = {};
    var ordered = [];
    (suggestions.flowLabels || []).forEach(function (n) { var name = typeof n === 'string' ? n : n.name; if (name && !names[name]) { names[name] = 1; ordered.push({ name: name, color: null }); } });
    (suggestions.repoLabels || []).forEach(function (l) { if (l.name && !names[l.name]) { names[l.name] = 1; ordered.push(l); } });
    ordered.filter(function (l) { return !applied[l.name]; }).slice(0, 24).forEach(function (l) {
      var agents = agentsForLabel(l.name);
      var chip = el('span', {
        class: 'label-chip', title: agents.length ? ('Add this label — wakes ' + agents.join(', ')) : 'Add this label',
        onclick: function () { addLabel(l.name); },
      }, [el('span', { class: 'label-dot', style: l.color ? 'background:#' + l.color : '' }), l.name]);
      // Inline caption previewing which agent(s) the label triggers (AC6–8);
      // a label that wakes no agent shows nothing rather than a wrong name.
      var caption = agents.length
        ? el('span', { class: 'trigger-hint', title: 'Wakes: ' + agents.join(', ') }, ['wakes ' + agents.join(', ')])
        : null;
      sug.appendChild(el('span', { class: 'suggest-item' }, [chip, caption]));
    });
    var hintEl = $('suggestHint');
    if (hintEl) hintEl.textContent = suggestHintText();
  }

  function addFromInput() {
    var v = ($('labelInput') && $('labelInput').value || '').trim();
    if (v) addLabel(v);
  }
  function addLabel(name) { writeLabel(name, 'add'); }
  function removeLabel(name) { writeLabel(name, 'remove'); }

  function writeLabel(name, action) {
    if (!currentIssue) return;
    req('/label', { method: 'POST', body: JSON.stringify({ team: team, repo: repo, number: currentIssue.number, label: name, action: action }) })
      .then(function (data) {
        renderDetail(data.issue);
        applyIssueToList(data.issue);
        loadSuggestions();
      })
      .catch(function (err) { setErr(err.message); });
  }

  // ── bootstrap ────────────────────────────────────────────────────────────────
  function preselect(ctx) {
    var local = readLocal();
    var last = ctx.lastUsed;
    var ids = teams.map(function (t) { return t.teamId; });
    // prefer server-remembered, then localStorage, then single team
    if (last && ids.indexOf(last.team) >= 0) { team = last.team; repo = last.repo; state = last.state || 'open'; type = IssueList.normType(last.type); }
    else if (local && ids.indexOf(local.team) >= 0) { team = local.team; repo = local.repo; state = local.state || 'open'; type = IssueList.normType(local.type); }
    else if (teams.length) { team = teams[0].teamId; }
    // stale repo → fall back to the team's first repo (handled in renderRepoSelect)
  }

  function boot() {
    req('/context').then(function (ctx) {
      teams = ctx.teams || [];
      if (!teams.length) { banner('This plugin is not granted to any team you can access.'); return; }
      preselect(ctx);
      renderTeamSelect();
      renderRepoSelect();
      $('stateSelect').value = state;
      $('typeSelect').value = type;
      updateBanner();
      loadList();
    }).catch(function (err) { setErr(err.message); });
  }

  // ── events ───────────────────────────────────────────────────────────────────
  $('teamSelect').addEventListener('change', function (e) {
    team = e.target.value;
    // restore this project's own last-used repo + state (#1650); renderRepoSelect
    // validates the repo against the team's current list and falls back if stale
    var t = currentTeam();
    repo = (t && t.lastRepo) || null;
    state = (t && t.lastState) || 'open';
    type = IssueList.normType(t && t.lastType);
    $('stateSelect').value = state;
    $('typeSelect').value = type;
    renderRepoSelect(); updateBanner(); saveLocal(); persistPref(); resetAndLoad();
  });
  $('repoSelect').addEventListener('change', function (e) { repo = e.target.value; saveLocal(); persistPref(); resetAndLoad(); });
  // A state change re-runs the current view (listing OR search) at page 1, so a
  // search respects the selected state (AC8) and pagination resets (AC3/AC7).
  $('stateSelect').addEventListener('change', function (e) { state = e.target.value; saveLocal(); persistPref(); resetAndLoad(); });
  $('typeSelect').addEventListener('change', function (e) { type = IssueList.normType(e.target.value); saveLocal(); persistPref(); resetAndLoad(); });
  $('refreshBtn').addEventListener('click', function () { loadList(); });
  $('prevBtn').addEventListener('click', function () { if (page > 1) { page -= 1; loadList(); } });
  $('nextBtn').addEventListener('click', function () { if (hasMore) { page += 1; loadList(); } });

  // Debounced title filter (AC4/AC11): typing does not fire a request per
  // keystroke. Each new query resets to the first page (AC7); clearing the box
  // (empty / whitespace-only) falls back to the normal listing (AC9).
  var searchTimer = null;
  $('searchInput').addEventListener('input', function (e) {
    searchText = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(resetAndLoad, 300);
  });

  // Follow the console's light/dark toggle live: the console (same origin as this
  // proxied iframe) writes the active theme to localStorage['eb-theme'], which
  // fires a `storage` event in this document. The pre-paint script in index.html
  // handles the initial value.
  window.addEventListener('storage', function (e) {
    if (e.key !== 'eb-theme' || !e.newValue) return;
    if (['admin-dark', 'admin-light', 'high-contrast'].indexOf(e.newValue) >= 0) {
      document.documentElement.dataset.theme = e.newValue;
    }
  });

  function persistPref() {
    if (!team) return;
    // team travels in the body (like writeLabel) so a multi-team viewer's pref
    // resolves server-side — a POST carries no team query param (#1651).
    req('/pref', { method: 'POST', body: JSON.stringify({ team: team, repo: repo, state: state, type: type }) }).catch(function () { /* best-effort */ });
  }

  boot();
})();
