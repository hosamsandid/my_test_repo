'use strict';

// ─── github-issues broker sidecar (plugin, issue #1633) ──────────────────────
//
// Brings the three read-mostly GitHub issue actions an operator does when
// releasing work — list issues, read an issue, add/remove a label — into the
// Agent Studio console, so the BA Human applying a `ready` gate no longer leaves
// the studio for GitHub. Built ON the Broker SDK (broker-sdk/), like
// netzplan-broker and test-mgmt-broker; this file is wiring.
//
// It holds a credential (a team's Working-Environment GitHub token) and reaches
// GitHub (capability: egress), but that credential is NOT baked into the image
// or entered at grant: the orchestrator resolves each granted team's
// `environment → { token, repositories }` and PUSHES a per-scope map here
// (PUT /internal/scope-credentials, bearer-authed). The token lives only in this
// sidecar's memory — never in the browser, never in an agent container (AC10).
//
// Two request surfaces:
//   1. `/ui/*` — the console-proxied UI + its data API. Every request carries
//      signed viewer headers (§4.8); the broker verifies them, resolves the
//      viewer's team scope, and calls GitHub server-side with that team's token.
//      A team/repo the viewer is not signed for is refused (403), and a repo not
//      in the selected team's environment yields no token (authorization guard).
//   2. `/cli/*` — the dependency-free agent CLI (aee-issues), scope-token authed.
//      Read-only in the MVP (list / show): agents browse issues; label writes are
//      the human UI's action.

const http = require('http');
const fs = require('fs');
const path = require('path');

const {
  verifyScopeToken,
  auditWriter,
  healthEndpoint,
  teardownScopeEndpoint,
  brokerConfig,
} = require('../../../broker-sdk');
const gh = require('./github-client');
const { ScopeStore } = require('./scope-store');
const { verifyViewerHeaders, requiredRoleForPath, roleAllows } = require('./viewer-headers');

const PLUGIN_ID = 'github-issues';

// The orchestrator's env contract (§4.8 / broker-config.js). `fallbacks` lets an
// operator run the broker standalone with GITHUB_ISSUES_* names while developing.
const cfg = brokerConfig({
  fallbacks: {
    port: ['GITHUB_ISSUES_BROKER_PORT'],
    signingSecret: ['GITHUB_ISSUES_BROKER_SIGNING_SECRET'],
    stateDir: ['GITHUB_ISSUES_STATE_DIR'],
    auditDir: ['GITHUB_ISSUES_AUDIT_DIR'],
  },
});
const PORT = cfg.port || 4008;
const SIGNING_SECRET = cfg.signingSecret;
const STATE_DIR = cfg.stateDir || '/plugin-state/github-issues';
const AUDIT_DIR = cfg.auditDir || '/workspace/plugin-audit/github-issues';

const store = new ScopeStore({ stateDir: STATE_DIR });
const audit = auditWriter(AUDIT_DIR, { retentionMs: 30 * 24 * 3600 * 1000 });

// scopeId -> teamName, pushed alongside the credentials so the UI can label the
// team selector without a second identity source.
const teamNames = new Map();

function writeAudit(scopeId, actor, subcommand, outcome, detail) {
  try {
    // ts is caller-supplied (buildPluginAuditLine is clock-free and drops a line
    // with no ts), so stamp it here — without it the write is silently a no-op.
    audit.write({ ts: new Date().toISOString(), pluginId: PLUGIN_ID, scopeId, agentId: actor || scopeId, subcommand, outcome, detail });
  } catch { /* audit is best-effort, never gates a call */ }
}

// ── small http helpers (netzplan-broker style) ──────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => resolve(s));
    req.on('error', () => resolve(s));
  });
}
function parseJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function query(req) {
  const q = (req.url || '').split('?')[1] || '';
  return new URLSearchParams(q);
}

// ── the served UI + its data API (viewer-header authed) ──────────────────────

// Resolve the team the request targets. It must be one of the viewer's signed
// team ids (authorization), and default to the single team / last-used team.
function pickTeam(viewer, requested) {
  const allowed = Array.isArray(viewer.teamIds) ? viewer.teamIds : [];
  if (requested && allowed.includes(requested)) return requested;
  if (!requested && allowed.length === 1) return allowed[0];
  return null;
}

function teamContext(scopeId) {
  const { repos, hasToken, known } = store.reposFor(scopeId);
  const creds = store.credsFor(scopeId);
  return {
    teamId: scopeId,
    teamName: teamNames.get(scopeId) || scopeId,
    repos,
    hasToken,
    known,
    flowLabels: (creds && Array.isArray(creds.flowLabels)) ? creds.flowLabels : [],
    labelAgents: (creds && creds.labelAgents && typeof creds.labelAgents === 'object') ? creds.labelAgents : {},
    labelUsage: (creds && creds.labelUsage && typeof creds.labelUsage === 'object') ? creds.labelUsage : {},
  };
}

