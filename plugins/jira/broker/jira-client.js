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

// ── field catalog: name → id resolution (#2415 epic link, #2416 custom fields) ─
// Jira addresses custom fields by an opaque id (`customfield_NNNNN`) that varies
// per site, so any capability that reads one by its human name ("Team", "Epic
// Link", "Sprint") must first resolve name → id from `/rest/api/3/field`. That
// list is fetched ONCE per site and cached: it feeds both the Epic Link lookup
// (#2415) and the agent-requested custom-field reads (#2416) from a single GET.
//
// Two Jira project styles link a Story to its parent Epic differently:
//   • team-managed (next-gen) — the native `parent` field, always present.
//   • company-managed (classic) — a custom field named "Epic Link" (schema
//     `com.pyxis.greenhopper.jira:gh-epic-link`) whose id varies per site, and
//     which stores the epic KEY as a plain string.
// So reads request BOTH the native `parent` and — when the site has one — the
// Epic Link field. A failed catalog fetch degrades to native-`parent`-only and
// must never break a read; the failure is NOT cached, so it self-heals on the
// next read (unlike a real "no such field" answer, which is a cached empty map).
const EPIC_LINK_SCHEMA = 'com.pyxis.greenhopper.jira:gh-epic-link';
// api base URL → { byName: Map(lowerName → id), byId: Map(id → {id,name,schema}), epicLinkId }
const fieldCatalogCache = new Map();

async function resolveFieldCatalog(base, auth) {
  const cached = fieldCatalogCache.get(base);
  if (cached) return cached;
  let catalog = null;
  try {
    const fields = await requestJson({ base, path: '/rest/api/3/field', authHeader: auth });
    if (Array.isArray(fields)) {
      const byName = new Map();
      const byId = new Map(); // #2417 — the schema too, so a write can shape the value per field type
      for (const f of fields) {
        if (f && f.id && f.name) {
          byName.set(String(f.name).toLowerCase(), String(f.id));
          byId.set(String(f.id), { id: String(f.id), name: String(f.name), schema: f.schema || null });
        }
      }
      const epic = fields.find((f) => f && f.schema && f.schema.custom === EPIC_LINK_SCHEMA)
        || fields.find((f) => f && f.name === 'Epic Link');
      catalog = { byName, byId, epicLinkId: epic && epic.id ? String(epic.id) : null };
    }
  } catch {
    catalog = null; // field list unreachable → transient, not cached (self-heals)
  }
  if (catalog) fieldCatalogCache.set(base, catalog);
  return catalog || { byName: new Map(), byId: new Map(), epicLinkId: null };
}

async function resolveEpicLinkFieldId(base, auth) {
  return (await resolveFieldCatalog(base, auth)).epicLinkId;
}

// The agent-facing standard columns a `--fields` selection may name (below);
// declared here so `partitionFields` can be defined before them.
// (AGENT_ISSUE_COLUMNS is the source of truth — see near shapeAgentIssue.)

// Split a caller's `--fields` list into standard columns (the projection over a
// shaped issue) and custom-field names (resolved to ids and surfaced under
// `customFields`). A name matching a known column is a column; anything else is
// a custom-field name. Pure — no HTTP, so a bad column still fails fast.
function partitionFields(fields) {
  const list = Array.isArray(fields) ? fields.map((f) => String(f || '').trim()).filter(Boolean) : [];
  const columns = [];
  const customNames = [];
  for (const f of list) {
    if (AGENT_ISSUE_COLUMNS.includes(f)) columns.push(f);
    else customNames.push(f);
  }
  return { columns, customNames };
}

