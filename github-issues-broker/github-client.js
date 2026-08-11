'use strict';

// ─── github-issues broker: GitHub client (plugin, issue #1633) ───────────────
//
// The one place the GitHub REST surface and the env's GitHub token are named.
// The broker holds the token (pushed per-scope by the orchestrator from the
// team's Working Environment, orchestrator/plugin-github-creds.js); the browser
// and the agent never see it — that containment is why this is a plugin (§8).
//
// Request-shaping (buildRequest), response-shaping (shapeIssue / shapeIssueList
// / shapeLabel) and error mapping (mapGithubError) are pure and dependency-free
// so they unit-test without a live GitHub; `call` is the thin async adapter that
// injects the credential + API base and performs the HTTP request with the
// runtime `fetch`. This mirrors test-mgmt-broker/vendor-client.js and
// podman-mcp's compose-validate.js — pure core separate from the I/O edge.

const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;

// Parse an "owner/name" repo full name. Returns { owner, name } or null. Keeps
// the broker from ever interpolating an unvalidated string into a REST path.
function parseRepoFullName(full) {
  if (typeof full !== 'string') return null;
  const m = full.trim().match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

// Normalise a requested issue state to the GitHub-accepted set.
function normState(state) {
  const s = String(state || 'open').toLowerCase();
  return s === 'closed' || s === 'all' ? s : 'open';
}

function clampPerPage(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1) return DEFAULT_PER_PAGE;
  return Math.min(v, MAX_PER_PAGE);
}

function clampPage(n) {
  const v = Number(n);
  return Number.isInteger(v) && v > 0 ? v : 1;
}

// Build the GitHub HTTP request for one broker operation. Returns
// `{ method, path }` — the caller prefixes the API base and adds auth. Every
// path component derived from user input is encodeURIComponent'd and the repo is
// validated by parseRepoFullName first, so no argument can reshape the path.
function buildRequest(op, args = {}) {
  const parsed = parseRepoFullName(args.repo);
  if (!parsed) throw new Error(`invalid repository "${String(args.repo)}" (expected owner/name)`);
  const { owner, name } = parsed;
  const seg = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  switch (op) {
    case 'list_issues': {
      const per = clampPerPage(args.perPage);
      const page = clampPage(args.page);
      const state = normState(args.state);
      return {
        method: 'GET',
        path: `${seg}/issues?state=${state}&per_page=${per}&page=${page}`,
      };
    }
    case 'get_issue':
      return { method: 'GET', path: `${seg}/issues/${encodeInt(args.number)}` };
    case 'list_labels':
      return { method: 'GET', path: `${seg}/labels?per_page=${MAX_PER_PAGE}` };
    case 'add_label':
      return {
        method: 'POST',
        path: `${seg}/issues/${encodeInt(args.number)}/labels`,
        body: { labels: [requireLabel(args.label)] },
      };
    case 'remove_label':
      return {
        method: 'DELETE',
        path: `${seg}/issues/${encodeInt(args.number)}/labels/${encodeURIComponent(requireLabel(args.label))}`,
      };
    default:
      throw new Error(`unknown github operation: ${op}`);
  }
}

function encodeInt(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1) throw new Error(`invalid issue number "${String(n)}"`);
  return String(v);
}

function requireLabel(label) {
  const s = typeof label === 'string' ? label.trim() : '';
  if (!s) throw new Error('a non-empty label is required');
  return s;
}

// A GitHub /issues response entry that carries `pull_request` IS a pull request
// (the /issues endpoint returns both; MVP is issues-only, PRs deferred).
function isPullRequest(raw) {
  return !!(raw && raw.pull_request);
}

function shapeLabel(raw) {
  if (typeof raw === 'string') return { name: raw, color: null, description: null };
  if (!raw || typeof raw !== 'object') return { name: '', color: null, description: null };
  return {
    name: String(raw.name || ''),
    color: raw.color ? String(raw.color) : null,
    description: raw.description ? String(raw.description) : null,
  };
}

// Shape one raw GitHub issue into the narrow object the UI/agent consume — no
// token, no unbounded nested payloads.
function shapeIssue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    number: Number(raw.number),
    title: String(raw.title || ''),
    state: String(raw.state || ''),
    body: raw.body == null ? '' : String(raw.body),
    labels: Array.isArray(raw.labels) ? raw.labels.map(shapeLabel) : [],
    user: raw.user && raw.user.login ? String(raw.user.login) : null,
    comments: Number.isFinite(raw.comments) ? raw.comments : 0,
    createdAt: raw.created_at || null,
    updatedAt: raw.updated_at || null,
    htmlUrl: raw.html_url || null,
    isPullRequest: isPullRequest(raw),
  };
}

// Shape + filter a raw /issues list: drop pull requests (MVP is issues-only).
function shapeIssueList(rawArr) {
  if (!Array.isArray(rawArr)) return [];
  return rawArr.filter((r) => !isPullRequest(r)).map(shapeIssue).filter(Boolean);
}

// Map a GitHub HTTP failure to a clear, actionable message (never a raw 4xx).
function mapGithubError(status, body, { op } = {}) {
  const ghMsg = body && typeof body === 'object' && body.message ? String(body.message) : '';
  switch (status) {
    case 401:
      return 'The GitHub token for this environment was rejected (401). Ask an admin to check or rotate it.';
    case 403:
      if (/rate limit/i.test(ghMsg)) return 'GitHub rate limit reached — try again shortly.';
      return 'The GitHub token lacks permission for this action (403). It may need "repo" / "issues" scope.';
    case 404:
      return op === 'remove_label'
        ? 'That label is not on the issue (nothing to remove).'
        : 'The requested repository or issue was not found (404), or the token cannot see it.';
    case 422:
      return ghMsg ? `GitHub rejected the request: ${ghMsg}` : 'GitHub rejected the request (422).';
    default:
      return ghMsg ? `GitHub error (${status}): ${ghMsg}` : `GitHub error (HTTP ${status}).`;
  }
}

function apiBaseFrom(env = process.env) {
  const raw = (env && env.GITHUB_API_BASE) || DEFAULT_GITHUB_API_BASE;
  return String(raw).replace(/\/+$/, '');
}

// Thin async adapter: perform the request against GitHub. The credential is
// supplied by the broker (never returned to the caller) and injected as a
// bearer token. Uses the runtime global `fetch` (Node ≥18 / the sidecar image).
//
// Returns `{ status, data }` for a 2xx. Removing a label that is absent (404 on
// remove_label) is treated as a no-op success, per the issue's "already
// absent → no-op" edge case. Any other non-2xx throws a mapped Error.
async function call(op, args, { token, apiBase } = {}) {
  const base = apiBase || apiBaseFrom();
  const spec = buildRequest(op, args);
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agent-studio-github-issues-plugin',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (spec.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(base + spec.path, {
    method: spec.method,
    headers,
    body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    if (op === 'remove_label' && res.status === 404) return { status: 200, data: null, noop: true };
    const err = new Error(mapGithubError(res.status, data, { op }));
    err.status = res.status;
    throw err;
  }
  return { status: res.status, data };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = {
  DEFAULT_GITHUB_API_BASE,
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
  parseRepoFullName,
  normState,
  buildRequest,
  isPullRequest,
  shapeLabel,
  shapeIssue,
  shapeIssueList,
  mapGithubError,
  apiBaseFrom,
  call,
};
