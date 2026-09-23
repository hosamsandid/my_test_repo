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

// Attachment reads (#2399). `show` lists at most ATTACHMENT_LIST_CAP items so a
// screenshot-heavy issue's output stays usable (the count still reports the
// true total); `attachment get` refuses a file over ATTACHMENT_MAX_BYTES rather
// than buffer an arbitrarily large body through the broker + the CLI's stdout.
const ATTACHMENT_LIST_CAP = 50;
const ATTACHMENT_MAX_BYTES = Number(process.env.JIRA_ATTACHMENT_MAX_BYTES) || 10 * 1024 * 1024;

// Attachment writes (#2408). The upload cap mirrors the read side's but is its
// own configurable knob (a site may want a different ceiling for what agents
// push back than for what they pull) — a file over it is refused before the
// multipart body is built. Jira's own instance limit may be lower; that surfaces
// as a mapped HTTP error from the upload itself.
const ATTACHMENT_UPLOAD_MAX_BYTES = Number(process.env.JIRA_ATTACHMENT_UPLOAD_MAX_BYTES) || 10 * 1024 * 1024;

// Basic-auth header for `email:apiToken`. Jira Cloud's REST v3 uses Basic auth
// with the Atlassian account e-mail as the username and an API token as the
// password.
function basicAuthHeader(email, apiToken) {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
}

// Quote a value for a JQL string literal. Inside JQL quotes `\` is the escape
// character, so backslashes MUST be doubled before the quotes are escaped —
// otherwise a bare `\"` becomes `\\"` (a literal backslash + an unescaped quote)
// and the caller-supplied value breaks out of the clause.
function jqlQuote(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The `updated >= -Nm` JQL for one project, oldest-first so fan-out order is
// chronological. `projectKey` goes through `jqlQuote` so it can never break out
// of the clause.
function buildProjectJql(projectKey, windowMinutes) {
  const mins = Number.isFinite(windowMinutes) && windowMinutes > 0 ? Math.ceil(windowMinutes) : 10;
  return `project = ${jqlQuote(projectKey)} AND updated >= -${mins}m ORDER BY updated ASC`;
}

// Body for POST /rest/api/3/search/jql (the "enhanced JQL search" that replaced
// the deprecated /rest/api/3/search). We need summary + status + issuetype (so
// the Activity view can group / filter status changes by ticket kind — story /
// bug / task) and the changelog expansion.
//
// NOTE: on THIS endpoint `expand` is a comma-delimited STRING, not the array
// the old /search endpoint took — passing an array is a 400 "Invalid request
// payload". (The reverted PR #1539 had the array form; its fake Jira never
// caught it, this spike did.)
function buildJqlSearchBody(jql, nextPageToken) {
  const body = {
    jql,
    fields: ['summary', 'status', 'issuetype'],
    expand: 'changelog',
    maxResults: PAGE_SIZE,
  };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  return body;
}

// The issue-type name from a raw issue's `fields.issuetype` (Story / Bug / Task /
// Sub-task / …), or null when the field was not requested or is absent.
function issueTypeOf(fields) {
  return fields && fields.issuetype && fields.issuetype.name ? String(fields.issuetype.name) : null;
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
    issueType: issueTypeOf(fields),
    changelog: raw.changelog || null,
  };
}

// Narrow a raw Jira attachment (from `fields.attachment[]`) to the metadata an
// agent needs to decide whether to fetch it: filename, id, MIME type, size,
// author display name, when it landed, and the content URL (the broker fetches
// through it; the agent never sees the credential the URL needs).
function shapeAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id == null ? '' : raw.id);
  if (!id) return null;
  const size = Number(raw.size);
  return {
    id,
    filename: raw.filename == null ? '' : String(raw.filename),
    mimeType: raw.mimeType ? String(raw.mimeType) : null,
    size: Number.isFinite(size) ? size : 0,
    author: raw.author && raw.author.displayName ? String(raw.author.displayName) : null,
    created: raw.created ? String(raw.created) : null,
    contentUrl: raw.content ? String(raw.content) : null,
  };
}