// Merge custom-field name lists (an admin-configured default set ∪ a per-request
// selection), de-duplicated case-insensitively, first spelling wins. Pure.
function mergeCustomFieldNames(...groups) {
  const out = [];
  const seen = new Set();
  for (const g of groups) {
    for (const raw of Array.isArray(g) ? g : []) {
      const name = String(raw || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

// Render one raw custom-field value into something an agent can read. Jira
// returns wildly different shapes per field type; this normalises the common
// ones and leaves an unknown shape verbatim. Crucially, an unset field is
// `null` (Jira returns null, or an empty array) so an EMPTY value is always
// distinguishable from a set one (#2416 acceptance).
function renderCustomFieldValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null; // e.g. an unset multi-select / labels field
    return raw.map(renderCustomFieldValue);
  }
  if (typeof raw === 'object') {
    // Option / select → {value}; user → {displayName}; version / component →
    // {name}; team (Advanced Roadmaps) → {id, title}. Prefer the human label but
    // keep the id when there is one, so a "Team" resolves to a name AND an id.
    const label = raw.value != null ? raw.value
      : raw.name != null ? raw.name
        : raw.title != null ? raw.title
          : raw.displayName != null ? raw.displayName : null;
    const id = raw.id != null ? raw.id
      : raw.accountId != null ? raw.accountId
        : raw.key != null ? raw.key : null;
    if (label != null || id != null) {
      const out = {};
      if (id != null) out.id = String(id);
      if (label != null) out.value = String(label);
      return out;
    }
    return raw; // unknown object shape — surface verbatim rather than drop it
  }
  return raw; // string / number / boolean
}

// Resolve the requested custom-field NAMES to ids via the (cached) catalog. An
// unresolved name is a 400 with the offending name — a typo, or a field this
// credential's account cannot see — never a silently-dropped field. Returns
// `{ resolved: [{ name, id }], ids: [id…] }`; empty when nothing was requested,
// in which case NO catalog fetch happens (the common, custom-field-less read).
async function resolveCustomFieldSelection(base, auth, names) {
  const list = mergeCustomFieldNames(names);
  if (!list.length) return { resolved: [], ids: [] };
  const catalog = await resolveFieldCatalog(base, auth);
  const resolved = [];
  const unknown = [];
  for (const name of list) {
    const id = catalog.byName.get(name.toLowerCase());
    if (id) resolved.push({ name, id });
    else unknown.push(name);
  }
  if (unknown.length) {
    const e = new Error(
      `unknown Jira field(s): ${unknown.join(', ')}. Use the field's human name as it appears in Jira (e.g. "Team").`,
    );
    e.status = 400;
    throw e;
  }
  return { resolved, ids: resolved.map((r) => r.id) };
}

// Build the `{ name: renderedValue|null }` map for a raw issue's resolved custom
// fields, keyed by the caller's original field-name spelling.
function buildCustomFields(rawFields, resolved) {
  const out = {};
  for (const { name, id } of resolved) out[name] = renderCustomFieldValue(rawFields[id]);
  return out;
}

// The parent/epic key for a shaped read: prefer the native `parent` key
// (team-managed), else the resolved Epic Link custom field (classic). `null`
// when the issue has neither — the common case for a top-level issue or epic.
function parentKeyOf(fields, epicLinkFieldId) {
  if (fields && fields.parent && fields.parent.key) return String(fields.parent.key);
  if (epicLinkFieldId && fields && fields[epicLinkFieldId]) return String(fields[epicLinkFieldId]);
  return null;
}

// Test seam: drop the per-site field catalog cache so each stubbed-fetch test
// starts from a clean lookup (the cache is otherwise process-lifetime).
function __resetCaches() {
  fieldCatalogCache.clear();
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

// Read one issue (CLI `show`). Narrow shape, with the browse URL. `customFields`
// (an array of human field names, e.g. ["Team"]) additionally reads those custom
// fields (#2416) — resolved name → id and surfaced under `customFields`.
async function getIssue(cred, issueKey, { env, customFields } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  // Resolve the site's Epic Link custom-field id (#2415) so a classic project's
  // story→epic link is requestable alongside the native `parent`, plus any
  // agent-requested custom fields (#2416). Both read one cached field catalog.
  const epicLinkFieldId = await resolveEpicLinkFieldId(base, auth);
  const custom = await resolveCustomFieldSelection(base, auth, customFields);
  const fieldList = ['summary', 'status', 'description', 'assignee', 'issuetype', 'attachment', 'created', 'updated', 'parent'];
  if (epicLinkFieldId) fieldList.push(epicLinkFieldId);
  for (const id of custom.ids) if (!fieldList.includes(id)) fieldList.push(id);
  const raw = await requestJson({
    base,
    path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${fieldList.join(',')}`,
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
    // Parent/epic key (#2415) so an agent can traverse Story→Epic: `show` the
    // key this returns. `null` when the issue has no parent (e.g. an epic).
    parent: parentKeyOf(fields, epicLinkFieldId),
    url: `${resolveJiraApiBase(cred.siteUrl)}/browse/${encodeURIComponent(raw.key || issueKey)}`,
  };
  // Requested custom fields (#2416). Only surfaced when some were requested, so
  // a plain `show` is byte-identical to before. An unset field is `null` (not a
  // dropped key), so an empty value is distinguishable from a set one.
  if (custom.resolved.length) out.customFields = buildCustomFields(fields, custom.resolved);
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
  // Available transitions (#2421). The transitions reachable from the issue's
  // *current* status, folded into `show` so an agent can pick its next move
  // directly instead of guessing-then-parsing a failed `transition` error.
  // Reuses `listTransitions`. A failed lookup degrades to omitting the key — a
  // read stays robust, matching the Epic Link fallback above; on success the
  // key is always present (possibly `[]` when the workflow allows no move).
  try {
    const transitions = await listTransitions(cred, out.key, { env });
    out.availableTransitions = transitions.map((t) => ({ transition: t.name, toStatus: t.toStatus }));
  } catch {
    /* transitions unavailable → omit the key rather than fail the whole read */
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

// The full set of workflow statuses a project supports, grouped by issue type
// (#2421) — GET /rest/api/3/project/{projectIdOrKey}/statuses. Independent of
// any single issue's current state, so an agent can see what a workflow supports
// before an issue reaches a given status (planning / capability check), unlike
// `show`'s availableTransitions which are relative to one issue's current state.
// Shaped to `[{ issueType, statuses: [{ name, category }] }]` per issue type.
async function listProjectStatuses(cred, { projectKey, env } = {}) {
  const key = String(projectKey || '').trim();
  if (!key) { const e = new Error('a project key is required'); e.status = 400; throw e; }
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const raw = await requestJson({
    base,
    path: `/rest/api/3/project/${encodeURIComponent(key)}/statuses`,
    authHeader: auth,
  });
  const types = Array.isArray(raw) ? raw : [];
  return types.map((t) => ({
    issueType: t && t.name ? String(t.name) : null,
    statuses: (t && Array.isArray(t.statuses) ? t.statuses : []).map((s) => ({
      name: s && s.name ? String(s.name) : null,
      // Jira's coarse workflow bucket ("new" / "indeterminate" / "done") — lets
      // an agent group statuses without hard-coding site-specific names.
      category: s && s.statusCategory && s.statusCategory.key ? String(s.statusCategory.key) : null,
    })),
  }));
}

// The agent-facing field set both `list` and `search` request from Jira, and
// the shaped shape they return — the columns an agent sees for a browsed issue.
const AGENT_ISSUE_FIELDS = ['summary', 'status', 'assignee', 'updated', 'issuetype', 'parent'];
const AGENT_ISSUE_COLUMNS = ['key', 'summary', 'status', 'issueType', 'assignee', 'updated', 'parent', 'url'];

// Narrow one raw search issue to the agent-facing columns (used by both
// `listProjectIssues` and `searchIssues`). `siteBase` builds the browse URL;
// `epicLinkFieldId` (when the site has one) lets a classic project's epic key
// surface as `parent` alongside the native `parent` (#2415).
function shapeAgentIssue(raw, siteBase, epicLinkFieldId) {
  const f = (raw && raw.fields) || {};
  return {
    key: String((raw && raw.key) || ''),
    summary: f.summary == null ? '' : String(f.summary),
    status: f.status && f.status.name ? String(f.status.name) : null,
    issueType: issueTypeOf(f),
    assignee: f.assignee && f.assignee.displayName ? String(f.assignee.displayName) : null,
    updated: f.updated || null,
    parent: parentKeyOf(f, epicLinkFieldId),
    url: `${siteBase}/browse/${encodeURIComponent((raw && raw.key) || '')}`,
  };
}

// The field set a search/list request sends: the agent columns plus, when the
// site has an Epic Link custom field, its id — so `parentKeyOf` can read the
// classic-project epic key. (`parent` is already in AGENT_ISSUE_FIELDS.)
function agentRequestFields(epicLinkFieldId) {
  return epicLinkFieldId ? [...AGENT_ISSUE_FIELDS, epicLinkFieldId] : AGENT_ISSUE_FIELDS;
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
async function listProjectIssues(cred, { projectKey, status, customFields, env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  let jql = `project = ${jqlQuote(projectKey)}`;
  if (typeof status === 'string' && status.trim()) {
    jql += ` AND status = ${jqlQuote(status.trim())}`;
  }
  jql += ' ORDER BY updated DESC';
  const epicLinkFieldId = await resolveEpicLinkFieldId(base, auth); // #2415
  const custom = await resolveCustomFieldSelection(base, auth, customFields); // #2416
  const listFields = ['summary', 'status', 'assignee', 'created', 'updated', 'issuetype', 'parent'];
  if (epicLinkFieldId) listFields.push(epicLinkFieldId);
  for (const id of custom.ids) if (!listFields.includes(id)) listFields.push(id);
  const result = await requestJson({
    base,
    path: '/rest/api/3/search/jql',
    method: 'POST',
    idempotent: true, // a read that happens to be a POST — safe to retry
    authHeader: auth,
    body: { jql, fields: listFields, maxResults: PAGE_SIZE },
  });
  const siteBase = resolveJiraApiBase(cred.siteUrl);
  return (Array.isArray(result.issues) ? result.issues : []).map((raw) => {
    const f = raw.fields || {};
    const row = {
      key: String(raw.key || ''),
      summary: f.summary == null ? '' : String(f.summary),
      status: f.status && f.status.name ? String(f.status.name) : null,
      issueType: issueTypeOf(f),
      assignee: f.assignee && f.assignee.displayName ? String(f.assignee.displayName) : null,
      created: f.created || null, // #2414 — so an agent can filter/sort list rows by age
      updated: f.updated || null,
      parent: parentKeyOf(f, epicLinkFieldId), // #2415 — Story→Epic traversal
      url: `${siteBase}/browse/${encodeURIComponent(raw.key || '')}`,
    };
    if (custom.resolved.length) row.customFields = buildCustomFields(f, custom.resolved); // #2416
    return row;
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
async function searchIssues(cred, { jql, fields, customFields, limit, env } = {}) {
  const query = String(jql == null ? '' : jql).trim();
  if (!query) { const e = new Error('a JQL query is required'); e.status = 400; throw e; }
  assertColumns(fields); // the standard-column projection — validated fast, no HTTP
  const cap = clampSearchLimit(limit);
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const siteBase = resolveJiraApiBase(cred.siteUrl);
  const epicLinkFieldId = await resolveEpicLinkFieldId(base, auth); // #2415
  const custom = await resolveCustomFieldSelection(base, auth, customFields); // #2416
  const reqFields = [...agentRequestFields(epicLinkFieldId), ...custom.ids];
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
        fields: reqFields,
        maxResults: Math.min(PAGE_SIZE, cap - issues.length),
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    });
    for (const raw of Array.isArray(result.issues) ? result.issues : []) {
      const shaped = shapeAgentIssue(raw, siteBase, epicLinkFieldId);
      if (!shaped.key) continue;
      const row = pickAgentColumns(shaped, fields);
      // Custom fields are additive: they ride alongside the projected columns
      // (never narrowed away by `--fields`), so `search --fields Team` returns
      // the full row plus Team, and `--fields status,Team` returns key+status+Team.
      if (custom.resolved.length) row.customFields = buildCustomFields(raw.fields || {}, custom.resolved);
      issues.push(row);
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

// ── custom-field write (#2417) ───────────────────────────────────────────────
//
// The write counterpart of the #2416 custom-field read: set an allow-listed
// custom field (e.g. "Team") on an issue. Three guards, in order:
//   1. allow-list — the field's human name MUST be in the team's
//      `writable-custom-fields` list, else it is REFUSED (403). An EMPTY list
//      means NO field is writable — the safe default until a Team Admin opts a
//      field in (a writable field is strictly more dangerous than a readable one,
//      so unlike the read allow-list this gate is mandatory, never a default set).
//   2. name → id resolution via the (cached) field catalog — an unknown name is a
//      400 with the offending name, never a silently-dropped write.
//   3. value shaping per the field's schema type — a Team / select / user field is
//      not a plain string (`shapeFieldWriteValue`); a raw `jsonValue` is the
//      escape hatch for an exotic field type, sent verbatim.
// The write is attributed by Jira's own issue history (the change is recorded
// under the broker's account, which represents the team — the same "attribution"
// a `transition` carries: no free-text field to stamp). Idempotent: the current
// value is read first and the PUT is skipped when it already matches, so a re-run
// adds no redundant history entry.

// Shape a scalar `value` into the write payload Jira expects for a field of the
// given `schema`. Pure. A number that will not parse is a 400; every other type
// degrades to a plain string, the safest default for an unmodelled field.
function shapeFieldWriteValue(schema, value) {
  const type = schema && schema.type ? String(schema.type) : 'string';
  const v = value == null ? '' : String(value);
  switch (type) {
    case 'string':
    case 'date':
    case 'datetime':
      return v;
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) { const e = new Error(`"${value}" is not a number`); e.status = 400; throw e; }
      return n;
    }
    case 'option':
    case 'option-with-child':
      return { value: v }; // a single-select — Jira also accepts { id }
    case 'user':
      return { accountId: v };
    case 'team': // Advanced Roadmaps "Team" custom field — keyed by team id
      return { id: v };
    case 'array': {
      const items = schema && schema.items ? String(schema.items) : 'string';
      if (items === 'option') return [{ value: v }];
      if (items === 'user') return [{ accountId: v }];
      return [v];
    }
    default:
      return v; // unmodelled scalar — send as a plain string
  }
}

// Whether the current raw field value already equals `wantStr` (idempotency). A
// rendered object matches on its id OR its human value; a rendered array matches
// if any member does; a scalar on string equality. Pure.
function fieldRenderedEquals(rendered, wantStr) {
  if (rendered && typeof rendered === 'object') {
    return String(rendered.id) === wantStr || String(rendered.value) === wantStr;
  }
  return String(rendered) === wantStr;
}

function fieldValueMatches(currentRaw, wantStr) {
  const rendered = renderCustomFieldValue(currentRaw);
  if (rendered === null || rendered === undefined) return false;
  if (Array.isArray(rendered)) return rendered.some((r) => fieldRenderedEquals(r, wantStr));
  return fieldRenderedEquals(rendered, wantStr);
}

// Set one allow-listed custom field on an issue (CLI `set-field`). `allowList` is
// the team's sanctioned writable field names; `value` (a scalar, shaped per the
// field's type) OR `jsonValue` (raw, verbatim) supplies what to write.
async function setCustomField(cred, issueKey, { fieldName, value, jsonValue, allowList, env } = {}) {
  const key = String(issueKey == null ? '' : issueKey).trim();
  if (!key) { const e = new Error('an issue key is required'); e.status = 400; throw e; }
  const name = String(fieldName == null ? '' : fieldName).trim();
  if (!name) { const e = new Error('a field name is required'); e.status = 400; throw e; }
  const hasJson = jsonValue !== undefined;
  if (!hasJson && (value === undefined || value === null)) {
    const e = new Error('a value is required (--value or --value-json)'); e.status = 400; throw e;
  }
  // (1) allow-list gate — a non-allow-listed field is refused (acceptance).
  const allow = (Array.isArray(allowList) ? allowList : [])
    .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (!allow.includes(name.toLowerCase())) {
    const e = new Error(
      allow.length
        ? `field "${name}" is not writable by agents. This team's writable-custom-fields allow-list is: `
          + `${allowList.join(', ')}. A Team Admin adds it on the Plugins page.`
        : `no custom field is writable by agents: this team's writable-custom-fields allow-list is empty. `
          + `A Team Admin adds "${name}" to it on the Plugins page.`,
    );
    e.status = 403;
    throw e;
  }
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  // (2) name → id + schema.
  const catalog = await resolveFieldCatalog(base, auth);
  const id = catalog.byName.get(name.toLowerCase());
  if (!id) {
    const e = new Error(`unknown Jira field: ${name}. Use the field's human name as it appears in Jira (e.g. "Team").`);
    e.status = 400;
    throw e;
  }
  const meta = catalog.byId.get(id) || { id, name, schema: null };
  // (3) value shaping — raw JSON verbatim, else per the field's schema type.
  const shaped = hasJson ? jsonValue : shapeFieldWriteValue(meta.schema, value);
  // Idempotency (scalar path only — a raw jsonValue's shape is not comparable): a
  // pre-read skips the write when the field already holds the target value, so a
  // re-run adds no redundant Jira history entry.
  if (!hasJson) {
    const cur = await requestJson({
      base,
      path: `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(id)}`,
      authHeader: auth,
    });
    const current = (cur.fields || {})[id];
    if (fieldValueMatches(current, String(value))) {
      return { issueKey: key, field: name, changed: false, value: renderCustomFieldValue(current) };
    }
  }
  // A write — NOT retried on a transport failure (F6), like updateDescription.
  await requestJson({
    base,
    path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
    method: 'PUT',
    authHeader: auth,
    body: { fields: { [id]: shaped } },
  });
  return { issueKey: key, field: name, changed: true, value: hasJson ? jsonValue : value };
}

// ── issue creation: one Epic + its child Stories (#2424) ─────────────────────
//
// The first CREATE capability of the plugin (reads + field/description writes
// existed; nothing created an issue). One call creates one **Epic** (the ask)
// and N **Stories** underneath it (the breakdown) in a single project, each
// Story linked to the Epic. Scoped to one project (§ the ticket): the epic and
// every story land in `projectKey`.
//
// Jira has no create-transaction, so the guards run in this order so a bad input
// fails BEFORE any issue exists (no orphan epic):
//   1. shape validation — a missing project / epic summary / story summary is a
//      400 up front.
//   2. custom-field allow-list — EVERY custom field named anywhere (epic or a
//      story) MUST be on the team's `writable-custom-fields` list, exactly like
//      `setCustomField` (#2417): the same fields (Team, Story Points) an admin
//      sanctioned for a set are the ones creatable here. A non-listed field is a
//      403 before anything is created. The Epic-link field the broker sets to
//      wire a Story to its Epic is structural, NOT a user-named field, so it is
//      exempt from the allow-list.
//   3. name → id + schema resolution via the (cached) field catalog — an unknown
//      custom-field name is a 400 up front.
// The epic is created first (its key is needed to link the stories); then each
// story is created and, if a `status` was given, transitioned (Jira creates an
// issue in the workflow's initial status, so a non-default start is a follow-up
// transition — the ticket's own note). A per-story failure AFTER the epic exists
// does NOT abort the rest: the story is recorded failed and the operation
// continues, so the caller gets the epic key + a per-story success/failure map
// (like `attachment add`). Creates are NEVER retried on a transport failure
// (F6): a retry landing after Jira accepted the first would create a duplicate.
const EPIC_ISSUE_TYPE = 'Epic';
const STORY_ISSUE_TYPE = 'Story';

// Build the `fields` object for one issue-create (epic or story). Pure. `spec`
// is the caller's `{ summary, description?, assignee?, fields? }`; `fieldMeta`
// maps a lower-cased custom-field name → its `{ id, schema }` (already resolved
// + allow-listed). A custom-field value that is already an object/array is sent
// verbatim (an escape hatch for an exotic shape); a scalar is shaped per the
// field's schema type via the shared `shapeFieldWriteValue` (Team → {id},
// number → Number, …).
function buildCreateFields({ projectKey, issueTypeName, spec, fieldMeta, attribution }) {
  const fields = {
    project: { key: projectKey },
    issuetype: { name: issueTypeName },
    summary: String(spec.summary || '').trim(),
  };
  const desc = spec.description == null ? '' : String(spec.description).trim();
  if (desc) fields.description = descriptionAdf(desc, attribution);
  const assignee = spec.assignee == null ? '' : String(spec.assignee).trim();
  if (assignee) fields.assignee = { accountId: assignee };
  if (spec.fields && typeof spec.fields === 'object') {
    for (const [name, value] of Object.entries(spec.fields)) {
      const meta = fieldMeta.get(name.toLowerCase());
      if (!meta) continue; // validated up front — defensive
      fields[meta.id] = value !== null && typeof value === 'object'
        ? value // exotic shape, verbatim (mirrors set-field's --value-json)
        : shapeFieldWriteValue(meta.schema, value);
    }
  }
  return fields;
}

// POST one issue-create. A write — never retried on a transport failure (F6).
// Returns `{ id, key }` (Jira answers 201 with them).
async function createIssue(base, auth, fields) {
  const res = await requestJson({
    base,
    path: '/rest/api/3/issue',
    method: 'POST',
    authHeader: auth,
    body: { fields },
  });
  return { id: res.id ? String(res.id) : null, key: String(res.key || '') };
}

// Every custom-field name used across the epic + all stories, first spelling
// wins (so the error/allow-list messages read as the caller typed them). Pure.
function collectCustomFieldNames(epic, stories) {
  const seen = new Set();
  const out = [];
  const add = (spec) => {
    if (spec && spec.fields && typeof spec.fields === 'object') {
      for (const name of Object.keys(spec.fields)) {
        const trimmed = String(name || '').trim();
        if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
        seen.add(trimmed.toLowerCase());
        out.push(trimmed);
      }
    }
  };
  add(epic);
  for (const s of Array.isArray(stories) ? stories : []) add(s);
  return out;
}

async function createEpicWithStories(cred, { projectKey, epic, stories, allowList, attribution, issueTypes, env } = {}) {
  const project = String(projectKey || '').trim();
  if (!project) { const e = new Error('a project key is required'); e.status = 400; throw e; }
  if (!epic || typeof epic !== 'object') { const e = new Error('an epic is required'); e.status = 400; throw e; }
  if (!String(epic.summary || '').trim()) { const e = new Error('the epic requires a summary'); e.status = 400; throw e; }
  const storyList = Array.isArray(stories) ? stories : [];
  storyList.forEach((s, i) => {
    if (!s || typeof s !== 'object' || !String(s.summary || '').trim()) {
      const e = new Error(`story #${i + 1} requires a summary`); e.status = 400; throw e;
    }
  });

  // (2) allow-list gate — every named custom field must be sanctioned (#2417).
  const usedNames = collectCustomFieldNames(epic, storyList);
  const allow = (Array.isArray(allowList) ? allowList : [])
    .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const notAllowed = usedNames.filter((n) => !allow.includes(n.toLowerCase()));
  if (notAllowed.length) {
    const e = new Error(
      allow.length
        ? `custom field(s) not writable by agents: ${notAllowed.join(', ')}. This team's `
          + `writable-custom-fields allow-list is: ${allowList.join(', ')}. A Team Admin adds them on the Plugins page.`
        : `no custom field is writable by agents: this team's writable-custom-fields allow-list is empty. `
          + `A Team Admin adds ${notAllowed.map((n) => `"${n}"`).join(', ')} to it on the Plugins page.`,
    );
    e.status = 403;
    throw e;
  }

  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);

  // (3) name → id + schema, up front (one cached catalog fetch feeds every field
  // AND the Epic-link id used to wire Story→Epic).
  const catalog = await resolveFieldCatalog(base, auth);
  const fieldMeta = new Map();
  const unknown = [];
  for (const name of usedNames) {
    const id = catalog.byName.get(name.toLowerCase());
    if (!id) { unknown.push(name); continue; }
    fieldMeta.set(name.toLowerCase(), catalog.byId.get(id) || { id, name, schema: null });
  }
  if (unknown.length) {
    const e = new Error(
      `unknown Jira field(s): ${unknown.join(', ')}. Use the field's human name as it appears in Jira (e.g. "Team").`,
    );
    e.status = 400;
    throw e;
  }

  const epicTypeName = String((issueTypes && issueTypes.epic) || EPIC_ISSUE_TYPE).trim() || EPIC_ISSUE_TYPE;
  const storyTypeName = String((issueTypes && issueTypes.story) || STORY_ISSUE_TYPE).trim() || STORY_ISSUE_TYPE;
  const siteBase = resolveJiraApiBase(cred.siteUrl);
  const browseUrl = (key) => `${siteBase}/browse/${encodeURIComponent(key)}`;

  // Apply an optional follow-up status transition to a just-created issue. Jira
  // creates in the workflow's initial status, so a requested non-default start is
  // a transition (the ticket's implementer note). A transition failure is
  // reported alongside the created key, never a hard failure — the issue exists.
  const applyStatus = async (key, status, out) => {
    const want = String(status || '').trim();
    if (!want) return;
    try {
      const t = await transitionIssue(cred, key, { toStatus: want, env });
      out.status = t.toStatus || want;
    } catch (err) {
      out.statusError = err.message;
    }
  };

  // (1→create) the epic first — its key links every story.
  const epicFields = buildCreateFields({ projectKey: project, issueTypeName: epicTypeName, spec: epic, fieldMeta, attribution });
  const epicCreated = await createIssue(base, auth, epicFields);
  const epicKey = epicCreated.key;
  const epicOut = { key: epicKey, url: browseUrl(epicKey), summary: String(epic.summary).trim() };
  await applyStatus(epicKey, epic.status, epicOut);

  // Each story, linked to the epic. Team-managed projects use the native
  // `parent`; company-managed (classic) uses the Epic Link custom field — mirror
  // the #2415 read side: a site with an Epic Link field id uses it, else `parent`.
  const storyResults = [];
  for (const [i, s] of storyList.entries()) {
    try {
      const storyFields = buildCreateFields({ projectKey: project, issueTypeName: storyTypeName, spec: s, fieldMeta, attribution });
      if (catalog.epicLinkId) storyFields[catalog.epicLinkId] = epicKey;
      else storyFields.parent = { key: epicKey };
      const created = await createIssue(base, auth, storyFields);
      const out = { summary: String(s.summary).trim(), key: created.key, url: browseUrl(created.key), ok: true };
      await applyStatus(created.key, s.status, out);
      storyResults.push(out);
    } catch (err) {
      storyResults.push({ summary: String(s.summary).trim(), ok: false, error: err.message });
    }
  }

  return {
    project,
    epic: epicOut,
    stories: storyResults,
    created: 1 + storyResults.filter((r) => r.ok).length,
    failed: storyResults.filter((r) => !r.ok).length,
  };
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
  shapeAgentIssue,
  parentKeyOf,
  partitionFields,
  mergeCustomFieldNames,
  renderCustomFieldValue,
  __resetCaches,
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
  listProjectStatuses,
  ATTACHMENT_LIST_CAP,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_UPLOAD_MAX_BYTES,
  addComment,
  updateDescription,
  listTransitions,
  transitionIssue,
  shapeFieldWriteValue,
  fieldValueMatches,
  setCustomField,
  buildCreateFields,
  collectCustomFieldNames,
  createEpicWithStories,
  EPIC_ISSUE_TYPE,
  STORY_ISSUE_TYPE,
};