// The per-repo label→agent trigger preview (#1642, AC6–8): `{ [label]: [name] }`
// for the selected repo, plus the any-label listeners under '' so the UI can
// fold them into every label. Repo-scoped because a trigger is repo-specific.
function labelAgentsForRepo(scopeId, repo) {
  const all = teamContext(scopeId).labelAgents;
  const forRepo = (all && all[repo]) || {};
  return (forRepo && typeof forRepo === 'object') ? forRepo : {};
}

async function handleUiApi(req, res, apiPath, viewer) {
  const params = query(req);
  const actor = viewer.sub || 'unknown';

  // Discovery: the viewer's authorized teams (with repos + token state) and their
  // last-used selection — everything the selector + pre-selection (AC3–AC5) need.
  if (apiPath === '/context' && req.method === 'GET') {
    // Each team carries its OWN last selection (lastRepo/lastState) so switching
    // back to an older project restores that project's own view (#1650 open-q1);
    // `lastUsed` is the globally most-recently-used one, restored on reopen.
    const teams = (viewer.teamIds || []).map((id) => {
      const ctx = teamContext(id);
      const pref = store.loadPref(id, actor);
      return Object.assign(ctx, {
        lastRepo: (pref && pref.repo) || null,
        lastState: (pref && pref.state) || null,
      });
    });
    const lastUsed = store.pickLastUsed(viewer.teamIds || [], actor);
    return sendJson(res, 200, { user: actor, teams, lastUsed });
  }

  // Writes (POST) carry their selection in the JSON body — the same place this
  // handler already reads `repo` from — while reads carry it in the query string.
  // Read the body once up front so the team is resolved consistently from either
  // source; without this a multi-team viewer's POST has no `team` query param and
  // pickTeam rejects it (#1651).
  const body = req.method === 'POST' ? parseJson(await readBody(req)) : {};

  // Everything below acts within one team+repo. Resolve + authorize both.
  const team = pickTeam(viewer, body.team || params.get('team'));
  if (!team) return sendJson(res, 400, { error: 'select a team you are a member of' });
  const repo = params.get('repo') || body.repo || '';

  if (apiPath === '/issues' && req.method === 'GET') {
    if (!repo) return sendJson(res, 400, { error: 'a repository is required' });
    const token = store.tokenForRepo(team, repo);
    if (!token) return void tokenErr(res, team, repo);
    const state = gh.normState(params.get('state'));
    const page = Number(params.get('page')) || 1;
    try {
      const { data } = await gh.call('list_issues', { repo, state, page, perPage: gh.DEFAULT_PER_PAGE }, { token });
      const issues = gh.shapeIssueList(data);
      // remember this team+repo for next visit (AC5)
      store.savePref(team, actor, { repo, state, updatedAt: nowIso() });
      writeAudit(team, actor, 'list', 'ok', repo);
      return sendJson(res, 200, { issues, page, hasMore: Array.isArray(data) && data.length >= gh.DEFAULT_PER_PAGE });
    } catch (err) {
      writeAudit(team, actor, 'list', 'error', repo);
      return sendJson(res, err.status || 502, { error: err.message });
    }
  }

  // Server-side title search over the WHOLE repo via GitHub's Search API (#1658),
  // so matches surface from any page, not just already-loaded issues. Ephemeral —
  // never persisted as a last-used pref. `hasMore` honours GitHub's 1000-result
  // search cap so the pager can't walk into a 422.
  if (apiPath === '/search' && req.method === 'GET') {
    if (!repo) return sendJson(res, 400, { error: 'a repository is required' });
    const token = store.tokenForRepo(team, repo);
    if (!token) return void tokenErr(res, team, repo);
    const text = params.get('q') || '';
    const state = gh.normState(params.get('state'));
    const page = Number(params.get('page')) || 1;
    const perPage = gh.DEFAULT_PER_PAGE;
    try {
      const { data } = await gh.call('search_issues', { repo, text, state, page, perPage }, { token });
      const shaped = gh.shapeSearchResult(data);
      const hasMore = shaped.issues.length >= perPage && page * perPage < 1000;
      writeAudit(team, actor, 'search', 'ok', repo);
      return sendJson(res, 200, {
        issues: shaped.issues, page, hasMore,
        totalCount: shaped.totalCount, incompleteResults: shaped.incompleteResults,
      });
    } catch (err) {
      writeAudit(team, actor, 'search', 'error', repo);
      return sendJson(res, err.status || 502, { error: err.message });
    }
  }

  if (apiPath === '/issue' && req.method === 'GET') {
    const number = Number(params.get('number'));
    const token = store.tokenForRepo(team, repo);
    if (!token) return void tokenErr(res, team, repo);
    try {
      const { data } = await gh.call('get_issue', { repo, number }, { token });
      writeAudit(team, actor, 'show', 'ok', `${repo}#${number}`);
      return sendJson(res, 200, { issue: gh.shapeIssue(data) });
    } catch (err) {
      writeAudit(team, actor, 'show', 'error', `${repo}#${number}`);
      return sendJson(res, err.status || 502, { error: err.message });
    }
  }

  // Suggested labels: the team's flow gate labels first (pushed), enriched with
  // the repo's existing label definitions. Free-text is still allowed on write.
  if (apiPath === '/labels' && req.method === 'GET') {
    const token = store.tokenForRepo(team, repo);
    if (!token) return void tokenErr(res, team, repo);
    const ctx = teamContext(team);
    const flowLabels = ctx.flowLabels;
    const labelUsage = ctx.labelUsage;
    const labelAgents = labelAgentsForRepo(team, repo);
    let repoLabels = [];
    try {
      const { data } = await gh.call('list_labels', { repo }, { token });
      repoLabels = Array.isArray(data) ? data.map(gh.shapeLabel) : [];
    } catch { /* suggestions are best-effort; free-text still works */ }
    return sendJson(res, 200, { flowLabels, repoLabels, labelAgents, labelUsage });
  }

  if (apiPath === '/label' && req.method === 'POST') {
    const number = Number(body.number);
    const label = String(body.label || '').trim();
    const action = body.action === 'remove' ? 'remove' : 'add';
    const bRepo = String(body.repo || repo || '');
    if (!label) return sendJson(res, 400, { error: 'a label is required' });
    const token = store.tokenForRepo(team, bRepo);
    if (!token) return void tokenErr(res, team, bRepo);
    try {
      await gh.call(action === 'remove' ? 'remove_label' : 'add_label', { repo: bRepo, number, label }, { token });
      // Re-fetch so the UI reflects GitHub's current labels without a full reload
      // (and never silently clobbers a concurrent change — the issue's edge case).
      const { data } = await gh.call('get_issue', { repo: bRepo, number }, { token });
      writeAudit(team, actor, action === 'remove' ? 'label-remove' : 'label-add', 'ok', `${bRepo}#${number}:${label}`);
      return sendJson(res, 200, { issue: gh.shapeIssue(data) });
    } catch (err) {
      writeAudit(team, actor, action === 'remove' ? 'label-remove' : 'label-add', 'error', `${bRepo}#${number}:${label}`);
      return sendJson(res, err.status || 502, { error: err.message });
    }
  }

  if (apiPath === '/pref' && req.method === 'POST') {
    store.savePref(team, actor, { repo: body.repo || null, state: body.state || null, updatedAt: nowIso() });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not found' });
}

function tokenErr(res, team, repo) {
  // Distinguish "no token bound to the environment" from "repo not in this team's
  // scope" so the UI can point the operator at configuring a token vs. re-selecting.
  const ctx = store.reposFor(team);
  if (!ctx.hasToken) {
    return sendJson(res, 400, {
      error: 'This team\'s Working Environment has no GitHub token configured. Ask an admin to add one on the GitHub Tokens page.',
      code: 'no-token',
    });
  }
  return sendJson(res, 403, {
    error: `Repository "${repo}" is not in this team's environment.`,
    code: 'repo-out-of-scope',
  });
}

async function handleUi(req, res, uiPath) {
  const viewer = verifyViewerHeaders(req, SIGNING_SECRET);
  if (!viewer) return sendJson(res, 401, { error: 'unsigned viewer' });
  const need = requiredRoleForPath(uiPath);
  if (!roleAllows(viewer.role, need)) {
    return sendJson(res, 403, { error: `route ${uiPath} requires ${need}; viewer is ${viewer.role}` });
  }

  if (uiPath === '/api' || uiPath.startsWith('/api/')) {
    const apiPath = uiPath.slice('/api'.length) || '/';
    return handleUiApi(req, res, apiPath, viewer);
  }

  // static assets: / → index.html, else a file under ui/
  const file = uiPath === '/' || uiPath === '' ? 'index.html' : uiPath.replace(/^\/+/, '');
  const abs = path.join(__dirname, 'ui', file);
  if (!abs.startsWith(path.join(__dirname, 'ui') + path.sep)) return sendJson(res, 404, { error: 'not found' });
  fs.readFile(abs, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': contentType(abs) });
    res.end(data);
  });
}