// Textual extensions the agent can read inline even when Jira's MIME type is a
// generic `application/octet-stream` (Jira often mislabels `.md`/`.log`/`.json`).
const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'rst', 'log', 'json', 'ndjson', 'csv', 'tsv',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'html', 'htm',
  'css', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'sql', 'sh', 'bash', 'py', 'rb', 'go',
  'java', 'c', 'h', 'cpp', 'cs', 'diff', 'patch', 'env',
]);

// Whether an attachment is safe to return as inline UTF-8 text (AC5) vs base64
// (AC6). Decides on the MIME type first, then falls back to the filename's
// extension for the octet-stream case.
function isTextualAttachment(mimeType, filename) {
  const mt = String(mimeType || '').toLowerCase();
  if (mt.startsWith('text/')) return true;
  if (/^application\/(json|xml|xhtml\+xml|javascript|ecmascript|x-yaml|yaml|x-sh|x-shellscript|sql|toml|x-toml)(;|$)/.test(mt)) return true;
  if (/\+(json|xml)(;|$)/.test(mt)) return true;
  const ext = String(filename || '').toLowerCase().split('.').pop();
  return TEXT_EXTENSIONS.has(ext);
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
    case 413:
      return `The file is larger than this Jira instance allows (413)${snippet ? `: ${snippet}` : ''}.`;
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

// `idempotent` decides whether a transport failure is retried. Default: GET
// only. A POST that is really a read (Jira's `/search/jql`) opts in; a write
// (comment, description, transition) must NOT — a transport error, including
// the 20 s abort, can arrive AFTER Jira accepted the request, and a retry then
// posts the attribution comment twice or re-runs the transition (F6).
async function requestJson({ base, path: reqPath, method = 'GET', authHeader, body, idempotent }) {
  const headers = { Accept: 'application/json', 'User-Agent': 'agent-studio-jira-plugin' };
  if (authHeader) headers.Authorization = authHeader;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const args = { base, path: reqPath, method, headers, payload };
  const retryable = idempotent !== undefined ? !!idempotent : method === 'GET';
  try {
    return await attempt(args);
  } catch (err) {
    // Retry ONCE on a transport failure — a stale keep-alive socket is gone on
    // the second try. An HTTP error (has .status) is not retried, and neither
    // is a non-idempotent request.
    if (err.transport && retryable) return attempt(args);
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
      idempotent: true, // a read that happens to be a POST — safe to retry
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
    path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,status,description,assignee,issuetype,attachment,created,updated`,
    authHeader: auth,
  });
  const fields = raw.fields || {};
  const out = {
    key: String(raw.key || issueKey),
    summary: fields.summary == null ? '' : String(fields.summary),
    status: fields.status && fields.status.name ? String(fields.status.name) : null,
    issueType: issueTypeOf(fields),
    assignee: fields.assignee && fields.assignee.displayName ? String(fields.assignee.displayName) : null,
    // Issue timestamps (#2414) so an agent can filter/sort reads by age. Jira
    // returns ISO-8601 strings; surface them verbatim (null when absent).
    created: fields.created ? String(fields.created) : null,
    updated: fields.updated ? String(fields.updated) : null,
    url: `${resolveJiraApiBase(cred.siteUrl)}/browse/${encodeURIComponent(raw.key || issueKey)}`,
  };
  // Attachment metadata (#2399, AC1). Only surfaced when the issue actually has
  // attachments — an issue with none carries no `attachments` key at all, so the
  // shape is byte-identical to before for the common case (AC2/AC8, no noise).
  const attachments = (Array.isArray(fields.attachment) ? fields.attachment : [])
    .map(shapeAttachment)
    .filter((a) => a && a.id);
  if (attachments.length) {
    out.attachmentCount = attachments.length;
    out.attachments = attachments.slice(0, ATTACHMENT_LIST_CAP);
    if (attachments.length > ATTACHMENT_LIST_CAP) out.attachmentsTruncated = true;
  }
  return out;
}

// The full (uncapped) attachment list for one issue — the ownership check
// `getAttachment` runs before a download, kept separate from `getIssue` so the
// display cap there can never hide a valid id from the check.
async function getIssueAttachments(cred, issueKey, { env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const raw = await requestJson({
    base,
    path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=attachment`,
    authHeader: auth,
  });
  const fields = raw.fields || {};
  return (Array.isArray(fields.attachment) ? fields.attachment : [])
    .map(shapeAttachment)
    .filter((a) => a && a.id);
}

