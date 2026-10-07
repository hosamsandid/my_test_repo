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

const { resolveJiraApiBase, adfToText } = require('./event-extract');

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
    // `created`/`reporter`/`priority` feed the issue_created extractor,
    // `comment` the comment_added one.
    fields: ['summary', 'status', 'issuetype', 'created', 'reporter', 'priority', 'comment'],
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
    created: fields.created ? String(fields.created) : null,
    reporter: fields.reporter && fields.reporter.displayName ? String(fields.reporter.displayName) : null,
    priority: fields.priority && fields.priority.name ? String(fields.priority.name) : null,
    comment: fields.comment && typeof fields.comment === 'object' ? fields.comment : null,
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
async function attempt({ base, path: reqPath, method, headers, payload, withLocation }) {
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
    // Jira's own answer, for a caller that maps a status more precisely than
    // mapJiraError can (an issue-link 404 can mean "no Link Issues permission").
    e.body = typeof text === 'string' ? text.slice(0, 1000) : '';
    throw e;
  }
  const data = text ? safeJson(text) : {};
  // A create that answers 201 with an empty body (POST /issueLink) carries the
  // new resource's URL only in `Location`.
  if (withLocation) {
    const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
    return { data, location: location || null };
  }
  return data;
}

// `idempotent` decides whether a transport failure is retried. Default: GET
// only. A POST that is really a read (Jira's `/search/jql`) opts in; a write
// (comment, description, transition) must NOT — a transport error, including
// the 20 s abort, can arrive AFTER Jira accepted the request, and a retry then
// posts the attribution comment twice or re-runs the transition (F6).
async function requestJson({ base, path: reqPath, method = 'GET', authHeader, body, idempotent, withLocation }) {
  const headers = { Accept: 'application/json', 'User-Agent': 'agent-studio-jira-plugin' };
  if (authHeader) headers.Authorization = authHeader;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const args = { base, path: reqPath, method, headers, payload, withLocation };
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
  const fieldList = ['summary', 'status', 'description', 'assignee', 'issuetype', 'attachment', 'created', 'updated', 'parent', 'issuelinks'];
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
    // Issue links (#2884), as seen from THIS issue ("blocks" / "is blocked by").
    // Always present — `[]` when the issue has none.
    links: shapeIssueLinks(fields.issuelinks, String(raw.key || issueKey)),
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

// One comment in full (CLI `show <key> --comment <id>`) — how an agent reads
// the rest of a `comment_added` wake whose `body` was cut (`bodyTruncated`).
// The body is the same plain text the wake carries (event-extract.js
// `adfToText`), uncut. An unknown id is Jira's 404, mapped like any read.
async function getComment(cred, issueKey, commentId, { env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const raw = await requestJson({
    base,
    path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
    authHeader: auth,
  });
  return {
    id: String(raw.id == null ? commentId : raw.id),
    author: raw.author && raw.author.displayName ? String(raw.author.displayName) : null,
    created: raw.created ? String(raw.created) : null,
    body: adfToText(raw.body),
  };
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

// Whether a Jira site answers at all, without a credential (#2640): Jira Cloud's
// `GET /serverInfo` is anonymous, so a team with only a site (no service
// account) can still learn that the site is right.
async function serverInfo(siteUrl, { env } = {}) {
  const base = apiBaseFor(siteUrl, env);
  const info = await requestJson({ base, path: '/rest/api/3/serverInfo' });
  return {
    baseUrl: info.baseUrl || base,
    serverTitle: info.serverTitle || null,
    deploymentType: info.deploymentType || null,
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

// The newest comments of one issue, newest first, stopping at the first one
// created before `sinceIso` — the backfill for a search response whose comment
// list was cut short (event-extract.js `isCommentListTruncated`). Returned
// oldest-first like the search response's own list. Bounded by MAX_PAGES.
const COMMENT_PAGE_SIZE = 50;
async function fetchRecentComments(cred, issueKey, { sinceIso, env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const since = Date.parse(sinceIso);
  const out = [];
  let startAt = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await requestJson({
      base,
      path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?orderBy=-created&startAt=${startAt}&maxResults=${COMMENT_PAGE_SIZE}`,
      authHeader: auth,
    });
    const values = Array.isArray(res.comments) ? res.comments : [];
    let reachedOld = false;
    for (const c of values) {
      if (!Number.isNaN(since) && Date.parse(c.created) < since) { reachedOld = true; break; }
      out.push(c);
    }
    startAt += values.length;
    if (reachedOld || values.length === 0 || (typeof res.total === 'number' && startAt >= res.total)) break;
  }
  return out.reverse();
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
//   1. allow-list — an EMPTY `writable-custom-fields` list means UNRESTRICTED:
//      any custom field the account can see is writable (#2449 flipped the
//      original #2417 deny-by-default). A NON-EMPTY list restricts writes to the
//      named fields; any other field is REFUSED (403). Operator note: filling the
//      list in is recommended where agents should only touch specific fields — a
//      writable field is strictly more dangerous than a readable one.
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
  // (1) allow-list gate — an empty list means unrestricted; a non-empty list
  // restricts writes to only the named fields (#2449 flips the old deny-by-default).
  const allow = (Array.isArray(allowList) ? allowList : [])
    .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes(name.toLowerCase())) {
    const e = new Error(
      `field "${name}" is not writable by agents. This team's writable-custom-fields allow-list is: `
        + `${allowList.join(', ')}. A Team Admin adds it on the Plugins page.`,
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
      return { issueKey: key, field: name, fieldId: id, changed: false, value: renderCustomFieldValue(current) };
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
  return { issueKey: key, field: name, fieldId: id, changed: true, value: hasJson ? jsonValue : value };
}

// ── issue links (#2884) ──────────────────────────────────────────────────────
//
// Read, create and remove links between two existing issues ("KAN-1 blocks
// KAN-2"). Jira names the two ends `inwardIssue` / `outwardIssue`, and the
// names mislead: on `POST /issueLink` the issue sent as `inwardIssue` is the one
// that takes the type's OUTWARD phrase ("A blocks B" = inwardIssue A,
// outwardIssue B), while on a read an issue lists the OTHER end under
// `outwardIssue` when it takes the outward phrase itself. So nothing
// agent-facing speaks of inward/outward: a read gives the relationship as seen
// from the issue, and a write takes "<A> <type name or phrase> <B>" and
// resolves the direction here. Link types vary per site (admin-configurable),
// so they are always read from `/issueLinkType`, never hard-coded.

const linkErr = (status, message) => { const e = new Error(message); e.status = status; return e; };

// One `issuelinks` entry as seen from `thisKey`. `null` for an entry whose
// other end is missing — Jira omits an issue the credential cannot see, and a
// deleted issue's links can linger — so `show` keeps the rest instead of failing.
function shapeIssueLink(raw, thisKey) {
  if (!raw || raw.id == null || !raw.type) return null;
  const other = raw.outwardIssue || raw.inwardIssue;
  if (!other || !other.key) return null;
  const phrase = (raw.outwardIssue ? raw.type.outward : raw.type.inward) || raw.type.name || '';
  const f = other.fields || {};
  return {
    id: String(raw.id),
    type: String(raw.type.name || ''),
    relationship: String(phrase),
    otherIssue: {
      key: String(other.key),
      summary: f.summary == null ? null : String(f.summary),
      status: f.status && f.status.name ? String(f.status.name) : null,
    },
    statement: `${thisKey} ${phrase} ${other.key}`,
  };
}

function shapeIssueLinks(rawLinks, thisKey) {
  return (Array.isArray(rawLinks) ? rawLinks : []).map((l) => shapeIssueLink(l, thisKey)).filter(Boolean);
}

function linkTypeLabel(t) {
  return `${t.name} (${t.outward} / ${t.inward})`;
}

// Resolve what the caller typed to a link type and a direction. Pure.
// Case-insensitive; the type NAME wins ("Blocks" → its outward phrase), else
// either phrase ("is blocked by" → `reversed`: the SECOND key takes the outward
// phrase). A phrase two types share is ambiguous, and an unknown one is refused
// listing every type — both before any Jira write.
function resolveLinkType(types, input) {
  const list = Array.isArray(types) ? types : [];
  const want = String(input || '').trim().toLowerCase();
  const available = list.map(linkTypeLabel).join(', ') || '(none)';
  if (!want) throw linkErr(400, `a link type is required. Available: ${available}`);
  const byName = list.find((t) => t.name.toLowerCase() === want);
  if (byName) return { type: byName, phrase: byName.outward || byName.name, reversed: false };
  const hits = [];
  for (const t of list) {
    if (t.outward.toLowerCase() === want) hits.push({ type: t, phrase: t.outward, reversed: false });
    else if (t.inward.toLowerCase() === want) hits.push({ type: t, phrase: t.inward, reversed: true });
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw linkErr(400, `"${input}" is a phrase of several link types (${hits.map((h) => h.type.name).join(', ')}) — name the link type instead.`);
  }
  throw linkErr(400, `unknown link type "${input}". Available: ${available}`);
}

// Inward and outward read the same ("relates to"): direction carries no
// meaning, so A→B and B→A are the same link.
function isSymmetric(t) {
  return t.inward.toLowerCase() === t.outward.toLowerCase();
}

// In `subject`'s raw `issuelinks`, the link of `type` where the subject takes
// the outward phrase towards `objectKey` (either direction for a symmetric type).
function findLink(rawLinks, type, objectKey) {
  const want = objectKey.toUpperCase();
  const sameType = (l) => l && l.type && (type.id && l.type.id != null ? String(l.type.id) === type.id : l.type.name === type.name);
  const keyOf = (i) => (i && i.key ? String(i.key).toUpperCase() : null);
  return (Array.isArray(rawLinks) ? rawLinks : []).find((l) => sameType(l)
    && (keyOf(l.outwardIssue) === want || (isSymmetric(type) && keyOf(l.inwardIssue) === want))) || null;
}

async function readIssueLinks(base, auth, issueKey) {
  try {
    const raw = await requestJson({ base, path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=issuelinks`, authHeader: auth });
    return (raw.fields && raw.fields.issuelinks) || [];
  } catch (e) {
    if (e.status === 404) throw linkErr(404, `issue ${issueKey} was not found, or the Jira account cannot see it (404). Nothing was changed.`);
    throw e;
  }
}

// A site admin can switch linking off globally. Checked before a link write so
// the refusal names the cause; an unreadable configuration is not a refusal —
// the write itself then decides.
async function assertLinkingEnabled(base, auth) {
  let conf;
  try {
    conf = await requestJson({ base, path: '/rest/api/3/configuration', authHeader: auth });
  } catch {
    return;
  }
  if (conf && conf.issueLinkingEnabled === false) {
    throw linkErr(409, 'issue linking is disabled on this Jira site — a Jira site admin turns it on (Jira settings → Issues → Issue linking). Nothing was changed.');
  }
}

// A refused link write, named by its cause. Jira answers a missing "Link
// Issues" permission with a 403 or a 404 whose body says so; any other 404 is
// an issue (or link) the account cannot see.
function linkWriteError(e, what) {
  if (!e || !e.status) return e;
  if (e.status === 403 || ((e.status === 404 || e.status === 400) && /permission/i.test(e.body || ''))) {
    return linkErr(403, `the Jira account lacks the "Link Issues" permission for ${what} (${e.status}). Nothing was changed.`);
  }
  if (e.status === 404) return linkErr(404, `${what} was not found, or the Jira account cannot see it (404). Nothing was changed.`);
  return e;
}

function linkIdFromLocation(location) {
  const m = /\/issueLink\/(\d+)\/?$/.exec(String(location || ''));
  return m ? m[1] : null;
}

function linkKeys(from, to) {
  const a = String(from || '').trim();
  const b = String(to || '').trim();
  if (!a || !b) throw linkErr(400, 'two issue keys are required, e.g. KAN-1 blocks KAN-2');
  if (a.toUpperCase() === b.toUpperCase()) throw linkErr(400, `an issue cannot be linked to itself (${a}).`);
  return [a, b];
}

// The site's link types (CLI `link-types`): `[{ id, name, inward, outward }]`.
async function listLinkTypes(cred, { env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const res = await requestJson({ base, path: '/rest/api/3/issueLinkType', authHeader: auth });
  return (Array.isArray(res.issueLinkTypes) ? res.issueLinkTypes : [])
    .map((t) => ({ id: String(t.id), name: String(t.name || ''), inward: String(t.inward || ''), outward: String(t.outward || '') }))
    .filter((t) => t.name);
}

// Link two existing issues: "<from> <type> <to>". Every refusal (self-link,
// unknown/ambiguous type, linking disabled, an invisible first issue) comes
// before the write. Idempotent: an existing link of the same type and direction
// is reported (`created: false`) instead of duplicated. Never retried on a
// transport failure (a retry after Jira accepted the first would duplicate).
async function createIssueLink(cred, { from, type, to, env } = {}) {
  const [a, b] = linkKeys(from, to);
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const resolved = resolveLinkType(await listLinkTypes(cred, { env }), type);
  await assertLinkingEnabled(base, auth);
  const [subject, object] = resolved.reversed ? [b, a] : [a, b];
  const statement = `${a} ${resolved.phrase} ${b}`;
  const result = (created, id) => ({ created, id, type: resolved.type.name, statement, issues: [a, b] });
  const existing = findLink(await readIssueLinks(base, auth, subject), resolved.type, object);
  if (existing) return result(false, String(existing.id));
  let location = null;
  try {
    const res = await requestJson({
      base,
      path: '/rest/api/3/issueLink',
      method: 'POST',
      authHeader: auth,
      body: { type: { name: resolved.type.name }, inwardIssue: { key: subject }, outwardIssue: { key: object } },
      withLocation: true,
    });
    location = res.location;
  } catch (e) {
    throw linkWriteError(e, `issue ${subject} or ${object}`);
  }
  let id = linkIdFromLocation(location);
  if (!id) {
    // No `Location` header: the new link is the one the subject now carries.
    try {
      const found = findLink(await readIssueLinks(base, auth, subject), resolved.type, object);
      id = found ? String(found.id) : null;
    } catch { /* the link exists; only its id is unknown */ }
  }
  return result(true, id);
}

// Remove a link by its id (from `show`), or by "<from> <type> <to>". A link that
// does not exist is a 404 and nothing changes. `issues` names both ends so the
// broker can mark the `Link` changelog echo on each as its own write.
async function removeIssueLink(cred, { id, from, type, to, env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  let out;
  if (id != null && String(id).trim()) {
    const linkId = String(id).trim();
    if (!/^\d+$/.test(linkId)) throw linkErr(400, `a link id is numeric (the "id" of an entry in \`aee-jira show\`'s links), got "${linkId}".`);
    await assertLinkingEnabled(base, auth);
    let link;
    try {
      link = await requestJson({ base, path: `/rest/api/3/issueLink/${linkId}`, authHeader: auth });
    } catch (e) {
      if (e.status === 404) throw linkErr(404, `link ${linkId} was not found (404) — it may already be removed, or the Jira account cannot see both issues. Nothing was changed.`);
      throw e;
    }
    const keys = [link.inwardIssue, link.outwardIssue].map((i) => (i && i.key ? String(i.key) : null)).filter(Boolean);
    out = { removed: true, id: linkId, type: link.type && link.type.name ? String(link.type.name) : null, issues: keys };
  } else {
    const [a, b] = linkKeys(from, to);
    const resolved = resolveLinkType(await listLinkTypes(cred, { env }), type);
    await assertLinkingEnabled(base, auth);
    const [subject, object] = resolved.reversed ? [b, a] : [a, b];
    const statement = `${a} ${resolved.phrase} ${b}`;
    const existing = findLink(await readIssueLinks(base, auth, subject), resolved.type, object);
    if (!existing) throw linkErr(404, `no link "${statement}" exists (404). Nothing was changed.`);
    out = { removed: true, id: String(existing.id), type: resolved.type.name, statement, issues: [a, b] };
  }
  try {
    await requestJson({ base, path: `/rest/api/3/issueLink/${out.id}`, method: 'DELETE', authHeader: auth });
  } catch (e) {
    throw linkWriteError(e, `link ${out.id}`);
  }
  return out;
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
//   2. custom-field allow-list — the same gate as `setCustomField` (#2417,
//      #2449): an EMPTY `writable-custom-fields` list means unrestricted; a
//      NON-EMPTY list means EVERY custom field named anywhere (epic or a story)
//      must be on it, and a non-listed field is a 403 before anything is
//      created. The Epic-link field the broker sets to wire a Story to its Epic
//      is structural, NOT a user-named field, so it is exempt from the allow-list.
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

// Validate every story up front (a story without a summary is a 400 before any
// create). Pure — throws, returns the list.
function validateStoryList(stories) {
  const storyList = Array.isArray(stories) ? stories : [];
  storyList.forEach((s, i) => {
    if (!s || typeof s !== 'object' || !String(s.summary || '').trim()) {
      const e = new Error(`story #${i + 1} requires a summary`); e.status = 400; throw e;
    }
  });
  return storyList;
}

// (2) allow-list gate — an empty list means unrestricted; a non-empty list
// restricts writes to only the named fields (#2449 flips the old deny-by-default).
// Throws a 403 naming every refused field. Pure — runs before any HTTP call.
function assertCreateFieldsAllowed(usedNames, allowList) {
  const allow = (Array.isArray(allowList) ? allowList : [])
    .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const notAllowed = allow.length
    ? usedNames.filter((n) => !allow.includes(n.toLowerCase()))
    : [];
  if (notAllowed.length) {
    const e = new Error(
      `custom field(s) not writable by agents: ${notAllowed.join(', ')}. This team's `
        + `writable-custom-fields allow-list is: ${allowList.join(', ')}. A Team Admin adds them on the Plugins page.`,
    );
    e.status = 403;
    throw e;
  }
}

// (3) name → id + schema, up front (one cached catalog fetch feeds every field
// AND the Epic-link id used to wire Story→Epic). An unknown name is a 400.
async function resolveCreateFieldMeta(base, auth, usedNames) {
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
  return { catalog, fieldMeta };
}

// Apply an optional follow-up status transition to a just-created issue. Jira
// creates in the workflow's initial status, so a requested non-default start is
// a transition (the ticket's implementer note). A transition failure is
// reported alongside the created key, never a hard failure — the issue exists.
function statusApplier(cred, env) {
  return async (key, status, out) => {
    const want = String(status || '').trim();
    if (!want) return;
    try {
      const t = await transitionIssue(cred, key, { toStatus: want, env });
      out.status = t.toStatus || want;
    } catch (err) {
      out.statusError = err.message;
    }
  };
}

// Create each story under `epicKey`, one at a time. Team-managed projects use
// the native `parent`; company-managed (classic) uses the Epic Link custom field
// — mirror the #2415 read side: a site with an Epic Link field id uses it, else
// `parent`. A per-story failure is recorded and the loop continues (no
// create-transaction); returns the per-story outcome list. The optional
// `prepare(spec, fields)` hook (add-stories, #2896) finishes one issue's create
// body — its type, priority, labels — and may throw to refuse just that issue;
// it returns extra outcome keys (e.g. `issueType`). `mapCreateError(err, fields)`
// may turn Jira's create refusal into a readable one.
async function createStoriesUnderEpic({ base, auth, projectKey, epicKey, storyList, storyTypeName, catalog, fieldMeta, attribution, applyStatus, browseUrl, onCreated, prepare, mapCreateError }) {
  const storyResults = [];
  for (const s of storyList) {
    try {
      const storyFields = buildCreateFields({ projectKey, issueTypeName: storyTypeName, spec: s, fieldMeta, attribution });
      if (catalog.epicLinkId) storyFields[catalog.epicLinkId] = epicKey;
      else storyFields.parent = { key: epicKey };
      const extra = typeof prepare === 'function' ? await prepare(s, storyFields) : null;
      let created;
      try {
        created = await createIssue(base, auth, storyFields);
      } catch (e) {
        throw (typeof mapCreateError === 'function' && mapCreateError(e, storyFields)) || e;
      }
      if (typeof onCreated === 'function') onCreated(created.key);
      const out = { summary: String(s.summary).trim(), ...(extra || {}), key: created.key, url: browseUrl(created.key), ok: true };
      await applyStatus(created.key, s.status, out);
      storyResults.push(out);
    } catch (err) {
      storyResults.push({ summary: String(s.summary).trim(), ok: false, error: err.message });
    }
  }
  return storyResults;
}

// `onCreated(key)` fires the moment each issue exists — before the next create
// — so the broker's own-writes registry knows the key before any poll can see
// it (a large epic spans several poll ticks).
async function createEpicWithStories(cred, { projectKey, epic, stories, allowList, attribution, issueTypes, env, onCreated } = {}) {
  const project = String(projectKey || '').trim();
  if (!project) { const e = new Error('a project key is required'); e.status = 400; throw e; }
  if (!epic || typeof epic !== 'object') { const e = new Error('an epic is required'); e.status = 400; throw e; }
  if (!String(epic.summary || '').trim()) { const e = new Error('the epic requires a summary'); e.status = 400; throw e; }
  const storyList = validateStoryList(stories);

  const usedNames = collectCustomFieldNames(epic, storyList);
  assertCreateFieldsAllowed(usedNames, allowList);

  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const { catalog, fieldMeta } = await resolveCreateFieldMeta(base, auth, usedNames);

  const epicTypeName = String((issueTypes && issueTypes.epic) || EPIC_ISSUE_TYPE).trim() || EPIC_ISSUE_TYPE;
  const storyTypeName = String((issueTypes && issueTypes.story) || STORY_ISSUE_TYPE).trim() || STORY_ISSUE_TYPE;
  const siteBase = resolveJiraApiBase(cred.siteUrl);
  const browseUrl = (key) => `${siteBase}/browse/${encodeURIComponent(key)}`;
  const applyStatus = statusApplier(cred, env);

  // (1→create) the epic first — its key links every story.
  const epicFields = buildCreateFields({ projectKey: project, issueTypeName: epicTypeName, spec: epic, fieldMeta, attribution });
  const epicCreated = await createIssue(base, auth, epicFields);
  const epicKey = epicCreated.key;
  if (typeof onCreated === 'function') onCreated(epicKey);
  const epicOut = { key: epicKey, url: browseUrl(epicKey), summary: String(epic.summary).trim() };
  await applyStatus(epicKey, epic.status, epicOut);

  const storyResults = await createStoriesUnderEpic({
    base, auth, projectKey: project, epicKey, storyList, storyTypeName, catalog, fieldMeta, attribution, applyStatus, browseUrl, onCreated,
  });

  return {
    project,
    epic: epicOut,
    stories: storyResults,
    created: 1 + storyResults.filter((r) => r.ok).length,
    failed: storyResults.filter((r) => !r.ok).length,
  };
}

// ── add new Stories to an EXISTING Epic (#2890) ──────────────────────────────
//
// The counterpart of `createEpicWithStories` for a team that already has its
// Epics: N new Stories are created under the Epic named by its key, in the
// Epic's own project. NO Epic is ever created. Same per-story contract
// (summary / description / assignee / status / fields), same allow-list gate,
// same per-story outcome map. The guards run before any create, in order:
//   1. shape validation — a malformed epic key, no stories, or a story without
//      a summary is a 400.
//   2. the custom-field allow-list (403), as in create-epic.
//   3. the Epic lookup — a key Jira does not return (absent, or not visible to
//      the team's credential, which is the team's project scope) is a 404; an
//      issue that is not an Epic is a 400 naming its actual type.
//   4. name → id resolution of the custom fields (400 on an unknown name).
//
// Any standard issue type under the Epic (#2896): a story entry may name its
// `type` (and the call a `defaultType`, the CLI's --type), plus `priority` and
// `labels` — create-issue's field contract. As soon as a type is named, the
// Epic's project types are read once and each issue's type is matched against
// them case-insensitively; an unknown, Epic or sub-task type, or a field the
// project requires for that type but the issue does not set, fails THAT issue
// only — the others are still created. With no type anywhere the call is the
// #2890 Story create, unchanged (no extra Jira reads).
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

// Per-issue refusals for a type under an Epic (#2896) — the other issues in
// the call still go through, so no "Nothing was created" tail.
const EPIC_CHILD_TYPE_REFUSALS = Object.freeze({
  epic: (name) => `${name} is an Epic type — an Epic cannot be created under another Epic (use \`aee-jira create-epic\` for a new Epic)`,
  subtask: (name) => `${name} is a sub-task type — a sub-task belongs under a Story or Task, not directly under an Epic`,
  tail: '',
});

// Shape-check the add-stories extras up front, like create-issue: `labels` is a
// list of single words, `type` a name. Pure — throws a 400.
function validateEpicChildExtras(storyList) {
  storyList.forEach((s, i) => {
    if (s.type != null && typeof s.type !== 'string') throw createIssueError(400, `issue #${i + 1}: type must be an issue type name, e.g. "Bug"`);
    if (s.labels == null) return;
    if (!Array.isArray(s.labels)) throw createIssueError(400, `issue #${i + 1}: labels must be a list of words`);
    const bad = s.labels.map((l) => String(l == null ? '' : l).trim()).filter((l) => l && !LABEL_RE.test(l));
    if (bad.length) {
      throw createIssueError(400, `Jira labels cannot contain spaces: ${bad.map((l) => `"${l}"`).join(', ')} (issue #${i + 1}). Nothing was created.`);
    }
  });
}

// `priority` / `labels` onto one create body (create-issue's contract). Pure.
function applyPriorityAndLabels(spec, fields) {
  const priority = spec.priority == null ? '' : String(spec.priority).trim();
  if (priority) fields.priority = { name: priority };
  const labels = (Array.isArray(spec.labels) ? spec.labels : []).map((l) => String(l == null ? '' : l).trim()).filter(Boolean);
  if (labels.length) fields.labels = labels;
}

// An issue counts as an Epic when its type carries the Epic name (or the
// payload's `issueTypes.epic` override, for a renamed type) or sits on Jira's
// Epic hierarchy level (1) — the latter covers a localised type name.
function isEpicIssueType(issuetype, epicTypeName) {
  if (!issuetype || typeof issuetype !== 'object') return false;
  if (String(issuetype.name || '').trim().toLowerCase() === epicTypeName.toLowerCase()) return true;
  return Number(issuetype.hierarchyLevel) === 1;
}

async function addStoriesToEpic(cred, { epicKey, stories, defaultType, allowList, attribution, issueTypes, env, onCreated } = {}) {
  const key = String(epicKey || '').trim().toUpperCase();
  if (!key) { const e = new Error('an --epic key is required'); e.status = 400; throw e; }
  if (!ISSUE_KEY_RE.test(key)) { const e = new Error(`"${String(epicKey).trim()}" is not a Jira issue key (expected e.g. KAN-12)`); e.status = 400; throw e; }
  const storyList = validateStoryList(stories);
  if (!storyList.length) { const e = new Error('at least one story is required'); e.status = 400; throw e; }
  validateEpicChildExtras(storyList);
  const fallbackType = String(defaultType || '').trim();
  const typed = Boolean(fallbackType) || storyList.some((s) => String(s.type || '').trim());

  const usedNames = collectCustomFieldNames(null, storyList);
  assertCreateFieldsAllowed(usedNames, allowList);

  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const epicTypeName = String((issueTypes && issueTypes.epic) || EPIC_ISSUE_TYPE).trim() || EPIC_ISSUE_TYPE;
  const storyTypeName = String((issueTypes && issueTypes.story) || STORY_ISSUE_TYPE).trim() || STORY_ISSUE_TYPE;

  // (3) the parent must exist, be visible, and be an Epic — before any create.
  let raw;
  try {
    raw = await requestJson({ base, path: `/rest/api/3/issue/${encodeURIComponent(key)}?fields=issuetype,project,summary`, authHeader: auth });
  } catch (e) {
    if (e.status === 404) {
      const err = new Error(`Epic ${key} was not found, or it is outside this team's Jira scope (the account cannot see it). Nothing was created.`);
      err.status = 404;
      throw err;
    }
    throw e;
  }
  const fields = (raw && raw.fields) || {};
  const actualKey = String(raw.key || key);
  if (!isEpicIssueType(fields.issuetype, epicTypeName)) {
    const typeName = (fields.issuetype && fields.issuetype.name) || 'unknown type';
    const e = new Error(`${actualKey} is a ${typeName}, not an Epic — add-stories only adds new issues under an existing Epic. Nothing was created.`);
    e.status = 400;
    throw e;
  }
  const project = String((fields.project && fields.project.key) || actualKey.replace(/-\d+$/, ''));

  const { catalog, fieldMeta } = await resolveCreateFieldMeta(base, auth, usedNames);
  const siteBase = resolveJiraApiBase(cred.siteUrl);
  const browseUrl = (k) => `${siteBase}/browse/${encodeURIComponent(k)}`;

  // (#2896) the Epic's project types, read once when any issue names a type.
  let projectTypes = null;
  if (typed) {
    const proj = await requestJson({ base, path: `/rest/api/3/project/${encodeURIComponent(project)}`, authHeader: auth });
    projectTypes = (proj && proj.issueTypes) || [];
  }
  const metaByType = new Map(); // type id → create metadata (or null), per call
  const prepare = async (s, storyFields) => {
    applyPriorityAndLabels(s, storyFields);
    if (!typed) return null;
    const wanted = String(s.type || '').trim() || fallbackType || storyTypeName;
    const type = resolveProjectIssueType(project, projectTypes, wanted, epicTypeName, EPIC_CHILD_TYPE_REFUSALS);
    if (type.id) {
      storyFields.issuetype = { id: String(type.id) };
      if (!metaByType.has(type.id)) metaByType.set(type.id, await readCreateFieldMeta(base, auth, project, type.id));
      const meta = metaByType.get(type.id);
      const missing = meta ? missingRequiredFields(meta, storyFields) : [];
      if (missing.length) {
        throw createIssueError(400,
          `project ${project} requires field(s) for a ${type.name} that were not provided: ${missing.join(', ')}. `
            + 'Pass them in "fields" by their Jira name.');
      }
    } else {
      storyFields.issuetype = { name: String(type.name) };
    }
    return { issueType: String(type.name) };
  };
  const mapCreateError = (e, storyFields) => {
    const msg = typed && e.status === 400 ? createRejectionMessage(e.body, catalog, storyFields, '') : null;
    return msg ? createIssueError(400, msg) : null;
  };

  const storyResults = await createStoriesUnderEpic({
    base, auth, projectKey: project, epicKey: actualKey, storyList, storyTypeName, catalog, fieldMeta, attribution,
    applyStatus: statusApplier(cred, env), browseUrl, onCreated, prepare, mapCreateError,
  });

  return {
    project,
    epic: { key: actualKey, url: browseUrl(actualKey), summary: String(fields.summary || '') },
    stories: storyResults,
    created: storyResults.filter((r) => r.ok).length,
    failed: storyResults.filter((r) => !r.ok).length,
  };
}

// ── one standalone issue, no parent Epic (#2894) ─────────────────────────────
//
// The everyday Jira create: ONE new issue of any standard type the project
// offers (Story, Task, Bug, a localised "Fehler", …), with no parent. Same field
// contract as the create-epic / add-stories issues (summary / description /
// assignee / status / custom `fields`), plus `priority` and `labels`. Jira has
// no create-transaction, so every guard runs before the single create:
//   1. shape validation — no project / issue type / summary, or a label with
//      whitespace (Jira labels are single words), is a 400.
//   2. the custom-field allow-list (403), as in set-field / create-epic.
//   3. the project lookup — a project Jira does not return to the team's
//      credential is outside the team's scope (404), worded like add-stories.
//   4. the issue type, matched case-insensitively against the PROJECT's own
//      type names (team- and company-managed alike): an unknown name is a 400
//      listing the types the project offers; an Epic points at create-epic and
//      a sub-task type is refused (both need a different command / a parent).
//   5. name → id resolution of the custom fields (400 on an unknown name).
//   6. the project's required fields for that type (create metadata): a
//      required field without a default that the call does not set is a 400
//      naming it, instead of Jira's raw error. An unreadable create metadata
//      skips this pre-check; Jira's own 400 is then mapped to field names (7).
//   7. the create itself — a 400 from Jira (e.g. an unknown assignee
//      accountId) is reported per field, by name; nothing was created.
// A requested `status` is a follow-up transition (statusApplier): its failure
// is reported next to the created key, never a hard failure.
const LABEL_RE = /^\S+$/;

function createIssueError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Standard (creatable here) vs Epic vs sub-task, from a project issue type. Pure.
function classifyIssueType(t, epicTypeName) {
  if (t && (t.subtask === true || Number(t.hierarchyLevel) < 0)) return 'subtask';
  if (isEpicIssueType(t, epicTypeName)) return 'epic';
  return 'standard';
}

// Match the requested type name against the project's types and refuse the
// ones the caller does not create. `refusals` words the Epic / sub-task refusal
// and the message tail per command. Pure — throws a 400, returns the type.
const STANDALONE_TYPE_REFUSALS = Object.freeze({
  epic: (name) => `${name} is an Epic type — use \`aee-jira create-epic\` to create an Epic (with its Stories)`,
  subtask: (name) => `${name} is a sub-task type, which always needs a parent issue — create-issue only creates standalone issues`,
  tail: ' Nothing was created.',
});

function resolveProjectIssueType(projectKey, projectTypes, requested, epicTypeName, refusals) {
  const want = String(requested || '').trim().toLowerCase();
  const types = Array.isArray(projectTypes) ? projectTypes.filter((t) => t && t.name) : [];
  const match = types.find((t) => String(t.name).trim().toLowerCase() === want);
  if (!match) {
    const standard = types.filter((t) => classifyIssueType(t, epicTypeName) === 'standard').map((t) => t.name);
    throw createIssueError(400,
      `project ${projectKey} has no issue type "${String(requested).trim()}". Available: ${standard.join(', ') || '(none)'}.${refusals.tail}`);
  }
  const kind = classifyIssueType(match, epicTypeName);
  if (kind === 'epic' || kind === 'subtask') throw createIssueError(400, `${refusals[kind](match.name)}.${refusals.tail}`);
  return match;
}

function resolveStandaloneIssueType(projectKey, projectTypes, requested, epicTypeName) {
  return resolveProjectIssueType(projectKey, projectTypes, requested, epicTypeName, STANDALONE_TYPE_REFUSALS);
}

// The required fields Jira lists for (project, type) that have no default and
// that `fields` (the create body) does not set. Pure.
function missingRequiredFields(meta, fields) {
  const exempt = new Set(['project', 'issuetype']);
  return (Array.isArray(meta) ? meta : [])
    .filter((f) => f && f.required && !f.hasDefaultValue)
    .filter((f) => {
      const id = String(f.fieldId || f.key || '');
      return id && !exempt.has(id) && !(id in fields);
    })
    .map((f) => String(f.name || f.fieldId || f.key));
}

// The (project, type) field metadata from Jira's create-meta endpoint, all
// pages. `null` when it cannot be read — the pre-check is then skipped.
async function readCreateFieldMeta(base, auth, projectKey, issueTypeId) {
  const out = [];
  try {
    for (let page = 0, startAt = 0; page < MAX_PAGES; page += 1) {
      const res = await requestJson({
        base,
        path: `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}?startAt=${startAt}&maxResults=${PAGE_SIZE}`,
        authHeader: auth,
      });
      const items = Array.isArray(res.fields) ? res.fields : Array.isArray(res.results) ? res.results : [];
      out.push(...items);
      startAt += items.length;
      if (!items.length || (res.total != null ? startAt >= Number(res.total) : items.length < PAGE_SIZE)) break;
    }
  } catch {
    return null;
  }
  return out;
}

// Turn Jira's 400 answer to a create (`{ errorMessages, errors: { fieldId: msg } }`)
// into one readable refusal, field ids named by their Jira names. `tail` ends
// the message (add-stories reports per issue, so it passes ''). Pure.
function createRejectionMessage(bodyText, catalog, fields, tail = ' Nothing was created.') {
  const body = safeJson(bodyText || '');
  const parts = [];
  for (const [id, msg] of Object.entries(body && body.errors && typeof body.errors === 'object' ? body.errors : {})) {
    if (id === 'assignee' && fields.assignee) {
      parts.push(`assignee "${fields.assignee.accountId}" was rejected (${msg}) — pass a valid Atlassian accountId of someone assignable in this project`);
      continue;
    }
    const meta = catalog && catalog.byId && catalog.byId.get(id);
    parts.push(`${meta ? meta.name : id}: ${msg}`);
  }
  for (const msg of Array.isArray(body && body.errorMessages) ? body.errorMessages : []) parts.push(String(msg));
  if (!parts.length) return null;
  return `Jira refused to create the issue: ${parts.map((p) => p.replace(/[.\s]+$/, '')).join('; ')}.${tail}`;
}

async function createStandaloneIssue(cred, { projectKey, issueType, issue, allowList, attribution, issueTypes, env, onCreated } = {}) {
  const requestedProject = String(projectKey || '').trim().toUpperCase();
  if (!requestedProject) throw createIssueError(400, 'a --project key is required');
  if (!String(issueType || '').trim()) throw createIssueError(400, 'an issue --type is required (e.g. Bug, Task, Story)');
  const spec = issue && typeof issue === 'object' ? issue : {};
  if (!String(spec.summary || '').trim()) throw createIssueError(400, 'the issue requires a summary');
  if (spec.labels != null && !Array.isArray(spec.labels)) throw createIssueError(400, 'labels must be a list of words');
  const labels = (spec.labels || []).map((l) => String(l == null ? '' : l).trim()).filter(Boolean);
  const badLabels = labels.filter((l) => !LABEL_RE.test(l));
  if (badLabels.length) {
    throw createIssueError(400, `Jira labels cannot contain spaces: ${badLabels.map((l) => `"${l}"`).join(', ')}. Nothing was created.`);
  }
  const priority = spec.priority == null ? '' : String(spec.priority).trim();

  const usedNames = collectCustomFieldNames(spec, []);
  assertCreateFieldsAllowed(usedNames, allowList);

  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const epicTypeName = String((issueTypes && issueTypes.epic) || EPIC_ISSUE_TYPE).trim() || EPIC_ISSUE_TYPE;

  // (3) the project must be visible to the team's credential — its scope.
  let project;
  try {
    project = await requestJson({ base, path: `/rest/api/3/project/${encodeURIComponent(requestedProject)}`, authHeader: auth });
  } catch (e) {
    if (e.status === 404) {
      throw createIssueError(404, `Project ${requestedProject} was not found, or it is outside this team's Jira scope (the account cannot see it). Nothing was created.`);
    }
    throw e;
  }
  const projectKeyActual = String((project && project.key) || requestedProject);
  // (4) the project's own type names
  const type = resolveStandaloneIssueType(projectKeyActual, project && project.issueTypes, issueType, epicTypeName);

  const { catalog, fieldMeta } = await resolveCreateFieldMeta(base, auth, usedNames);
  const fields = buildCreateFields({ projectKey: projectKeyActual, issueTypeName: type.name, spec, fieldMeta, attribution });
  if (type.id) fields.issuetype = { id: String(type.id) };
  if (priority) fields.priority = { name: priority };
  if (labels.length) fields.labels = labels;

  // (6) required fields the call leaves unset
  if (type.id) {
    const meta = await readCreateFieldMeta(base, auth, projectKeyActual, type.id);
    const missing = meta ? missingRequiredFields(meta, fields) : [];
    if (missing.length) {
      throw createIssueError(400,
        `project ${projectKeyActual} requires field(s) for a ${type.name} that were not provided: ${missing.join(', ')}. `
          + 'Pass them in "fields" by their Jira name. Nothing was created.');
    }
  }

  // (7) the create — never retried (F6)
  let created;
  try {
    created = await createIssue(base, auth, fields);
  } catch (e) {
    const msg = e.status === 400 ? createRejectionMessage(e.body, catalog, fields) : null;
    if (msg) throw createIssueError(400, msg);
    throw e;
  }
  if (typeof onCreated === 'function') onCreated(created.key);
  const siteBase = resolveJiraApiBase(cred.siteUrl);
  const out = {
    project: projectKeyActual,
    issueType: String(type.name),
    key: created.key,
    url: `${siteBase}/browse/${encodeURIComponent(created.key)}`,
    summary: fields.summary,
  };
  await statusApplier(cred, env)(created.key, spec.status, out);
  return out;
}

// ── put EXISTING issues under an Epic, move them, take them out (#2895) ──────
//
// Backlog grooming: set the parent Epic of one or more existing standard issues
// (Story, Task, Bug, …) — or clear it (`epicKey` null). Only Epic ↔ standard
// issue parenting: an Epic or a sub-task in the list is refused per issue.
// Order of work:
//   1. shape — a malformed target key or an empty list is a 400.
//   2. the target lookup — a key Jira does not return (absent, or not visible to
//      the team's credential = outside the team's scope) is a 404; an issue
//      that is not an Epic is a 400 naming its type. Nothing is changed.
//   3. each issue in turn (duplicates once, no cap): read it, refuse an Epic /
//      sub-task, skip one already under the target (`unchanged`, a success),
//      else write the parent. A per-issue failure is recorded and the loop
//      continues, so one bad key never hides the others.
// The write uses the native `parent` field — Jira Cloud's parent for both
// project styles — and falls back to the site's Epic Link field when Jira
// rejects `parent` (400) on an older company-managed configuration.

// Jira's changelog names for a parent change on the child issue: `parent` /
// `IssueParentAssociation` (native parent) and `Epic Link` (classic). The Epic
// side logs `Epic Child`. The broker stamps these as own writes.
const PARENT_CHANGE_FIELDS = Object.freeze(['parent', 'IssueParentAssociation', 'Epic Link']);
const EPIC_CHILD_FIELD = 'Epic Child';

const parentErr = (status, message) => { const e = new Error(message); e.status = status; return e; };
const outOfScope = (what, key) => `${what}${key} was not found, or it is outside this team's Jira scope (the account cannot see it)`;

// Jira's own reason for a refused edit (`{ errorMessages, errors }`), readable.
function parentWriteRefusal(err, key) {
  if (err.status === 404) return `${outOfScope('', key)}.`;
  const body = safeJson(err.body || '');
  const parts = [];
  for (const [field, msg] of Object.entries(body && body.errors && typeof body.errors === 'object' ? body.errors : {})) parts.push(`${field}: ${msg}`);
  for (const msg of Array.isArray(body && body.errorMessages) ? body.errorMessages : []) parts.push(String(msg));
  if (!parts.length) return err.message;
  const prefix = err.status === 403 ? `the Jira account may not edit ${key} (403)` : 'Jira refused the change';
  return `${prefix}: ${parts.map((p) => p.replace(/[.\s]+$/, '')).join('; ')}`;
}

async function writeParent(base, auth, key, epicKey, epicLinkId) {
  const viaParent = { parent: epicKey ? { key: epicKey } : null };
  const attempts = epicLinkId ? [viaParent, { [epicLinkId]: epicKey || null }] : [viaParent];
  let first = null;
  for (const fields of attempts) {
    try {
      // A write — NOT retried on a transport failure (F6).
      await requestJson({ base, path: `/rest/api/3/issue/${encodeURIComponent(key)}`, method: 'PUT', authHeader: auth, body: { fields } });
      return;
    } catch (e) {
      if (!first) first = e;
      if (e.status !== 400) throw e;
    }
  }
  throw first;
}

// `onChanged(issueKey, { from, to })` fires the moment each parent write lands
// (before the next one), so the own-writes registry knows it before any poll.
async function setParentEpic(cred, { epicKey, issueKeys, issueTypes, env, onChanged } = {}) {
  const removing = epicKey == null || String(epicKey).trim() === '';
  const target = removing ? null : String(epicKey).trim().toUpperCase();
  if (target && !ISSUE_KEY_RE.test(target)) throw parentErr(400, `"${String(epicKey).trim()}" is not a Jira issue key (expected e.g. KAN-12)`);
  const keys = [];
  for (const k of Array.isArray(issueKeys) ? issueKeys : []) {
    const norm = String(k == null ? '' : k).trim().toUpperCase();
    if (norm && !keys.includes(norm)) keys.push(norm);
  }
  if (!keys.length) throw parentErr(400, 'at least one issue key is required');

  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const epicTypeName = String((issueTypes && issueTypes.epic) || EPIC_ISSUE_TYPE).trim() || EPIC_ISSUE_TYPE;
  const siteBase = resolveJiraApiBase(cred.siteUrl);
  const browseUrl = (k) => `${siteBase}/browse/${encodeURIComponent(k)}`;

  let epic = null;
  if (target) {
    let raw;
    try {
      raw = await requestJson({ base, path: `/rest/api/3/issue/${encodeURIComponent(target)}?fields=issuetype,summary`, authHeader: auth });
    } catch (e) {
      if (e.status === 404) throw parentErr(404, `${outOfScope('Epic ', target)}. Nothing was changed.`);
      throw e;
    }
    const f = (raw && raw.fields) || {};
    const actual = String(raw.key || target);
    if (classifyIssueType(f.issuetype, epicTypeName) !== 'epic') {
      const typeName = (f.issuetype && f.issuetype.name) || 'unknown type';
      throw parentErr(400, `${actual} is a ${typeName}, not an Epic — issues can only be put under an Epic. Nothing was changed.`);
    }
    epic = { key: actual, url: browseUrl(actual), summary: String(f.summary || '') };
  }

  const epicLinkId = await resolveEpicLinkFieldId(base, auth);
  const readFields = ['issuetype', 'summary', 'parent', ...(epicLinkId ? [epicLinkId] : [])].join(',');
  const results = [];
  for (const key of keys) {
    const out = { issue: key };
    try {
      if (!ISSUE_KEY_RE.test(key)) throw parentErr(400, `"${key}" is not a Jira issue key (expected e.g. KAN-30)`);
      let raw;
      try {
        raw = await requestJson({ base, path: `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(readFields)}`, authHeader: auth });
      } catch (e) {
        if (e.status === 404) throw parentErr(404, `${outOfScope('', key)}.`);
        throw e;
      }
      const f = (raw && raw.fields) || {};
      const typeName = (f.issuetype && f.issuetype.name) || 'issue';
      const kind = classifyIssueType(f.issuetype, epicTypeName);
      if (kind === 'epic') throw parentErr(400, `${key} is an Epic — an Epic cannot be put under or taken out of another Epic`);
      if (kind === 'subtask') throw parentErr(400, `${key} is a ${typeName} — a sub-task's parent is a standard issue, not an Epic; it is not moved`);
      const from = parentKeyOf(f, epicLinkId);
      out.from = from;
      out.to = epic ? epic.key : null;
      if ((from || null) === out.to) {
        out.ok = true;
        out.outcome = 'unchanged';
        out.message = epic ? `already under ${epic.key}` : 'has no parent Epic';
      } else {
        try {
          await writeParent(base, auth, key, out.to, epicLinkId);
        } catch (e) {
          throw parentErr(e.status, parentWriteRefusal(e, key));
        }
        if (typeof onChanged === 'function') onChanged(key, { from, to: out.to });
        out.ok = true;
        out.outcome = !epic ? 'removed' : from ? 'moved' : 'added';
        out.message = !epic ? `removed from ${from}` : from ? `moved from ${from} to ${epic.key}` : `added to ${epic.key}`;
      }
    } catch (err) {
      out.ok = false;
      out.outcome = 'failed';
      out.error = err.message;
    }
    results.push(out);
  }

  return {
    epic,
    issues: results,
    changed: results.filter((r) => r.ok && r.outcome !== 'unchanged').length,
    unchanged: results.filter((r) => r.outcome === 'unchanged').length,
    failed: results.filter((r) => !r.ok).length,
  };
}

// ── board & sprint management (Jira Agile API, #2450) ────────────────────────
//
// The first capability that touches Jira's **Agile** surface (`/rest/agile/1.0`,
// not `/rest/api/3`): the board/sprint concept the plugin had none of. Three
// things an agent can now do, all bound to a Scrum board resolved by its
// human-readable name (like the field name→id resolution the custom-field ops
// use, #2416/#2417):
//   • READ  — list a board's sprints (needed to know "where the last one ends"
//             so a bulk generation can continue from it).
//   • WRITE — create ONE sprint (explicit name/start/end).
//   • WRITE — BULK-generate a run of future sprints from a cadence + a naming
//             template + a target end date, continuing by default from the
//             board's latest existing sprint.
//
// A Scrum board only ever has one *active* sprint; every sprint this creates is
// a Jira "future" (not-started) sprint — the state a plain POST /sprint yields,
// so no state is sent. The whole date/naming computation (`planSprints` and its
// helpers) is PURE so the month-crosses-week-boundary naming rule and the
// continuation arithmetic unit-test without a live Jira; the async functions are
// the thin adapters, same pure-core / I/O-edge split as the rest of this module.

const AGILE_BASE = '/rest/agile/1.0';
const AGILE_PAGE_SIZE = 50;
// A hard safety bound on a single bulk generation so a far-future `--until` (or a
// tiny cadence) can never spiral into thousands of create calls. 2 years of
// weekly sprints — generous for real planning, cheap to refuse past.
const MAX_BULK_SPRINTS = 104;

// English month names, fixed (never the runtime locale) so a rendered sprint
// name is deterministic regardless of where the broker runs.
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// Parse a caller date (a bare `YYYY-MM-DD` or a full ISO-8601 string) and
// truncate it to its UTC calendar day (a Date at 00:00:00.000Z). All sprint date
// math is done in UTC so it is independent of the broker's timezone. Throws a 400
// on an unparseable value.
function parseUtcDay(value, label = 'date') {
  const s = String(value == null ? '' : value).trim();
  if (!s) { const e = new Error(`a ${label} is required`); e.status = 400; throw e; }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    const e = new Error(`"${value}" is not a valid ${label} (use YYYY-MM-DD)`); e.status = 400; throw e;
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addUtcDays(day, n) {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + n));
}

// A UTC-day Date → the `T00:00:00.000Z` ISO string Jira's sprint create accepts.
function isoStartOfDay(day) {
  return `${day.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

// The occurrence index of the day's weekday within its month: the Nth Monday /
// Tuesday / … . `ceil(dayOfMonth / 7)` — day 1–7 → 1, 8–14 → 2, …, 26 → 4. This
// is the "week-of-month" the example naming rule uses, and because it is keyed
// entirely off the sprint's START day (its Monday), the "Monday decides the
// label even when the week crosses into the next month" rule falls out for free.
function weekOfMonth(day) {
  return Math.ceil(day.getUTCDate() / 7);
}

// Render one sprint's name from a caller template + its start day (+ 1-based
// index in the batch). Supported placeholders (a known token is substituted; an
// unknown `{token}` is left verbatim so a typo is visible, not silently dropped):
//   {MMM} 3-letter month, {MMMM} full month, {MM} 2-digit month, {M} month,
//   {YYYY} year, {YY} 2-digit year, {DD} 2-digit day, {D} day,
//   {weekOfMonth} the Nth-weekday-of-month index, {n}/{index} 1-based batch #.
// Month/day come from the sprint's START day (its Monday) — the documented rule.
function renderSprintName(template, day, index) {
  const tokens = {
    MMM: MONTHS_SHORT[day.getUTCMonth()],
    MMMM: MONTHS_FULL[day.getUTCMonth()],
    MM: String(day.getUTCMonth() + 1).padStart(2, '0'),
    M: String(day.getUTCMonth() + 1),
    YYYY: String(day.getUTCFullYear()),
    YY: String(day.getUTCFullYear()).slice(-2),
    DD: String(day.getUTCDate()).padStart(2, '0'),
    D: String(day.getUTCDate()),
    weekOfMonth: String(weekOfMonth(day)),
    n: String(index),
    index: String(index),
  };
  return String(template).replace(/\{(\w+)\}/g, (m, key) => (
    Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : m
  ));
}

// Pure: the run of sprints to create. Each sprint is `cadenceDays` long; the
// first starts on `start` (a UTC-day Date) and every next one starts the day
// AFTER the previous one's (inclusive) end, so the sprints are contiguous. A
// sprint is generated while its START day is on or before `until` (so the target
// date is always reached / covered). Returns `[{ name, startDate, endDate }]`
// with ISO `T00:00:00.000Z` bounds. Throws a 400 on a bad cadence / empty
// template / a run that would exceed MAX_BULK_SPRINTS.
function planSprints({ start, cadenceDays, until, nameTemplate }) {
  const tmpl = String(nameTemplate == null ? '' : nameTemplate).trim();
  if (!tmpl) { const e = new Error('a name template is required'); e.status = 400; throw e; }
  const days = Math.floor(Number(cadenceDays));
  if (!Number.isFinite(days) || days < 1) {
    const e = new Error('cadence must be a whole number of days ≥ 1'); e.status = 400; throw e;
  }
  const sprints = [];
  let cur = start;
  let index = 1;
  while (cur.getTime() <= until.getTime()) {
    if (sprints.length >= MAX_BULK_SPRINTS) {
      const e = new Error(
        `this run would create more than ${MAX_BULK_SPRINTS} sprints — narrow the target date or widen the cadence`,
      );
      e.status = 400; throw e;
    }
    const end = addUtcDays(cur, days - 1); // inclusive last day (Mon..Sun for weekly)
    sprints.push({ name: renderSprintName(tmpl, cur, index), startDate: isoStartOfDay(cur), endDate: isoStartOfDay(end) });
    cur = addUtcDays(cur, days);
    index += 1;
  }
  return sprints;
}

// Shape one raw Agile sprint to what the CLI consumes.
function shapeSprint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id == null ? null : String(raw.id);
  if (id == null) return null;
  return {
    id,
    name: raw.name == null ? '' : String(raw.name),
    state: raw.state ? String(raw.state) : null,
    startDate: raw.startDate ? String(raw.startDate) : null,
    endDate: raw.endDate ? String(raw.endDate) : null,
    goal: raw.goal ? String(raw.goal) : null,
    boardId: raw.originBoardId == null ? null : String(raw.originBoardId),
  };
}

// Resolve a human-readable board NAME to its id (mirrors the field name→id
// resolution the custom-field ops use). Jira's `?name=` filter is a substring
// match, so this narrows further: an exact (case-insensitive) name wins; failing
// that, a single candidate is accepted; otherwise it is an actionable error that
// lists what it found (a 404 for none, a 409 for several) rather than guessing.
// `projectKeyOrId` optionally disambiguates when two projects have like-named
// boards. Returns `{ id, name, type }`.
async function resolveBoardByName(cred, { boardName, projectKeyOrId, env } = {}) {
  const wanted = String(boardName == null ? '' : boardName).trim();
  if (!wanted) { const e = new Error('a board name is required'); e.status = 400; throw e; }
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const boards = [];
  let startAt = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const qs = new URLSearchParams({ name: wanted, startAt: String(startAt), maxResults: String(AGILE_PAGE_SIZE) });
    if (projectKeyOrId) qs.set('projectKeyOrId', String(projectKeyOrId));
    const res = await requestJson({ base, path: `${AGILE_BASE}/board?${qs.toString()}`, authHeader: auth });
    const values = Array.isArray(res.values) ? res.values : [];
    for (const b of values) if (b && b.id != null) boards.push({ id: String(b.id), name: String(b.name || ''), type: b.type ? String(b.type) : null });
    startAt += values.length;
    if (res.isLast || values.length === 0 || (typeof res.total === 'number' && startAt >= res.total)) break;
  }
  if (boards.length === 0) {
    const e = new Error(`no board found matching "${wanted}". Check the board name (as it appears in Jira).`);
    e.status = 404; throw e;
  }
  const exact = boards.filter((b) => b.name.toLowerCase() === wanted.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    const e = new Error(`"${wanted}" matches ${exact.length} boards: ${exact.map((b) => `${b.name} (id ${b.id})`).join(', ')}. Disambiguate with --project.`);
    e.status = 409; throw e;
  }
  if (boards.length === 1) return boards[0];
  const e = new Error(`"${wanted}" is ambiguous — ${boards.length} boards contain it: ${boards.map((b) => `${b.name} (id ${b.id})`).join(', ')}. Use the exact board name.`);
  e.status = 409; throw e;
}

// Resolve the board (by id if given, else by name) to `{ id, name }`.
async function resolveBoard(cred, { boardId, boardName, projectKeyOrId, env } = {}) {
  if (boardId != null && String(boardId).trim()) {
    return { id: String(boardId).trim(), name: null, type: null };
  }
  return resolveBoardByName(cred, { boardName, projectKeyOrId, env });
}

// List a board's sprints (CLI `sprint list`). `state` optionally filters to Jira's
// future / active / closed buckets (a comma list). Paginated. Returns
// `{ board: { id, name }, sprints: [shapeSprint…] }`.
async function listBoardSprints(cred, { boardId, boardName, projectKeyOrId, state, env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const board = await resolveBoard(cred, { boardId, boardName, projectKeyOrId, env });
  const sprints = [];
  let startAt = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const qs = new URLSearchParams({ startAt: String(startAt), maxResults: String(AGILE_PAGE_SIZE) });
    if (state && String(state).trim()) qs.set('state', String(state).trim());
    const res = await requestJson({ base, path: `${AGILE_BASE}/board/${encodeURIComponent(board.id)}/sprint?${qs.toString()}`, authHeader: auth });
    const values = Array.isArray(res.values) ? res.values : [];
    for (const raw of values) { const s = shapeSprint(raw); if (s) sprints.push(s); }
    startAt += values.length;
    if (res.isLast || values.length === 0 || (typeof res.total === 'number' && startAt >= res.total)) break;
  }
  return { board: { id: board.id, name: board.name }, sprints };
}

// Normalise a caller-supplied sprint boundary for `createSprint`: a bare
// `YYYY-MM-DD` becomes start-of-day UTC; a full ISO string is validated and sent
// verbatim (the caller owns the exact time).
function normalizeSprintBoundary(value, label) {
  const s = String(value == null ? '' : value).trim();
  if (!s) { const e = new Error(`a ${label} is required`); e.status = 400; throw e; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) { const e = new Error(`"${value}" is not a valid ${label}`); e.status = 400; throw e; }
  return s;
}

// POST one sprint to `/rest/agile/1.0/sprint`. A future (not-started) sprint —
// no `state` is sent, which is what a plain create yields. A WRITE: never retried
// on a transport failure (F6) — a retry landing after Jira accepted the first
// would create a duplicate sprint. Returns the shaped created sprint.
async function postSprint(base, auth, { name, startDate, endDate, goal, originBoardId }) {
  const body = { name, originBoardId: Number(originBoardId) };
  if (startDate) body.startDate = startDate;
  if (endDate) body.endDate = endDate;
  if (goal) body.goal = goal;
  const res = await requestJson({ base, path: `${AGILE_BASE}/sprint`, method: 'POST', authHeader: auth, body });
  return shapeSprint(res) || { id: res && res.id != null ? String(res.id) : null, name };
}

// Create ONE sprint on a board (CLI `sprint create`). Explicit name + start/end.
async function createSprint(cred, { boardId, boardName, projectKeyOrId, name, startDate, endDate, goal, env } = {}) {
  const sprintName = String(name == null ? '' : name).trim();
  if (!sprintName) { const e = new Error('a sprint name is required'); e.status = 400; throw e; }
  const start = normalizeSprintBoundary(startDate, 'start date');
  const end = normalizeSprintBoundary(endDate, 'end date');
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const board = await resolveBoard(cred, { boardId, boardName, projectKeyOrId, env });
  const created = await postSprint(base, auth, {
    name: sprintName, startDate: start, endDate: end, goal: goal ? String(goal) : undefined, originBoardId: board.id,
  });
  return { board: { id: board.id, name: board.name }, sprint: created };
}

// The board's latest sprint end (for "continue from where the last one ends"):
// the max endDate across all of the board's sprints, or null when none carries a
// date. Pure over an already-listed sprint array.
function latestSprintEnd(sprints) {
  let best = null;
  for (const s of Array.isArray(sprints) ? sprints : []) {
    if (!s || !s.endDate) continue;
    const t = new Date(s.endDate).getTime();
    if (Number.isNaN(t)) continue;
    if (best === null || t > best.t) best = { t, sprint: s };
  }
  return best;
}

// BULK-generate a run of future sprints on a board (CLI `sprint bulk-create`).
// Computes every sprint from a cadence + naming template + target end date,
// continuing by DEFAULT from the board's latest existing sprint (an explicit
// `--start` overrides, and is the required fallback for a board with no sprints
// yet). The plan is computed up front (pure `planSprints`); each sprint is then
// created, and — because the dates are precomputed, not chained on Jira's
// responses — a per-sprint failure is recorded and does NOT abort the rest (the
// caller gets a per-sprint success/failure map, like `create-epic`). Creates are
// never retried on a transport failure (F6).
async function bulkCreateSprints(cred, { boardId, boardName, projectKeyOrId, nameTemplate, cadenceDays = 7, until, start, goal, env } = {}) {
  const untilDay = parseUtcDay(until, 'target end date');
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const board = await resolveBoard(cred, { boardId, boardName, projectKeyOrId, env });

  // Where does the first sprint start? An explicit `--start` wins; otherwise
  // continue from the day after the board's latest existing sprint's end.
  let firstStart;
  if (start != null && String(start).trim()) {
    firstStart = parseUtcDay(start, 'start date');
  } else {
    const { sprints } = await listBoardSprints(cred, { boardId: board.id, env });
    const latest = latestSprintEnd(sprints);
    if (!latest) {
      const e = new Error(
        `board "${board.name || board.id}" has no dated sprint to continue from — supply --start for the first sprint`,
      );
      e.status = 400; throw e;
    }
    firstStart = addUtcDays(parseUtcDay(latest.sprint.endDate, 'sprint end date'), 1);
  }

  const plan = planSprints({ start: firstStart, cadenceDays, until: untilDay, nameTemplate });
  if (plan.length === 0) {
    const e = new Error('the target end date is before the first sprint start — nothing to create'); e.status = 400; throw e;
  }

  const results = [];
  for (const p of plan) {
    try {
      const created = await postSprint(base, auth, {
        name: p.name, startDate: p.startDate, endDate: p.endDate, goal: goal ? String(goal) : undefined, originBoardId: board.id,
      });
      results.push({ name: p.name, startDate: p.startDate, endDate: p.endDate, id: created.id, state: created.state, ok: true });
    } catch (err) {
      results.push({ name: p.name, startDate: p.startDate, endDate: p.endDate, ok: false, error: err.message });
    }
  }
  return {
    board: { id: board.id, name: board.name },
    requested: plan.length,
    created: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    sprints: results,
  };
}

// ── sprint lifecycle transitions (close / start / advance, #2491) ────────────
//
// #2450 could only CREATE sprints (always in Jira's "future" state); nothing
// could flip a sprint's `state`. These three ops close the change of state:
//   • closeSprint  — active → closed (complete the current sprint).
//   • startSprint  — future → active (start the next sprint), refusing to add a
//                    second active sprint (Jira allows only one per board).
//   • advanceSprint — the combined roll-over: close the active one, then start
//                     the next future one, reporting BOTH outcomes distinctly
//                     (a partial success is not all-or-nothing).
// All reuse #2450's board resolution and the Agile API; all are WRITES — never
// retried (F6), a retry landing after Jira accepted the first would double-apply.
// State is changed with a POST to `/rest/agile/1.0/sprint/{id}` (a full update),
// so the sprint's existing name/dates/goal are re-sent to avoid clearing them.

// GET one sprint by id → shaped (null if the response carries no id).
async function getSprintById(base, auth, sprintId) {
  const res = await requestJson({ base, path: `${AGILE_BASE}/sprint/${encodeURIComponent(sprintId)}`, authHeader: auth });
  return shapeSprint(res);
}

// POST a sprint's new state. Re-sends the existing name/dates/goal alongside the
// state so the full-update POST does not clear them. Returns the shaped sprint.
async function postSprintState(base, auth, sprint, newState) {
  const body = { state: newState };
  if (sprint.name) body.name = sprint.name;
  if (sprint.startDate) body.startDate = sprint.startDate;
  if (sprint.endDate) body.endDate = sprint.endDate;
  if (sprint.goal) body.goal = sprint.goal;
  const res = await requestJson({
    base, path: `${AGILE_BASE}/sprint/${encodeURIComponent(sprint.id)}`, method: 'POST', authHeader: auth, body,
  });
  return shapeSprint(res) || { ...sprint, state: newState };
}

// The board's single active sprint (Jira allows only one), or null.
function activeSprintOf(sprints) {
  return (Array.isArray(sprints) ? sprints : []).find((s) => s && s.state === 'active') || null;
}

// The board's next future sprint to activate: the earliest-starting one. Dated
// sprints sort by start; an undated future sprint falls back to list order.
function nextFutureSprint(sprints) {
  const future = (Array.isArray(sprints) ? sprints : []).filter((s) => s && s.state === 'future');
  if (future.length === 0) return null;
  const dated = future.filter((s) => s.startDate)
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
  return dated[0] || future[0];
}

// Count issues left INCOMPLETE (statusCategory != done) in a sprint. The plain
// `state:"closed"` call does not move still-open issues (there is no dialog to
// ask an agent) — they stay on the now-closed sprint — so the count is reported
// back instead. Best-effort: a failure degrades to null (never breaks the close),
// like the #2415 Epic Link lookup.
async function countIncompleteSprintIssues(base, auth, sprintId) {
  try {
    let incomplete = 0;
    let startAt = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const qs = new URLSearchParams({
        startAt: String(startAt), maxResults: String(AGILE_PAGE_SIZE), fields: 'status',
      });
      const res = await requestJson({
        base, path: `${AGILE_BASE}/sprint/${encodeURIComponent(sprintId)}/issue?${qs.toString()}`, authHeader: auth,
      });
      const issues = Array.isArray(res.issues) ? res.issues : [];
      for (const it of issues) {
        const cat = it && it.fields && it.fields.status && it.fields.status.statusCategory;
        const key = cat && (cat.key || cat.colorName);
        if (String(key || '').toLowerCase() !== 'done') incomplete += 1;
      }
      startAt += issues.length;
      const total = typeof res.total === 'number' ? res.total : null;
      if (issues.length === 0 || (total !== null && startAt >= total)) break;
    }
    return incomplete;
  } catch {
    return null;
  }
}

// Close (complete) a board's active sprint (CLI `sprint close`). Resolves the
// target: an explicit --sprint-id, else the board's single active sprint. Refuses
// a sprint that is not active. Reports the count of issues left incomplete.
async function closeSprint(cred, { boardId, boardName, projectKeyOrId, sprintId, env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const board = await resolveBoard(cred, { boardId, boardName, projectKeyOrId, env });
  let target;
  if (sprintId != null && String(sprintId).trim()) {
    target = await getSprintById(base, auth, String(sprintId).trim());
    if (!target) { const e = new Error(`sprint ${sprintId} not found`); e.status = 404; throw e; }
  } else {
    const { sprints } = await listBoardSprints(cred, { boardId: board.id, env });
    target = activeSprintOf(sprints);
    if (!target) {
      const e = new Error(`board "${board.name || board.id}" has no active sprint to close`);
      e.status = 409; throw e;
    }
  }
  if (target.state !== 'active') {
    const e = new Error(`sprint "${target.name}" (id ${target.id}) is ${target.state || 'not active'} — only an active sprint can be closed`);
    e.status = 409; throw e;
  }
  const incompleteIssues = await countIncompleteSprintIssues(base, auth, target.id);
  const closed = await postSprintState(base, auth, target, 'closed');
  return { board: { id: board.id, name: board.name }, sprint: closed, incompleteIssues };
}

// Start (activate) a board's next future sprint (CLI `sprint start`). Resolves the
// target: an explicit --sprint-id, else the earliest future sprint. Refuses a
// sprint that is not future, a sprint with no dates (Jira rejects a dateless
// activation), and a second active sprint on a board that already has one.
async function startSprint(cred, { boardId, boardName, projectKeyOrId, sprintId, env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const board = await resolveBoard(cred, { boardId, boardName, projectKeyOrId, env });
  // One read serves both the target lookup and the "already active?" guard.
  const { sprints } = await listBoardSprints(cred, { boardId: board.id, env });
  let target;
  if (sprintId != null && String(sprintId).trim()) {
    const id = String(sprintId).trim();
    target = sprints.find((s) => s.id === id) || await getSprintById(base, auth, id);
    if (!target) { const e = new Error(`sprint ${sprintId} not found`); e.status = 404; throw e; }
  } else {
    target = nextFutureSprint(sprints);
    if (!target) {
      const e = new Error(`board "${board.name || board.id}" has no future sprint to start`);
      e.status = 409; throw e;
    }
  }
  if (target.state !== 'future') {
    const e = new Error(`sprint "${target.name}" (id ${target.id}) is ${target.state || 'not future'} — only a future sprint can be started`);
    e.status = 409; throw e;
  }
  const alreadyActive = activeSprintOf(sprints);
  if (alreadyActive && alreadyActive.id !== target.id) {
    const e = new Error(`board "${board.name || board.id}" already has an active sprint ("${alreadyActive.name}", id ${alreadyActive.id}) — close it before starting another`);
    e.status = 409; throw e;
  }
  if (!target.startDate || !target.endDate) {
    const e = new Error(`sprint "${target.name}" (id ${target.id}) has no start/end date — set its dates before starting it`);
    e.status = 400; throw e;
  }
  const started = await postSprintState(base, auth, target, 'active');
  return { board: { id: board.id, name: board.name }, sprint: started };
}

// Advance the board (CLI `sprint advance`): close the active sprint, then start
// the next future one — the weekly roll-over as one call. Both phases run and are
// reported distinctly (`close` / `start`), so a partial outcome (e.g. closed but
// no future sprint to start) is visible rather than all-or-nothing. `--close-id`
// / `--start-id` override each target. A missing active sprint is a SKIP (not a
// failure — a first-ever activation is valid); every other phase error is a
// failure. Writes are never retried (F6).
async function advanceSprint(cred, { boardId, boardName, projectKeyOrId, closeSprintId, startSprintId, env } = {}) {
  const base = apiBaseFor(cred.siteUrl, env);
  const auth = basicAuthHeader(cred.email, cred.apiToken);
  const board = await resolveBoard(cred, { boardId, boardName, projectKeyOrId, env });
  const { sprints } = await listBoardSprints(cred, { boardId: board.id, env });

  // Phase 1 — close the active sprint (explicit id overrides).
  let close;
  let toClose;
  if (closeSprintId != null && String(closeSprintId).trim()) {
    const id = String(closeSprintId).trim();
    toClose = sprints.find((s) => s.id === id) || await getSprintById(base, auth, id);
  } else {
    toClose = activeSprintOf(sprints);
  }
  if (!toClose) {
    close = { ok: false, skipped: true, reason: 'no-active-sprint', error: `board "${board.name || board.id}" has no active sprint to close` };
  } else if (toClose.state !== 'active') {
    close = { ok: false, error: `sprint "${toClose.name}" (id ${toClose.id}) is ${toClose.state || 'not active'} — only an active sprint can be closed` };
  } else {
    try {
      const incompleteIssues = await countIncompleteSprintIssues(base, auth, toClose.id);
      const closed = await postSprintState(base, auth, toClose, 'closed');
      close = { ok: true, sprint: closed, incompleteIssues };
    } catch (err) {
      close = { ok: false, error: err.message };
    }
  }

  // Phase 2 — start the next future sprint (explicit id overrides). Runs even if
  // phase 1 skipped or failed, so both outcomes surface.
  let start;
  let toStart;
  if (startSprintId != null && String(startSprintId).trim()) {
    const id = String(startSprintId).trim();
    toStart = sprints.find((s) => s.id === id) || await getSprintById(base, auth, id);
  } else {
    toStart = nextFutureSprint(sprints);
  }
  // A sprint the close DID NOT clear still blocks a second activation (Jira's
  // one-active rule). The just-closed sprint no longer counts.
  const blockingActive = sprints.find((s) => s.state === 'active' && !(close.ok && close.sprint && s.id === close.sprint.id)) || null;
  if (!toStart) {
    start = { ok: false, error: `board "${board.name || board.id}" has no future sprint to start` };
  } else if (toStart.state !== 'future') {
    start = { ok: false, error: `sprint "${toStart.name}" (id ${toStart.id}) is ${toStart.state || 'not future'} — only a future sprint can be started` };
  } else if (blockingActive) {
    start = { ok: false, error: `board "${board.name || board.id}" still has an active sprint ("${blockingActive.name}", id ${blockingActive.id}) — cannot start another` };
  } else if (!toStart.startDate || !toStart.endDate) {
    start = { ok: false, error: `sprint "${toStart.name}" (id ${toStart.id}) has no start/end date — set its dates before starting it` };
  } else {
    try {
      const started = await postSprintState(base, auth, toStart, 'active');
      start = { ok: true, sprint: started };
    } catch (err) {
      start = { ok: false, error: err.message };
    }
  }

  const failed = (!close.ok && !close.skipped) || !start.ok;
  return { board: { id: board.id, name: board.name }, close, start, failed };
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
  serverInfo,
  searchProjectIssues,
  fetchRecentComments,
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
  getComment,
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
  // issue links (#2884)
  shapeIssueLink,
  shapeIssueLinks,
  resolveLinkType,
  listLinkTypes,
  createIssueLink,
  removeIssueLink,
  buildCreateFields,
  collectCustomFieldNames,
  createEpicWithStories,
  addStoriesToEpic,
  isEpicIssueType,
  // standalone issue create (#2894)
  classifyIssueType,
  resolveStandaloneIssueType,
  resolveProjectIssueType,
  missingRequiredFields,
  createRejectionMessage,
  createStandaloneIssue,
  // parent Epic of existing issues (#2895)
  setParentEpic,
  parentWriteRefusal,
  PARENT_CHANGE_FIELDS,
  EPIC_CHILD_FIELD,
  EPIC_ISSUE_TYPE,
  STORY_ISSUE_TYPE,
  // board & sprint management (#2450)
  MAX_BULK_SPRINTS,
  parseUtcDay,
  addUtcDays,
  isoStartOfDay,
  weekOfMonth,
  renderSprintName,
  planSprints,
  shapeSprint,
  latestSprintEnd,
  resolveBoardByName,
  listBoardSprints,
  createSprint,
  bulkCreateSprints,
  // sprint lifecycle transitions (#2491)
  activeSprintOf,
  nextFutureSprint,
  closeSprint,
  startSprint,
  advanceSprint,
};