// ── the agent CLI surface (read-only in MVP; scope-token authed) ─────────────
async function handleCli(req, res, cliPath) {
  const v = verifyScopeToken(req, SIGNING_SECRET);
  if (!v || v.pluginId !== PLUGIN_ID) return sendJson(res, 401, { error: 'unauthorized' });
  const scopeId = v.scopeId;
  const params = query(req);

  if (cliPath === '/repos' && req.method === 'GET') {
    const { repos, hasToken } = store.reposFor(scopeId);
    writeAudit(scopeId, scopeId, 'repos', 'ok');
    return sendJson(res, 200, { repos, hasToken });
  }
  const repo = params.get('repo') || '';
  const token = store.tokenForRepo(scopeId, repo);
  if (cliPath === '/list' && req.method === 'GET') {
    if (!token) { writeAudit(scopeId, scopeId, 'list', 'denied', repo); return sendJson(res, 400, { error: 'unknown repo or no token in scope' }); }
    try {
      const { data } = await gh.call('list_issues', { repo, state: gh.normState(params.get('state')), page: Number(params.get('page')) || 1 }, { token });
      writeAudit(scopeId, scopeId, 'list', 'ok', repo);
      return sendJson(res, 200, { issues: gh.shapeIssueList(data) });
    } catch (err) {
      writeAudit(scopeId, scopeId, 'list', 'error', repo);
      return sendJson(res, err.status || 502, { error: err.message });
    }
  }
  if (cliPath === '/show' && req.method === 'GET') {
    if (!token) { writeAudit(scopeId, scopeId, 'show', 'denied', repo); return sendJson(res, 400, { error: 'unknown repo or no token in scope' }); }
    try {
      const { data } = await gh.call('get_issue', { repo, number: Number(params.get('number')) }, { token });
      writeAudit(scopeId, scopeId, 'show', 'ok', repo);
      return sendJson(res, 200, { issue: gh.shapeIssue(data) });
    } catch (err) {
      writeAudit(scopeId, scopeId, 'show', 'error', repo);
      return sendJson(res, err.status || 502, { error: err.message });
    }
  }
  return sendJson(res, 404, { error: 'not found' });
}