// Download one attachment's raw bytes from Jira's content endpoint. Jira Cloud
// 302/303-redirects `/attachment/content/{id}` to a signed media URL; `fetch`
// follows it and (per the Fetch spec) drops the Authorization header on the
// cross-origin hop — the signed URL needs no credential, so the token never
// leaves the first, same-origin request. A `Buffer` is returned so the caller
// decides text vs base64. Same idempotent-GET transport retry as the reads.
async function downloadAttachmentContent(cred, attachmentId, { env, maxBytes = ATTACHMENT_MAX_BYTES } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const reqPath = `/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`;
  const headers = { Accept: '*/*', 'User-Agent': 'agent-studio-jira-plugin', Authorization: auth };
  const doAttempt = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(base + reqPath, { method: 'GET', headers, redirect: 'follow', signal: ctrl.signal });
    } catch (err) {
      const cause = err && err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
      const wrapped = new Error(`${err.message}${cause}`);
      wrapped.transport = true;
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const e = new Error(mapJiraError(res.status, text));
      e.status = res.status;
      throw e;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (maxBytes && buf.length > maxBytes) {
      const e = new Error(`attachment content exceeds the ${maxBytes}-byte fetch limit.`);
      e.status = 413;
      throw e;
    }
    return { buf, contentType: res.headers && res.headers.get ? res.headers.get('content-type') : null };
  };
  try {
    return await doAttempt();
  } catch (err) {
    if (err.transport) return doAttempt(); // a read — a stale keep-alive socket is gone on the retry
    throw err;
  }
}

// Fetch one attachment's content by id (CLI `attachment get`, #2399). Confirms
// the id belongs to the given issue first (AC4 — an id on another issue, or one
// deleted since `show` listed it, is a clean 404, never a raw Jira body), then
// refuses an over-cap file (AC edge case) before downloading. Text types come
// back as inline UTF-8 (AC5), everything else as base64 (AC6); the CLI decides
// how to surface each.
async function getAttachment(cred, issueKey, attachmentId, { env, maxBytes = ATTACHMENT_MAX_BYTES } = {}) {
  const wantId = String(attachmentId == null ? '' : attachmentId).trim();
  if (!wantId) { const e = new Error('an attachment id is required'); e.status = 400; throw e; }
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : ATTACHMENT_MAX_BYTES;
  const attachments = await getIssueAttachments(cred, issueKey, { env });
  const att = attachments.find((a) => a.id === wantId);
  if (!att) {
    const e = new Error(
      `attachment ${wantId} is not on issue ${issueKey} — it may have been deleted, or it belongs to another issue.`,
    );
    e.status = 404;
    throw e;
  }
  if (att.size && att.size > cap) {
    const e = new Error(
      `attachment ${wantId} (${att.filename}) is ${att.size} bytes, over the ${cap}-byte fetch limit — `
      + `open it directly in Jira${att.contentUrl ? `: ${att.contentUrl}` : ''}.`,
    );
    e.status = 413;
    throw e;
  }
  const { buf, contentType } = await downloadAttachmentContent(cred, wantId, { env, maxBytes: cap });
  const mimeType = att.mimeType || contentType || null;
  const textual = isTextualAttachment(mimeType, att.filename);
  return {
    id: att.id,
    filename: att.filename,
    mimeType,
    size: att.size || buf.length,
    author: att.author,
    encoding: textual ? 'text' : 'base64',
    content: textual ? buf.toString('utf8') : buf.toString('base64'),
  };
}

