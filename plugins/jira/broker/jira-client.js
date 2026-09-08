'use strict';

// ─── jira broker: Jira Cloud REST client ─────────────────────────────────────
//
// The one place the Jira Cloud REST surface and the per-scope credential
// ({siteUrl, email, apiToken}) are named. The broker holds the credential
// (pushed per-scope by the orchestrator, or read from env for the Phase-0
// spike); the browser and the agent never see it — that containment is why
// Jira is a plugin and not an MCP registry entry (docs/jira-plugin-plan.md §2).
//
// Request-shaping (buildJqlSearchBody / changelogPath), response-shaping
// (shapeIssue) and error mapping (mapJiraError) are pure and dependency-free so
// they unit-test without a live Jira; `search` / `fetchChangelog` are the thin
// async adapters that inject Basic auth + the API base and perform the HTTP
// request with the runtime `fetch`. Same pure-core / I/O-edge split as
// github-issues-broker/github-client.js and test-mgmt-broker/vendor-client.js.

const { resolveJiraApiBase } = require('./event-extract');

// One JQL search page is 100 issues; MAX_PAGES caps total issues considered for
// a single project in a single poll (100 × 20 = 2000) — generous enough that a
// legitimate result is never cut short, cheap enough to never spiral.
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

// Basic-auth header for `email:apiToken`. Jira Cloud's REST v3 uses Basic auth
// with the Atlassian account e-mail as the username and an API token as the
// password.
function basicAuthHeader(email, apiToken) {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
}

// The `updated >= -Nm` JQL for one project, oldest-first so fan-out order is
// chronological. `projectKey` is quoted and its embedded quotes escaped so it
// can never break out of the clause.
function buildProjectJql(projectKey, windowMinutes) {
  const key = String(projectKey || '').replace(/"/g, '\\"');
  const mins = Number.isFinite(windowMinutes) && windowMinutes > 0 ? Math.ceil(windowMinutes) : 10;
  return `project = "${key}" AND updated >= -${mins}m ORDER BY updated ASC`;
}

// Body for POST /rest/api/3/search/jql (the "enhanced JQL search" that replaced
// the deprecated /rest/api/3/search). We only ever need summary + status fields
// and the changelog expansion.
//
// NOTE: on THIS endpoint `expand` is a comma-delimited STRING, not the array
// the old /search endpoint took — passing an array is a 400 "Invalid request
// payload". (The reverted PR #1539 had the array form; its fake Jira never
// caught it, this spike did.)
function buildJqlSearchBody(jql, nextPageToken) {
  const body = {
    jql,
    fields: ['summary', 'status'],
    expand: 'changelog',
    maxResults: PAGE_SIZE,
  };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  return body;
}

function changelogPath(issueKey, startAt = 0) {
  return `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog?startAt=${Number(startAt) || 0}&maxResults=${PAGE_SIZE}`;
}

// Narrow the raw search issue to what the poller and the CLI consume.
function shapeIssue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fields = raw.fields || {};
  const status = fields.status && fields.status.name ? String(fields.status.name) : null;
  return {
    key: String(raw.key || ''),
    summary: fields.summary == null ? '' : String(fields.summary),
    status,
    changelog: raw.changelog || null,
  };
}

// Map a Jira HTTP failure to a clear, actionable message (never a raw 4xx body).
function mapJiraError(status, bodyText) {
  const snippet = typeof bodyText === 'string' ? bodyText.slice(0, 200) : '';
  switch (status) {
    case 400:
      return `Jira rejected the request (400)${snippet ? `: ${snippet}` : ''}. The project key or JQL may be invalid.`;
    case 401:
      return 'Jira rejected the credential (401). Check the account e-mail and API token for this scope.';
    case 403:
      return 'The Jira account lacks permission for this project or action (403).';
    case 404:
      return 'The Jira project or issue was not found (404), or the account cannot see it.';
    case 429:
      return 'Jira rate limit reached (429) — backing off.';
    default:
      return `Jira error (HTTP ${status})${snippet ? `: ${snippet}` : ''}.`;
  }
}

// The API base for a client, from a stored siteUrl or the JIRA_API_BASE test
// seam (mirrors github-client's GITHUB_API_BASE). An explicit seam always wins
// so a fixture host is reachable without touching the credential shape.
function apiBaseFor(siteUrl, env = process.env) {
  const seam = env && env.JIRA_API_BASE;
  if (seam) return String(seam).replace(/\/+$/, '');
  return resolveJiraApiBase(siteUrl);
}

const REQUEST_TIMEOUT_MS = 20_000;

