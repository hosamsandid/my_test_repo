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

  // ── state ───────────────────────────────────────────────────────────────────
  var teams = [];          // [{teamId, teamName, repos, hasToken, flowLabels}]
  var team = null;         // selected teamId
  var repo = null;         // selected repo fullName
  var state = 'open';
  var page = 1;
  var issues = [];
  var selected = null;     // selected issue number

  function currentTeam() { return teams.filter(function (t) { return t.teamId === team; })[0] || null; }

  function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ team: team, repo: repo, state: state })); } catch (e) { /* ignore */ }
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

  function loadIssues(reset) {
    var t = currentTeam();
    if (!t || !repo || !t.hasToken) { $('issueList').innerHTML = ''; renderListEmpty(); return; }
    if (reset) { page = 1; issues = []; selected = null; renderDetail(null); }
    skeleton(true);
    $('listEmpty').classList.add('hidden');
    req('/issues?team=' + encodeURIComponent(team) + '&repo=' + encodeURIComponent(repo) + '&state=' + encodeURIComponent(state) + '&page=' + page)
      .then(function (data) {
        skeleton(false);
        issues = issues.concat(data.issues || []);
        renderIssueList();
        $('listMore').classList.toggle('hidden', !data.hasMore);
      })
      .catch(function (err) {
        skeleton(false);
        renderIssueList();
        if (err.code === 'no-token') banner(err.message);
        else setErr(err.message);
      });
  }

  function renderListEmpty() {
    var t = currentTeam();
    var e = $('listEmpty');
    if (!t || !t.repos || !t.repos.length || !t.hasToken) { e.classList.add('hidden'); return; }
    if (!issues.length) { e.textContent = 'No ' + (state === 'all' ? '' : state + ' ') + 'issues in this repository.'; e.classList.remove('hidden'); }
    else e.classList.add('hidden');
  }

  function stateBadge(s) { return el('span', { class: 'state ' + (s === 'closed' ? 'closed' : 'open') }, [s]); }

  function labelChips(labels, onRemove) {
    return (labels || []).map(function (l) {
      var kids = [el('span', { class: 'label-dot', style: l.color ? 'background:#' + l.color : '' }), l.name];
      if (onRemove) kids.push(el('button', { title: 'Remove label', onclick: function (ev) { ev.stopPropagation(); onRemove(l.name); } }, ['×']));
      return el('span', { class: 'label-chip' }, kids);
    });
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
  var suggestions = { flowLabels: [], repoLabels: [] };

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
      stateBadge(issue.state),
      issue.user ? el('span', {}, ['opened by ' + issue.user]) : null,
      issue.htmlUrl ? el('a', { href: issue.htmlUrl, target: '_blank', rel: 'noopener' }, ['view on GitHub ↗']) : null,
    ]));
    d.appendChild(el('div', { class: 'body' + (issue.body ? '' : ' empty-body') }, [issue.body || 'No description provided.']));

    d.appendChild(el('div', { class: 'section-title' }, ['Labels']));
    d.appendChild(el('div', { class: 'labels' }, issue.labels && issue.labels.length ? labelChips(issue.labels, removeLabel) : [el('span', { class: 'hint' }, ['No labels yet.'])]));

    d.appendChild(el('div', { class: 'section-title' }, ['Add a label']));
    var input = el('input', { id: 'labelInput', placeholder: 'label name (any label)', onkeydown: function (ev) { if (ev.key === 'Enter') addFromInput(); } });
    d.appendChild(el('div', { class: 'add-label' }, [input, el('button', { class: 'btn', onclick: addFromInput }, ['Add'])]));
    var sug = el('div', { class: 'suggest', id: 'suggest' });
    d.appendChild(sug);
    d.appendChild(el('div', { class: 'hint' }, ['Flow gate labels are suggested first; you can type any label.']));
    renderSuggestions();
  }

  function loadSuggestions() {
    req('/labels?team=' + encodeURIComponent(team) + '&repo=' + encodeURIComponent(repo))
      .then(function (data) { suggestions = data; renderSuggestions(); })
      .catch(function () { /* suggestions are optional */ });
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
      sug.appendChild(el('span', { class: 'label-chip', title: 'Add this label', onclick: function () { addLabel(l.name); } },
        [el('span', { class: 'label-dot', style: l.color ? 'background:#' + l.color : '' }), l.name]));
    });
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
    if (last && ids.indexOf(last.team) >= 0) { team = last.team; repo = last.repo; state = last.state || 'open'; }
    else if (local && ids.indexOf(local.team) >= 0) { team = local.team; repo = local.repo; state = local.state || 'open'; }
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
      updateBanner();
      loadIssues(true);
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
    $('stateSelect').value = state;
    renderRepoSelect(); updateBanner(); saveLocal(); persistPref(); loadIssues(true);
  });
  $('repoSelect').addEventListener('change', function (e) { repo = e.target.value; saveLocal(); persistPref(); loadIssues(true); });
  $('stateSelect').addEventListener('change', function (e) { state = e.target.value; saveLocal(); persistPref(); loadIssues(true); });
  $('refreshBtn').addEventListener('click', function () { loadIssues(true); });
  $('moreBtn').addEventListener('click', function () { page += 1; loadIssues(false); });

  function persistPref() {
    if (!team) return;
    req('/pref', { method: 'POST', body: JSON.stringify({ repo: repo, state: state }) }).catch(function () { /* best-effort */ });
  }

  boot();
})();