// Upload one local file to an issue as a NEW attachment (CLI `attachment add`,
// #2408). The file's bytes arrive here as a Buffer (the broker decoded the CLI's
// base64 body); the credential and the Jira call stay server-side, so the token
// never leaves the broker (AC7). Jira Cloud attaches via a multipart POST to the
// issue's `/attachments` endpoint that REQUIRES the `X-Atlassian-Token: no-check`
// header (its XSRF guard) and the file under the form field `file`; it answers
// 200 with an array of the created attachment(s). The over-cap file is refused
// before the body is built (AC edge case); an unknown/foreign issue key or a
// permission/attachments-disabled failure comes back as a mapped domain error
// (AC4), never a raw Jira body.
//
// This is a WRITE and is NEVER retried on a transport failure: a retry that
// lands after Jira already accepted the first upload would create a DUPLICATE
// attachment (Jira treats a same-named upload as a new, additional file — it
// never dedups). Same F6 discipline as addComment / updateDescription.
async function addAttachment(cred, issueKey, { filename, buffer, mimeType, env, maxBytes = ATTACHMENT_UPLOAD_MAX_BYTES } = {}) {
  const key = String(issueKey == null ? '' : issueKey).trim();
  if (!key) { const e = new Error('an issue key is required'); e.status = 400; throw e; }
  const name = String(filename == null ? '' : filename).trim();
  if (!name) { const e = new Error('a filename is required'); e.status = 400; throw e; }
  if (!Buffer.isBuffer(buffer)) { const e = new Error('file content is required'); e.status = 400; throw e; }
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : ATTACHMENT_UPLOAD_MAX_BYTES;
  if (buffer.length > cap) {
    const e = new Error(`${name} is ${buffer.length} bytes, over the ${cap}-byte upload limit.`);
    e.status = 413;
    throw e;
  }
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const reqPath = `/rest/api/3/issue/${encodeURIComponent(key)}/attachments`;
  const form = new FormData();
  form.append('file', new Blob([buffer], mimeType ? { type: String(mimeType) } : {}), name);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    // `Content-Type` (with the multipart boundary) is set by fetch from the
    // FormData — do NOT set it by hand or the boundary is lost.
    res = await fetch(base + reqPath, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'agent-studio-jira-plugin',
        Authorization: auth,
        'X-Atlassian-Token': 'no-check',
      },
      body: form,
      signal: ctrl.signal,
    });
  } catch (err) {
    const cause = err && err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
    const wrapped = new Error(`${err.message}${cause}`);
    wrapped.transport = true;
    throw wrapped; // a write — never retried (a duplicate attachment otherwise)
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(mapJiraError(res.status, text));
    e.status = res.status;
    throw e;
  }
  const parsed = text ? safeJson(text) : [];
  const created = (Array.isArray(parsed) ? parsed : [parsed]).map(shapeAttachment).filter((a) => a && a.id);
  if (!created.length) {
    const e = new Error(`Jira accepted the upload of ${name} but returned no attachment metadata.`);
    e.status = 502;
    throw e;
  }
  // One file in → one attachment out; return its metadata (id + filename at least, AC3).
  return created[0];
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

// The agent-facing field set both `list` and `search` request from Jira, and
// the shaped shape they return — the columns an agent sees for a browsed issue.
const AGENT_ISSUE_FIELDS = ['summary', 'status', 'assignee', 'updated', 'issuetype'];
const AGENT_ISSUE_COLUMNS = ['key', 'summary', 'status', 'issueType', 'assignee', 'updated', 'url'];