function contentType(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}
function nowIso() { return new Date().toISOString(); }

const handleHealth = healthEndpoint(async () => ({ scopes: store.creds.size }));
const handleTeardown = teardownScopeEndpoint((scopeId) => {
  teamNames.delete(String(scopeId));
  return { reaped: store.teardown(scopeId) };
}, { secret: SIGNING_SECRET });

async function handleRequest(req, res) {
  const urlPath = (req.url || '').split('?')[0];

  if (req.method === 'GET' && urlPath === '/healthz') return void (await handleHealth(req, res));
  if (req.method === 'POST' && urlPath === '/internal/teardown-scope') return void (await handleTeardown(req, res));

  // Per-scope credential + repo push from the orchestrator (§4.8 push shape,
  // like teardown-scope): bearer-authed with a minted scope token. Replaces the
  // whole in-memory map so a revoked team simply disappears from it.
  if (req.method === 'PUT' && urlPath === '/internal/scope-credentials') {
    const v = verifyScopeToken(req, SIGNING_SECRET);
    if (!v) return void sendJson(res, 401, { error: 'unauthorized' });
    const parsed = parseJson(await readBody(req));
    const scopes = parsed.scopes || {};
    store.setCredentials(scopes);
    teamNames.clear();
    for (const [scopeId, entry] of Object.entries(scopes)) {
      if (entry && entry.teamName) teamNames.set(String(scopeId), String(entry.teamName));
    }
    return void sendJson(res, 200, { ok: true, scopes: store.creds.size });
  }

  if (urlPath === '/ui' || urlPath.startsWith('/ui/')) {
    const uiPath = urlPath === '/ui' ? '/' : urlPath.slice('/ui'.length) || '/';
    return void (await handleUi(req, res, uiPath));
  }

  if (urlPath === '/cli' || urlPath.startsWith('/cli/')) {
    const cliPath = urlPath === '/cli' ? '/' : urlPath.slice('/cli'.length) || '/';
    return void (await handleCli(req, res, cliPath));
  }

  return void sendJson(res, 404, { error: 'not found' });
}

const httpServer = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    try { res.end(JSON.stringify({ error: (err && err.message) || String(err) })); } catch { /* ignore */ }
  });
});

if (require.main === module) {
  httpServer.listen(PORT, () => process.stdout.write(`[github-issues-broker] listening on :${PORT}\n`));
}

module.exports = { store, teamNames, handleRequest, httpServer, audit, PLUGIN_ID, SIGNING_SECRET };
