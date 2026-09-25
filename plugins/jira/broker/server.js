'use strict';

// ─── jira broker sidecar (plugin) ───────────────────────────────────────────
//
// Built ON the Broker SDK (broker-sdk/), like every reference plugin broker.
// This file is wiring; every decision that is pure lives in a sibling module
// (jira-client.js, event-extract.js, watch-store.js, inbox-store.js, poller.js)
// and the shared primitives come from the SDK.
//
//   • The poll loop runs inside this sidecar (poller.js). On a fresh status
//     change it appends the event to the per-scope inbox and wakes the granted
//     agents through the generic `POST /internal/plugin-event` channel (Jira
//     plan §4B) — `deliver()` below. The agent can also PULL: `aee-jira inbox`
//     (peek) / `aee-jira inbox --consume <id>…` (drain by id) reads the
//     per-scope queue the broker holds.
//   • Credentials are the orchestrator-pushed per-scope map (`PUT /internal/
//     scope-credentials`, §5) — never env, never a file in the image.
//   • Watch config (which projects / which transitions wake whom) is set by a
//     Team Admin through the `/admin` UI route (`PUT /ui/api/admin/watch`),
//     role-gated on the signed viewer identity. There is deliberately NO
//     scope-token-authed route for it: a granted agent's token must not be
//     able to reconfigure its own team's watches (the Phase-0 `spike-config`
//     seam that once allowed exactly that is gone).

const http = require('http');
const fs = require('fs');
const path = require('path');

const {
  withUnexpectedErrors,
  verifyScopeToken,
  mint,
  auditWriter,
  healthEndpoint,
  teardownScopeEndpoint,
  internalPushEndpoint,
  brokerConfig,
} = require('../../../broker-sdk');
const { WatchStore } = require('./watch-store');
const { InboxStore } = require('./inbox-store');
const { ActivityStore } = require('./activity-store');
const { OwnWritesStore } = require('./own-writes-store');
const { JiraPoller } = require('./poller');
const { deriveWatchHealth, summariseWatchHealth } = require('./watch-health');
const { EVENT_KINDS, EVENT_ID_RE, AGENT_COMMENT_MARKER, describeEvent } = require('./event-extract');
const jira = require('./jira-client');
const brokerPolicy = require('./broker-policy');
const { verifyViewerHeaders, requiredRoleForPath, roleAllows, roleForTeam } = require('./viewer-headers');

const PLUGIN_ID = 'jira';

const cfg = brokerConfig({
  fallbacks: {
    port: ['JIRA_BROKER_PORT'],
    signingSecret: ['JIRA_BROKER_SIGNING_SECRET'],
    stateDir: ['JIRA_STATE_DIR'],
    auditDir: ['JIRA_AUDIT_DIR'],
  },
});
const PORT = cfg.port || 4009;
const SIGNING_SECRET = cfg.signingSecret;
const STATE_DIR = cfg.stateDir || '/state/jira';
const AUDIT_DIR = cfg.auditDir || '/audit';

const watchStore = new WatchStore({ stateDir: STATE_DIR });
const inboxStore = new InboxStore({ stateDir: STATE_DIR, ttlSeconds: cfg.quota.ttlSeconds, maxObjects: cfg.quota.maxObjects });
// The retained event log ("what did the poller see, and what did it wake").
// Its own 14-day retention + row cap — deliberately NOT the manifest quota,
// which counts inbox objects (see activity-store.js).
const activityStore = new ActivityStore({ stateDir: STATE_DIR });
// What this broker itself wrote to Jira, so the poller can stamp `origin` on
// the events those writes come back as (own-writes-store.js).
const ownWritesStore = new OwnWritesStore({ stateDir: STATE_DIR });

// Recording an own write must never fail the write the agent asked for — the
// cost of a lost record is one `origin: human` on the echo, not an error.
function recordOwnWrite(fn) {
  try { fn(); } catch (err) { process.stderr.write(`[jira-broker] own-writes record failed: ${err.message}\n`); }
}
const audit = auditWriter(AUDIT_DIR, { retentionMs: 30 * 24 * 3600 * 1000 });

// Per-watch health from the poll cursors, keyed by the watch's projectKey. When
// a scope has a credential the cursor key is `<siteUrl>::<projectKey>`; without
// one there is no cursor yet and every watch reads as not-yet-baselined.
function watchHealthFor(scopeId) {
  const conf = watchStore.loadConfig(scopeId);
  const cred = resolveCredential(scopeId);
  const now = Date.now();
  const watches = (conf.watches || []).map((w) => {
    const ref = cred ? `${cred.siteUrl}::${w.projectKey}` : null;
    const cursor = ref ? conf.cursors[ref] : null;
    return { ...w, health: deriveWatchHealth(cursor, now) };
  });
  return { watches, summary: summariseWatchHealth(watches.map((w) => w.health)), setBy: conf.setBy, setAt: conf.setAt };
}

// Per-scope Jira credential, pushed by the orchestrator (Phase 1, Jira plan §5):
// `PUT /internal/scope-credentials` with `{ scopes: { <scopeId>: { "site-url",
// "email", "api-token" } } }`. In-memory only (the pattern github-issues uses);
// the orchestrator re-pushes on boot / grant change / credential save. The token
// never touches disk here and never reaches an agent.
const scopeCredentials = new Map(); // scopeId -> { site-url, email, api-token }

function writeAudit(scopeId, actor, subcommand, outcome, detail) {
  try {
    audit.write({ ts: new Date().toISOString(), pluginId: PLUGIN_ID, scopeId, agentId: actor || scopeId, subcommand, outcome, detail });
  } catch { /* best-effort */ }
}