// Narrow one raw search issue to the agent-facing columns (used by both
// `listProjectIssues` and `searchIssues`). `siteBase` builds the browse URL.
function shapeAgentIssue(raw, siteBase) {
  const f = (raw && raw.fields) || {};
  return {
    key: String((raw && raw.key) || ''),
    summary: f.summary == null ? '' : String(f.summary),
    status: f.status && f.status.name ? String(f.status.name) : null,
    issueType: issueTypeOf(f),
    assignee: f.assignee && f.assignee.displayName ? String(f.assignee.displayName) : null,
    updated: f.updated || null,
    url: `${siteBase}/browse/${encodeURIComponent((raw && raw.key) || '')}`,
  };
}

// A caller-supplied `--fields` selection reduces a shaped issue to just those
// columns. `undefined`/empty → the full shape. An unknown column is a 400 with
// the valid set (validated once, up front, by `assertColumns`) — never a
// silently-dropped field. `key` is always kept: it is the issue's identity.
function assertColumns(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return;
  const unknown = fields.filter((f) => !AGENT_ISSUE_COLUMNS.includes(f));
  if (unknown.length) {
    const e = new Error(`unknown --fields: ${unknown.join(', ')}. Valid columns: ${AGENT_ISSUE_COLUMNS.join(', ')}`);
    e.status = 400;
    throw e;
  }
}

function pickAgentColumns(issue, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return issue;
  const keep = new Set(['key', ...fields]);
  const out = {};
  for (const col of AGENT_ISSUE_COLUMNS) if (keep.has(col)) out[col] = issue[col];
  return out;
}

// `search --limit` bounds: default one page, hard-ceilinged at the same
// MAX_PAGES × PAGE_SIZE budget the pollers use so a broad query can never
// spiral. A non-positive or non-numeric value falls back to the default.
const SEARCH_DEFAULT_LIMIT = PAGE_SIZE;
const SEARCH_MAX_LIMIT = MAX_PAGES * PAGE_SIZE;

function clampSearchLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return SEARCH_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), SEARCH_MAX_LIMIT);
}