// One HTTP attempt with a hard timeout. A transport failure (undici's
// `TypeError: fetch failed` — DNS, TLS, a stale pooled socket in a long-running
// process) is rethrown with its `cause` folded into the message so the poller
// log is actionable.
async function attempt({ base, path: reqPath, method, headers, payload }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(base + reqPath, { method, headers, body: payload, signal: ctrl.signal });
  } catch (err) {
    const cause = err && err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
    const wrapped = new Error(`${err.message}${cause}`);
    wrapped.transport = true;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(mapJiraError(res.status, text));
    e.status = res.status;
    throw e;
  }
  return text ? safeJson(text) : {};
}

async function requestJson({ base, path: reqPath, method = 'GET', authHeader, body }) {
  const headers = { Accept: 'application/json', 'User-Agent': 'agent-studio-jira-plugin' };
  if (authHeader) headers.Authorization = authHeader;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const args = { base, path: reqPath, method, headers, payload };
  try {
    return await attempt(args);
  } catch (err) {
    // Retry ONCE on a transport failure — a stale keep-alive socket is gone on
    // the second try. An HTTP error (has .status) is not retried.
    if (err.transport) return attempt(args);
    throw err;
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// One credential = { siteUrl, email, apiToken }. Every method takes it plus an
// optional `env` for the JIRA_API_BASE seam.

// All issues updated within `windowMinutes` for one project, paginated to
// MAX_PAGES. Each issue carries its (possibly truncated) changelog.
async function searchProjectIssues(cred, { projectKey, windowMinutes, env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const jql = buildProjectJql(projectKey, windowMinutes);
  const issues = [];
  let nextPageToken;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await requestJson({
      base,
      path: '/rest/api/3/search/jql',
      method: 'POST',
      authHeader: auth,
      body: buildJqlSearchBody(jql, nextPageToken),
    });
    const pageIssues = Array.isArray(result.issues) ? result.issues : [];
    for (const raw of pageIssues) {
      const shaped = shapeIssue(raw);
      if (shaped && shaped.key) issues.push(shaped);
    }
    if (result.isLast !== false || !result.nextPageToken) break;
    nextPageToken = result.nextPageToken;
  }
  return issues;
}

// The full, paginated changelog for one issue — only called for issues whose
// search-response changelog was truncated (rare, bounded to those issues).
async function fetchFullChangelog(cred, issueKey, { env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const histories = [];
  let startAt = 0;
  for (;;) {
    const page = await requestJson({ base, path: changelogPath(issueKey, startAt), authHeader: auth });
    const values = Array.isArray(page.values) ? page.values : [];
    histories.push(...values);
    startAt += values.length;
    if (page.isLast || values.length === 0 || (typeof page.total === 'number' && startAt >= page.total)) break;
  }
  return histories;
}

// Read one issue (CLI `show`). Narrow shape, with the browse URL.
async function getIssue(cred, issueKey, { env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const raw = await requestJson({
    base,
    path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,status,description,assignee`,
    authHeader: auth,
  });
  const fields = raw.fields || {};
  return {
    key: String(raw.key || issueKey),
    summary: fields.summary == null ? '' : String(fields.summary),
    status: fields.status && fields.status.name ? String(fields.status.name) : null,
    assignee: fields.assignee && fields.assignee.displayName ? String(fields.assignee.displayName) : null,
    url: `${resolveJiraApiBase(cred.siteUrl)}/browse/${encodeURIComponent(raw.key || issueKey)}`,
  };
}

// Which Atlassian account the credential authenticates as (GET /myself) — the
// definitive check for an email/token mismatch (spike diagnostics).
async function whoAmI(cred, { env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const me = await requestJson({ base, path: '/rest/api/3/myself', authHeader: auth });
  return {
    accountId: me.accountId || null,
    emailAddress: me.emailAddress || null,   // often hidden by account privacy settings → null
    displayName: me.displayName || null,
    active: me.active !== false,
    locale: me.locale || null,
  };
}

// The projects the credential's user can see (CLI `projects`; spike diagnostics).
// Paginated `/rest/api/3/project/search`.
async function listProjects(cred, { env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const projects = [];
  let startAt = 0;
  for (;;) {
    const page = await requestJson({
      base,
      path: `/rest/api/3/project/search?startAt=${startAt}&maxResults=50`,
      authHeader: auth,
    });
    const values = Array.isArray(page.values) ? page.values : [];
    for (const p of values) projects.push({ key: p.key, name: p.name, id: p.id, type: p.projectTypeKey });
    startAt += values.length;
    if (page.isLast || values.length === 0 || (typeof page.total === 'number' && startAt >= page.total)) break;
  }
  return projects;
}

// A project's issues, most-recently-updated first, optionally filtered to one
// current status (CLI `list`). `status` is quoted + escaped so it can never
// break out of the clause. Capped at one page (PAGE_SIZE) — an agent browsing a
// project does not need 2000 rows.
async function listProjectIssues(cred, { projectKey, status, env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const key = String(projectKey || '').replace(/"/g, '\\"');
  let jql = `project = "${key}"`;
  if (typeof status === 'string' && status.trim()) {
    jql += ` AND status = "${status.trim().replace(/"/g, '\\"')}"`;
  }
  jql += ' ORDER BY updated DESC';
  const result = await requestJson({
    base,
    path: '/rest/api/3/search/jql',
    method: 'POST',
    authHeader: auth,
    body: { jql, fields: ['summary', 'status', 'assignee', 'updated'], maxResults: PAGE_SIZE },
  });
  const siteBase = resolveJiraApiBase(cred.siteUrl);
  return (Array.isArray(result.issues) ? result.issues : []).map((raw) => {
    const f = raw.fields || {};
    return {
      key: String(raw.key || ''),
      summary: f.summary == null ? '' : String(f.summary),
      status: f.status && f.status.name ? String(f.status.name) : null,
      assignee: f.assignee && f.assignee.displayName ? String(f.assignee.displayName) : null,
      updated: f.updated || null,
      url: `${siteBase}/browse/${encodeURIComponent(raw.key || '')}`,
    };
  });
}

// Run an arbitrary JQL (spike diagnostics only — `probe --jql`). Same shaping as
// searchProjectIssues but the caller owns the whole query.
async function searchJql(cred, jql, { env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const issues = [];
  let nextPageToken;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await requestJson({
      base,
      path: '/rest/api/3/search/jql',
      method: 'POST',
      authHeader: auth,
      body: buildJqlSearchBody(jql, nextPageToken),
    });
    for (const raw of Array.isArray(result.issues) ? result.issues : []) {
      const shaped = shapeIssue(raw);
      if (shaped && shaped.key) issues.push(shaped);
    }
    if (result.isLast !== false || !result.nextPageToken) break;
    nextPageToken = result.nextPageToken;
  }
  return issues;
}

// ── attributed writes (Phase 4, D3 — role-gated, not confirmation-gated) ─────

// A minimal Atlassian Document Format wrapper for a plain-text comment body.
// `attribution` is prepended as its own paragraph so a human reading the issue
// can see the comment came from an agent (the scope token names only the team,
// so this is "an agent on team <x>", never a spoofable agent id).
function commentAdf(text, attribution) {
  const paras = [];
  if (attribution) {
    paras.push({ type: 'paragraph', content: [{ type: 'text', text: attribution, marks: [{ type: 'em' }] }] });
  }
  for (const line of String(text || '').split('\n')) {
    paras.push({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] });
  }
  return { type: 'doc', version: 1, content: paras };
}

async function addComment(cred, issueKey, { body, attribution, env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const res = await requestJson({
    base,
    path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
    method: 'POST',
    authHeader: auth,
    body: { body: commentAdf(body, attribution) },
  });
  return { id: res.id || null, issueKey };
}

// The transitions available from the issue's CURRENT status, as
// `[{ id, name, toStatus }]` (CLI/UI needs the names to offer a choice).
async function listTransitions(cred, issueKey, { env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const res = await requestJson({
    base,
    path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    authHeader: auth,
  });
  return (Array.isArray(res.transitions) ? res.transitions : []).map((t) => ({
    id: String(t.id),
    name: String(t.name || ''),
    toStatus: t.to && t.to.name ? String(t.to.name) : null,
  }));
}

// Move an issue to the status named `toStatus`. Resolves the transition id from
// the available transitions (Jira has no "set status" — you apply a transition),
// matching case-insensitively on the transition name OR its target status name.
// Throws a clear domain error if no transition leads there from where the issue
// currently is.
async function transitionIssue(cred, issueKey, { toStatus, env } = {}) {
  const want = String(toStatus || '').trim().toLowerCase();
  if (!want) { const e = new Error('a target status is required'); e.status = 400; throw e; }
  const available = await listTransitions(cred, issueKey, { env });
  const match = available.find((t) => t.name.toLowerCase() === want || (t.toStatus || '').toLowerCase() === want);
  if (!match) {
    const e = new Error(
      `no transition to "${toStatus}" from the issue's current status. Available: `
      + (available.map((t) => `${t.name}${t.toStatus ? ` → ${t.toStatus}` : ''}`).join(', ') || '(none)'),
    );
    e.status = 409;
    throw e;
  }
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  await requestJson({
    base,
    path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    method: 'POST',
    authHeader: auth,
    body: { transition: { id: match.id } },
  });
  return { issueKey, applied: match.name, toStatus: match.toStatus };
}

module.exports = {
  MAX_PAGES,
  PAGE_SIZE,
  basicAuthHeader,
  buildProjectJql,
  buildJqlSearchBody,
  changelogPath,
  shapeIssue,
  commentAdf,
  mapJiraError,
  apiBaseFor,
  whoAmI,
  searchProjectIssues,
  listProjectIssues,
  searchJql,
  fetchFullChangelog,
  getIssue,
  listProjects,
  addComment,
  listTransitions,
  transitionIssue,
};