// Resolve a scope's Jira credential from the orchestrator-pushed per-scope map.
// Returns null when the scope has no entry or an incomplete one (the poller
// then logs "no usable credential" and skips it — a granted-but-unconfigured
// team is a normal transient state, not an error).
function resolveCredential(scopeId) {
  const v = scopeCredentials.get(String(scopeId));
  if (!v) return null;
  const siteUrl = (v['site-url'] || '').trim();
  const email = (v.email || '').trim();
  const apiToken = (v['api-token'] || '').trim();
  if (!siteUrl || !email || !apiToken) return null;
  // Optional admin allow-list of readable custom fields (#2416): a comma list of
  // human field names ("Team, Sprint") a Team Admin sets alongside site/token.
  // Surfaced by default on every read; a per-request `--fields` adds to it.
  const readableCustomFields = String(v['readable-custom-fields'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  // Optional admin allow-list of WRITABLE custom fields (#2417): a comma list of
  // human field names ("Team") an agent may set via `aee-jira set-field`. Empty =
  // no field is writable (the safe default — a write is stricter than a read).
  const writableCustomFields = String(v['writable-custom-fields'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return { siteUrl, email, apiToken, readableCustomFields, writableCustomFields };
}

// ── delivery: POST /internal/plugin-event (Jira plan §4B) ───────────────────
// The broker→orchestrator wake channel. A minted scope token carries
// {pluginId: 'jira', scopeId}; the orchestrator verifies it, resolves the scope
// to its team, and fans out to every granted agent with a matching
// `plugin-event` trigger. No `http` trigger to hand-wire.
function orchestratorUrl() {
  return (process.env.AEE_ORCHESTRATOR_URL || 'http://orchestrator:4002').replace(/\/+$/, '');
}

// The wake's one-line summary. A digest is single-kind (the poller fans out
// per kind), so its noun comes from the first event's kind.
function summariseEvents(kind, events, { projectKey } = {}) {
  const first = events[0] || {};
  if (kind === 'digest') {
    const noun = (EVENT_KINDS[first.event] && EVENT_KINDS[first.event].noun) || 'events';
    return `${events.length} ${noun}${projectKey ? ` in ${projectKey}` : ''}`;
  }
  return describeEvent(first);
}

// A wake POST must settle fast — the poll loop holds `running` across it (one
// `_tick` fans out every scope sequentially), so a black-holed orchestrator
// connection would otherwise stall polling for undici's multi-minute default.
const DELIVER_TIMEOUT_MS = 15_000;

// A digest carries the WHOLE folded set — the orchestrator matches every
// agent's payloadFilter against all of it and only then caps what goes into
// that agent's prompt (its `DIGEST_INLINE_MAX`). Cutting here, before the
// filter, would hide every event past the cut from the match and leave an
// agent whose transitions all sit there un-woken. This is only a hard safety
// bound on the wake body (~350 B/event → ~350 KB, under the orchestrator's
// 1 MB body cap); past it, `truncated: true` says the set is incomplete.
const DIGEST_MAX_EVENTS = 1000;

// `projectKey` is set on a project-level (bulk) digest — F8; a per-issue
// digest has none. Both carry the same `{kind:'digest', count, events}` shape
// the orchestrator's payloadFilter any-matches and the agent runtime envelopes.
async function deliver({ scopeId, kind, events, projectKey }) {
  if (kind === 'throttle-warning') {
    // Nothing to wake an agent about — the throttle already suppressed the
    // events. Record it and move on.
    writeAudit(scopeId, scopeId, 'wake', 'throttled', kind);
    return;
  }
  const token = mint(PLUGIN_ID, scopeId, SIGNING_SECRET);
  const first = events[0] || {};
  const eventId = kind === 'digest' ? null : (first.id || null);
  const body = {
    // Every extractor sets `event` explicitly; there is no default kind.
    event: first.event,
    summary: summariseEvents(kind, events, { projectKey }),
    // Omit rather than send an explicit null for a digest (the validator
    // accepts either, but the entry shape prefers omission).
    ...(eventId ? { eventId } : {}),
    // A digest carries every folded event (`count` = their number); the
    // agent's `aee-jira inbox` holds them too. Only DIGEST_MAX_EVENTS cuts.
    payload: kind === 'digest'
      ? {
        kind: 'digest',
        ...(projectKey ? { projectKey } : {}),
        count: events.length,
        events: events.slice(0, DIGEST_MAX_EVENTS),
        ...(events.length > DIGEST_MAX_EVENTS ? { truncated: true } : {}),
      }
      : first,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DELIVER_TIMEOUT_MS);
  try {
    const res = await fetch(`${orchestratorUrl()}/internal/plugin-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const out = await res.json().catch(() => ({}));
    writeAudit(scopeId, scopeId, 'wake', res.ok ? 'ok' : `http-${res.status}`, `${kind}:${out.delivered ?? '?'}`);
    process.stdout.write(
      `[jira-broker] plugin-event ${res.ok ? `ok (${out.delivered ?? '?'} agent(s))` : `HTTP ${res.status}`} `
      + `→ ${scopeId} (${kind}, ${events.length} event(s))\n`,
    );
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? `timeout after ${DELIVER_TIMEOUT_MS}ms` : err.message;
    writeAudit(scopeId, scopeId, 'wake', 'error', reason);
    process.stdout.write(`[jira-broker] plugin-event FAILED → ${scopeId}: ${reason}\n`);
  } finally {
    clearTimeout(timer);
  }
}

const poller = new JiraPoller({
  watchStore,
  inboxStore,
  activityStore,
  ownWritesStore,
  resolveCredential,
  deliver,
  intervalMs: Number(process.env.JIRA_POLL_INTERVAL_MS) || undefined,
  baseWindowMinutes: Number(process.env.JIRA_POLL_WINDOW_MINUTES) || undefined,
  throttleStatePath: path.join(STATE_DIR, 'throttle-state.json'),
  log: (m) => process.stdout.write(`${m}\n`),
});

// ── small http helpers ─────────────────────────────────────────────────────
// Every body this broker reads is a small JSON control message (a CLI arg set,
// a watch-config list, the per-scope credential push). Cap it so a malformed or
// hostile request cannot buffer unbounded memory; an over-cap body resolves
// empty and parseJson turns it into `{}` (a 4xx from the handler).
const MAX_BODY_BYTES = 1_000_000;
// An attachment upload carries the file's bytes base64-encoded inside the JSON
// body (CLI→broker), one file per request. Its cap is the raw upload ceiling
// grown by the ~4/3 base64 blow-up plus a small JSON envelope margin — bounded,
// but far above the 1 MB control-message default so a legitimate file is not
// truncated into an opaque 400.
const ATTACHMENT_BODY_MAX_BYTES = Math.ceil(jira.ATTACHMENT_UPLOAD_MAX_BYTES * 4 / 3) + 64 * 1024;
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let s = '';
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      s += c;
      if (s.length > maxBytes) { over = true; s = ''; req.destroy(); }
    });
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
  return new URLSearchParams((req.url || '').split('?')[1] || '');
}

// `aee-jira inbox --consume <id>…` — the ids an agent may drain are the ones
// its OWN wake payload carried (`payload.id`, or `payload.events[].id` in a
// digest). The whole-inbox drain is gone: the inbox is per team and every
// agent on it is woken for its own subset, so a bare consume would take a
// teammate's events. A stale CLI copy sending `consume=1` gets a 400 that
// names the fix instead of a silent team-wide drain. An agent may only ever
// drain the ids its own wake named (a convention the CLI keeps — the broker
// cannot tell agents apart, one scope token per team). `EVENT_ID_RE` lives in
// event-extract.js so every extractor's ids are tested against the same rule.
// Ids travel in the GET query string; 200 ids at the regex's maximum length
// would exceed Node's 16 KB header limit (431, fails closed) — realistic ids
// (`KAN-6:10312`) fit ~1000×.
const CONSUME_MAX_IDS = 200;
const CONSUME_USAGE = 'consume takes the event ids you were woken for: aee-jira inbox --consume <event-id> [<event-id> ...] '
  + '(each id is in your wake payload as `id`, or `events[].id` in a digest)';

// → { ok: true, ids } | { ok: false, status, error, message }. `raw` is the
// `consume` query value; absent = peek, handled by the caller.
function parseConsumeIds(raw) {
  const ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0 || !ids.every((id) => EVENT_ID_RE.test(id))) {
    return { ok: false, status: 400, error: 'consume-requires-ids', message: CONSUME_USAGE };
  }
  if (ids.length > CONSUME_MAX_IDS) {
    return { ok: false, status: 400, error: 'too-many-ids', message: `at most ${CONSUME_MAX_IDS} ids per consume` };
  }
  return { ok: true, ids: [...new Set(ids)] };
}

// ── the agent CLI surface (scope-token authed) ─────────────────────────────
async function handleCli(req, res, cliPath) {
  const v = verifyScopeToken(req, SIGNING_SECRET);
  if (!v || v.pluginId !== PLUGIN_ID) return sendJson(res, 401, { error: 'unauthorized' });
  const scopeId = v.scopeId;
  const params = query(req);

  if (cliPath === '/whoami' && req.method === 'GET') {
    return sendJson(res, 200, { scopeId, plugin: PLUGIN_ID });
  }

  if (cliPath === '/inbox' && req.method === 'GET') {
    if (!params.has('consume')) {
      const entries = inboxStore.list(scopeId);
      writeAudit(scopeId, scopeId, 'inbox', 'ok', `peeked:${entries.length}`);
      return sendJson(res, 200, { entries, consumed: false });
    }
    const parsed = parseConsumeIds(params.get('consume'));
    if (!parsed.ok) {
      writeAudit(scopeId, scopeId, 'inbox', 'refused', parsed.error);
      return sendJson(res, parsed.status, { error: parsed.error, message: parsed.message });
    }
    const { entries, missing } = inboxStore.consumeIds(scopeId, parsed.ids);
    writeAudit(scopeId, scopeId, 'inbox', 'ok', `consumed:${entries.length}${missing.length ? ` missing:${missing.length}` : ''}`);
    return sendJson(res, 200, { entries, consumed: true, missing });
  }

  // ── reads that need the per-scope Jira credential (Phase 3) ───────────────
  const readOps = { '/projects': 'projects', '/list': 'list', '/search': 'search', '/show': 'show', '/statuses': 'statuses' };
  if (readOps[cliPath] && req.method === 'GET') {
    const op = readOps[cliPath];
    const cred = resolveCredential(scopeId);
    if (!cred) {
      writeAudit(scopeId, scopeId, op, 'no-credential');
      return sendJson(res, 400, {
        error: 'This team has no Jira credential configured. A Team Admin sets it on the Plugins page.',
        code: 'no-credential',
      });
    }
    try {
      let result;
      // The admin allow-list of readable custom fields (#2416) is surfaced on
      // every read by default; a per-request `--fields` custom name adds to it.
      const defaultCustomFields = cred.readableCustomFields || [];
      if (op === 'projects') {
        result = { projects: await jira.listProjects(cred) };
      } else if (op === 'list') {
        const project = (params.get('project') || '').trim();
        if (!project) return sendJson(res, 400, { error: 'a --project key is required' });
        result = {
          project,
          issues: await jira.listProjectIssues(cred, {
            projectKey: project,
            status: params.get('status') || undefined,
            customFields: defaultCustomFields,
          }),
        };
      } else if (op === 'search') {
        // Arbitrary JQL, scope-guarded by the credential itself (jira.searchIssues):
        // it resolves as the bound account, so it can only read the team's site +
        // permitted projects — the JQL cannot escape the tenant boundary.
        const jql = (params.get('jql') || '').trim();
        if (!jql) return sendJson(res, 400, { error: 'a --jql query is required' });
        const fieldsParam = (params.get('fields') || '').trim();
        const requested = fieldsParam ? fieldsParam.split(',').map((f) => f.trim()).filter(Boolean) : [];
        // `--fields` names standard columns (a projection) AND/OR custom fields:
        // split them so the columns drive the projection and the custom names are
        // read + added on top (union with the admin allow-list).
        const { columns, customNames } = jira.partitionFields(requested);
        const limit = params.get('limit') || undefined;
        result = {
          jql,
          issues: await jira.searchIssues(cred, {
            jql,
            fields: columns.length ? columns : undefined,
            customFields: jira.mergeCustomFieldNames(defaultCustomFields, customNames),
            limit,
          }),
        };
      } else if (op === 'statuses') {
        // The full set of workflow statuses a project supports, grouped by issue
        // type (#2421) — a project-wide read, independent of any single issue.
        const project = (params.get('project') || '').trim();
        if (!project) return sendJson(res, 400, { error: 'a --project key is required' });
        result = { project, statuses: await jira.listProjectStatuses(cred, { projectKey: project }) };
      } else {
        const issue = (params.get('issue') || '').trim();
        if (!issue) return sendJson(res, 400, { error: 'an issue key is required' });
        // `show --fields "Team"`: all names are custom fields (a plain `show`
        // already returns every standard field), unioned with the admin list.
        const fieldsParam = (params.get('fields') || '').trim();
        const requested = fieldsParam ? fieldsParam.split(',').map((f) => f.trim()).filter(Boolean) : [];
        const { customNames } = jira.partitionFields(requested);
        result = {
          issue: await jira.getIssue(cred, issue, {
            customFields: jira.mergeCustomFieldNames(defaultCustomFields, customNames),
          }),
        };
      }
      writeAudit(scopeId, scopeId, op, 'ok', params.get('project') || params.get('issue') || params.get('jql') || '');
      return sendJson(res, 200, result);
    } catch (err) {
      writeAudit(scopeId, scopeId, op, 'error', err.message);
      return sendJson(res, err.status && err.status >= 400 && err.status < 500 ? err.status : 502, { error: err.message });
    }
  }

  // ── sprint list on a board (Agile read, #2450) ───────────────────────────
  // A read like /list, but over the Jira Agile API: the sprints on a board
  // resolved by its human name. Needs the credential (jira.listBoardSprints
  // resolves board name → id server-side), no write policy — it creates nothing.
  if (cliPath === '/sprint/list' && req.method === 'GET') {
    const cred = resolveCredential(scopeId);
    if (!cred) {
      writeAudit(scopeId, scopeId, 'sprint-list', 'no-credential');
      return sendJson(res, 400, {
        error: 'This team has no Jira credential configured. A Team Admin sets it on the Plugins page.',
        code: 'no-credential',
      });
    }
    const board = (params.get('board') || '').trim();
    if (!board) return sendJson(res, 400, { error: 'a --board name is required' });
    try {
      const result = await jira.listBoardSprints(cred, {
        boardName: board,
        projectKeyOrId: (params.get('project') || '').trim() || undefined,
        state: (params.get('state') || '').trim() || undefined,
      });
      writeAudit(scopeId, scopeId, 'sprint-list', 'ok', board);
      return sendJson(res, 200, result);
    } catch (err) {
      writeAudit(scopeId, scopeId, 'sprint-list', 'error', `${board}: ${err.message}`);
      return sendJson(res, err.status && err.status >= 400 && err.status < 500 ? err.status : 502, { error: err.message });
    }
  }

  // ── attachment content fetch by id (Phase 3 read, #2399) ─────────────────
  // A read like /show, but it downloads one attachment's bytes server-side and
  // returns them as inline text or base64. jira.getAttachment confirms the id
  // belongs to the issue before fetching, so an id on another issue (or one
  // deleted since `show`) is a mapped 404, never a raw Jira body.
  if (cliPath === '/attachment' && req.method === 'GET') {
    const cred = resolveCredential(scopeId);
    if (!cred) {
      writeAudit(scopeId, scopeId, 'attachment', 'no-credential');
      return sendJson(res, 400, {
        error: 'This team has no Jira credential configured. A Team Admin sets it on the Plugins page.',
        code: 'no-credential',
      });
    }
    const issue = (params.get('issue') || '').trim();
    const id = (params.get('id') || '').trim();
    if (!issue) return sendJson(res, 400, { error: 'an issue key is required' });
    if (!id) return sendJson(res, 400, { error: 'an attachment id is required' });
    try {
      const attachment = await jira.getAttachment(cred, issue, id);
      writeAudit(scopeId, scopeId, 'attachment', 'ok', `${issue}:${id}`);
      return sendJson(res, 200, { attachment });
    } catch (err) {
      writeAudit(scopeId, scopeId, 'attachment', 'error', `${issue}:${id}: ${err.message}`);
      return sendJson(res, err.status && err.status >= 400 && err.status < 500 ? err.status : 502, { error: err.message });
    }
  }

  // ── attachment upload by path (Phase 4 write, #2408) ─────────────────────
  // The write counterpart of `/attachment`: the CLI sends ONE file per request
  // as `{ issue, filename, contentBase64 }`; the broker decodes it and uploads
  // it to the issue server-side (the Jira token never leaves here — AC7). One
  // file per request keeps the buffered body bounded and gives the CLI clean
  // per-file success/failure to report when several files are attached in one
  // invocation (AC6). Role-gated like the other writes (D3).
  if (cliPath === '/attachment/add' && req.method === 'POST') {
    const authz = brokerPolicy.authorizeWrite('attach');
    if (!authz.allow) {
      writeAudit(scopeId, scopeId, 'attach', 'denied', authz.code);
      return sendJson(res, 403, { error: authz.reason, code: authz.code });
    }
    const cred = resolveCredential(scopeId);
    if (!cred) {
      writeAudit(scopeId, scopeId, 'attach', 'no-credential');
      return sendJson(res, 400, {
        error: 'This team has no Jira credential configured. A Team Admin sets it on the Plugins page.',
        code: 'no-credential',
      });
    }
    const raw = await readBody(req, ATTACHMENT_BODY_MAX_BYTES);
    // An over-cap body is dropped to empty by readBody → parses to `{}` → the
    // filename/content checks below turn it into a clear 413, not a silent hang.
    if (!raw) {
      writeAudit(scopeId, scopeId, 'attach', 'error', 'body-too-large');
      return sendJson(res, 413, { error: `the upload exceeds the ${jira.ATTACHMENT_UPLOAD_MAX_BYTES}-byte limit for this plugin.` });
    }
    const body = parseJson(raw);
    const issue = String(body.issue || '').trim();
    const filename = String(body.filename || '').trim();
    if (!issue) return sendJson(res, 400, { error: 'an issue key is required' });
    if (!filename) return sendJson(res, 400, { error: 'a filename is required' });
    if (typeof body.contentBase64 !== 'string' || !body.contentBase64) {
      return sendJson(res, 400, { error: 'file content is required' });
    }
    let buffer;
    try {
      buffer = Buffer.from(body.contentBase64, 'base64');
    } catch {
      return sendJson(res, 400, { error: 'file content is not valid base64' });
    }
    try {
      const attachment = await jira.addAttachment(cred, issue, { filename, buffer, mimeType: body.mimeType });
      // Jira logs an upload as an `Attachment` changelog item (fieldId
      // `attachment`) — a field_changed the poller will see.
      recordOwnWrite(() => ownWritesStore.recordField(scopeId, issue, 'attachment'));
      writeAudit(scopeId, scopeId, 'attach', 'ok', `${issue}:${attachment.id} (${filename})`);
      return sendJson(res, 200, { attachment });
    } catch (err) {
      writeAudit(scopeId, scopeId, 'attach', 'error', `${issue} ${filename}: ${err.message}`);
      return sendJson(res, err.status && err.status >= 400 && err.status < 500 ? err.status : 502, { error: err.message });
    }
  }

  // ── issue creation: one Epic + N child Stories (#2424) ───────────────────
  // The plugin's first CREATE. The CLI sends `{ project, epic, stories[], issueTypes? }`;
  // the broker creates the epic then each story (linked to it), gating every
  // named custom field on the team's `writable-custom-fields` allow-list (#2417)
  // BEFORE anything is created. A per-story failure after the epic exists is
  // reported, not fatal (jira.createEpicWithStories). Role-gated like the other
  // writes (D3); the Jira token stays server-side.
  if (cliPath === '/create-epic' && req.method === 'POST') {
    const authz = brokerPolicy.authorizeWrite('create');
    if (!authz.allow) {
      writeAudit(scopeId, scopeId, 'create', 'denied', authz.code);
      return sendJson(res, 403, { error: authz.reason, code: authz.code });
    }
    const cred = resolveCredential(scopeId);
    if (!cred) {
      writeAudit(scopeId, scopeId, 'create', 'no-credential');
      return sendJson(res, 400, {
        error: 'This team has no Jira credential configured. A Team Admin sets it on the Plugins page.',
        code: 'no-credential',
      });
    }
    const body = parseJson(await readBody(req));
    const project = String(body.project || '').trim();
    if (!project) return sendJson(res, 400, { error: 'a --project key is required' });
    if (!body.epic || typeof body.epic !== 'object') return sendJson(res, 400, { error: 'an epic is required' });
    try {
      const result = await jira.createEpicWithStories(cred, {
        projectKey: project,
        epic: body.epic,
        stories: Array.isArray(body.stories) ? body.stories : [],
        allowList: cred.writableCustomFields || [],
        attribution: `Created by an agent on team "${scopeId}" via Agent Studio.`,
        issueTypes: body.issueTypes && typeof body.issueTypes === 'object' ? body.issueTypes : undefined,
        // Each created issue is ours; its follow-up `status` transition (and
        // whatever fields that sets) is covered by the wildcard field record.
        onCreated: (key) => recordOwnWrite(() => {
          ownWritesStore.recordIssue(scopeId, key);
          ownWritesStore.recordField(scopeId, key, '*');
        }),
      });
      writeAudit(scopeId, scopeId, 'create', 'ok', `${project}:${result.epic.key} +${result.stories.filter((s) => s.ok).length}/${result.stories.length} stories`);
      return sendJson(res, 200, result);
    } catch (err) {
      writeAudit(scopeId, scopeId, 'create', 'error', `${project}: ${err.message}`);
      return sendJson(res, err.status && err.status >= 400 && err.status < 500 ? err.status : 502, { error: err.message });
    }
  }

  // ── sprint creation on a board (Agile write, #2450) ──────────────────────
  // Two board-scoped writes: create ONE future sprint, or BULK-generate a run of
  // them up to a target date. Role-gated like every other write (D3); the Jira
  // token stays server-side. `sprint-bulk-create` continues by default from the
  // board's latest existing sprint (jira.bulkCreateSprints), so a per-sprint
  // failure is reported, not fatal — the dates are precomputed, not chained.
  if (cliPath === '/sprint/create' && req.method === 'POST') {
    const authz = brokerPolicy.authorizeWrite('sprint-create');
    if (!authz.allow) {
      writeAudit(scopeId, scopeId, 'sprint-create', 'denied', authz.code);
      return sendJson(res, 403, { error: authz.reason, code: authz.code });
    }
    const cred = resolveCredential(scopeId);
    if (!cred) {
      writeAudit(scopeId, scopeId, 'sprint-create', 'no-credential');
      return sendJson(res, 400, { error: 'This team has no Jira credential configured.', code: 'no-credential' });
    }
    const body = parseJson(await readBody(req));
    const board = String(body.board || '').trim();
    if (!board) return sendJson(res, 400, { error: 'a --board name is required' });
    try {
      const result = await jira.createSprint(cred, {
        boardName: board,
        projectKeyOrId: String(body.project || '').trim() || undefined,
        name: body.name,
        startDate: body.start,
        endDate: body.end,
        goal: body.goal,
      });
      writeAudit(scopeId, scopeId, 'sprint-create', 'ok', `${board}:${result.sprint.id || result.sprint.name}`);
      return sendJson(res, 200, result);
    } catch (err) {
      writeAudit(scopeId, scopeId, 'sprint-create', 'error', `${board}: ${err.message}`);
      return sendJson(res, err.status && err.status >= 400 && err.status < 500 ? err.status : 502, { error: err.message });
    }
  }

  if (cliPath === '/sprint/bulk-create' && req.method === 'POST') {
    const authz = brokerPolicy.authorizeWrite('sprint-bulk-create');
    if (!authz.allow) {
      writeAudit(scopeId, scopeId, 'sprint-bulk-create', 'denied', authz.code);
      return sendJson(res, 403, { error: authz.reason, code: authz.code });
    }
    const cred = resolveCredential(scopeId);
    if (!cred) {
      writeAudit(scopeId, scopeId, 'sprint-bulk-create', 'no-credential');
      return sendJson(res, 400, { error: 'This team has no Jira credential configured.', code: 'no-credential' });
    }
    const body = parseJson(await readBody(req));
    const board = String(body.board || '').trim();
    if (!board) return sendJson(res, 400, { error: 'a --board name is required' });
    try {
      const result = await jira.bulkCreateSprints(cred, {
        boardName: board,
        projectKeyOrId: String(body.project || '').trim() || undefined,
        nameTemplate: body.nameTemplate,
        cadenceDays: body.cadenceDays,
        until: body.until,
        start: body.start,
        goal: body.goal,
      });
      writeAudit(scopeId, scopeId, 'sprint-bulk-create', 'ok', `${board}:${result.created}/${result.requested}`);
      return sendJson(res, 200, result);
    } catch (err) {
      writeAudit(scopeId, scopeId, 'sprint-bulk-create', 'error', `${board}: ${err.message}`);
      return sendJson(res, err.status && err.status >= 400 && err.status < 500 ? err.status : 502, { error: err.message });
    }
  }

  // ── attributed writes (Phase 4, D3 — role-gated server-side, no confirm) ──
  const writeOps = { '/comment': 'comment', '/transition': 'transition', '/update': 'update', '/set-field': 'set-field' };
  if (writeOps[cliPath] && req.method === 'POST') {
    const op = writeOps[cliPath];
    const authz = brokerPolicy.authorizeWrite(op);
    if (!authz.allow) {
      writeAudit(scopeId, scopeId, op, 'denied', authz.code);
      return sendJson(res, 403, { error: authz.reason, code: authz.code });
    }
    const cred = resolveCredential(scopeId);
    if (!cred) {
      writeAudit(scopeId, scopeId, op, 'no-credential');
      return sendJson(res, 400, { error: 'This team has no Jira credential configured.', code: 'no-credential' });
    }
    const body = parseJson(await readBody(req));
    const issue = String(body.issue || '').trim();
    if (!issue) return sendJson(res, 400, { error: 'an issue key is required' });
    // Opens every agent comment; the comment extractor keys `origin` on it.
    const attribution = `${AGENT_COMMENT_MARKER} "${scopeId}" via Agent Studio.`;
    try {
      let result;
      if (op === 'comment') {
        const text = String(body.body || '').trim();
        if (!text) return sendJson(res, 400, { error: 'a comment body is required' });
        result = await jira.addComment(cred, issue, { body: text, attribution });
        if (result && result.id) recordOwnWrite(() => ownWritesStore.recordComment(scopeId, issue, result.id));
      } else if (op === 'update') {
        const text = String(body.description || '').trim();
        if (!text) return sendJson(res, 400, { error: 'a description is required' });
        result = await jira.updateDescription(cred, issue, {
          description: text,
          attribution: `Description rewritten by an agent on team "${scopeId}" via Agent Studio.`,
        });
        // Unused by today's kinds; a future description_changed needs it.
        recordOwnWrite(() => ownWritesStore.recordDescription(scopeId, issue));
      } else if (op === 'set-field') {
        const field = String(body.field || '').trim();
        if (!field) return sendJson(res, 400, { error: 'a field name is required' });
        const hasJson = Object.prototype.hasOwnProperty.call(body, 'valueJson');
        if (!hasJson && (body.value === undefined || body.value === null)) {
          return sendJson(res, 400, { error: 'a value is required (--value or --value-json)' });
        }
        result = await jira.setCustomField(cred, issue, {
          fieldName: field,
          value: hasJson ? undefined : body.value,
          jsonValue: hasJson ? body.valueJson : undefined,
          allowList: cred.writableCustomFields || [],
        });
        // A no-op re-set writes nothing to Jira, so there is no echo to mark.
        if (result && result.changed) {
          recordOwnWrite(() => ownWritesStore.recordField(scopeId, issue, result.fieldId || field));
        }
      } else {
        result = await jira.transitionIssue(cred, issue, { toStatus: body.to });
        // The status change itself has no `origin` (a transition is meant to
        // wake the next stage), but Jira logs `resolution` and any
        // transition-screen field in the same history — those field_changed
        // echoes are ours.
        recordOwnWrite(() => ownWritesStore.recordField(scopeId, issue, '*'));
      }
      const detail = op === 'transition' ? `${issue}→${body.to || ''}`
        : op === 'set-field' ? `${issue}.${String(body.field || '').trim()}`
          : issue;
      writeAudit(scopeId, scopeId, op, 'ok', detail);
      return sendJson(res, 200, result);
    } catch (err) {
      writeAudit(scopeId, scopeId, op, 'error', `${issue}: ${err.message}`);
      return sendJson(res, err.status && err.status >= 400 && err.status < 500 ? err.status : 502, { error: err.message });
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

// ── the served UI (Jira plan §6.4) — console-proxied, viewer-header authed ───
// The `/` route (team-member): the issues in a team's scope, the per-scope
// event inbox, and what the poller is watching. Phase 4 adds `/admin`.
function contentType(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

function pickTeam(viewer, requested) {
  const allowed = Array.isArray(viewer.teamIds) ? viewer.teamIds : [];
  if (requested && allowed.includes(requested)) return requested;
  if (!requested && allowed.length === 1) return allowed[0];
  return null;
}

async function handleUiApi(req, res, apiPath, viewer) {
  const params = query(req);

  if (apiPath === '/context' && req.method === 'GET') {
    const teams = (viewer.teamIds || []).map((id) => {
      const health = watchHealthFor(id);
      return {
        teamId: id,
        // Per team, from the signed map — the admin page offers only the
        // teams the viewer actually administers.
        isAdmin: roleAllows(roleForTeam(viewer, id), 'team-admin'),
        hasCredential: !!resolveCredential(id),
        watches: health.watches.map((w) => w.projectKey),
        watchHealth: health.summary,
        inbox: inboxStore.count(id),
        activity: activityStore.count(id),
      };
    });
    // `isAdmin` at the top level means "admin of at least one team here" —
    // whether to show the admin link at all, never which team it applies to.
    return sendJson(res, 200, { user: viewer.sub, role: viewer.role, isAdmin: teams.some((t) => t.isAdmin), teams });
  }

  const team = pickTeam(viewer, params.get('team'));
  if (!team) return sendJson(res, 400, { error: 'select a team you are a member of' });

  // The elevated-route gate, on the SELECTED team's role (F4 of the Jira
  // review). `handleUi` already checked the flat role — the caller's max
  // across their teams — which is the right pre-filter but the wrong gate
  // here: admin of A + member of B must not reach B's /admin via `?team=B`.
  // `roleForTeam` never elevates (an in-scope team missing from the signed
  // map is a plain team-member), so a header from an older proxy that signed
  // no map cannot open /admin for any team.
  const needForTeam = requiredRoleForPath(`/api${apiPath}`);
  const roleHere = roleForTeam(viewer, team);
  if (!roleAllows(roleHere, needForTeam)) {
    return sendJson(res, 403, { error: `${apiPath} requires ${needForTeam} in ${team}; viewer is ${roleHere || 'not a member'}` });
  }

  if (apiPath === '/inbox' && req.method === 'GET') {
    return sendJson(res, 200, { entries: inboxStore.list(team) });
  }
  if (apiPath === '/activity' && req.method === 'GET') {
    const limit = Math.min(Math.max(Number(params.get('limit')) || 200, 1), 1000);
    return sendJson(res, 200, { rows: activityStore.list(team, { limit }) });
  }
  if (apiPath === '/watches' && req.method === 'GET') {
    const health = watchHealthFor(team);
    const conf = watchStore.loadConfig(team);
    return sendJson(res, 200, {
      watches: health.watches,
      health: health.summary,
      cursors: conf.cursors,
      setBy: conf.setBy,
      setAt: conf.setAt,
    });
  }

  // ── /admin — the watch config (team-admin IN THE SELECTED TEAM; gated above) ─
  // Replaces #1539's `env.jiraProjects[]` + the `jira-event` trigger fields.
  // Which AGENTS a transition wakes is now decided per-agent by a `plugin-event`
  // trigger (Phase 2) — this route configures only which projects/statuses the
  // broker watches.
  if (apiPath === '/admin/watch' && req.method === 'GET') {
    const conf = watchStore.loadConfig(team);
    // `eventKinds` drives the per-watch checkboxes, so the admin page never
    // hard-codes a kind the broker cannot produce.
    const eventKinds = Object.entries(EVENT_KINDS).map(([name, k]) => ({ name, label: k.label }));
    return sendJson(res, 200, { watches: conf.watches, eventKinds, setBy: conf.setBy, setAt: conf.setAt });
  }
  if (apiPath === '/admin/watch' && req.method === 'PUT') {
    const body = parseJson(await readBody(req));
    const conf = watchStore.setConfig(team, {
      watches: Array.isArray(body.watches) ? body.watches : [],
      setBy: viewer.sub || 'admin',
    });
    return sendJson(res, 200, { ok: true, watches: conf.watches });
  }

  // Clear the exponential backoff on one failing watch so the next poll tick
  // (≤ the poll interval) re-attempts it — after a Team Admin has fixed the
  // credential. Does not force an immediate poll.
  if (apiPath === '/admin/retry' && req.method === 'POST') {
    const body = parseJson(await readBody(req));
    const projectKey = String(body.projectKey || '').trim();
    if (!projectKey) return sendJson(res, 400, { error: 'a projectKey is required' });
    const cred = resolveCredential(team);
    if (!cred) return sendJson(res, 400, { error: 'This team has no Jira credential configured.', code: 'no-credential' });
    const ref = `${cred.siteUrl}::${projectKey}`;
    const cursor = watchStore.getCursor(team, ref) || {};
    const cleared = { ...cursor, consecutiveFailures: 0 };
    delete cleared.skipUntil;
    watchStore.saveCursor(team, ref, cleared);
    writeAudit(team, viewer.sub || 'admin', 'watch-retry', 'ok', projectKey);
    return sendJson(res, 200, { ok: true, projectKey });
  }

  const cred = resolveCredential(team);
  if (!cred) return sendJson(res, 400, { error: 'This team has no Jira credential configured.', code: 'no-credential' });
  try {
    if (apiPath === '/projects' && req.method === 'GET') {
      return sendJson(res, 200, { projects: await jira.listProjects(cred) });
    }
    if (apiPath === '/issues' && req.method === 'GET') {
      const project = (params.get('project') || '').trim();
      if (!project) return sendJson(res, 400, { error: 'a project is required' });
      return sendJson(res, 200, { issues: await jira.listProjectIssues(cred, { projectKey: project, status: params.get('status') || undefined }) });
    }
  } catch (err) {
    return sendJson(res, err.status && err.status < 500 ? err.status : 502, { error: err.message });
  }
  return sendJson(res, 404, { error: 'not found' });
}

async function handleUi(req, res, uiPath) {
  const viewer = verifyViewerHeaders(req, SIGNING_SECRET);
  if (!viewer) return sendJson(res, 401, { error: 'unsigned viewer' });
  // Coarse gate on the flat role (the caller's best team): enough for page
  // loads and assets, and a cheap refusal for a viewer who is admin nowhere.
  // A team-selecting API route is gated AGAIN on the chosen team's role in
  // handleUiApi — that is the real check.
  const need = requiredRoleForPath(uiPath);
  if (!roleAllows(viewer.role, need)) {
    return sendJson(res, 403, { error: `route ${uiPath} requires ${need}; viewer is ${viewer.role}` });
  }
  if (uiPath === '/api' || uiPath.startsWith('/api/')) {
    return handleUiApi(req, res, uiPath.slice('/api'.length) || '/', viewer);
  }
  // Route paths (no file extension) map to their page; assets keep their name.
  const ROUTE_PAGE = { '/': 'index.html', '': 'index.html', '/admin': 'admin.html' };
  const file = Object.prototype.hasOwnProperty.call(ROUTE_PAGE, uiPath)
    ? ROUTE_PAGE[uiPath]
    : uiPath.replace(/^\/+/, '');
  const abs = path.join(__dirname, 'ui', file);
  if (!abs.startsWith(path.join(__dirname, 'ui') + path.sep)) return sendJson(res, 404, { error: 'not found' });
  fs.readFile(abs, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': contentType(abs) });
    res.end(data);
  });
}

const handleHealth = healthEndpoint(async () => ({
  scopes: watchStore.listScopes().length,
  scopesWithCredential: [...scopeCredentials.keys()].filter((sid) => !!resolveCredential(sid)).length,
}));
const handleTeardown = teardownScopeEndpoint((scopeId) => {
  scopeCredentials.delete(String(scopeId));
  return {
    reaped: watchStore.teardown(scopeId) + inboxStore.teardown(scopeId) + activityStore.teardown(scopeId)
      + ownWritesStore.teardown(scopeId),
  };
}, { secret: SIGNING_SECRET });

// PUT /internal/scope-credentials — the orchestrator's per-scope credential push
// (Jira plan §5). Accepts the orchestrator's `_internal` token ONLY (SDK
// `internalPushEndpoint`): every granted team holds a jira token minted with
// the same secret, and the map carries each team's api-token AND the site the
// poller will talk to — "any valid token" here would let one team wipe every
// other team's credential or repoint its poller at an attacker-controlled
// site. Replaces the whole map so a revoked team disappears.
const handleScopeCredentials = internalPushEndpoint(async (req, res) => {
  const body = parseJson(await readBody(req));
  const scopes = body && body.scopes && typeof body.scopes === 'object' ? body.scopes : {};
  scopeCredentials.clear();
  for (const [scopeId, values] of Object.entries(scopes)) {
    if (values && typeof values === 'object') scopeCredentials.set(String(scopeId), values);
  }
  return sendJson(res, 200, {
    ok: true,
    scopes: scopeCredentials.size,
    usable: [...scopeCredentials.keys()].filter((sid) => !!resolveCredential(sid)).length,
  });
}, { secret: SIGNING_SECRET, pluginId: PLUGIN_ID });

async function handleRequest(req, res) {
  const urlPath = (req.url || '').split('?')[0];

  if (req.method === 'GET' && urlPath === '/healthz') return void (await handleHealth(req, res));
  if (req.method === 'POST' && urlPath === '/internal/teardown-scope') return void (await handleTeardown(req, res));
  if (req.method === 'PUT' && urlPath === '/internal/scope-credentials') return void (await handleScopeCredentials(req, res));

  // A read-only status endpoint for an operator: what the poller sees for the
  // token's own scope.
  if (req.method === 'GET' && urlPath === '/internal/status') {
    const v = verifyScopeToken(req, SIGNING_SECRET);
    if (!v || v.pluginId !== PLUGIN_ID) return void sendJson(res, 401, { error: 'unauthorized' });
    const conf = watchStore.loadConfig(v.scopeId);
    const health = watchHealthFor(v.scopeId);
    return void sendJson(res, 200, {
      scopeId: v.scopeId,
      watches: health.watches,
      health: health.summary,
      cursors: conf.cursors,
      inbox: inboxStore.count(v.scopeId),
      activity: activityStore.count(v.scopeId),
      setBy: conf.setBy,
      setAt: conf.setAt,
      credential: resolveCredential(v.scopeId)
        ? { configured: true, site: resolveCredential(v.scopeId).siteUrl }
        : { configured: false },
    });
  }

  if (urlPath === '/cli' || urlPath.startsWith('/cli/')) {
    const cliPath = urlPath === '/cli' ? '/' : urlPath.slice('/cli'.length) || '/';
    return void (await handleCli(req, res, cliPath));
  }

  if (urlPath === '/ui' || urlPath.startsWith('/ui/')) {
    const uiPath = urlPath === '/ui' ? '/' : urlPath.slice('/ui'.length) || '/';
    return void (await handleUi(req, res, uiPath));
  }

  return void sendJson(res, 404, { error: 'not found' });
}

// Last-resort catch: every route already maps upstream/validation failures to
// a status + message above, so anything landing here is a broker bug. The stack
// goes to stderr (podman logs); the client gets a generic body — an internal
// message/stack is not the agent's to read (CodeQL js/stack-trace-exposure).
// Last-resort catch: every route already maps upstream/validation failures to
// a status + message above, so anything landing here is a broker bug. The
// operator keeps the detail; the client gets a generic body (CodeQL
// js/stack-trace-exposure). Via the SDK wrapper rather than an inline .catch():
// it also contains a SYNCHRONOUS throw raised before the handler returns a
// promise, which the inline form could not.
const httpServer = http.createServer(withUnexpectedErrors('jira-broker', handleRequest));

if (require.main === module) {
  httpServer.listen(PORT, () => process.stdout.write(`[jira-broker] listening on :${PORT}\n`));
  poller.start();
}

module.exports = { handleRequest, httpServer, watchStore, inboxStore, activityStore, ownWritesStore, poller, resolveCredential, deliver, scopeCredentials, PLUGIN_ID, SIGNING_SECRET, DIGEST_MAX_EVENTS };