// A project's issues, most-recently-updated first, optionally filtered to one
// current status (CLI `list`). `status` is quoted + escaped so it can never
// break out of the clause. Capped at one page (PAGE_SIZE) — an agent browsing a
// project does not need 2000 rows.
async function listProjectIssues(cred, { projectKey, status, env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  let jql = `project = ${jqlQuote(projectKey)}`;
  if (typeof status === 'string' && status.trim()) {
    jql += ` AND status = ${jqlQuote(status.trim())}`;
  }
  jql += ' ORDER BY updated DESC';
  const result = await requestJson({
    base,
    path: '/rest/api/3/search/jql',
    method: 'POST',
    idempotent: true, // a read that happens to be a POST — safe to retry
    authHeader: auth,
    body: { jql, fields: ['summary', 'status', 'assignee', 'created', 'updated', 'issuetype'], maxResults: PAGE_SIZE },
  });
  const siteBase = resolveJiraApiBase(cred.siteUrl);
  return (Array.isArray(result.issues) ? result.issues : []).map((raw) => {
    const f = raw.fields || {};
    return {
      key: String(raw.key || ''),
      summary: f.summary == null ? '' : String(f.summary),
      status: f.status && f.status.name ? String(f.status.name) : null,
      issueType: issueTypeOf(f),
      assignee: f.assignee && f.assignee.displayName ? String(f.assignee.displayName) : null,
      created: f.created || null, // #2414 — so an agent can filter/sort list rows by age
      updated: f.updated || null,
      url: `${siteBase}/browse/${encodeURIComponent(raw.key || '')}`,
    };
  });
}

// Agent-facing arbitrary JQL search (#2413). Promotes the diagnostic-only
// `searchJql` to the CLI: the caller owns the whole query, so it can express
// filters `list` cannot (`created`, an empty custom field, a summary regex, …).
//
// Scope guard: the query runs under the per-scope credential, exactly like
// `list`/`show`. Jira resolves it as that account, so it can only ever return
// issues on the credential's bound site (the base URL) and in the projects that
// account is permitted to browse — the JQL cannot reach another team's site or a
// project the credential can't already see. There is no separate allow-list to
// bypass; the credential *is* the tenant boundary.
//
// Shaped like `list` (no changelog expansion — that's a poller concern) and
// capped at `limit` issues (default one page, hard-ceilinged at MAX_PAGES ×
// PAGE_SIZE) so a broad query can never spiral. `fields` optionally narrows the
// returned columns.
async function searchIssues(cred, { jql, fields, limit, env } = {}) {
  const query = String(jql == null ? '' : jql).trim();
  if (!query) { const e = new Error('a JQL query is required'); e.status = 400; throw e; }
  assertColumns(fields);
  const cap = clampSearchLimit(limit);
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const siteBase = resolveJiraApiBase(cred.siteUrl);
  const issues = [];
  let nextPageToken;
  for (let page = 0; page < MAX_PAGES && issues.length < cap; page += 1) {
    const result = await requestJson({
      base,
      path: '/rest/api/3/search/jql',
      method: 'POST',
      idempotent: true, // a read that happens to be a POST — safe to retry
      authHeader: auth,
      body: {
        jql: query,
        fields: AGENT_ISSUE_FIELDS,
        maxResults: Math.min(PAGE_SIZE, cap - issues.length),
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    });
    for (const raw of Array.isArray(result.issues) ? result.issues : []) {
      const shaped = shapeAgentIssue(raw, siteBase);
      if (shaped.key) issues.push(pickAgentColumns(shaped, fields));
      if (issues.length >= cap) break;
    }
    if (result.isLast !== false || !result.nextPageToken) break;
    nextPageToken = result.nextPageToken;
  }
  return issues;
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
      idempotent: true, // a read that happens to be a POST — safe to retry
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

// The whole description as ADF paragraphs, the attribution LAST (in italics):
// this replaces text a human may have written, so the provenance line belongs
// under it, not above it — the reverse of a comment.
function descriptionAdf(text, attribution) {
  const paras = [];
  for (const line of String(text || '').split('\n')) {
    paras.push({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] });
  }
  if (attribution) {
    paras.push({ type: 'paragraph', content: [{ type: 'text', text: attribution, marks: [{ type: 'em' }] }] });
  }
  return { type: 'doc', version: 1, content: paras };
}

// Replace an issue's description. Jira keeps the previous value in the issue
// history, which is why this is a routine, role-gated write (D3) and not an
// approval-pen one. Jira answers 204 with no body.
async function updateDescription(cred, issueKey, { description, attribution, env } = {}) {
  const text = String(description || '').trim();
  if (!text) { const e = new Error('a description is required'); e.status = 400; throw e; }
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  await requestJson({
    base,
    path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    method: 'PUT',
    authHeader: auth,
    body: { fields: { description: descriptionAdf(text, attribution) } },
  });
  return { issueKey, updated: 'description' };
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
  jqlQuote,
  buildProjectJql,
  buildJqlSearchBody,
  changelogPath,
  shapeIssue,
  shapeAttachment,
  isTextualAttachment,
  issueTypeOf,
  commentAdf,
  descriptionAdf,
  mapJiraError,
  apiBaseFor,
  whoAmI,
  searchProjectIssues,
  listProjectIssues,
  searchIssues,
  clampSearchLimit,
  pickAgentColumns,
  AGENT_ISSUE_COLUMNS,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  searchJql,
  fetchFullChangelog,
  getIssue,
  getIssueAttachments,
  downloadAttachmentContent,
  getAttachment,
  addAttachment,
  listProjects,
  ATTACHMENT_LIST_CAP,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_UPLOAD_MAX_BYTES,
  addComment,
  updateDescription,
  listTransitions,
  transitionIssue,
};
